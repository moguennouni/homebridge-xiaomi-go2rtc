'use strict';

const os = require('node:os');
const { setTimeout: wait } = require('node:timers/promises');
const { Go2rtc } = require('./go2rtc');
const { StreamingDelegate } = require('./streamingDelegate');
const { resolveFfmpegPath } = require('./ffmpeg');
const { loadSpec, availableControls } = require('./miotSpec');
const { t, setLanguage } = require('./i18n');
const pkg = require('../package.json');

const PLUGIN_NAME = pkg.name;
const PLATFORM_NAME = 'XiaomiGo2rtc';

const XIAOMI_REGIONS = ['cn', 'de', 'i2', 'ru', 'sg', 'us'];
// Retry quickly until an account is connected in the go2rtc UI
const DISCOVERY_RETRY_MS = 30 * 1000;
// Then refresh from time to time to follow IP address changes
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
// MISS command cmdMotorReq, see go2rtc pkg/xiaomi/miss/client.go
const PTZ_COMMAND = 0x112;
const PTZ_RESET_MS = 600;
// Settings can also be changed from Mi Home, so they are read again regularly
const SETTINGS_REFRESH_MS = 60 * 1000;
// How long the HomeKit motion sensor stays on after the camera reported a movement
const MOTION_DURATION_MS = 15 * 1000;
const MOTION_RETRY_MS = 5 * 1000;
// A clean end just means the shared connection stopped with its stream: reconnect right away
const MOTION_RECONNECT_MS = 1000;
const MOTION_MAX_RETRY_MS = 60 * 1000;
// The Xiaomi cloud lists an event 20 to 30 s after it happened: checking more often than every 5 s gains nothing
const MOTION_INTERVAL_S = 10;
const MOTION_MIN_INTERVAL_S = 5;
const MOTION_CLOUD_WINDOW_MIN = 5;
// Events found after an outage are too old to be worth a notification
const MOTION_CLOUD_MAX_AGE_MS = 2 * 60 * 1000;
const PEOPLE_EVENTS = ['PeopleMotion', 'Face', 'KnownFace'];

const lanAddress = () => {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if ((address.family === 'IPv4' || address.family === 4) && !address.internal) {
        return address.address;
      }
    }
  }
  return t('serverIp');
};

// go2rtc source URL: xiaomi://<user>:<region>@<ip>?did=<did>&model=<model>
const parseSource = (source) => {
  try {
    const url = new URL(source.url);
    const did = url.searchParams.get('did');
    if (!did) {
      return null;
    }
    return {
      did,
      model: url.searchParams.get('model') || 'camera',
      ip: url.hostname,
      name: source.name,
      url: source.url,
    };
  } catch {
    return null;
  }
};

class XiaomiGo2rtcPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    setLanguage(this.config.language);

    this.cameras = new Map();
    this.hiddenLogged = new Set();
    this.regionsByAccount = new Map();
    this.discoveryTimer = null;
    this.timers = [];
    this.motionWatchers = [];
    this.accounts = [];
    this.accountHintShown = false;
    this.noCameraHintShown = false;

    if (!config) {
      return;
    }

    api.on('didFinishLaunching', () => {
      this.start().catch((err) => this.log.error(t('startFailed', { error: err.message })));
    });
    api.on('shutdown', () => {
      clearTimeout(this.discoveryTimer);
      this.timers.forEach(clearInterval);
      this.motionWatchers.forEach((watcher) => watcher.abort());
      for (const camera of this.cameras.values()) {
        camera.delegate.shutdown();
      }
      if (this.go2rtc) {
        this.go2rtc.stop();
      }
    });
  }

  get uiUrl() {
    return `http://${lanAddress()}:${this.config.apiPort || 1984}`;
  }

  async start() {
    const { config } = this;
    this.ffmpegPath = resolveFfmpegPath(config.ffmpegPath);
    this.log.debug(t('ffmpegUsed', { path: this.ffmpegPath }));

    this.go2rtc = new Go2rtc({
      log: this.log,
      storagePath: this.api.user.storagePath(),
      apiPort: config.apiPort || 1984,
      rtspPort: config.rtspPort || 8554,
      binaryPath: config.go2rtcPath,
      useOfficial: config.useOfficialGo2rtc === true,
      ffmpegPath: this.ffmpegPath,
      username: config.uiUsername,
      password: config.uiPassword,
    });

    await this.go2rtc.ensureBinary();
    await this.go2rtc.writeConfig();
    await this.go2rtc.start();

    const variants = { 'xiaomi-control': t('variantXiaomiControl'), official: t('variantOfficial'), custom: t('variantCustom', { path: config.go2rtcPath }) };
    this.log.info(t('go2rtcStarted', { variant: variants[this.go2rtc.variant], url: this.uiUrl }));
    if (!(config.uiUsername && config.uiPassword)) {
      this.log.warn(t('noUiPassword'));
    }

    await this.discover();
  }

  async discover() {
    try {
      const sources = await this.findCameras();
      const discoveredDids = new Set(sources.map((source) => source.did));
      for (const source of [...sources, ...this.manualCameras(discoveredDids)]) {
        await this.addOrUpdateCamera(source);
      }
    } catch (err) {
      this.log.warn(t('discoveryFailed', { error: err.message }));
    }

    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => this.discover(), this.cameras.size ? DISCOVERY_REFRESH_MS : DISCOVERY_RETRY_MS);
  }

  // Some cameras (e.g. MJSXJ10CM) are missing from the cloud device list but still stream when given their IP and did
  manualCameras(discoveredDids) {
    if (!this.accounts || !this.accounts.length) {
      return [];
    }
    return (this.config.cameras || [])
      .filter((camera) => camera.did && camera.ip && !discoveredDids.has(String(camera.did)))
      .map((camera) => {
        const did = String(camera.did);
        const account = camera.account || this.accounts[0];
        const region = camera.region || this.config.region || 'de';
        const model = camera.model || 'chuangmi.camera.unknown';
        const query = new URLSearchParams({ did, model });
        return {
          did,
          model,
          ip: camera.ip,
          name: camera.name || t('defaultCameraName', { did }),
          url: `xiaomi://${account}:${region}@${camera.ip}?${query}`,
        };
      });
  }

  async findCameras() {
    const accounts = await this.go2rtc.listXiaomiAccounts();
    this.accounts = accounts;
    if (!accounts.length) {
      if (!this.accountHintShown) {
        this.log.info(t('noAccount', { url: this.uiUrl }));
        this.accountHintShown = true;
      }
      return [];
    }

    const cameras = [];
    for (const account of accounts) {
      const regions = this.config.region ? [this.config.region] : (this.regionsByAccount.get(account) || XIAOMI_REGIONS);
      const regionsWithCameras = [];
      let lastError = null;

      for (const region of regions) {
        let sources;
        try {
          sources = await this.go2rtc.listXiaomiCameras(account, region);
        } catch (err) {
          lastError = err;
          this.log.debug(t('accountRegionError', { account, region, error: err.message }));
          continue;
        }
        if (sources.length) {
          regionsWithCameras.push(region);
        }
        for (const source of sources) {
          const camera = parseSource(source);
          if (camera) {
            cameras.push(camera);
          }
        }
      }

      if (regionsWithCameras.length) {
        this.regionsByAccount.set(account, regionsWithCameras);
      } else if (lastError) {
        this.log.warn(t('accountError', { account, error: lastError.message }));
      } else if (!this.cameras.size && !this.noCameraHintShown) {
        this.log.info(t('noCameraFound', { account }));
        this.noCameraHintShown = true;
      }
    }
    return cameras;
  }

  async addOrUpdateCamera(source) {
    const override = (this.config.cameras || []).find((camera) => String(camera.did) === source.did) || {};
    if (override.hidden) {
      if (!this.hiddenLogged.has(source.did)) {
        this.log.info(t('cameraHidden', { name: source.name, did: source.did }));
        this.hiddenLogged.add(source.did);
      }
      return;
    }

    const url = override.subtype ? `${source.url}&subtype=${encodeURIComponent(override.subtype)}` : source.url;
    const streamName = `xiaomi_${source.did}`;

    const existing = this.cameras.get(source.did);
    if (existing) {
      if (existing.url !== url) {
        await this.go2rtc.setStream(streamName, url);
        existing.url = url;
        this.log.info(`[${existing.delegate.camera.name}] ${t('addressUpdated', { ip: source.ip })}`);
      }
      return;
    }

    await this.go2rtc.setStream(streamName, url);

    const { hap } = this.api;
    const camera = {
      name: override.name || source.name || t('defaultCameraName', { did: source.did }),
      streamName,
      videoMode: override.videoMode || 'auto',
      audio: override.audio === true,
      audioSampleRate: override.audioSampleRate || 0,
      motion: override.motion === true,
      motionSource: override.motionSource === 'camera' ? 'camera' : 'cloud',
      motionInterval: Math.max(override.motionInterval || MOTION_INTERVAL_S, MOTION_MIN_INTERVAL_S) * 1000,
      motionPeopleOnly: override.motionTypes === 'people',
      motionDuration: (override.motionDuration || MOTION_DURATION_MS / 1000) * 1000,
      encoder: override.encoder || 'libx264',
      maxWidth: override.maxWidth || 1280,
    };

    const uuid = hap.uuid.generate(`${PLUGIN_NAME}:${source.did}`);
    const accessory = new this.api.platformAccessory(camera.name, uuid, hap.Categories.CAMERA);
    accessory.getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(hap.Characteristic.Model, source.model)
      .setCharacteristic(hap.Characteristic.SerialNumber, source.did)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, pkg.version);

    const delegate = new StreamingDelegate({ hap, log: this.log, camera, go2rtc: this.go2rtc, ffmpegPath: this.ffmpegPath });
    accessory.configureController(delegate.controller);

    const extraServices = [];
    if (override.ptz) {
      extraServices.push(...this.addPtzButtons(accessory, camera, override));
    }
    if (override.settings) {
      extraServices.push(...await this.addSettingsSwitches(accessory, camera, source.model));
    }

    // Linked to the camera so the Home app groups the switches with it, like other multi-service accessories
    const cameraService = delegate.controller.streamManagements[0] && delegate.controller.streamManagements[0].getService();
    if (cameraService && extraServices.length) {
      cameraService.setPrimaryService(true);
      for (const service of extraServices) {
        cameraService.addLinkedService(service);
      }
    }

    // Cameras must be published as external accessories, each one is paired separately
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.cameras.set(source.did, { delegate, accessory, url });

    this.log.info(t('cameraAdded', { name: camera.name, model: source.model, ip: source.ip, did: source.did }));
    this.log.info(t('pairingHint'));

    if (camera.motion) {
      this.watchMotion(camera, delegate);
    }

    // Probe now so the first stream in the Home app starts without the extra delay
    delegate.getCodecs().catch((err) => {
      this.log.warn(`[${camera.name}] ${t('streamUnreadable', { error: err.message })}`);
    });
  }

  // The motion sensor is fed either by the Xiaomi cloud (the camera's own detection, late) or by the camera motor
  // (immediate, but only when motion tracking turns the camera)
  watchMotion(camera, delegate) {
    const service = delegate.controller.motionService;
    if (!service) {
      return;
    }

    const { hap } = this.api;
    const watcher = new AbortController();
    this.motionWatchers.push(watcher);

    let resetTimer = null;
    watcher.signal.addEventListener('abort', () => clearTimeout(resetTimer));

    const detected = (message) => {
      service.updateCharacteristic(hap.Characteristic.MotionDetected, true);
      this.log.debug(`[${camera.name}] ${message}`);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        service.updateCharacteristic(hap.Characteristic.MotionDetected, false);
      }, camera.motionDuration);
    };

    if (camera.motionSource === 'camera') {
      this.watchCameraMotion(camera, watcher.signal, detected);
    } else {
      this.pollCloudMotion(camera, watcher.signal, detected);
    }
  }

  // The camera reports a motor message on its own when its tracking turns to follow a movement: that is the
  // only motion signal it gives locally, in real time.
  async watchCameraMotion(camera, signal, detected) {
    let retry = MOTION_RETRY_MS;

    while (!signal.aborted) {
      let clean = true;
      try {
        await this.go2rtc.watchMotion(camera.streamName, {
          signal,
          onReady: () => {
            retry = MOTION_RETRY_MS;
            this.log.info(`[${camera.name}] ${t('motionWatching')}`);
          },
          onMessage: () => detected(t('motionDetected')),
        });
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        clean = false;
        const reason = err.status === 404 && !/stream not found/.test(err.message) ? t('motionUnsupported') : err.message;
        this.log.warn(`[${camera.name}] ${t('motionWatchFailed', { error: reason, seconds: retry / 1000 })}`);
      }

      if (signal.aborted) {
        return;
      }
      await wait(clean ? MOTION_RECONNECT_MS : retry, undefined, { signal }).catch(() => {});
      if (!clean) {
        retry = Math.min(retry * 2, MOTION_MAX_RETRY_MS);
      }
    }
  }

  // The Xiaomi cloud lists the events the camera detected, as Mi Home shows them. Events already listed at start
  // are only remembered, so a restart does not notify old movements.
  async pollCloudMotion(camera, signal, detected) {
    const seen = new Map(); // event id → creation time
    let first = true;
    let failing = false;
    let retry = camera.motionInterval;

    this.log.info(`[${camera.name}] ${t('motionCloudWatching', { seconds: camera.motionInterval / 1000 })}`);

    while (!signal.aborted) {
      let delay = camera.motionInterval;
      try {
        const events = await this.go2rtc.listEvents(camera.streamName, { minutes: MOTION_CLOUD_WINDOW_MIN, limit: 20 });
        if (failing) {
          failing = false;
          this.log.info(`[${camera.name}] ${t('motionCloudBack')}`);
        }
        retry = camera.motionInterval;

        const now = Date.now();
        let latest = null;
        for (const event of events) {
          const id = String(event.fileId || event.createTime);
          if (!event.createTime || seen.has(id)) {
            continue;
          }
          seen.set(id, event.createTime);

          // "ObjectMotion:PeopleMotion" when the camera saw both
          const types = String(event.eventType || '').split(':');
          if (first || now - event.createTime > MOTION_CLOUD_MAX_AGE_MS
            || (camera.motionPeopleOnly && !types.some((type) => PEOPLE_EVENTS.includes(type)))) {
            continue;
          }
          if (!latest || event.createTime > latest.createTime) {
            latest = event;
          }
        }
        first = false;

        // The request only covers the last minutes: older ids cannot come back
        for (const [id, createTime] of seen) {
          if (now - createTime > 2 * MOTION_CLOUD_WINDOW_MIN * 60 * 1000) {
            seen.delete(id);
          }
        }

        if (latest) {
          const delaySeconds = Math.round((now - latest.createTime) / 1000);
          detected(t('motionCloudDetected', { type: latest.eventType || '?', delay: delaySeconds }));
        }
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        delay = retry;
        retry = Math.min(retry * 2, MOTION_MAX_RETRY_MS);
        const reason = err.status === 404 && !/stream not found/.test(err.message) ? t('motionUnsupported') : err.message;
        const message = `[${camera.name}] ${t('motionCloudFailed', { error: reason, seconds: delay / 1000 })}`;
        // A cloud outage would otherwise fill the log every few seconds
        if (failing) {
          this.log.debug(message);
        } else {
          this.log.warn(message);
        }
        failing = true;
      }

      await wait(delay, undefined, { signal }).catch(() => {});
    }
  }

  // Camera settings (standby, indicator light...) read and written through the Xiaomi cloud (MIoT)
  async addSettingsSwitches(accessory, camera, model) {
    const { hap } = this.api;

    let spec;
    try {
      spec = await loadSpec(model, this.go2rtc.dir);
    } catch (err) {
      this.log.warn(`[${camera.name}] ${t('specUnavailable', { model, error: err.message })}`);
      return [];
    }
    if (!spec) {
      this.log.warn(`[${camera.name}] ${t('modelUnknown', { model })}`);
      return [];
    }

    const controls = availableControls(spec);
    const state = new Map();
    const services = [];

    for (const control of controls) {
      const service = accessory.addService(hap.Service.Switch, `${camera.name} ${control.name}`, `setting-${control.id}`);
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      service.setCharacteristic(hap.Characteristic.ConfiguredName, control.name);

      const on = service.getCharacteristic(hap.Characteristic.On);
      on.onGet(() => state.get(control.id) || false);
      on.onSet(async (value) => {
        const enabled = Boolean(value);
        try {
          await this.go2rtc.setProperty(camera.streamName, control.siid, control.piid, control.toXiaomi(enabled));
          state.set(control.id, enabled);
          this.log.info(`[${camera.name}] ${t(enabled ? 'settingEnabled' : 'settingDisabled', { setting: control.name })}`);
        } catch (err) {
          this.log.warn(`[${camera.name}] ${t('settingChangeFailed', { setting: control.name, error: this.settingsError(err) })}`);
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

      control.characteristic = on;
      services.push(service);
    }

    const refresh = async () => {
      try {
        for (const item of await this.go2rtc.getProperties(camera.streamName, controls) || []) {
          const control = controls.find((c) => c.siid === item.siid && c.piid === item.piid);
          if (control && item.code === 0) {
            const value = control.toHomeKit(item.value);
            state.set(control.id, value);
            control.characteristic.updateValue(value);
          }
        }
      } catch (err) {
        this.log.debug(`[${camera.name}] ${t('settingsReadFailed', { error: this.settingsError(err) })}`);
      }
    };
    refresh();
    this.timers.push(setInterval(refresh, SETTINGS_REFRESH_MS));

    this.log.info(`[${camera.name}] ${t('settingsAvailable', { settings: controls.map((c) => c.name).join(', ') || t('none') })}`);
    return services;
  }

  settingsError(err) {
    if (err.status === 404 && !/stream not found/.test(err.message)) {
      return t('settingsUnsupported');
    }
    return err.message;
  }

  // Momentary switches grouped with the camera in the Home app
  addPtzButtons(accessory, camera, override) {
    const { hap } = this.api;
    // Codes checked on chuangmi.camera.026c02 (one pan step is small, one tilt step is larger)
    const panSteps = override.ptzPanSteps || 1;
    const tiltSteps = override.ptzTiltSteps || 1;
    const directions = [
      { id: 'left', name: t('ptzLeft'), data: override.ptzLeft || '{"operation":2}', steps: panSteps },
      { id: 'right', name: t('ptzRight'), data: override.ptzRight || '{"operation":1}', steps: panSteps },
      { id: 'up', name: t('ptzUp'), data: override.ptzUp || '{"operation":4}', steps: tiltSteps },
      { id: 'down', name: t('ptzDown'), data: override.ptzDown || '{"operation":3}', steps: tiltSteps },
    ];

    const services = [];
    for (const direction of directions) {
      const service = accessory.addService(hap.Service.Switch, `${camera.name} ${direction.name}`, `ptz-${direction.id}`);
      services.push(service);
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
      service.setCharacteristic(hap.Characteristic.ConfiguredName, direction.name);

      const on = service.getCharacteristic(hap.Characteristic.On);
      on.onGet(() => false);
      on.onSet((value) => {
        if (!value) {
          return;
        }
        setTimeout(() => on.updateValue(false), PTZ_RESET_MS);
        this.moveCamera(camera, direction).catch(() => {});
      });
    }
    return services;
  }

  async moveCamera(camera, direction) {
    try {
      let reply = '';
      for (let step = 0; step < direction.steps; step++) {
        const result = await this.go2rtc.sendCommand(camera.streamName, PTZ_COMMAND, direction.data);
        reply = (result && result.reply) || '';
      }
      // Reply: 4-byte command id + {"ret":0, "angle":67,"elevation":26} (position when the last step was received)
      const position = reply.match(/"angle":\s*(-?\d+).*"elevation":\s*(-?\d+)/);
      this.log.debug(`[${camera.name}] ${t('ptzMoved', { direction: direction.name, steps: direction.steps, position: position ? t('ptzPosition', { pan: position[1], tilt: position[2] }) : '' })}`);
    } catch (err) {
      if (err.status === 409) {
        this.log.warn(`[${camera.name}] ${t('ptzOpenLiveView')}`);
      } else if (err.status === 404 && !/stream not found/.test(err.message)) {
        this.log.warn(`[${camera.name}] ${t('ptzUnsupported')}`);
      } else {
        this.log.warn(`[${camera.name}] ${t('ptzFailed', { error: err.message })}`);
      }
      throw err;
    }
  }
}

module.exports = { XiaomiGo2rtcPlatform, PLATFORM_NAME, PLUGIN_NAME };

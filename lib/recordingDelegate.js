'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { t } = require('./i18n');

// HomeKit asks for at least 4 s of video before the event
const PREBUFFER_MS = 4000;
// Longest fragment accepted: the shared transcoding has a key frame every 2 s, so fragments last about 2 s
const FRAGMENT_MS = 4000;
const RESTART_DELAY_MS = 10 * 1000;
const INIT_WAIT_MS = 10 * 1000;
// Without any new fragment for this long, the prebuffer is considered stalled
const STALL_MS = 3 * FRAGMENT_MS;
// A home hub closes a recording itself once the motion is over: this only ends a forgotten one
const MAX_RECORDING_MS = 3 * 60 * 1000;
// 30 s of prebuffer at one fragment every 2 s, with a margin
const MAX_FRAGMENTS = 40;
const MAX_BOX_BYTES = 16 * 1024 * 1024;

// HomeKit Secure Video. A permanent ffmpeg copies the camera H.264 (the shared transcoding for an H.265 camera) into
// fragmented MP4, one fragment per key frame, and the last seconds stay in memory. A recording sends the
// initialization segment, that prebuffer, then the following fragments until the home hub closes the stream.
class RecordingDelegate {
  // getSource: async () => RTSP URL of an H.264 stream of the camera, or null when there is none
  constructor({ hap, log, camera, ffmpegPath, getSource }) {
    this.hap = hap;
    this.log = log;
    this.camera = camera;
    this.ffmpegPath = ffmpegPath;
    this.getSource = getSource;
    this.controller = null;
    // Kept and sent at the start of every recording, even when the home hub chose a shorter prebuffer: the cloud
    // motion trigger comes 10 to 30 s after the movement
    this.prebufferMs = camera.recordingPrebufferMs || PREBUFFER_MS;

    this.active = false;
    this.configuration = undefined;
    this.stopped = false;
    this.starting = false;
    this.refreshAgain = false;
    this.restartTimer = null;

    this.child = null;
    this.childKey = null;
    // Incremented at each ffmpeg start: fragments of different runs cannot be mixed in one recording
    this.generation = 0;
    this.resetBuffer();

    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  // prebufferMs: the maximum prebuffer announced to the home hub, which chooses a value up to it
  static recordingOptions(hap, prebufferMs = PREBUFFER_MS) {
    return {
      prebufferLength: prebufferMs,
      mediaContainerConfiguration: { type: hap.MediaContainerType.FRAGMENTED_MP4, fragmentLength: FRAGMENT_MS },
      video: {
        type: hap.VideoCodecType.H264,
        // The profile and level of the shared transcoding: HomeKit refuses a recording that differs from its choice
        parameters: { profiles: [hap.H264Profile.HIGH], levels: [hap.H264Level.LEVEL4_0] },
        // 1080p and 720p are required by HomeKit; the camera sends its own resolution anyway
        resolutions: [[1920, 1080, 30], [1920, 1080, 15], [1280, 720, 30], [1280, 720, 15], [640, 360, 30], [640, 360, 15]],
      },
      audio: {
        codecs: {
          type: hap.AudioRecordingCodecType.AAC_LC,
          samplerate: [hap.AudioRecordingSamplerate.KHZ_16, hap.AudioRecordingSamplerate.KHZ_32],
          audioChannels: 1,
          bitrateMode: hap.AudioBitrate.VARIABLE,
        },
      },
    };
  }

  prefix(message) {
    return `[${this.camera.name}] ${message}`;
  }

  // The recording services only exist once the controller is configured on the accessory
  attach(controller) {
    this.controller = controller;
    const service = this.recordingService();
    if (service) {
      service.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).on('change', () => this.refresh());
    }
  }

  recordingService() {
    return this.controller && this.controller.recordingManagement && this.controller.recordingManagement.recordingManagementService;
  }

  // HomeKit forbids audio in the recording when the user turned it off in the Home app
  get audioWanted() {
    const service = this.recordingService();
    return this.camera.audio && Boolean(service && service.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value);
  }

  get sampleRate() {
    const { AudioRecordingSamplerate } = this.hap;
    const rate = this.configuration && this.configuration.audioCodec.samplerate;
    return rate === AudioRecordingSamplerate.KHZ_32 ? 32000 : 16000;
  }

  updateRecordingActive(active) {
    this.active = active;
    this.log.info(this.prefix(t(active ? 'recordingEnabled' : 'recordingDisabled')));
    this.refresh();
  }

  updateRecordingConfiguration(configuration) {
    this.configuration = configuration;
    if (configuration) {
      const { videoCodec, mediaContainerConfiguration } = configuration;
      const [width, height, fps] = videoCodec.resolution;
      this.log.info(this.prefix(t('recordingConfigured', {
        width, height, fps,
        bitrate: videoCodec.parameters.bitRate,
        iframe: videoCodec.parameters.iFrameInterval,
        samplerate: this.sampleRate,
        prebuffer: configuration.prebufferLength,
        fragment: mediaContainerConfiguration.fragmentLength,
      })));
      if (configuration.prebufferLength < this.prebufferMs) {
        this.log.info(this.prefix(t('prebufferLonger', { chosen: configuration.prebufferLength, kept: this.prebufferMs / 1000 })));
      }
    }
    this.refresh();
  }

  // Starts, restarts or stops the prebuffer to match the recording state
  refresh() {
    if (this.stopped) {
      return;
    }
    if (!this.active || !this.configuration) {
      this.stopPrebuffer();
      return;
    }
    if (this.starting) {
      this.refreshAgain = true;
      return;
    }
    const key = `${this.sampleRate}:${this.audioWanted}`;
    if (this.child && this.childKey === key) {
      return;
    }
    this.stopPrebuffer();
    this.startPrebuffer(key).catch((err) => {
      this.log.warn(this.prefix(t('prebufferFailed', { error: err.message, seconds: RESTART_DELAY_MS / 1000 })));
      this.scheduleRestart();
    });
  }

  async startPrebuffer(key) {
    this.starting = true;
    let source;
    try {
      source = await this.getSource();
    } finally {
      this.starting = false;
    }
    if (this.refreshAgain) {
      this.refreshAgain = false;
      this.refresh();
      return;
    }
    if (this.stopped || !this.active || !this.configuration || this.child) {
      return;
    }
    if (!source) {
      this.log.warn(this.prefix(t('recordingNeedsShared')));
      return;
    }

    const withAudio = this.audioWanted;
    const sampleRate = this.sampleRate;
    const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', source];
    if (!withAudio) {
      // HomeKit expects an audio track: silence, read at its real pace so that it does not pile up before the video
      args.push('-re', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`);
    }
    args.push(
      '-map', '0:v:0', '-map', withAudio ? '0:a:0' : '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', String(sampleRate), '-ac', '1', '-b:a', '32k',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      'pipe:1',
    );
    this.log.debug(this.prefix(`ffmpeg ${args.join(' ')}`));

    const child = spawn(this.ffmpegPath, args);
    this.child = child;
    this.childKey = key;
    this.generation++;
    this.resetBuffer();
    this.log.info(this.prefix(t(withAudio ? 'prebufferStartedAudio' : 'prebufferStartedSilent')));

    let lastLine = '';
    child.stdout.on('data', (chunk) => this.onData(child, chunk));
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          lastLine = line.trim();
          this.log.debug(this.prefix(`[ffmpeg] ${lastLine}`));
        }
      }
    });
    child.on('error', (err) => {
      lastLine = err.message;
    });
    child.on('exit', (code, signal) => {
      // Stopped on purpose, or replaced by a newer run
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.childKey = null;
      this.resetBuffer();
      this.log.warn(this.prefix(t('prebufferFailed', { error: lastLine || `code ${code}, signal ${signal}`, seconds: RESTART_DELAY_MS / 1000 })));
      this.scheduleRestart();
    });
  }

  resetBuffer() {
    this.pending = null;
    this.initParts = [];
    this.init = null;
    this.moof = null;
    this.fragments = [];
  }

  // Splits the ffmpeg output into MP4 boxes
  onData(child, chunk) {
    if (this.child !== child) {
      return;
    }
    this.pending = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      let size = this.pending.readUInt32BE(0);
      let headerSize = 8;
      if (size === 1) {
        if (this.pending.length < 16) {
          return;
        }
        size = Number(this.pending.readBigUInt64BE(8));
        headerSize = 16;
      }
      if (size < headerSize || size > MAX_BOX_BYTES) {
        this.log.warn(this.prefix(t('prebufferBadData', { size })));
        child.kill('SIGKILL');
        return;
      }
      if (this.pending.length < size) {
        return;
      }
      // Copied so that a small box does not keep a large chunk alive
      const box = Buffer.from(this.pending.subarray(0, size));
      this.pending = this.pending.length > size ? this.pending.subarray(size) : null;
      this.onBox(box.toString('latin1', 4, 8), box);
      if (!this.pending) {
        return;
      }
    }
  }

  onBox(type, box) {
    switch (type) {
      case 'ftyp':
        this.initParts = [box];
        break;
      case 'moov':
        this.init = Buffer.concat([...this.initParts, box]);
        this.initParts = [];
        this.events.emit('init');
        break;
      case 'moof':
        this.moof = box;
        break;
      case 'mdat':
        if (this.moof) {
          this.addFragment(Buffer.concat([this.moof, box]));
          this.moof = null;
        }
        break;
      default:
        // Other boxes (free, sidx...) are not needed by HomeKit
    }
  }

  addFragment(data) {
    const now = Date.now();
    const fragment = { generation: this.generation, sequence: this.sequence = (this.sequence || 0) + 1, data, time: now };
    this.fragments.push(fragment);
    // Keep the fragments that end within the prebuffer: the oldest one kept then starts before it
    const keepFrom = now - this.prebufferMs;
    while (this.fragments.length > 1 && (this.fragments[0].time <= keepFrom || this.fragments.length > MAX_FRAGMENTS)) {
      this.fragments.shift();
    }
    this.events.emit('fragment');
  }

  // Resolves true when the event happens, false on timeout or when the signal aborts
  waitFor(event, timeoutMs, signal) {
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        this.events.off(event, onEvent);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(value);
      };
      const onEvent = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.events.on(event, onEvent);
      if (signal) {
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  async *handleRecordingStreamRequest(streamId, signal) {
    if (!this.init && !await this.waitFor('init', INIT_WAIT_MS, signal)) {
      if (signal && signal.aborted) {
        return;
      }
      this.log.warn(this.prefix(t('recordingNotReady')));
      throw new Error('prebuffer not ready');
    }

    const { generation, init } = this;
    const prebuffer = [...this.fragments];
    const recording = { started: Date.now(), fragments: 0 };
    this.recording = recording;
    const prebufferSeconds = prebuffer.length ? Math.round((Date.now() - prebuffer[0].time) / 1000) + 2 : 0;
    this.log.info(this.prefix(t('recordingStarted', { seconds: prebufferSeconds })));

    yield { data: init, isLast: false };

    let sequence = 0;
    for (const fragment of prebuffer) {
      if (signal && signal.aborted) {
        return;
      }
      sequence = fragment.sequence;
      recording.fragments++;
      yield { data: fragment.data, isLast: false };
    }

    while (!(signal && signal.aborted)) {
      if (this.generation !== generation) {
        this.log.warn(this.prefix(t('recordingStalled', { seconds: 0 })));
        throw new Error('prebuffer restarted');
      }
      const next = this.fragments.find((fragment) => fragment.sequence > sequence);
      if (!next) {
        if (!await this.waitFor('fragment', STALL_MS, signal) && !(signal && signal.aborted)) {
          this.log.warn(this.prefix(t('recordingStalled', { seconds: STALL_MS / 1000 })));
          throw new Error('no video');
        }
        continue;
      }
      sequence = next.sequence;
      recording.fragments++;
      const isLast = Date.now() - recording.started >= MAX_RECORDING_MS;
      yield { data: next.data, isLast };
      if (isLast) {
        return;
      }
    }
  }

  acknowledgeStream() {
    this.logRecordingEnd(t('recordingAcknowledged'));
  }

  closeRecordingStream(streamId, reason) {
    const name = reason === undefined ? t('recordingConnectionClosed') : (this.hap.HDSProtocolSpecificErrorReason[reason] || String(reason));
    this.logRecordingEnd(name);
  }

  logRecordingEnd(reason) {
    const recording = this.recording;
    this.recording = null;
    const seconds = recording ? Math.round((Date.now() - recording.started) / 1000) : 0;
    this.log.info(this.prefix(t('recordingEnded', { reason, fragments: recording ? recording.fragments : 0, seconds })));
  }

  scheduleRestart() {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.refresh();
    }, RESTART_DELAY_MS);
  }

  stopPrebuffer() {
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const { child } = this;
    this.child = null;
    this.childKey = null;
    this.resetBuffer();
    if (!child) {
      return;
    }
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 2000);
  }

  shutdown() {
    this.stopped = true;
    this.stopPrebuffer();
  }
}

module.exports = { RecordingDelegate };

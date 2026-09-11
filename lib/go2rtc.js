'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const YAML = require('yaml');
const { t } = require('./i18n');

const GO2RTC_VERSION = '1.9.14';

// Binaries and SHA-256 digests published on https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.14
const GO2RTC_ASSETS = {
  'linux-x64': { file: 'go2rtc_linux_amd64', sha256: '32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6' },
  'linux-arm64': { file: 'go2rtc_linux_arm64', sha256: '359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50' },
  'linux-arm': { file: 'go2rtc_linux_arm', sha256: '4d7e1639af5a2722a28e864468fd8099b3c1682565446c798bf9e3b38fde12e4' },
  'linux-armv6': { file: 'go2rtc_linux_armv6', sha256: '4dc20370556b29f3a90f4c7a09dcd95472c8f74cca56d4d1fb91f32bdd15174c' },
  'linux-ia32': { file: 'go2rtc_linux_i386', sha256: '12a114d19fc9fba1b3541cf7c6bb9b01896a6845f31285ec77269e2e7c613885' },
};

// go2rtc-xiaomi-control binaries built by GitHub Actions for each release of this plugin. The release workflow
// fills this file with their SHA-256 digests; from a git checkout it is empty and the official go2rtc is used.
const XIAOMI_CONTROL = require('./go2rtc-binaries.json');
const XIAOMI_CONTROL_REPO = 'moguennouni/homebridge-xiaomi-go2rtc';

const RESTART_DELAY_MS = 5000;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

const sha256File = async (file) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

const assetKey = () => {
  let arch = process.arch;
  if (arch === 'arm' && String(process.config.variables.arm_version) === '6') {
    arch = 'armv6';
  }
  return `${process.platform}-${arch}`;
};

class Go2rtc {
  constructor({ log, storagePath, apiPort, rtspPort, binaryPath, useOfficial, ffmpegPath, username, password }) {
    this.log = log;
    this.dir = path.join(storagePath, 'xiaomi-go2rtc');
    this.configPath = path.join(this.dir, 'go2rtc.yaml');
    this.pidPath = path.join(this.dir, 'go2rtc.pid');
    this.apiPort = apiPort;
    this.rtspPort = rtspPort;
    this.binaryPath = binaryPath;
    this.useOfficial = useOfficial;
    // 'xiaomi-control', 'official' or 'custom' (go2rtcPath)
    this.variant = null;
    this.ffmpegPath = ffmpegPath;
    this.username = username;
    this.password = password;

    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  get apiUrl() {
    return `http://127.0.0.1:${this.apiPort}`;
  }

  rtspUrl(streamName) {
    return `rtsp://127.0.0.1:${this.rtspPort}/${streamName}`;
  }

  async ensureBinary() {
    await fsp.mkdir(this.dir, { recursive: true });

    if (this.binaryPath) {
      if (!fs.existsSync(this.binaryPath)) {
        throw new Error(t('go2rtcNotFound', { path: this.binaryPath }));
      }
      this.variant = 'custom';
      return this.binaryPath;
    }

    const key = assetKey();

    if (!this.useOfficial) {
      const asset = XIAOMI_CONTROL.release && XIAOMI_CONTROL.assets[key];
      if (asset) {
        this.variant = 'xiaomi-control';
        return this.download({
          name: `go2rtc-xiaomi-control ${XIAOMI_CONTROL.go2rtc}`,
          url: `https://github.com/${XIAOMI_CONTROL_REPO}/releases/download/${XIAOMI_CONTROL.release}/${asset.file}`,
          sha256: asset.sha256,
          target: path.join(this.dir, `go2rtc-xiaomi-control-${XIAOMI_CONTROL.release}${path.extname(asset.file)}`),
        });
      }
      this.log.warn(t('xiaomiControlUnavailable', { platform: key }));
    }

    const asset = GO2RTC_ASSETS[key];
    if (!asset) {
      throw new Error(t('noGo2rtcBinary', { platform: key }));
    }
    this.variant = 'official';
    return this.download({
      name: `go2rtc ${GO2RTC_VERSION}`,
      url: `https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${asset.file}`,
      sha256: asset.sha256,
      target: path.join(this.dir, `go2rtc-${GO2RTC_VERSION}`),
    });
  }

  async download({ name, url, sha256, target }) {
    if (fs.existsSync(target) && await sha256File(target) === sha256) {
      this.binaryPath = target;
      return target;
    }

    this.log.info(t('downloading', { name }));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(t('downloadFailed', { name, status: `${response.status} ${response.statusText}` }));
    }

    const data = Buffer.from(await response.arrayBuffer());
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== sha256) {
      throw new Error(t('badDigest', { name, expected: sha256, actual: digest }));
    }

    const tmp = `${target}.download`;
    await fsp.writeFile(tmp, data, { mode: 0o755 });
    await fsp.rename(tmp, target);
    this.log.info(t('downloaded', { name }));
    await this.removeOldBinaries(target);

    this.binaryPath = target;
    return target;
  }

  // Binaries of previous versions (not the config nor the pid file)
  async removeOldBinaries(keep) {
    for (const file of await fsp.readdir(this.dir)) {
      const full = path.join(this.dir, file);
      if (/^go2rtc-(xiaomi-control-v|\d)/.test(file) && full !== keep) {
        await fsp.unlink(full).catch(() => {});
      }
    }
  }

  // Updates only the keys managed by the plugin; everything else (Xiaomi tokens, streams) is kept.
  async writeConfig() {
    let config = {};
    if (fs.existsSync(this.configPath)) {
      config = YAML.parse(await fsp.readFile(this.configPath, 'utf8')) || {};
    }

    config.api = { ...config.api, listen: `:${this.apiPort}` };
    if (this.username && this.password) {
      config.api.username = this.username;
      config.api.password = this.password;
    } else {
      delete config.api.username;
      delete config.api.password;
    }

    // Only the local ffmpeg reads the RTSP streams
    config.rtsp = { ...config.rtsp, listen: `127.0.0.1:${this.rtspPort}` };
    config.ffmpeg = { ...config.ffmpeg, bin: this.ffmpegPath };

    // The file holds the Xiaomi account token
    await fsp.writeFile(this.configPath, YAML.stringify(config), { mode: 0o600 });
  }

  // A go2rtc left over by a Homebridge crash would keep the ports busy
  async killLeftover() {
    let pid;
    try {
      pid = parseInt(await fsp.readFile(this.pidPath, 'utf8'), 10);
    } catch {
      return;
    }
    if (!pid) {
      return;
    }

    if (process.platform === 'linux') {
      try {
        const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmdline.includes('go2rtc')) {
          return;
        }
      } catch {
        return;
      }
    }

    try {
      process.kill(pid, 'SIGTERM');
      this.log.warn(t('leftoverStopped', { pid }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      // Already gone
    }
  }

  async start() {
    this.stopping = false;
    await this.killLeftover();

    this.child = spawn(this.binaryPath, ['-config', this.configPath], { cwd: this.dir });
    const child = this.child;
    await fsp.writeFile(this.pidPath, String(child.pid)).catch(() => {});

    const onOutput = (chunk) => {
      for (const rawLine of chunk.toString().split('\n')) {
        const line = stripAnsi(rawLine).trim();
        if (!line) {
          continue;
        }
        if (/ (ERR|FTL) /.test(line)) {
          this.log.error(`[go2rtc] ${line}`);
        } else if (/ WRN /.test(line)) {
          this.log.warn(`[go2rtc] ${line}`);
        } else {
          this.log.debug(`[go2rtc] ${line}`);
        }
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('error', (err) => this.log.error(t('go2rtcLaunchFailed', { error: err.message })));
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (this.stopping) {
        return;
      }
      this.log.warn(t('go2rtcExited', { code, signal, seconds: RESTART_DELAY_MS / 1000 }));
      this.restartTimer = setTimeout(() => {
        this.start().catch((err) => this.log.error(t('go2rtcRestartFailed', { error: err.message })));
      }, RESTART_DELAY_MS);
    });

    await this.waitReady();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      // Nothing to clean up
    }
  }

  async waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.apiUrl}/api`);
        if (response.ok) {
          return;
        }
      } catch {
        // Not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(t('go2rtcNoAnswer', { port: this.apiPort }));
  }

  // Requests from 127.0.0.1 skip go2rtc's basic auth (unless local_auth is set)
  async request(pathAndQuery, { method = 'GET' } = {}) {
    const response = await fetch(`${this.apiUrl}${pathAndQuery}`, { method });
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`go2rtc ${method} ${pathAndQuery.split('?')[0]} : ${response.status} ${body.trim()}`);
      error.status = response.status;
      throw error;
    }
    return body ? JSON.parse(body) : null;
  }

  async listXiaomiAccounts() {
    return (await this.request('/api/xiaomi')) || [];
  }

  async listXiaomiCameras(userId, region) {
    const query = new URLSearchParams({ id: userId, region });
    try {
      const result = await this.request(`/api/xiaomi?${query}`);
      return (result && result.sources) || [];
    } catch (err) {
      // go2rtc answers 404 "no sources" when the account has no camera in this region
      if (err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  // Needs the patched go2rtc (go2rtc-xiaomi-control), the official build has no command API
  async sendCommand(streamName, cmd, data) {
    const query = new URLSearchParams({ src: streamName, cmd: String(cmd), data });
    return this.request(`/api/xiaomi/command?${query}`, { method: 'POST' });
  }

  // MIoT properties through the Xiaomi cloud (patched go2rtc): [{ siid, piid, value, code }]
  async getProperties(streamName, props) {
    const query = new URLSearchParams({ src: streamName, props: props.map((p) => `${p.siid}.${p.piid}`).join(',') });
    return this.request(`/api/xiaomi/miot?${query}`);
  }

  async setProperty(streamName, siid, piid, value) {
    const query = new URLSearchParams({ src: streamName, siid: String(siid), piid: String(piid), value: JSON.stringify(value) });
    const result = await this.request(`/api/xiaomi/miot?${query}`, { method: 'POST' });
    const failed = (result || []).find((item) => item.code !== 0);
    if (failed) {
      throw new Error(t('settingsRefused', { code: failed.code }));
    }
  }

  async setStream(name, source) {
    const query = new URLSearchParams({ name, src: source });
    await this.request(`/api/streams?${query}`, { method: 'PUT' });
  }
}

module.exports = { Go2rtc, GO2RTC_VERSION, XIAOMI_CONTROL };

'use strict';

const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const ffmpeg = require('./ffmpeg');
const { t } = require('./i18n');

const SNAPSHOT_CACHE_MS = 20000;
// Stop the stream when the viewer stops sending RTCP reports
const RTCP_TIMEOUT_MS = 15000;
// Opening the Xiaomi P2P session can take a while before the first report
const STARTUP_TIMEOUT_MS = 45000;
const PKT_SIZE_VIDEO = 1316;
const PKT_SIZE_AUDIO = 188;

const H264_PROFILES = ['baseline', 'main', 'high'];
const H264_LEVELS = ['3.1', '3.2', '4.0'];

const pickPort = () => new Promise((resolve, reject) => {
  const socket = dgram.createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, () => {
    const { port } = socket.address();
    socket.close(() => resolve(port));
  });
});

class StreamingDelegate {
  // camera: { name, streamName, videoMode, audio, encoder, maxWidth }
  constructor({ hap, log, camera, go2rtc, ffmpegPath }) {
    this.hap = hap;
    this.log = log;
    this.camera = camera;
    this.go2rtc = go2rtc;
    this.ffmpegPath = ffmpegPath;

    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();
    this.codecs = null;
    this.probing = null;
    this.lastSnapshot = null;
    this.snapshotPromise = null;

    this.controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      // A motion sensor linked to the camera, fed by what the camera reports
      sensors: camera.motion ? { motion: true } : undefined,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1080, 30], [1280, 720, 30], [640, 480, 30], [640, 360, 30],
            [480, 360, 30], [480, 270, 30], [320, 240, 15], [320, 180, 15],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: false,
          codecs: [{ type: hap.AudioStreamingCodecType.AAC_ELD, samplerate: hap.AudioStreamingSamplerate.KHZ_16 }],
        },
      },
    });
  }

  get url() {
    return this.go2rtc.rtspUrl(this.camera.streamName);
  }

  prefix(message) {
    return `[${this.camera.name}] ${message}`;
  }

  async getCodecs() {
    if (this.codecs) {
      return this.codecs;
    }
    if (!this.probing) {
      this.probing = ffmpeg.probe(this.ffmpegPath, this.url)
        .then((codecs) => {
          this.codecs = codecs;
          const copy = this.useCopy(codecs);
          this.log.info(this.prefix(t('streamDetected', { video: codecs.video, audio: codecs.audio || t('none'), mode: t(copy ? 'modeCopy' : 'modeTranscode') })));
          return codecs;
        })
        .finally(() => {
          this.probing = null;
        });
    }
    return this.probing;
  }

  useCopy(codecs) {
    if (this.camera.videoMode === 'copy') {
      return true;
    }
    if (this.camera.videoMode === 'transcode') {
      return false;
    }
    return codecs.video === 'h264';
  }

  handleSnapshotRequest(request, callback) {
    this.getSnapshot(request.width)
      .then((buffer) => callback(undefined, buffer))
      .catch((err) => {
        this.log.warn(this.prefix(t('snapshotFailed', { error: err.message })));
        callback(err);
      });
  }

  async getSnapshot(width) {
    if (this.lastSnapshot && Date.now() - this.lastSnapshot.time < SNAPSHOT_CACHE_MS) {
      return this.lastSnapshot.buffer;
    }
    if (!this.snapshotPromise) {
      this.snapshotPromise = ffmpeg.snapshot(this.ffmpegPath, this.url, width)
        .then((buffer) => {
          this.lastSnapshot = { buffer, time: Date.now() };
          return buffer;
        })
        .finally(() => {
          this.snapshotPromise = null;
        });
    }
    try {
      return await this.snapshotPromise;
    } catch (err) {
      // An old image is better than an error tile in the Home app
      if (this.lastSnapshot) {
        return this.lastSnapshot.buffer;
      }
      throw err;
    }
  }

  async prepareStream(request, callback) {
    try {
      const videoReturnPort = await pickPort();
      const audioReturnPort = await pickPort();
      const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
      const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

      this.pendingSessions.set(request.sessionID, {
        address: request.targetAddress,
        ipv6: request.addressVersion === 'ipv6',
        videoPort: request.video.port,
        videoReturnPort,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
        videoSSRC,
        audioPort: request.audio.port,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]).toString('base64'),
        audioSSRC,
      });

      callback(undefined, {
        video: { port: videoReturnPort, ssrc: videoSSRC, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
        audio: { port: audioReturnPort, ssrc: audioSSRC, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt },
      });
    } catch (err) {
      this.log.error(this.prefix(t('prepareFailed', { error: err.message })));
      callback(err);
    }
  }

  handleStreamRequest(request, callback) {
    const { StreamRequestTypes } = this.hap;
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request)
          .then(() => callback())
          .catch((err) => {
            this.log.error(this.prefix(t('startStreamFailed', { error: err.message })));
            callback(err);
          });
        break;
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(this.prefix(t('reconfigureIgnored', { width: request.video.width, height: request.video.height })));
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
      default:
        callback();
    }
  }

  buildArgs(session, request, codecs) {
    const { width, height, fps, max_bit_rate: bitrate, pt, profile, level } = request.video;
    const target = session.ipv6 ? `[${session.address}]` : session.address;
    const copy = this.useCopy(codecs);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp', '-i', this.url,
      '-map', '0:v:0',
    ];

    if (copy) {
      args.push('-c:v', 'copy');
    } else {
      const encoder = this.camera.encoder || 'libx264';
      const outWidth = Math.min(width, this.camera.maxWidth || width);
      args.push('-c:v', encoder);
      if (encoder === 'libx264') {
        args.push(
          '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-profile:v', H264_PROFILES[profile] || 'main',
          '-level:v', H264_LEVELS[level] || '3.1',
        );
      }
      args.push(
        // Keep the camera frame rate: forcing the requested one duplicates frames and wastes CPU
        '-pix_fmt', 'yuv420p',
        '-g', String(fps * 2), '-bf', '0',
        // Never upscale, keep the aspect ratio
        '-vf', `scale='min(${outWidth},iw)':-2:flags=fast_bilinear`,
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`,
      );
    }

    args.push(
      '-an', '-sn', '-dn',
      '-payload_type', String(pt),
      '-ssrc', String(session.videoSSRC),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', session.videoSRTP,
      `srtp://${target}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${PKT_SIZE_VIDEO}`,
    );

    const withAudio = this.camera.audio && codecs.audio && request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD;
    if (withAudio) {
      args.push('-map', '0:a:0');
      // Official go2rtc labels 16 kHz A-law as 8 kHz: reinterpret the samples at their real rate
      if (this.camera.audioSampleRate) {
        args.push('-af', `asetrate=${this.camera.audioSampleRate}`);
      }
      args.push(
        '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-flags', '+global_header',
        '-ar', `${request.audio.sample_rate}k`,
        // HomeKit expects one frame per packet (30 ms at 16 kHz = 480 samples), libfdk defaults to 512
        // and the voice then sounds slow and deep. libfdk ignores -frame_size, the option is -frame_length.
        '-frame_length', String((request.audio.packet_time || 30) * request.audio.sample_rate),
        '-b:a', `${request.audio.max_bit_rate}k`,
        '-ac', String(request.audio.channel || 1),
        '-vn', '-sn', '-dn',
        '-payload_type', String(request.audio.pt),
        '-ssrc', String(session.audioSSRC),
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', session.audioSRTP,
        `srtp://${target}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=${PKT_SIZE_AUDIO}`,
      );
    }

    const mode = copy ? t('descriptionCopy') : t('descriptionTranscode', { width: Math.min(width, this.camera.maxWidth || width) });
    return { args, description: `${mode} ${width}x${height}@${fps} ${bitrate} kbit/s${withAudio ? t('descriptionAudio') : ''}` };
  }

  async startStream(request) {
    const { sessionID } = request;
    const session = this.pendingSessions.get(sessionID);
    if (!session) {
      throw new Error(t('unknownSession'));
    }
    this.pendingSessions.delete(sessionID);

    let codecs;
    try {
      codecs = await this.getCodecs();
    } catch (err) {
      if (this.camera.videoMode === 'auto') {
        throw new Error(t('go2rtcStreamUnreadable', { error: err.message }));
      }
      // The codec is forced: try anyway, without audio
      codecs = { video: null, audio: null };
    }

    const { args, description } = this.buildArgs(session, request, codecs);
    this.log.info(this.prefix(t('streamStarting', { description })));
    this.log.debug(this.prefix(`ffmpeg ${args.join(' ')}`));

    const child = spawn(this.ffmpegPath, args);
    const socket = dgram.createSocket(session.ipv6 ? 'udp6' : 'udp4');
    const active = { child, socket, timer: null, stopping: false, lastLines: [] };
    this.ongoingSessions.set(sessionID, active);

    const armTimeout = (ms) => {
      clearTimeout(active.timer);
      active.timer = setTimeout(() => {
        this.log.info(this.prefix(t('viewerGone')));
        this.controller.forceStopStreamingSession(sessionID);
        this.stopStream(sessionID);
      }, ms);
    };

    socket.on('message', () => armTimeout(RTCP_TIMEOUT_MS));
    socket.on('error', (err) => this.log.debug(this.prefix(`Socket RTCP : ${err.message}`)));
    socket.bind(session.videoReturnPort);
    armTimeout(STARTUP_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) {
          continue;
        }
        this.log.debug(this.prefix(`[ffmpeg] ${line.trim()}`));
        active.lastLines.push(line.trim());
        if (active.lastLines.length > 5) {
          active.lastLines.shift();
        }
      }
    });
    child.on('error', (err) => this.log.error(this.prefix(t('ffmpegLaunchFailed', { path: this.ffmpegPath, error: err.message }))));
    child.on('exit', (code, signal) => {
      if (active.stopping) {
        return;
      }
      this.log.error(this.prefix(t('ffmpegStopped', { code, signal, lines: active.lastLines.join(' | ') || t('noMessage') })));
      this.controller.forceStopStreamingSession(sessionID);
      this.stopStream(sessionID);
    });
  }

  stopStream(sessionID) {
    this.pendingSessions.delete(sessionID);
    const active = this.ongoingSessions.get(sessionID);
    if (!active) {
      return;
    }
    this.ongoingSessions.delete(sessionID);

    active.stopping = true;
    clearTimeout(active.timer);
    try {
      active.socket.close();
    } catch {
      // Already closed
    }
    active.child.kill('SIGTERM');
    setTimeout(() => {
      if (active.child.exitCode === null && active.child.signalCode === null) {
        active.child.kill('SIGKILL');
      }
    }, 2000);
    this.log.info(this.prefix(t('streamStopped')));
  }

  shutdown() {
    for (const sessionID of [...this.ongoingSessions.keys()]) {
      this.stopStream(sessionID);
    }
  }
}

module.exports = { StreamingDelegate };

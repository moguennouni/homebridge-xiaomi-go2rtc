'use strict';

const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpeg = require('./ffmpeg');
const { t } = require('./i18n');
const { RecordingDelegate } = require('./recordingDelegate');

const SNAPSHOT_CACHE_MS = 20000;
// How long the Home app gets the event thumbnail instead of a live snapshot
const EVENT_SNAPSHOT_MS = 30000;
// Stop the stream when the viewer stops sending RTCP reports
const RTCP_TIMEOUT_MS = 15000;
// Opening the Xiaomi P2P session can take a while before the first report
const STARTUP_TIMEOUT_MS = 45000;
// HAP marks a stream slot busy as soon as it is prepared and never frees one that is not started: the Home app
// starts within a second, so a prepared session still waiting after this is abandoned
const PREPARE_TIMEOUT_MS = 10000;
const PKT_SIZE_VIDEO = 1316;
const PKT_SIZE_AUDIO = 188;
const AAC_ELD_FRAME_LENGTH = 480;
// Period of the two-way audio rate message
const TALK_RATE_SECONDS = 5;
// Silence after which the speaker request is ended, the next sound opening the speaker again
const TALK_IDLE_MS = 1500;
// The tested camera speaker plays A-law at 16 kHz, like its microphone: at 8 kHz the voice was an octave higher,
// with a gap after every packet
const TALK_SAMPLE_RATE = 16000;

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
    this.eventSnapshot = null;

    this.recording = camera.recording
      ? new RecordingDelegate({ hap, log, camera, ffmpegPath, getSource: () => this.recordingSource() })
      : null;

    this.controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      recording: this.recording
        ? { options: RecordingDelegate.recordingOptions(hap, camera.recordingAnnouncedPrebufferMs), delegate: this.recording }
        : undefined,
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
          twoWayAudio: Boolean(camera.audio && camera.twoWayAudio),
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
          this.log.info(this.prefix(t('streamDetected', { video: codecs.video, audio: codecs.audio || t('none'), mode: t(copy ? 'modeCopy' : (this.camera.sharedStreamName ? 'modeShared' : 'modeTranscode')) })));
          return codecs;
        })
        .finally(() => {
          this.probing = null;
        });
    }
    return this.probing;
  }

  // The recording services exist once the controller is configured on the accessory
  controllerConfigured() {
    if (this.recording) {
      this.recording.attach(this.controller);
    }
  }

  // H.264 stream for the recording prebuffer: the camera stream itself, or else the shared transcoding
  async recordingSource() {
    const codecs = await this.getCodecs();
    if (this.useCopy(codecs)) {
      return this.url;
    }
    return this.camera.sharedStreamName ? this.go2rtc.rtspUrl(this.camera.sharedStreamName) : null;
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

  // The thumbnail the camera took when it detected a movement: the Home app asks for a snapshot right after the
  // notification, 20 to 30 s after the movement, when the scene is often empty again
  setEventSnapshot(buffer) {
    this.eventSnapshot = { buffer, time: Date.now() };
  }

  async getSnapshot(width) {
    if (this.eventSnapshot && Date.now() - this.eventSnapshot.time < EVENT_SNAPSHOT_MS) {
      return this.eventSnapshot.buffer;
    }
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

      // The address tells which device asked (iPhone, iPad...), to find the ones that prepare without starting
      this.log.debug(this.prefix(t('streamPrepared', { address: request.targetAddress })));
      this.pendingSessions.set(request.sessionID, {
        address: request.targetAddress,
        ipv6: request.addressVersion === 'ipv6',
        videoPort: request.video.port,
        videoReturnPort,
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64'),
        videoSSRC,
        audioPort: request.audio.port,
        audioReturnPort,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]).toString('base64'),
        audioSSRC,
        timer: setTimeout(() => {
          if (this.pendingSessions.delete(request.sessionID)) {
            this.log.info(this.prefix(t('streamNeverStarted', { address: request.targetAddress })));
            this.controller.forceStopStreamingSession(request.sessionID);
          }
        }, PREPARE_TIMEOUT_MS),
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
    // go2rtc transcodes once for every viewer: each ffmpeg here then only copies the H.264 and converts the audio
    const shared = !copy && Boolean(this.camera.sharedStreamName);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp', '-i', shared ? this.go2rtc.rtspUrl(this.camera.sharedStreamName) : this.url,
      '-map', '0:v:0',
    ];

    if (copy || shared) {
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
        // AAC-ELD frames are 480 samples (30 ms at 16 kHz): libfdk defaults to 512 and the voice then sounds slow and
        // deep, and it refuses to start with any other length. A home hub on cellular asks for 60 ms packets, which
        // made 960 samples. libfdk ignores -frame_size, the option is -frame_length.
        '-frame_length', String(AAC_ELD_FRAME_LENGTH),
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

    let mode = t('descriptionTranscode', { width: Math.min(width, this.camera.maxWidth || width) });
    if (copy) {
      mode = t('descriptionCopy');
    } else if (shared) {
      mode = t('descriptionShared');
    }
    return { args, withAudio, description: `${mode} ${width}x${height}@${fps} ${bitrate} kbit/s${withAudio ? t('descriptionAudio') : ''}` };
  }

  async startStream(request) {
    const { sessionID } = request;
    const session = this.pendingSessions.get(sessionID);
    if (!session) {
      throw new Error(t('unknownSession'));
    }
    clearTimeout(session.timer);
    this.pendingSessions.delete(sessionID);

    // Registered before the codec probe: a stop arriving meanwhile must not leave an ffmpeg running for nobody
    const active = { child: null, socket: null, timer: null, stopping: false, lastLines: [] };
    this.ongoingSessions.set(sessionID, active);

    let codecs;
    try {
      codecs = await this.getCodecs();
    } catch (err) {
      if (this.camera.videoMode === 'auto') {
        this.ongoingSessions.delete(sessionID);
        throw new Error(t('go2rtcStreamUnreadable', { error: err.message }));
      }
      // The codec is forced: try anyway, without audio
      codecs = { video: null, audio: null };
    }
    if (active.stopping) {
      return;
    }

    const { args, withAudio, description } = this.buildArgs(session, request, codecs);
    this.log.info(this.prefix(t('streamStarting', { description, address: session.address })));
    this.log.debug(this.prefix(`ffmpeg ${args.join(' ')}`));

    const child = spawn(this.ffmpegPath, args);
    const socket = dgram.createSocket(session.ipv6 ? 'udp6' : 'udp4');
    active.child = child;
    active.socket = socket;

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

    if (withAudio && this.camera.twoWayAudio) {
      active.talk = this.startTalk(session, request);
    }

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

  // Two-way audio: HomeKit sends the microphone of the device (SRTP, AAC-ELD 16 kHz) to the audio port given in
  // prepareStream. ffmpeg turns it into A-law 16 kHz, sent to the camera speaker through go2rtc as it comes.
  startTalk(session, request) {
    const ipVersion = session.ipv6 ? 'IP6' : 'IP4';
    const pt = request.audio.pt;
    const sdp = [
      'v=0',
      `o=- 0 0 IN ${ipVersion} ${session.address}`,
      's=Talk',
      `c=IN ${ipVersion} ${session.address}`,
      't=0 0',
      `m=audio ${session.audioReturnPort} RTP/AVP ${pt}`,
      'b=AS:24',
      `a=rtpmap:${pt} MPEG4-GENERIC/16000/1`,
      'a=rtcp-mux',
      `a=fmtp:${pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00`,
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${session.audioSRTP}`,
      '',
    ].join('\r\n');

    const args = [
      // info level: the input stream description tells the sample rate the decoder found
      '-hide_banner', '-loglevel', 'info', '-nostats',
      '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
      '-f', 'sdp', '-c:a', 'libfdk_aac', '-i', 'pipe:0',
      '-f', 'alaw', '-ar', String(TALK_SAMPLE_RATE), '-ac', '1', 'pipe:1',
    ];
    const child = spawn(this.ffmpegPath, args);
    const talk = { child, request: null, failed: false, stopping: false, bytes: 0, windowBytes: 0, timer: null, dump: null };

    child.stdin.on('error', () => {});
    child.stdin.end(sdp);
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) {
          continue;
        }
        // The decoded microphone format, e.g. "Audio: aac (ELD), 16000 Hz, mono": logged without debug mode
        if (/Stream #\d+:\d+.*Audio:/.test(line)) {
          this.log.info(this.prefix(t('talkInput', { line: line.trim() })));
        } else {
          this.log.debug(this.prefix(`[ffmpeg talk] ${line.trim()}`));
        }
      }
    });
    child.on('error', (err) => this.log.debug(this.prefix(`[ffmpeg talk] ${err.message}`)));

    // The device only sends audio while its microphone is on: the speaker is opened on the first sound
    child.stdout.on('data', (chunk) => {
      if (talk.failed || talk.stopping) {
        return;
      }
      if (!talk.request) {
        talk.request = this.go2rtc.openSpeaker(this.camera.streamName);
        talk.request.on('response', (res) => {
          let body = '';
          res.on('data', (data) => {
            body += data;
          });
          res.on('end', () => {
            if (res.statusCode !== 200 && !talk.stopping) {
              talk.failed = true;
              const reason = res.statusCode === 404 && !/stream not found/.test(body) ? t('talkUnsupported') : `${res.statusCode} ${body.trim()}`;
              this.log.warn(this.prefix(t('talkFailed', { error: reason })));
            }
          });
        });
        talk.request.on('error', (err) => {
          if (!talk.stopping) {
            talk.failed = true;
            this.log.warn(this.prefix(t('talkFailed', { error: err.message })));
          }
        });
        this.log.info(this.prefix(t('talkStarted', { address: session.address })));
      }

      if (!talk.timer) {
        // A-law is one byte per sample: less than the sample rate means missing or slowed down audio
        talk.timer = setInterval(() => {
          if (talk.windowBytes) {
            this.log.info(this.prefix(t('talkRate', { rate: Math.round(talk.windowBytes / TALK_RATE_SECONDS), expected: TALK_SAMPLE_RATE })));
          }
          talk.windowBytes = 0;
        }, TALK_RATE_SECONDS * 1000);

        // Diagnostic: XIAOMI_TALK_DUMP saves the decoded microphone audio (raw A-law 16 kHz)
        if (process.env.XIAOMI_TALK_DUMP) {
          const file = path.join(os.tmpdir(), `xiaomi-talk-${Date.now()}.alaw`);
          talk.dump = fs.createWriteStream(file);
          talk.dump.on('error', () => {});
          this.log.info(this.prefix(t('talkDump', { file })));
        }
      }
      talk.bytes += chunk.length;
      talk.windowBytes += chunk.length;
      if (talk.dump) {
        talk.dump.write(chunk);
      }
      talk.request.write(chunk);

      // The device stops sending while its microphone is off, and the camera then seems to close its speaker: the
      // request is ended after a silence, so that the next sound opens the speaker again
      clearTimeout(talk.idleTimer);
      talk.idleTimer = setTimeout(() => {
        if (talk.request) {
          talk.request.end();
          talk.request = null;
        }
      }, TALK_IDLE_MS);
    });

    return talk;
  }

  stopTalk(talk) {
    talk.stopping = true;
    clearInterval(talk.timer);
    clearTimeout(talk.idleTimer);
    if (talk.dump) {
      talk.dump.end();
    }
    talk.child.kill('SIGKILL');
    if (talk.request) {
      talk.request.end();
    }
  }

  stopStream(sessionID) {
    const pending = this.pendingSessions.get(sessionID);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSessions.delete(sessionID);
    }
    const active = this.ongoingSessions.get(sessionID);
    if (!active) {
      return;
    }
    this.ongoingSessions.delete(sessionID);

    active.stopping = true;
    clearTimeout(active.timer);
    // Stopped while the stream was still starting: nothing was launched yet
    if (!active.child) {
      return;
    }
    try {
      active.socket.close();
    } catch {
      // Already closed
    }
    if (active.talk) {
      this.stopTalk(active.talk);
    }
    const { child } = active;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 2000);
    this.log.info(this.prefix(t('streamStopped')));
  }

  shutdown() {
    if (this.recording) {
      this.recording.shutdown();
    }
    for (const session of this.pendingSessions.values()) {
      clearTimeout(session.timer);
    }
    this.pendingSessions.clear();
    for (const sessionID of [...this.ongoingSessions.keys()]) {
      this.stopStream(sessionID);
    }
  }
}

module.exports = { StreamingDelegate };

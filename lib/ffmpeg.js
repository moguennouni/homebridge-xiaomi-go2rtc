'use strict';

const { spawn } = require('node:child_process');
const { t } = require('./i18n');

const resolveFfmpegPath = (configuredPath) => {
  if (configuredPath) {
    return configuredPath;
  }
  try {
    const bundled = require('ffmpeg-for-homebridge');
    if (bundled) {
      return bundled;
    }
  } catch {
    // Optional: fall back to the system ffmpeg
  }
  return 'ffmpeg';
};

const run = (ffmpegPath, args, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, args);
  const stdout = [];
  let stderr = '';

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(t('ffmpegTimeout', { seconds: timeoutMs / 1000 })));
  }, timeoutMs);

  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout), stderr });
  });
});

// Reads the codecs announced by the RTSP stream ("ffmpeg -i" prints them, then exits without output file)
const probe = async (ffmpegPath, url, timeoutMs = 30000) => {
  const { stderr } = await run(ffmpegPath, ['-hide_banner', '-rtsp_transport', 'tcp', '-i', url], timeoutMs);

  const video = stderr.match(/Stream #\d+:\d+.*?: Video: (\w+)/);
  const audio = stderr.match(/Stream #\d+:\d+.*?: Audio: (\w+)/);
  if (!video) {
    const lastLine = stderr.trim().split('\n').pop();
    throw new Error(t('noVideoTrack', { line: lastLine }));
  }

  return { video: video[1], audio: audio ? audio[1] : null };
};

const snapshot = async (ffmpegPath, url, width, timeoutMs = 15000) => {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-i', url,
    '-frames:v', '1',
    '-vf', `scale=${width}:-2`,
    '-f', 'image2', '-c:v', 'mjpeg',
    'pipe:1',
  ];
  const { code, stdout, stderr } = await run(ffmpegPath, args, timeoutMs);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(t('snapshotError', { line: stderr.trim().split('\n').pop() || `code ${code}` }));
  }
  return stdout;
};

module.exports = { resolveFfmpegPath, probe, snapshot };

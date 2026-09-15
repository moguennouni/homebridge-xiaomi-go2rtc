# Changelog

## 0.9.0

- **Shared transcoding** (`sharedTranscode`, on by default): an H.265 camera is transcoded to H.264 once by go2rtc,
  for every device watching, instead of once per device. Each additional viewer now only copies the video and
  converts the audio, which saves most of the CPU and memory on small boards. The shared stream uses H.264 at
  600 kbit/s with a key frame every 2 s; `maxWidth` and the bitrate requested by the Home app do not apply to it.
  Set `"sharedTranscode": false` to go back to one transcoding per viewer.
  Measured on an Orange Pi One with two devices watching: one transcoding at about 50% CPU plus 8% per viewer,
  instead of one full transcoding per viewer, and about twice as much free memory. A second device, or a
  notification opened while another device watches, also starts faster.
- **HomeKit Secure Video recording** (`recording`, experimental, off by default): a permanent ffmpeg copies the
  camera H.264 (the shared transcoding for an H.265 camera) into fragmented MP4 and keeps the last 4 seconds; the
  home hub receives them followed by the recording when the motion sensor fires. Needs a home hub, iCloud+ and the
  motion sensor. `recordingPrebuffer` (4 to 30 s) sets how much video before the trigger starts each clip, so that
  the late cloud motion trigger still shows the movement; `recordingPrebufferAnnounced` lowers the value announced
  to the home hub if it refuses a long prebuffer, the plugin sending the seconds kept anyway.
- **Recovery after a lost camera connection**: when go2rtc reports that it lost a camera, the plugin restarts
  go2rtc (at most every 5 minutes). go2rtc reconnects a camera on its own, but the shared transcoding then starts over
  under the running readers: the recording prebuffer kept the previous initialization segment (the home hub
  cancelled every clip) and the live view stopped after a few seconds, until Homebridge was restarted.
- go2rtc-xiaomi-control: audio sent to the camera was empty. go2rtc 1.9.14 copied the packet header a second time
  instead of the audio (`cs2` `WritePacket`), so the speaker only crackled.
- **Two-way audio** (`twoWayAudio`, experimental, off by default): the microphone button of the Home app live view
  plays the voice on the camera speaker. The tested camera sometimes closes its connection a few seconds after
  receiving audio (then recovered by the go2rtc restart above). The plugin decodes the device microphone (AAC-ELD) into A-law 8 kHz and sends it to
  go2rtc-xiaomi-control, which gains `POST /api/xiaomi/speaker` (the audio body goes to the speaker of the playing
  stream, 40 ms packets).
- Fix: no stream at all away from home (cellular through a home hub) when audio was on. The hub asks for 60 ms audio
  packets, which set AAC-ELD frames to 960 samples, a length the encoder refuses: frames are now always 480 samples.

- Fix: the pan/tilt switches moved the camera the opposite way (up went down, left went right). Default commands
  are now `{"operation":1}` left, `2` right, `3` up, `4` down. A `ptzLeft`/`ptzRight`/`ptzUp`/`ptzDown` set by hand
  to work around it must be removed.

## 0.8.1

- Fix: "another user is watching" when a second device opened the camera, typically from a motion notification,
  while only one stream was running. HomeKit reserves a stream slot as soon as a stream is prepared, and
  HAP-NodeJS never frees one that the Home app prepares without starting it. The plugin now frees such a slot after
  10 s.
- The logs name the device address of each stream (`Starting the stream for 192.168.1.14`), and of each prepared
  stream in debug mode, to tell which device prepares streams without starting them.
- Fix: a stream stopped by the Home app while it was still starting could leave an FFmpeg transcoding for nobody.

## 0.8.0

- **The notification shows the movement**: with the cloud motion source, the notification snapshot is now the
  thumbnail the camera took with the event, instead of a live snapshot taken 20 to 30 s later, when the scene is
  often empty again. It also spares a H.265 decoding by FFmpeg for each notification. When the thumbnail cannot be
  read, the notification falls back to a live snapshot.
- go2rtc-xiaomi-control: event thumbnail (`/api/xiaomi/image`), downloaded from the Xiaomi cloud and decrypted
  (AES-128-CBC).

## 0.7.1

- Cloud motion source: each detection is now written to the log (type of event and delay), not only in debug mode.
  Without it, a working sensor left no trace.

## 0.7.0

- **Motion sensor source** (`motionSource`): `cloud`, the new default, reads the events of the camera from the
  Xiaomi cloud (what Mi Home lists), every `motionInterval` seconds (10 by default, 5 minimum). Reliable, 20 to 30 s
  late, and `"motionTypes": "people"` keeps people only. `camera` is the 0.6.0 behaviour: immediate, but every turn
  of the motion tracking raises a movement.
  **Upgrading from 0.6.0:** a camera with `"motion": true` switches to the cloud source; set
  `"motionSource": "camera"` to keep the previous one.
- Hide the motion sensor settings in the Homebridge UI until the sensor is enabled.

## 0.6.0

- **Motion sensor** (`motion`), fed by the camera itself, in real time and without the cloud: when its motion
  tracking turns to follow a movement, the camera reports it and the plugin raises a HomeKit motion event. Needs
  "motion tracking" enabled on the camera; `motionDuration` sets how long the sensor stays on (15 s by default).
  The plugin keeps a light connection to the camera, without video, and reuses the video connection when there is
  one.
- go2rtc-xiaomi-control: motion event stream (`/api/xiaomi/motion`), read-only list of the Xiaomi cloud events
  (`/api/xiaomi/events`, encrypted GET requests), diagnostic listener (`/api/xiaomi/watch`), and a guard against a
  crash when the camera sends data on a channel go2rtc does not use.
- Fix: the MIoT specification could not be cached when its folder was missing, which silently removed the settings
  switches.

## 0.5.0

- English by default: log messages, switch names and the Homebridge UI settings screen. Logs and switch names are
  in French when the system language is French, or with the new `language` option (`auto`, `en`, `fr`).
  **Upgrading from 0.4.x:** if your system is not in French, the switches are renamed in English (Left, Standby...);
  set `language` to `fr` to keep the French names. Names you changed yourself in the Home app are kept.
- Bug report and camera report forms on GitHub.

## 0.4.1

- go2rtc-xiaomi-control binaries are built with an empty Go build ID, so rebuilding them on any system (Linux,
  macOS, Windows) with the same Go version gives the same SHA-256 digests as the release. In 0.4.0, only the build
  ID differed between systems; the compiled code was already identical.

## 0.4.0

First public release.

- Xiaomi Mi Home cameras in HomeKit through a go2rtc instance managed by the plugin.
- go2rtc-xiaomi-control, an unofficial build of go2rtc 1.9.14 with a public patch, built by GitHub Actions for Linux
  (armv6, armv7, arm64, x86, x64), macOS and Windows, downloaded by the plugin and checked by SHA-256. The official
  go2rtc 1.9.14 remains available with `useOfficialGo2rtc`.
- Automatic camera discovery, and manual declaration (did + IP + region) for cameras missing from the Xiaomi
  cloud device list (e.g. MJSXJ10CM).
- H.264 copied as is, H.265 transcoded to H.264; camera quality (`subtype`) and maximum width settings.
- Audio (AAC-ELD, 480-sample frames as expected by HomeKit). 16 kHz A-law cameras are detected by
  go2rtc-xiaomi-control; `audioSampleRate` fixes them with the official go2rtc.
- Pan/tilt switches and camera settings switches (standby, indicator light, motion tracking, motion detection,
  night vision), grouped with the camera in the Home app.
- `scripts/find-xiaomi-camera.sh` finds the did, IP and region of a camera; `scripts/build-go2rtc.sh` rebuilds
  go2rtc-xiaomi-control from the official sources.

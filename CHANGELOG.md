# Changelog

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

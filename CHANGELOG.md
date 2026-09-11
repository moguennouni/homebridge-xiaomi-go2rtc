# Changelog

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

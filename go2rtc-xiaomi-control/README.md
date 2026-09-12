# go2rtc-xiaomi-control

**Unofficial** modified build of [go2rtc](https://github.com/AlexxIT/go2rtc) 1.9.14, used by
homebridge-xiaomi-go2rtc for the optional features that the official go2rtc does not provide.

> This build is not made, endorsed or supported by the go2rtc author (Alexey Khit). Please report its issues to
> this repository, never to the go2rtc project. go2rtc is MIT licensed, Copyright (c) 2022 Alexey Khit: see
> [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Changes compared to go2rtc 1.9.14

The complete and only list of changes is [`go2rtc-xiaomi-control.patch`](go2rtc-xiaomi-control.patch) (about 230
lines). It adds:

| Change | Why |
|---|---|
| `POST /api/xiaomi/command?src=<stream>&cmd=<id>&data=<payload>` | Sends a MISS command to the Xiaomi camera of a **playing** stream and returns its reply. Used for pan/tilt (command `0x112`). |
| Reading of camera command replies | The command channel has a 10-message buffer: unread replies would fill it and close the video connection. |
| `GET /api/xiaomi/miot?src=<stream>&props=<siid>.<piid>,...` and `POST /api/xiaomi/miot?src=<stream>&siid=&piid=&value=` | Reads and writes MIoT properties (standby, indicator light...) of the camera behind the stream, through the Xiaomi cloud, with the account already connected in go2rtc. Only the device of the stream can be reached. |
| `GET /api/xiaomi/motion?src=<stream>` | Server-Sent Events of what the camera says. A camera with motion tracking enabled reports a motor message when it turns to follow a movement: this is the only real-time motion signal it gives, and it works without any video. Reuses the connection of a playing stream when there is one. |
| `GET /api/xiaomi/events?src=<stream>&minutes=&limit=` | The events the camera uploaded to the Xiaomi cloud, the list Mi Home shows (type, time, clip id). Read only. Needs encrypted GET requests, which go2rtc did not implement. |
| `GET /api/xiaomi/image?src=<stream>&fileId=&stoId=` | The thumbnail the camera took with an event (`fileId` and `imgStoreId` of the event list), as a JPEG. The Xiaomi cloud sends it encrypted with AES-128-CBC (account `ssecurity` as key, random IV sent with the request); go2rtc decrypts it. Lets a notification show the movement instead of a snapshot taken 20 to 30 s later. |
| `GET /api/xiaomi/watch?src=<stream>&seconds=` | Diagnostic: opens a connection without video and returns everything the camera sends during that time. |
| Guard on the unused channels | The connection uses channels 0 and 2; data on any other channel dereferenced a nil pointer, which crashed go2rtc. It is now reported instead. |
| A-law sample rate measured from the first packets | Some cameras (e.g. `chuangmi.camera.026c02`) send 16 kHz A-law, which go2rtc labels 8 kHz: the audio then plays at half speed, an octave lower. |
| Version `1.9.14-xiaomi-control` | Makes the modified build recognizable in the web UI and logs. go2rtc itself appends `+dev.b5948cf.dirty`: built from go2rtc commit `b5948cf` (tag v1.9.14), with local modifications (the patch). |

These endpoints follow go2rtc's API authentication: from the local network they need the `api` username and
password, requests from the server itself (127.0.0.1) do not, as for every go2rtc endpoint.

## How it is distributed

For each release of the plugin, the [release workflow](../.github/workflows/release.yml) builds this patched go2rtc
for Linux (armv6, armv7, arm64, x86, x64), macOS (Intel, Apple Silicon) and Windows (x64), attaches the binaries,
`SHA256SUMS` and go2rtc's license to the GitHub release, and writes the digests into the npm package
(`lib/go2rtc-binaries.json`). The plugin downloads the binary of its platform and version, and refuses it if the
digest differs. Nothing has to be installed by hand.

## Build it yourself

Requirements: `git`, [Go](https://go.dev/dl/) 1.24 or later, a Linux or macOS shell (or Git Bash on Windows).

```bash
bash scripts/build-go2rtc.sh
```

The script downloads the official go2rtc v1.9.14 sources, applies the patch, builds every binary in
`go2rtc-xiaomi-control/dist/` and prints their SHA-256 digests. With the same Go version as the release build logs,
the digests are the same as the published ones (Go builds are reproducible).

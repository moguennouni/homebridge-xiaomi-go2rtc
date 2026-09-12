# homebridge-xiaomi-go2rtc

[![npm](https://img.shields.io/npm/v/homebridge-xiaomi-go2rtc)](https://www.npmjs.com/package/homebridge-xiaomi-go2rtc)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-xiaomi-go2rtc)](https://www.npmjs.com/package/homebridge-xiaomi-go2rtc)
[![CI](https://github.com/moguennouni/homebridge-xiaomi-go2rtc/actions/workflows/ci.yml/badge.svg)](https://github.com/moguennouni/homebridge-xiaomi-go2rtc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Version française](README.fr.md)

Homebridge plugin that brings **Xiaomi Mi Home cameras to Apple Home (HomeKit)**: live video, snapshots, audio,
pan/tilt and camera settings.

Xiaomi cameras do not provide RTSP: they stream through Xiaomi's encrypted P2P protocol. The plugin runs and
manages [go2rtc](https://github.com/AlexxIT/go2rtc), which speaks this protocol, and exposes each camera as a
HomeKit camera.

> **Not affiliated with Xiaomi, Apple, Homebridge or go2rtc.** See [Disclaimer](#disclaimer).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connect your Xiaomi account](#connect-your-xiaomi-account)
- [Declare a camera that is not discovered](#declare-a-camera-that-is-not-discovered)
- [Add the camera to the Home app](#add-the-camera-to-the-home-app)
- [Video performance](#video-performance)
- [Audio](#audio)
- [Motion sensor](#motion-sensor)
- [Pan/tilt and camera settings](#pantilt-and-camera-settings)
- [About go2rtc-xiaomi-control](#about-go2rtc-xiaomi-control)
- [Configuration reference](#configuration-reference)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Update and uninstall](#update-and-uninstall)
- [Disclaimer](#disclaimer)
- [Credits and license](#credits-and-license)

## Features

- Live video and snapshots in the Home app, for each camera of your Xiaomi account.
- Automatic discovery of cameras, or manual declaration for cameras the Xiaomi cloud does not list.
- H.264 cameras are copied as is (almost no CPU); H.265 cameras are transcoded to H.264, the only codec HomeKit
  accepts.
- Audio from the camera microphone.
- A motion sensor fed by the camera itself, in real time, without the cloud.
- Pan/tilt switches and camera settings switches (standby, indicator light, motion tracking, motion detection,
  night vision), grouped with the camera.
- Nothing else to install: the plugin downloads and checks the go2rtc build it needs.

Tested with: Orange Pi One (Allwinner H3, armv7, 512 MB RAM, Armbian), Node.js 22, camera **MJSXJ10CM**
(Mi 360° Camera 1080p, model `chuangmi.camera.026c02`, H.265), transcoded in real time in SD quality.

## How it works

```
Xiaomi camera ──(local network, encrypted P2P)──► go2rtc ──(RTSP, 127.0.0.1 only)──► FFmpeg ──(SRTP)──► iPhone / iPad
                          ▲
       encryption keys requested from the Xiaomi cloud at each connection
```

- The video goes from the camera to your server **on your local network**, then to your Apple devices.
- go2rtc needs Internet access at each connection to get the encryption keys from the Xiaomi cloud, with your
  account.
- go2rtc connects to a camera only while someone watches it or a snapshot is requested.
- The go2rtc build used by default is [go2rtc-xiaomi-control](#about-go2rtc-xiaomi-control): the official go2rtc
  plus a small public patch, built by GitHub Actions for each release of this plugin.

## Requirements

- **Homebridge** 1.8 or later, with **Node.js 22** or later (`node -v`).
- A supported server:

  | System | Architectures | Status |
  |---|---|---|
  | Linux (Raspberry Pi, Orange Pi, mini PC, NAS, Docker) | armv6, armv7, arm64, x86, x64 | Tested on armv7 |
  | macOS | Intel, Apple Silicon | Should work, not tested yet |
  | Windows | x64 | Should work, not tested yet |

  The Raspberry Pi 5 is not supported yet by ffmpeg-for-homebridge: install FFmpeg yourself and set `ffmpegPath`.
- A **Xiaomi account with a password**. go2rtc cannot use "Sign in with Google / Apple / Facebook": see
  [Connect your Xiaomi account](#connect-your-xiaomi-account).
- Mostly cameras released after 2020 (go2rtc's `xiaomi/miss` protocol). See go2rtc's
  [list of known cameras](https://github.com/AlexxIT/go2rtc/issues/1982).
- For H.265 cameras, enough CPU to transcode, or the SD quality of the camera (see
  [Video performance](#video-performance)).

## Installation

### 1. Install the plugin

**From Homebridge UI (recommended):** **Plugins** tab → search for `homebridge-xiaomi-go2rtc` → **Install**.

**From a terminal**, with the npm of your Homebridge installation. To find it, run on the server:

```bash
ps -eo user,args | grep [h]omebridge
```

Then use the command matching what you see.

**Official image or apt package**: user `homebridge`, paths under `/opt/homebridge` or `/var/lib/homebridge`.

```bash
sudo -u homebridge /opt/homebridge/bin/npm install --prefix /var/lib/homebridge homebridge-xiaomi-go2rtc
```

**Global npm install**: `homebridge` started from `/usr/lib/node_modules` or `/usr/local/lib/node_modules`.

```bash
sudo npm install -g homebridge-xiaomi-go2rtc
```

**Docker** (`homebridge/homebridge` image): in Homebridge UI → menu (⋮) → **Terminal**, run:

```bash
npm install homebridge-xiaomi-go2rtc
```

The package of each version is also attached to the
[GitHub releases](https://github.com/moguennouni/homebridge-xiaomi-go2rtc/releases): replace
`homebridge-xiaomi-go2rtc` with the URL of its `.tgz` file in the commands above.

The installation also downloads [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge),
which can take a few minutes on a small board.

### 2. Minimal configuration

In Homebridge UI → **Plugins** → **Xiaomi Cameras (go2rtc)** → **Settings**, or in `config.json`:

```json
{
  "platform": "XiaomiGo2rtc",
  "name": "Xiaomi Cameras",
  "uiUsername": "admin",
  "uiPassword": "choose-a-password"
}
```

Set **`uiUsername` and `uiPassword`**: without them, every device of your local network can open the go2rtc web
UI and watch your cameras.

Do **not** enable "child bridge" on small boards (512 MB RAM): it starts one more Node.js process. Cameras are
separate HomeKit accessories anyway.

### 3. Restart Homebridge

On first start, the plugin downloads go2rtc-xiaomi-control for your system from the GitHub release of its version,
and checks its SHA-256 digest (written in the plugin itself). The log then shows:

```
Downloading go2rtc-xiaomi-control 1.9.14-xiaomi-control...
go2rtc-xiaomi-control 1.9.14-xiaomi-control downloaded and checked.
go2rtc-xiaomi-control started. Web UI: http://192.168.1.10:1984
No Xiaomi account connected. Open http://192.168.1.10:1984, click "Add" then "Xiaomi"...
```

Logs and switch names follow the system language (English or French); force it with the `language` option.

## Connect your Xiaomi account

This is done once, in the go2rtc web UI, and not in the plugin configuration: your Xiaomi password is never
stored by the plugin.

1. If you usually sign in to Mi Home with **Google, Apple or Facebook**, first add a password to your Xiaomi
   account: go to [account.xiaomi.com](https://account.xiaomi.com), sign in as usual, note your **Xiaomi ID** (the
   number shown on the account page and in Mi Home → Profile), then **Security** → **Password**. Xiaomi may ask
   you to link and verify an e-mail address or a phone number first. Your usual sign-in keeps working.
2. Open the go2rtc web UI (`http://<server-ip>:1984`), with `uiUsername` / `uiPassword`.
3. Click **Add**, then **Xiaomi**. Enter your Xiaomi ID (or e-mail / phone) and password, then the code received
   by e-mail or SMS, and the captcha if one is shown.
4. Within 30 seconds, the Homebridge log shows each discovered camera:

   ```
   Camera added: "Living room" (chuangmi.camera.026c02, 192.168.1.50, did 123456789).
   ```

go2rtc stores a token (not your password) in `xiaomi-go2rtc/go2rtc.yaml`, in the Homebridge storage folder
(e.g. `/var/lib/homebridge`). The file is readable only by the user running Homebridge.

## Declare a camera that is not discovered

Some cameras, such as the **MJSXJ10CM**, work in Mi Home but are missing from the device list the Xiaomi cloud
returns to third-party tools. go2rtc then answers "no sources" in every region, and the log shows
`No camera found automatically`. They can still be used if you give their **IP address**, **did** (device
id) and **region**.

### Find the did, IP and region automatically

On the Homebridge server (Linux or macOS), with the Xiaomi account connected in go2rtc:

```bash
curl -fsSL -o /tmp/find-xiaomi-camera.sh https://raw.githubusercontent.com/moguennouni/homebridge-xiaomi-go2rtc/main/scripts/find-xiaomi-camera.sh
```

```bash
bash /tmp/find-xiaomi-camera.sh
```

The script lists the Xiaomi devices of your network, then tries each one in each Xiaomi cloud region (it takes a
minute or two). Keep the line marked `OK`:

```
no      ip=192.168.1.50 did=123456789 region=de  (streams: xiaomi: permit deny)
OK      ip=192.168.1.50 did=123456789 region=sg  <-- declare this camera with these values
```

`permit deny` means that the Xiaomi cloud refuses this device for this region: this is expected for every region
except yours. If your camera does not appear at all, pass its IP (shown in Mi Home → camera → settings → network
information) as second argument: `bash /tmp/find-xiaomi-camera.sh 1984 192.168.1.50`.

About regions: Mi Home asks for a **country**, go2rtc needs the **Xiaomi server** of that country: `de` (Europe),
`sg` (Singapore, also used for many other countries), `us`, `ru`, `i2` (India), `cn` (mainland China). The script
finds it for you.

### Declare the camera

In the plugin settings → **Camera settings** → add a camera, or in `config.json`:

```json
"cameras": [
  {
    "did": "123456789",
    "ip": "192.168.1.50",
    "region": "sg",
    "model": "chuangmi.camera.026c02",
    "name": "Living room"
  }
]
```

`model` is optional for the video, but required for the camera settings switches. Mi Home usually shows it, with
the did, in the camera settings → device information (the menu name depends on the camera). The MJSXJ10CM is
`chuangmi.camera.026c02`.

Give the camera a **fixed IP address** (DHCP reservation in your router): a declared camera is not followed if its
IP changes.

## Add the camera to the Home app

Each camera is a separate accessory, not part of the Homebridge bridge:

1. Home app → **+** → **Add Accessory** → **More options...**
2. Choose the camera.
3. Enter the **Homebridge PIN** (the same as the bridge).

The first time you open the live view, allow 5 to 10 seconds: go2rtc gets the keys from the Xiaomi cloud and opens
the P2P connection.

## Video performance

HomeKit only accepts **H.264** video. The log shows what the camera sends:

```
[Living room] Stream detected: video hevc, audio pcm_alaw → transcoded to H.264.
```

- **`h264`**: copied as is, fine on any server.
- **`hevc`** (H.265): decoded and re-encoded by FFmpeg, which is CPU intensive. On small boards, request the SD
  stream of the camera: `"subtype": "sd"`.

To measure whether your server keeps up, close the Home app and run on the server (adjust the stream name,
`xiaomi_<did>`; this example is for a global npm install):

```bash
F=$(npm root -g)/homebridge-xiaomi-go2rtc/node_modules/ffmpeg-for-homebridge/ffmpeg; [ -x "$F" ] || F=ffmpeg; "$F" -hide_banner -rtsp_transport tcp -i rtsp://127.0.0.1:8554/xiaomi_123456789 -t 30 -map 0:v:0 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -vf "scale='min(1280,iw)':-2:flags=fast_bilinear" -b:v 800k -f null - 2>&1 | tr '\r' '\n' | grep -E "Video: |speed=" | sed -n '1p;$p'
```

A final `speed=` of **1.0x or more** means real time. For reference, an Orange Pi One reaches 0.85x in HD
(1920x1080) and 1.03x in SD (640x360).

## Audio

Enable it per camera with `"audio": true`. Audio is converted to AAC-ELD for HomeKit.

Some cameras (e.g. `chuangmi.camera.026c02`) send 16 kHz audio, which the official go2rtc labels as 8 kHz: the voice
then sounds slow and deep. go2rtc-xiaomi-control, used by default, measures the real rate and fixes it. Only if
you use the official go2rtc (`useOfficialGo2rtc`), set `"audioSampleRate": 16000` on such a camera.

## Motion sensor

`"motion": true` adds a HomeKit motion sensor to the camera, fed by the camera itself, in real time and without
the cloud: when its motion tracking turns to follow a movement, it reports it, and the plugin turns that into a
motion event. You then get notifications in the Home app and can trigger automations.

- **"Motion tracking" must be enabled on the camera** (the `Motion tracking` switch, or Mi Home): it is by turning
  to follow that the camera reports a movement.
- The sensor stays on for `motionDuration` seconds (15 by default) after the last report.
- The plugin keeps a light connection to the camera: no video, no decoding, a few bytes now and then. It reuses
  the video connection while you are watching.
- The motion events of the Xiaomi cloud (what Mi Home lists, with `PeopleMotion` / `ObjectMotion` types) are **not**
  used: measured on a MJSXJ10CM, they arrive 20 to 60 s late, and at most one every 3 minutes, the alarm interval
  of the camera. `GET /api/xiaomi/events` of go2rtc-xiaomi-control reads them if you want to experiment.

## Pan/tilt and camera settings

- **Pan/tilt** (`"ptz": true`): four switches, Left / Right / Up / Down. They only
  work **while the live view is open**, because the command goes through the video connection.
- **Settings** (`"settings": true`): Standby, Status light, Motion tracking, Motion detection, Night vision (auto or
  off), depending on
  what the model exposes. The plugin finds them in the public MIoT specification of the model (miot-spec.org), so
  `model` must be known (automatic for discovered cameras). They go through the Xiaomi cloud and are read again
  every minute, to follow changes made in Mi Home.

### Directions and step size

The directions were checked on `chuangmi.camera.026c02`, where one horizontal step is small (about 3 units) and one
vertical step larger (about 9). Increase `ptzPanSteps` / `ptzTiltSteps` to move more per press. On another model,
if a direction is wrong, change `ptzLeft`, `ptzRight`, `ptzUp`, `ptzDown` (defaults: `{"operation":2}`,
`{"operation":1}`, `{"operation":4}`, `{"operation":3}`). To test a command by hand while the live view is open:

```bash
curl -s -X POST -G http://127.0.0.1:1984/api/xiaomi/command --data-urlencode src=xiaomi_123456789 --data-urlencode cmd=0x112 --data-urlencode 'data={"operation":1}'
```

The reply contains `"ret":0` when the camera accepted the command, and the motor position.

### Grouping in the Home app

All switches are linked to the camera service. If the Home app shows them as separate tiles: long press the camera →
⚙️ → turn off **Show as Separate Tiles** if available, or put the camera and its switches in the same room. The Home
app does not allow custom buttons inside the full-screen live view.

## About go2rtc-xiaomi-control

The official go2rtc cannot move the camera, change its settings, or detect 16 kHz audio. go2rtc-xiaomi-control is
an **unofficial** build of go2rtc 1.9.14 with a small public [patch](go2rtc-xiaomi-control/go2rtc-xiaomi-control.patch)
(about 230 lines, described in [go2rtc-xiaomi-control/README.md](go2rtc-xiaomi-control/README.md)).

- It is built by GitHub Actions from the official go2rtc sources and the patch, for each release of this plugin
  ([workflow](.github/workflows/release.yml), public build logs).
- The plugin downloads the binary of its own version and refuses it if its SHA-256 digest differs from the one
  written in the plugin.
- Builds are reproducible: `bash scripts/build-go2rtc.sh` rebuilds the same binaries.
- Its version reads `1.9.14-xiaomi-control+dev.b5948cf.dirty`: go2rtc commit `b5948cf` (tag v1.9.14) with local
  modifications.
- It is not made or supported by the go2rtc author: report its issues here, never to the go2rtc project.

To use another go2rtc instead: `useOfficialGo2rtc` downloads the official go2rtc 1.9.14 (Linux only, without pan/tilt,
settings or the audio fix), and `go2rtcPath` runs a go2rtc binary you installed yourself.

## Configuration reference

### General settings

| Key | Default | Description |
|---|---|---|
| `platform` | | Must be `XiaomiGo2rtc` |
| `name` | `Xiaomi Cameras` | Name of the platform in the logs |
| `language` | `auto` | Language of the logs and switch names: `auto` (system language), `en`, `fr` |
| `uiUsername`, `uiPassword` | none | Login of the go2rtc web UI from the local network. **Strongly recommended.** |
| `region` | automatic | Xiaomi server of your account (`de`, `sg`, `us`, `ru`, `i2`, `cn`). Speeds up discovery; also the default region of declared cameras |
| `apiPort` | `1984` | Port of the go2rtc web UI and API |
| `rtspPort` | `8554` | Local RTSP port of go2rtc (listens on 127.0.0.1 only) |
| `useOfficialGo2rtc` | `false` | Advanced: download the official go2rtc 1.9.14 instead of go2rtc-xiaomi-control |
| `go2rtcPath` | | Advanced: path of a go2rtc binary to run instead of the downloaded one |
| `ffmpegPath` | ffmpeg-for-homebridge | Path of another FFmpeg |
| `cameras` | `[]` | Per camera settings, see below |

### Camera settings (`cameras[]`)

| Key | Default | Description |
|---|---|---|
| `did` | **required** | Xiaomi device id, shown in the log when a camera is discovered |
| `name` | Mi Home name | Name in HomeKit |
| `hidden` | `false` | `true` to not expose this camera |
| `ip` | | IP address: declares the camera manually (cameras that are not discovered) |
| `region` | general `region`, else `de` | Xiaomi server of a declared camera |
| `model` | | Xiaomi model, e.g. `chuangmi.camera.026c02`. Required for `settings` on a declared camera |
| `account` | first account | Xiaomi account id, when several accounts are connected in go2rtc |
| `subtype` | camera default | Quality requested from the camera: `hd`, `sd` |
| `videoMode` | `auto` | `auto` (copy H.264, transcode otherwise), `copy`, `transcode` |
| `encoder` | `libx264` | H.264 encoder when transcoding, e.g. `h264_v4l2m2m` (hardware, board dependent) |
| `maxWidth` | `1280` | Maximum width when transcoding |
| `audio` | `false` | Audio from the camera |
| `audioSampleRate` | `0` | `16000` fixes slow, deep audio, with the **official** go2rtc only |
| `motion` | `false` | Motion sensor, needs motion tracking enabled on the camera |
| `motionDuration` | `15` | How long the motion sensor stays on, in seconds |
| `settings` | `false` | Settings switches |
| `ptz` | `false` | Pan/tilt switches |
| `ptzPanSteps`, `ptzTiltSteps` | `1` | Motor steps per press, horizontal and vertical |
| `ptzLeft`, `ptzRight`, `ptzUp`, `ptzDown` | see above | Advanced: payload of the pan/tilt command |

A complete example is in [config.example.json](config.example.json).

## Security and privacy

| Port | Listens on | Purpose |
|---|---|---|
| 1984 (`apiPort`) | local network | go2rtc web UI and API, protected by `uiUsername` / `uiPassword` |
| 8554 (`rtspPort`) | 127.0.0.1 only | Streams read by FFmpeg |
| 8555 | local network | go2rtc WebRTC (web UI preview) |

- Do not forward these ports on your router.
- The Xiaomi account token is stored in `xiaomi-go2rtc/go2rtc.yaml` (mode 600). Your password is not stored.
- What goes to the Internet: go2rtc contacts the Xiaomi cloud (login, device list, encryption keys, camera
  settings); the plugin downloads go2rtc from GitHub and MIoT specifications from miot-spec.org. The video itself
  stays on your local network. When you watch away from home, HomeKit relays it end-to-end encrypted through your
  home hub.

## Troubleshooting

Run Homebridge in debug mode (`-D`, in Homebridge UI → Homebridge Settings) to see the go2rtc and FFmpeg
messages.

| Symptom | Cause | Fix |
|---|---|---|
| "no sources" in every region in go2rtc, `No camera found automatically` | The Xiaomi cloud does not list this camera | [Declare it](#declare-a-camera-that-is-not-discovered) |
| `streams: xiaomi: permit deny` | Wrong region (or wrong did) for this account | Run `find-xiaomi-camera.sh` |
| `Cannot take a snapshot ... 404 Not Found` | go2rtc cannot open the stream | Look at the go2rtc line just before |
| `Cannot download go2rtc-xiaomi-control` | No Internet access, or GitHub unreachable, at first start | Check the connection, restart Homebridge |
| `Invalid SHA-256 digest` | The downloaded file is not the expected one | Retry; if it persists, open an issue (never bypass this check) |
| Choppy or late video, 100 % CPU | H.265 transcoding too heavy | `"subtype": "sd"`, lower `maxWidth` |
| Slow, deep voice | 16 kHz camera audio labelled 8 kHz | Use the default go2rtc-xiaomi-control, or `"audioSampleRate": 16000` with the official go2rtc |
| `This go2rtc does not support pan/tilt` / `settings` | The official or a custom go2rtc is running | Remove `go2rtcPath` and `useOfficialGo2rtc` |
| `Open the camera in the Home app to move it` | Pan/tilt used while the live view is closed | Open the live view first |
| `Model "..." unknown to miot-spec.org` | Missing or wrong `model` | Set `model` |
| `cannot change it (refused by the Xiaomi cloud (code ...))` | This model does not accept this setting through the cloud | Change it in Mi Home instead |
| `sudo: unknown user homebridge` while installing | Homebridge is not installed with the official image | Use the command matching your installation |

Also check the stream in the go2rtc web UI (Streams tab): if it does not play there, the problem is between go2rtc
and the camera, not HomeKit.

## Update and uninstall

- **Update**: from Homebridge UI (Plugins → Update), or with the installation command. At the next start, the
  plugin downloads the go2rtc-xiaomi-control of the new version and removes the previous one. Your configuration and
  Xiaomi connection are kept.
- **Uninstall**: remove the platform from the configuration, uninstall the plugin (Homebridge UI, or
  `npm uninstall` instead of `npm install` in the installation command), then delete the `xiaomi-go2rtc` folder in
  the Homebridge storage folder: it contains the Xiaomi account token and go2rtc. Remove the cameras from the Home
  app.

## Disclaimer

- This project is **not affiliated with, endorsed by or sponsored by** Xiaomi, Apple, the Homebridge project or the
  go2rtc author. Xiaomi, Mi Home, Apple, HomeKit and other names are trademarks of their respective owners and are
  only used to describe compatibility.
- **go2rtc-xiaomi-control is not an official go2rtc build.** Report its issues here, not to the go2rtc project.
- The plugin uses your own Xiaomi account and the same cloud services as the Mi Home app. Xiaomi can change them at
  any time, which can stop the plugin from working. Use it at your own risk and in accordance with the terms of the
  services you use.
- The software is provided "as is", without warranty of any kind (see [LICENSE](LICENSE)).

## Credits and license

- [go2rtc](https://github.com/AlexxIT/go2rtc) by Alexey Khit (MIT) does all the Xiaomi streaming work.
- [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) provides FFmpeg.
- Third-party licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- This plugin: [MIT](LICENSE), Copyright (c) 2026 Amine GUENNOUNI.
- Maintainers: [docs/RELEASING.md](docs/RELEASING.md) (in French).

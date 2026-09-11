# Third-party notices

This project uses or distributes the following third-party software. Each component keeps its own license; the
MIT license of this repository does not apply to them.

## go2rtc

- Project: https://github.com/AlexxIT/go2rtc
- License: MIT, Copyright (c) 2022 Alexey Khit
- How it is used:
  - By default, the plugin runs `go2rtc-xiaomi-control`, an **unofficial modified build** of go2rtc 1.9.14. The full
    list of changes is the patch file `go2rtc-xiaomi-control/go2rtc-xiaomi-control.patch`. The binaries are built by
    GitHub Actions from the official sources and this patch, and attached to the GitHub releases of this repository
    together with go2rtc's license (`LICENSE.go2rtc`) and the patch. This modified build is not made, endorsed or
    supported by the go2rtc author: please do not report its issues to the go2rtc project.
  - With the `useOfficialGo2rtc` option, the plugin downloads the **official, unmodified** go2rtc 1.9.14 binary from
    the go2rtc GitHub releases and checks its SHA-256 digest. It is not redistributed by this repository.

```
MIT License

Copyright (c) 2022 Alexey Khit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm dependencies

Installed by npm from the npm registry when the plugin is installed; not redistributed by this repository.

| Package | License | Use |
|---|---|---|
| [yaml](https://www.npmjs.com/package/yaml) | ISC | Reads and writes the go2rtc configuration file |
| [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge) | See the package | Provides a static FFmpeg binary (FFmpeg itself is LGPL/GPL, see https://ffmpeg.org/legal.html) |

## MIoT specifications

Camera settings are located at runtime in the public MIoT specifications served by https://miot-spec.org. They
are downloaded by the plugin on the user's server and are not redistributed by this repository.

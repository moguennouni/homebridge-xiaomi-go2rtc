#!/usr/bin/env bash
# Builds go2rtc-xiaomi-control: the official go2rtc sources + go2rtc-xiaomi-control.patch, nothing else.
# Requires git, Go (https://go.dev/dl/) and Node.js. Writes to go2rtc-xiaomi-control/dist/:
# - the binaries for every platform supported by the plugin,
# - SHA256SUMS,
# - go2rtc-binaries.json (file names and digests, copied into lib/ when the npm package is released),
# - LICENSE.go2rtc and the patch.
set -euo pipefail

GO2RTC_VERSION="1.9.14"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/go2rtc-xiaomi-control/go2rtc-xiaomi-control.patch"
OUT="$ROOT/go2rtc-xiaomi-control/dist"
RELEASE="v$(cd "$ROOT" && node -p "require('./package.json').version")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading go2rtc v$GO2RTC_VERSION (official sources)..."
git -c core.autocrlf=false -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$GO2RTC_VERSION" https://github.com/AlexxIT/go2rtc.git "$WORK/go2rtc"

cd "$WORK/go2rtc"
git apply --check "$PATCH"
git apply "$PATCH"
echo "Patch applied: $(git diff --shortstat)"

rm -rf "$OUT"
mkdir -p "$OUT"

# plugin platform key (Node.js process.platform-process.arch) / GOOS / GOARCH / GOARM
TARGETS="
linux-arm/linux/arm/7
linux-armv6/linux/arm/6
linux-arm64/linux/arm64/
linux-x64/linux/amd64/
linux-ia32/linux/386/
darwin-x64/darwin/amd64/
darwin-arm64/darwin/arm64/
win32-x64/windows/amd64/
"

for target in $TARGETS; do
  IFS=/ read -r key os arch arm <<< "$target"
  name="go2rtc-xiaomi-control_${os}_${arch}"
  [ "$arch" = "arm" ] && [ "$arm" = "6" ] && name="${name}v6"
  [ "$os" = "windows" ] && name="${name}.exe"
  echo "Building $name..."
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" GOARM="$arm" go build -ldflags "-s -w -buildid=" -trimpath -o "$OUT/$name" .
  echo "$key $name" >> "$OUT/targets.txt"
done

cp LICENSE "$OUT/LICENSE.go2rtc"
cp "$PATCH" "$OUT/"

cd "$OUT"
if command -v sha256sum > /dev/null; then
  sha256sum go2rtc-xiaomi-control_* | sed 's/ \*/  /' > SHA256SUMS
else
  shasum -a 256 go2rtc-xiaomi-control_* > SHA256SUMS
fi

node - targets.txt SHA256SUMS "$RELEASE" "$GO2RTC_VERSION" > go2rtc-binaries.json <<'EOF'
const fs = require('fs');
const [targetsFile, sumsFile, release, go2rtcVersion] = process.argv.slice(2);
const sums = Object.fromEntries(fs.readFileSync(sumsFile, 'utf8').trim().split('\n')
  .map((line) => line.trim().split(/\s+/)).map(([hash, file]) => [file.replace(/^\*/, ''), hash]));
const assets = {};
for (const line of fs.readFileSync(targetsFile, 'utf8').trim().split('\n')) {
  const [key, file] = line.split(' ');
  assets[key] = { file, sha256: sums[file] };
}
console.log(JSON.stringify({ release, go2rtc: `${go2rtcVersion}-xiaomi-control`, assets }, null, 2));
EOF
rm targets.txt

echo "Built with $(go version) for release $RELEASE:"
cat SHA256SUMS

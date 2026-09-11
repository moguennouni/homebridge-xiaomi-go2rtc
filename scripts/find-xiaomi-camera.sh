#!/usr/bin/env bash
# Finds the Xiaomi devices of the local network (miIO "hello" on UDP 54321) and tests, for each device and each
# Xiaomi cloud region, whether go2rtc can open its video stream. The working line gives the did, IP and region
# to declare in the plugin configuration.
#
# Run it on the Homebridge server, after connecting your Xiaomi account in the go2rtc web UI (Add > Xiaomi).
# Usage: bash find-xiaomi-camera.sh [go2rtc API port, default 1984] [camera IP, default: whole network]
set -uo pipefail

API="http://127.0.0.1:${1:-1984}"
TARGET="${2:-255.255.255.255}"

ACCOUNT=$(curl -s "$API/api/xiaomi" | tr -d '[]" ' | cut -d, -f1)
if [ -z "$ACCOUNT" ]; then
  echo "No Xiaomi account connected in go2rtc ($API). Open the go2rtc web UI, then Add > Xiaomi."
  exit 1
fi
echo "Xiaomi account: $ACCOUNT"

DEVICES=$(node -e '
const socket = require("dgram").createSocket("udp4");
socket.on("message", (msg, remote) => console.log(remote.address + " " + msg.readUInt32BE(8)));
socket.bind(() => {
  socket.setBroadcast(true);
  const hello = Buffer.alloc(32, 255);
  hello.writeUInt32BE(0x21310020, 0);
  socket.send(hello, 54321, process.argv[1]);
});
setTimeout(() => process.exit(0), 4000);
' "$TARGET" | sort -u)

if [ -z "$DEVICES" ]; then
  echo "No Xiaomi device answered on $TARGET."
  exit 1
fi
echo "Xiaomi devices answering on the network (IP did):"
echo "$DEVICES"
echo

echo "$DEVICES" | while read -r IP DID; do
  [ -z "$DID" ] && continue
  for REGION in de sg i2 us ru cn; do
    NAME="find_${DID}_${REGION}"
    curl -s -X PUT -G "$API/api/streams" --data-urlencode "name=$NAME" \
      --data-urlencode "src=xiaomi://$ACCOUNT:$REGION@$IP?did=$DID&model=chuangmi.camera.unknown" >/dev/null
    RESULT=$(curl -s -m 25 "$API/api/streams?src=$NAME&video=all" | tr '\n' ' ' | cut -c1-100)
    case "$RESULT" in
      *producers*) echo "OK      ip=$IP did=$DID region=$REGION  <-- declare this camera with these values" ;;
      "") echo "timeout ip=$IP did=$DID region=$REGION" ;;
      *) echo "no      ip=$IP did=$DID region=$REGION  ($RESULT)" ;;
    esac
    curl -s -X DELETE -G "$API/api/streams" --data-urlencode "src=$NAME" >/dev/null
  done
done

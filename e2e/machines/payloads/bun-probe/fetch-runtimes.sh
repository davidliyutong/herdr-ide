#!/bin/sh
# Downloads the Bun runtimes the probe runs into rt/<name>/bun, verified
# against the release's SHASUMS256.txt and the digests pinned here.
set -eu
cd "$(dirname "$0")"
v=${BUN_VERSION:-1.4.5}
base=https://github.com/oven-sh/bun/releases/download/bun-v$v
pinned() { # bun 1.4.5
  case $1 in
  bun-linux-x64-baseline) echo dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 ;;
  bun-linux-x64) echo 94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb ;;
  bun-linux-x64-musl-baseline) echo 96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6 ;;
  esac
}
mkdir -p rt/dl
curl -fsSL -o rt/dl/SHASUMS256.txt "$base/SHASUMS256.txt"
for z in ${RUNTIMES:-bun-linux-x64-baseline bun-linux-x64 bun-linux-x64-musl-baseline}; do
  curl -fsSL -o "rt/dl/$z.zip" "$base/$z.zip"
  got=$(sha256sum "rt/dl/$z.zip" | cut -d' ' -f1)
  listed=$(grep "  $z.zip\$" rt/dl/SHASUMS256.txt | cut -d' ' -f1)
  want=$listed
  [ "$v" = 1.4.5 ] && want=$(pinned "$z")
  if [ "$got" != "$listed" ] || [ "$got" != "$want" ]; then
    echo "$z.zip: sha256 $got, release lists $listed, pinned $want" >&2
    exit 1
  fi
  echo "$z.zip: sha256 $got verified"
  rm -rf "rt/$z"
  unzip -q -o "rt/dl/$z.zip" -d rt/
done
rm -rf rt/dl

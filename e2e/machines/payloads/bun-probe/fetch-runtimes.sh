#!/bin/sh
# Downloads the Bun runtimes the probe runs into rt/<name>/bun beside this
# script (fetch-runtimes.sh DIR: into DIR/<name>/bun), verified against the
# release's SHASUMS256.txt and the digests pinned here.
# ARCHS="amd64 arm64" (default: both) or RUNTIMES="name ..." selects runtimes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/rt}
mkdir -p "$out"
out=$(cd "$out" && pwd)
v=${BUN_VERSION:-1.4.5}
base=https://github.com/oven-sh/bun/releases/download/bun-v$v
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
pinned() { # bun 1.4.5
  case $1 in
  bun-linux-x64-baseline) echo dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 ;;
  bun-linux-x64) echo 94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb ;;
  bun-linux-x64-musl-baseline) echo 96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6 ;;
  bun-linux-aarch64) echo 18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;;
  bun-linux-aarch64-musl) echo d655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c ;;
  esac
}
default_rts=
for a in ${ARCHS:-amd64 arm64}; do
  case $a in
  amd64|x64|x86_64) default_rts="$default_rts bun-linux-x64-baseline bun-linux-x64 bun-linux-x64-musl-baseline" ;;
  arm64|aarch64) default_rts="$default_rts bun-linux-aarch64 bun-linux-aarch64-musl" ;;
  *) echo "unsupported arch: $a" >&2; exit 1 ;;
  esac
done
mkdir -p "$out/dl"
curl -fsSL -o "$out/dl/SHASUMS256.txt" "$base/SHASUMS256.txt"
for z in ${RUNTIMES:-$default_rts}; do
  curl -fsSL -o "$out/dl/$z.zip" "$base/$z.zip"
  got=$(sha256_file "$out/dl/$z.zip")
  listed=$(grep "  $z.zip\$" "$out/dl/SHASUMS256.txt" | cut -d' ' -f1)
  want=$listed
  [ "$v" = 1.4.5 ] && want=$(pinned "$z")
  if [ "$got" != "$listed" ] || [ "$got" != "$want" ]; then
    echo "$z.zip: sha256 $got, release lists $listed, pinned $want" >&2
    exit 1
  fi
  echo "$z.zip: sha256 $got verified"
  rm -rf "${out:?}/$z"
  unzip -q -o "$out/dl/$z.zip" -d "$out/"
done
rm -rf "$out/dl"

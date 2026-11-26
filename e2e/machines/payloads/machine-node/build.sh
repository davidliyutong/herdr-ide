#!/bin/sh
# Builds this payload on a computer with the repository: the TypeScript
# build's executables of linux/amd64 and linux/arm64 for glibc and musl
# (exe/, backend/scripts/build.ts: the hub and the machine side, each with
# the pinned herdr-core embedded, fetched by bun backend/scripts/fetch-hc.ts),
# which run.sh picks from, and the driver (driver.js).
# MATRIX_ARCHS="amd64 arm64" (default: both) selects architectures.
# Then: machines.py run-matrix payloads/machine-node/run.sh [IMAGE...].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
bun -e "
  const r = await Bun.build({ entrypoints: ['$here/driver.ts'], target: 'bun' });
  if (!r.success) throw new AggregateError(r.logs, 'driver');
  await Bun.write('$here/driver.js', await r.outputs[0].text());
"
archs=${MATRIX_ARCHS:-"amd64 arm64"}
hc_plats=
pairs=
for a in $archs; do
  case $a in
  amd64|x64|x86_64)
    hc_plats="$hc_plats linux/amd64"
    pairs="$pairs linux-amd64:bun-linux-x64-baseline linux-amd64-musl:bun-linux-x64-musl-baseline"
    ;;
  arm64|aarch64)
    hc_plats="$hc_plats linux/arm64"
    pairs="$pairs linux-arm64:bun-linux-arm64 linux-arm64-musl:bun-linux-arm64-musl"
    ;;
  *) echo "unsupported arch: $a" >&2; exit 1 ;;
  esac
done
mkdir -p "$here/hc"
# shellcheck disable=SC2086
bun backend/scripts/fetch-hc.ts --out "$here/hc" $hc_plats
rm -rf "$here/exe"
mkdir -p "$here/exe"
slug=$(sed -n "s/^export const SLUG = '\\(.*\\)';$/\\1/p" backend/shared/lib/brand.ts)
for k in $pairs; do
  bun backend/scripts/build.ts --out "$here/exe/$slug-${k%%:*}" --target "${k#*:}" --version matrix --hc "$here/hc"
done
echo "built $here ($archs)"

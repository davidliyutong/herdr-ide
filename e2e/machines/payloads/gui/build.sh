#!/bin/sh
# Builds this payload on a computer with the repository: the TypeScript
# build's executables of linux/amd64 and linux/arm64 for glibc and musl
# (exe/, backend/scripts/build.ts, each with its GUI helper embedded), the
# X program bundled (bin/xclient.js, e2e/fakes/xclient.ts), the video
# encoder when one was built (enc/encoder-linux-<arch>.gz,
# scripts/build-ffmpeg.sh) and the driver (driver.js).
# MATRIX_ARCHS="amd64 arm64" (default: both) selects architectures.
# Then: machines.py run-matrix payloads/gui/run.sh [IMAGE...].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
rm -rf "$here/exe" "$here/bin" "$here/enc"
mkdir -p "$here/exe" "$here/bin"
bun backend/scripts/fetch-deps.ts --only encoder,gpupick,gui-helper
bun -e "
  for (const [src, out] of [['$here/driver.ts', '$here/driver.js'], ['$root/e2e/fakes/xclient.ts', '$here/bin/xclient.js']]) {
    const r = await Bun.build({ entrypoints: [src], target: 'bun' });
    if (!r.success) throw new AggregateError(r.logs, src);
    await Bun.write(out, await r.outputs[0].text());
  }
"
archs=${MATRIX_ARCHS:-"amd64 arm64"}
slug=$(sed -n "s/^export const SLUG = '\\(.*\\)';$/\\1/p" backend/shared/lib/brand.ts)
for a in $archs; do
  case $a in
  amd64|x64|x86_64)
    a=amd64
    pairs="linux-amd64:bun-linux-x64-baseline linux-amd64-musl:bun-linux-x64-musl-baseline"
    ;;
  arm64|aarch64)
    a=arm64
    pairs="linux-arm64:bun-linux-arm64 linux-arm64-musl:bun-linux-arm64-musl"
    ;;
  *) echo "unsupported arch: $a" >&2; exit 1 ;;
  esac
  for k in $pairs; do
    # No herdr-core: the display needs none.
    bun backend/scripts/build.ts --out "$here/exe/$slug-${k%%:*}" --target "${k#*:}" --version matrix \
      --encoder dist/deps/encoder --gui dist/deps/gui-helper --gpupick dist/deps/gpupick 2>&1 | grep -v 'no herdr-core' || true
    [ -x "$here/exe/$slug-${k%%:*}" ]
  done
  if [ -f "dist/deps/encoder/encoder-linux-$a.gz" ]; then
    mkdir -p "$here/enc" && cp "dist/deps/encoder/encoder-linux-$a.gz" "$here/enc/encoder-linux-$a.gz"
  fi
done
echo "built $here ($archs)"

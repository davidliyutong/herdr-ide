#!/bin/sh
# Builds this payload on a computer with the repository: the TypeScript
# build's executables of linux/amd64 for glibc and musl (exe/,
# backend/scripts/build.ts, each with the GUI helper of linux/amd64
# embedded), the X program of the program windows' tests bundled
# (bin/xclient.js, e2e/fakes/xclient.ts: run.sh runs it with the machine's
# executable acting as Bun), the video encoder when one was built
# (enc/encoder.gz, scripts/build-ffmpeg.sh) and the driver (driver.js).
# Then:
# machines.py run-matrix payloads/gui/run.sh [IMAGE...].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
rm -rf "$here/exe" "$here/bin"
mkdir -p "$here/exe" "$here/bin"
bun -e "
  for (const [src, out] of [['$here/driver.ts', '$here/driver.js'], ['$root/e2e/fakes/xclient.ts', '$here/bin/xclient.js']]) {
    const r = await Bun.build({ entrypoints: [src], target: 'bun' });
    if (!r.success) throw new AggregateError(r.logs, src);
    await Bun.write(out, await r.outputs[0].text());
  }
"
slug=$(sed -n "s/^export const SLUG = '\\(.*\\)';$/\\1/p" backend/shared/lib/brand.ts)
for k in linux-amd64:bun-linux-x64-baseline linux-amd64-musl:bun-linux-x64-musl-baseline; do
  # No herdr-core: the display needs none.
  bun backend/scripts/build.ts --out "$here/exe/$slug-${k%%:*}" --target "${k#*:}" --version matrix 2>&1 | grep -v 'no herdr-core' || true
  [ -x "$here/exe/$slug-${k%%:*}" ]
done
# The video encoder when scripts/build-ffmpeg.sh built it: run.sh then tries video.
rm -rf "$here/enc"
if [ -f dist/ffmpeg/linux-amd64/encoder.gz ]; then
  mkdir -p "$here/enc" && cp dist/ffmpeg/linux-amd64/encoder.gz "$here/enc/"
fi
echo "built $here"

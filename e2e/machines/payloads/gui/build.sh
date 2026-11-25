#!/bin/sh
# Builds this payload on a computer with the repository: the TypeScript
# build's executables of linux/amd64 for glibc and musl (exe/,
# backend/scripts/build.ts --machine ts, each with the GUI helper of
# linux/amd64 embedded), the X program of the program windows' tests
# (bin/e2e-xclient, e2e/xclient), the video encoder when one was built
# (enc/encoder.gz, scripts/build-ffmpeg.sh) and the driver (driver.js).
# Then:
# machines.py run-matrix payloads/gui/run.sh [IMAGE...].
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
bun -e "
  const r = await Bun.build({ entrypoints: ['$here/driver.ts'], target: 'bun' });
  if (!r.success) throw new AggregateError(r.logs, 'driver');
  await Bun.write('$here/driver.js', await r.outputs[0].text());
"
rm -rf "$here/exe" "$here/bin"
mkdir -p "$here/exe" "$here/bin"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$here/bin/e2e-xclient" ./e2e/xclient
slug=$(sed -n "s/^export const SLUG = '\\(.*\\)';$/\\1/p" backend/shared/lib/brand.ts)
for k in linux-amd64:bun-linux-x64-baseline linux-amd64-musl:bun-linux-x64-musl-baseline; do
  # No herdr-core: the display needs none.
  bun backend/scripts/build.ts --out "$here/exe/$slug-${k%%:*}" --target "${k#*:}" --version matrix --machine ts 2>&1 | grep -v 'no herdr-core' || true
  [ -x "$here/exe/$slug-${k%%:*}" ]
done
# The video encoder when scripts/build-ffmpeg.sh built it: run.sh then tries video.
rm -rf "$here/enc"
if [ -f dist/ffmpeg/linux-amd64/encoder.gz ]; then
  mkdir -p "$here/enc" && cp dist/ffmpeg/linux-amd64/encoder.gz "$here/enc/"
fi
echo "built $here"

#!/bin/sh
# Builds this payload on a computer with the repository: the TypeScript
# machine executables of linux/amd64 for glibc and musl (exe/,
# backend/scripts/machines.ts, each with the pinned herdr-core embedded),
# which run.sh picks from, and the driver (driver.js). Then:
# machines.py run-matrix payloads/machine-node/run.sh [IMAGE...].
#
#   build.sh            the executables and the driver
#   build.sh --go       also the Go machine build of linux/amd64 (go/), which
#                       run-go.sh runs in their place (it gets herdr-core
#                       uploaded from hc/)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
bun -e "
  const r = await Bun.build({ entrypoints: ['$here/driver.ts'], target: 'bun' });
  if (!r.success) throw new AggregateError(r.logs, 'driver');
  await Bun.write('$here/driver.js', await r.outputs[0].text());
"
mkdir -p "$here/hc"
go run ./scripts/fetch-hc -out "$here/hc" linux/amd64
gunzip -c "$here/hc/hc-linux-amd64.gz" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1 > "$here/hc/herdr-core.sha256"
rm -rf "$here/exe"
bun backend/scripts/machines.ts --out "$here/exe" --version matrix --hc "$here/hc" --raw linux-amd64 linux-amd64-musl
rm -f "$here"/exe/*.gz
if [ "${1:-}" = --go ]; then
  slug=$(sed -n "s/^export const SLUG = '\\(.*\\)';$/\\1/p" backend/shared/lib/brand.ts)
  mkdir -p "$here/go"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$here/go/$slug" "./cmd/$slug"
fi
echo "built $here"

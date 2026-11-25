#!/bin/sh
# Builds this payload on a computer with the repository: the machine bundle
# (machine.js, backend/hosts/machine/bundle.ts) and its driver (driver.js),
# the pinned herdr-core of linux/amd64 (hc/, gzip and its SHA-256: the
# terminal core the driver installs), and the Bun runtimes run.sh picks
# from (rt/, ../bun-probe/fetch-runtimes.sh; needs sha256sum and unzip).
# Then: machines.py run-matrix payloads/machine-node/run.sh [IMAGE...].
#
#   build.sh            everything
#   build.sh --no-rt    without the runtimes (fetched on the KVM host)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
cd "$root"
bun -e "
  const { buildBundle } = await import('$root/backend/hosts/machine/bundle.ts');
  await Bun.write('$here/machine.js', (await buildBundle('matrix')).js);
  const r = await Bun.build({ entrypoints: ['$here/driver.ts'], target: 'bun' });
  if (!r.success) throw new AggregateError(r.logs, 'driver');
  await Bun.write('$here/driver.js', await r.outputs[0].text());
"
mkdir -p "$here/hc"
go run ./scripts/fetch-hc -exe "$here/hc/herdr-core" linux/amd64
gzip -9 -n -f "$here/hc/herdr-core"
gunzip -c "$here/hc/herdr-core.gz" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1 > "$here/hc/herdr-core.sha256"
[ "${1:-}" = --no-rt ] || RUNTIMES="bun-linux-x64-baseline bun-linux-x64-musl-baseline" "$here/../bun-probe/fetch-runtimes.sh" "$here/rt"
echo "built $here"

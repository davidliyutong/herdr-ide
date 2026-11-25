#!/usr/bin/env bash
# Runs the program windows' integration test (backend/features/gui/
# integration.test.ts: the TypeScript machine side and the GUI helper
# against a real Xvfb) in a Linux container, from any host with Docker:
# Bun's image with Xvfb, the repository mounted, the X program
# (e2e/fakes/xclient.ts) compiled by Bun for the container's architecture,
# as a user without privileges. `make it` runs the same test directly on a
# Linux host with Xvfb.
#
#   scripts/gui-it.sh
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
darch=$(docker info --format '{{.Architecture}}')
case "$darch" in
  x86_64 | amd64) target=bun-linux-x64-baseline ;;
  aarch64 | arm64) target=bun-linux-arm64 ;;
  *) echo "Docker on $darch: no GUI helper for it" >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/x" "$tmp/stage"
# In a directory of its own: Bun leaves a .<hash>.bun-build copy of the
# executable in its working directory.
(cd "$tmp/stage" && bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target="$target" \
  "$root/e2e/fakes/xclient.ts" --outfile "$tmp/x/e2e-xclient" >/dev/null)
image="${SLUG}-gui-it"
docker build -q --label "${SLUG}.e2e=1" -t "$image" - >/dev/null <<'EOF'
FROM oven/bun:1.4.5
RUN apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/* \
  && useradd -m it
EOF
docker run --rm --label "${SLUG}.e2e=1" -v "$PWD:/w:ro" -v "$tmp/x:/x:ro" -e GUI_TEST_XCLIENT=/x/e2e-xclient -u it -w /w/backend "$image" \
  bun test features/gui/integration.test.ts

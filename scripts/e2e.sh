#!/usr/bin/env bash
# End-to-end tests (make e2e): builds the web UI, the core of this platform
# with the pinned herdr-core of this platform embedded (fetched once into
# dist/hc) and the fake coding agents into dist/e2e, then runs the
# Playwright suite in e2e/ against isolated instances. Arguments go to
# Playwright (a file, -g <title>, --headed, --repeat-each 3).
#
#   SKIP_WEB=1 scripts/e2e.sh       # reuse web/dist
#   SKIP_BUILD=1 scripts/e2e.sh     # reuse dist/e2e
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
OUT=dist/e2e
os=$(go env GOOS)
arch=$(go env GOARCH)

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ -z "${SKIP_WEB:-}" ]]; then
    echo "==> web"
    (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null && touch dist/.gitkeep)
  fi
  echo "==> herdr-core for $os/$arch"
  go run ./scripts/fetch-hc "$os/$arch"
  echo "==> core and fake agents"
  mkdir -p "$OUT/fakebin"
  go build -o "$OUT/core" "./cmd/${SLUG}"
  go build -o "$OUT/fakebin/kimi" ./e2e/fakeacp
fi

pnpm -C e2e install --frozen-lockfile >/dev/null
# The Chromium of the pinned Playwright, installed only when it is missing:
# an install also removes the browsers of other Playwright versions it
# deems unused from the shared cache.
chromium=$(pnpm -C e2e exec playwright install --dry-run --no-shell chromium | sed -n 's/^ *Install location: *//p' | head -1)
if [[ ! -f "$chromium/INSTALLATION_COMPLETE" ]]; then
  echo "==> Chromium for Playwright"
  pnpm -C e2e exec playwright install --no-shell chromium
fi
exec pnpm -C e2e exec playwright test "$@"

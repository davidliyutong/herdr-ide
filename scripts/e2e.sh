#!/usr/bin/env bash
# End-to-end tests (make e2e): builds the web UI, the core of this platform
# with the pinned herdr-core of this platform embedded (fetched once into
# dist/hc) and the fake coding agents into dist/e2e, then runs the
# Playwright suite in e2e/ against isolated instances. Arguments go to
# Playwright (a file, -g <title>, --headed, --repeat-each 3).
#
# With Docker, the SSH machine tests (e2e/tests/ssh.spec.ts) also get the
# Linux machine build, herdr-core and fake agent of Docker's architecture
# and the sshd image (e2e/sshd); without it they skip, unless
# E2E_REQUIRE_DOCKER=1 (CI), which fails instead.
#
#   SKIP_WEB=1 scripts/e2e.sh       # reuse web/dist
#   SKIP_BUILD=1 scripts/e2e.sh     # reuse dist/e2e
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
OUT=dist/e2e
os=$(go env GOOS)
arch=$(go env GOARCH)

# Docker's architecture as Go names it, empty without a Docker daemon.
darch=""
if command -v docker >/dev/null 2>&1 && darch=$(docker info --format '{{.Architecture}}' 2>/dev/null); then
  case "$darch" in
    x86_64 | amd64) darch=amd64 ;;
    aarch64 | arm64) darch=arm64 ;;
    *) echo "Docker on $darch: no machine build for it" >&2; darch="" ;;
  esac
else
  darch=""
fi
if [[ -z "$darch" && -n "${E2E_REQUIRE_DOCKER:-}" ]]; then
  echo "E2E_REQUIRE_DOCKER is set but Docker is not available" >&2
  exit 1
fi

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ -z "${SKIP_WEB:-}" ]]; then
    echo "==> web"
    (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null && touch dist/.gitkeep)
  fi
  platforms="$os/$arch"
  [[ -n "$darch" && "linux/$darch" != "$platforms" ]] && platforms="$platforms linux/$darch"
  echo "==> herdr-core for $platforms"
  # shellcheck disable=SC2086
  go run ./scripts/fetch-hc $platforms
  echo "==> core and fake agents"
  mkdir -p "$OUT/fakebin"
  go build -o "$OUT/core" "./cmd/${SLUG}"
  # A newer build of the same code (another version, written later), which
  # takes the nodes over from the first (tests/nodes.spec.ts).
  go build -ldflags "-X $(sed -n 's/^module //p' go.mod)/internal/agentproto.Version=dev-e2e-newer" -o "$OUT/core-newer" "./cmd/${SLUG}"
  go build -o "$OUT/fakebin/kimi" ./e2e/fakeacp
  if [[ -n "$darch" ]]; then
    # The SSH machine's: the machine build the core uploads (--agent-dir)
    # and the fake agent the harness copies into the container.
    echo "==> machine build and fake agent for linux/$darch"
    mkdir -p "$OUT/agents" "$OUT/linux-$darch"
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -trimpath -tags machine -o "$OUT/agents/${SLUG}-linux-$darch" "./cmd/${SLUG}"
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -o "$OUT/linux-$darch/kimi" ./e2e/fakeacp
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -o "$OUT/linux-$darch/e2e-xclient" ./e2e/xclient
  fi
fi

if [[ -n "$darch" ]]; then
  # Cached by Docker: rebuilt only when e2e/sshd changes.
  echo "==> sshd image"
  docker build -q --label "${SLUG}.e2e=1" -t "${SLUG}-e2e-sshd" e2e/sshd >/dev/null
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

#!/usr/bin/env bash
# End-to-end tests (make e2e): builds the web UI, the core of this platform
# (backend/, bun backend/scripts/build.ts) with the machine build and the
# pinned herdr-core of this platform embedded (fetched once into dist/hc)
# and the fake coding agents into dist/e2e, then runs the Playwright suite
# in e2e/ against isolated instances. Arguments go to Playwright (a file,
# -g <title>, --headed, --repeat-each 3).
#
# With Docker, the SSH machine tests (e2e/tests/ssh.spec.ts) also get the
# Linux machine build, herdr-core and fake agent of Docker's architecture
# and the sshd image (e2e/sshd); without it they skip, unless
# E2E_REQUIRE_DOCKER=1 (CI), which fails instead.
#
#   SKIP_WEB=1 scripts/e2e.sh       # reuse web/dist
#   SKIP_BUILD=1 scripts/e2e.sh     # reuse dist/e2e
#   E2E_DIR=dist/e2e-b scripts/e2e.sh  # build into another directory
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
OUT=${E2E_DIR:-dist/e2e}
[[ "$OUT" == /* ]] || OUT="$PWD/$OUT"
# The harness finds the builds there (e2e/harness/paths.ts).
export E2E_DIR="$OUT"
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
    (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
  fi
  platforms="$os/$arch"
  [[ -n "$darch" && "linux/$darch" != "$platforms" ]] && platforms="$platforms linux/$darch"
  echo "==> herdr-core for $platforms"
  rm -rf "$OUT/payload" && mkdir -p "$OUT/payload/hc" "$OUT/payload/agents" "$OUT/payload/agents-newer"
  # shellcheck disable=SC2086
  go run ./scripts/fetch-hc -out "$OUT/payload/hc" $platforms
  echo "==> machine builds and fake agents"
  mod=$(sed -n 's/^module //p' go.mod)
  mkdir -p "$OUT/fakebin"
  # This host's machine build, which the core runs for the local machine,
  # and the same code as another, newer version for the newer core.
  go build -trimpath -o "$OUT/payload/agents/${SLUG}-$os-$arch" "./cmd/${SLUG}"
  go build -trimpath -ldflags "-X $mod/internal/agentproto.Version=dev-e2e-newer" -o "$OUT/payload/agents-newer/${SLUG}-$os-$arch" "./cmd/${SLUG}"
  go build -o "$OUT/fakebin/kimi" ./e2e/fakeacp
  if [[ -n "$darch" ]]; then
    # The SSH machine's: the machine build the core uploads (--agent-dir)
    # and the fake agent the harness copies into the container.
    echo "==> machine build and fake agent for linux/$darch"
    mkdir -p "$OUT/agents" "$OUT/linux-$darch"
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -trimpath -o "$OUT/agents/${SLUG}-linux-$darch" "./cmd/${SLUG}"
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -o "$OUT/linux-$darch/kimi" ./e2e/fakeacp
    CGO_ENABLED=0 GOOS=linux GOARCH=$darch go build -o "$OUT/linux-$darch/e2e-xclient" ./e2e/xclient
    if [[ "linux/$darch" != "$os/$arch" ]]; then
      cp "$OUT/agents/${SLUG}-linux-$darch" "$OUT/payload/agents/"
      cp "$OUT/agents/${SLUG}-linux-$darch" "$OUT/payload/agents-newer/"
    fi
  fi
  # The core and a newer build of the same code (another version, written
  # later), which takes the nodes over from the first (tests/nodes.spec.ts).
  echo "==> core"
  (cd backend && pnpm install --frozen-lockfile >/dev/null)
  common=(--web web/dist --hc "$OUT/payload/hc")
  # The bridge extension when a build staged it (scripts/build.sh).
  [[ -d dist/payload/ext ]] && common+=(--ext dist/payload/ext)
  bun backend/scripts/build.ts --out "$OUT/core" --agents "$OUT/payload/agents" "${common[@]}" >/dev/null
  bun backend/scripts/build.ts --out "$OUT/core-newer" --version dev-e2e-newer --agents "$OUT/payload/agents-newer" "${common[@]}" >/dev/null
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

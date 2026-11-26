#!/usr/bin/env bash
# End-to-end tests (make e2e): builds the web UI, the hub of this platform
# (backend/, bun backend/scripts/build.ts: one executable that is the hub
# and the machine side of its platform) with the pinned herdr-core of this
# platform embedded (bun backend/scripts/fetch-hc.ts) and the fake coding
# agents (e2e/fakes, compiled by Bun) into dist/e2e, then runs the
# Playwright suite in e2e/ against isolated instances. Arguments go to
# Playwright (a file, -g <title>, --headed, --repeat-each 3).
#
# With Docker, the SSH machine tests (e2e/tests/ssh.spec.ts) also get the
# machine builds of Docker's Linux, glibc's and musl's (the SSH machine is
# Alpine), the fake agent and the X program of the program windows
# (e2e/fakes/xclient.ts) built for it, and the sshd image (e2e/sshd);
# without it they skip, unless E2E_REQUIRE_DOCKER=1 (CI), which fails
# instead.
#
# The machine builds go into machines/ with their SHA256SUMS, which the
# hubs take as --agent-dir (a build of no release: nothing is
# downloaded); hub is this host's. They are built again as another, newer
# version into machines-newer/ (hub-newer), which takes the nodes over
# from the first (tests/nodes.spec.ts).
#
#   SKIP_WEB=1 scripts/e2e.sh       # reuse web/dist
#   SKIP_BUILD=1 scripts/e2e.sh     # reuse dist/e2e
#   E2E_DIR=dist/e2e-b scripts/e2e.sh  # build into another directory
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
# shellcheck source=scripts/load-env.sh
source "$ROOT/scripts/load-env.sh"
load_repo_dotenv "$ROOT"

SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
OUT=${E2E_DIR:-dist/e2e}
[[ "$OUT" == /* ]] || OUT="$PWD/$OUT"
# The harness finds the builds there (e2e/harness/paths.ts).
export E2E_DIR="$OUT"

# This host's platform, as the builds name it.
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "no end-to-end tests on $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "no build for $(uname -m)" >&2; exit 1 ;;
esac

# Docker's architecture, empty without a Docker daemon.
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

# Bun's compile target of a build key (empty: this host's).
target_of() {
  case "$1" in
    "$os-$arch") echo "" ;;
    linux-amd64) echo bun-linux-x64-baseline ;;
    linux-arm64) echo bun-linux-arm64 ;;
    linux-amd64-musl) echo bun-linux-x64-musl-baseline ;;
    linux-arm64-musl) echo bun-linux-arm64-musl ;;
  esac
}

# Compiles a fake (e2e/fakes/<name>.ts) into one executable for a build
# key. The compile runs in a directory of its own: Bun leaves a
# .<hash>.bun-build copy of the executable in its working directory.
fake() {
  local name=$1 out=$2 t tmp
  t=$(target_of "$3")
  tmp=$(mktemp -d)
  if ! (cd "$tmp" && bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig ${t:+"--target=$t"} \
    "$ROOT/e2e/fakes/$name.ts" --outfile "$out" >/dev/null); then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ -z "${SKIP_WEB:-}" ]]; then
    echo "==> web"
    (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
  fi
  platforms="$os/$arch"
  [[ -n "$darch" && "linux/$darch" != "$platforms" ]] && platforms="$platforms linux/$darch"
  echo "==> herdr-core for $platforms"
  rm -rf "$OUT/hc" && mkdir -p "$OUT/hc"
  # shellcheck disable=SC2086
  bun backend/scripts/fetch-hc.ts --out "$OUT/hc" $platforms
  echo "==> fake agents"
  rm -rf "$OUT/fakebin" "$OUT"/linux-*
  mkdir -p "$OUT/fakebin"
  fake acp "$OUT/fakebin/kimi" "$os-$arch"
  fake codex "$OUT/fakebin/codex" "$os-$arch"
  fake claude "$OUT/fakebin/claude" "$os-$arch"
  if [[ -n "$darch" ]]; then
    # The SSH machine's (Alpine: musl), which the harness copies into its
    # container.
    echo "==> fake agent and X program for linux/$darch"
    mkdir -p "$OUT/linux-$darch"
    fake acp "$OUT/linux-$darch/kimi" "linux-$darch-musl"
    fake xclient "$OUT/linux-$darch/e2e-xclient" "linux-$darch-musl"
    fake http "$OUT/linux-$darch/e2e-http" "linux-$darch-musl"
  fi
  echo "==> machine builds"
  (cd backend && pnpm install --frozen-lockfile >/dev/null)
  common=(--web web/dist --hc "$OUT/hc")
  # The bridge extension when a build staged it (scripts/build.sh).
  [[ -d dist/payload/ext ]] && common+=(--ext dist/payload/ext)
  # This host's, and Docker's Linux, glibc's and musl's; again as the newer
  # version, whose node the newer hub runs.
  keys="$os-$arch"
  [[ -n "$darch" && "linux-$darch" != "$keys" ]] && keys="$keys linux-$darch"
  [[ -n "$darch" ]] && keys="$keys linux-$darch-musl"
  rm -rf "$OUT/machines" "$OUT/machines-newer" "$OUT/payload"
  for v in dev dev-e2e-newer; do
    dir="$OUT/machines"
    [[ "$v" == dev ]] || dir="$OUT/machines-newer"
    mkdir -p "$dir"
    for k in $keys; do
      t=$(target_of "$k")
      extra=()
      [[ -n "$t" ]] && extra+=(--target "$t")
      # This host's, as the desktop app carries it.
      [[ "$k" == "$os-$arch" && "$v" == dev ]] && extra+=(--payload-out "$OUT/payload")
      bun backend/scripts/build.ts --out "$dir/${SLUG}-$k" --version "$v" "${common[@]}" ${extra[@]+"${extra[@]}"} >/dev/null
    done
    # The manifest of this "release": the executables as an archive would
    # hold them.
    (cd "$dir" && for k in $keys; do
      printf '%s  %s\n' "$( { sha256sum "${SLUG}-$k" 2>/dev/null || shasum -a 256 "${SLUG}-$k"; } | cut -d' ' -f1)" "${SLUG}-$k/${SLUG}"
    done > SHA256SUMS)
  done
  cp "$OUT/machines/${SLUG}-$os-$arch" "$OUT/hub"
  cp "$OUT/machines-newer/${SLUG}-$os-$arch" "$OUT/hub-newer"
  gzip -1 -c "$OUT/machines/${SLUG}-$os-$arch" > "$OUT/payload/machine/${SLUG}-$os-$arch.gz"
  # The desktop app's smoke test (tests/desktop.spec.ts) runs it unpackaged
  # with the hub bundled for its utility process and the payloads above;
  # it skips where the desktop's packages are not installed.
  if [[ -d desktop/node_modules/electron ]]; then
    echo "==> desktop app"
    pnpm -C desktop build >/dev/null
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
if [[ "$os" == linux && -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "==> headless Linux: wrapping Playwright in xvfb-run"
    exec xvfb-run -a -s "-screen 0 2000x1200x24" pnpm -C e2e exec playwright test "$@"
  fi
  echo "note: no DISPLAY/WAYLAND_DISPLAY and no xvfb-run; desktop Electron tests will skip" >&2
fi
exec pnpm -C e2e exec playwright test "$@"

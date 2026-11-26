#!/usr/bin/env bash
# Runs Linux-specific backend tests inside a Linux container (oven/bun +
# Xvfb), from macOS or any host with Docker:
#   - default: Linux-only unit/extended/integration tests (sys, /proc
#     sessions, gpupick LD_PRELOAD, display, real Xvfb GUI integration);
#   - LINUX_TEST_ALL=1: full backend suite with EXTENDED_TESTS=1;
#   - arguments: forwarded to `bun test` (e.g. features/gui/machine/pick.test.ts).
#
#   make test-linux
#   scripts/test-linux.sh features/gui/machine/pick.test.ts
#   LINUX_TEST_ALL=1 scripts/test-linux.sh
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
# shellcheck source=scripts/load-env.sh
source "$root/scripts/load-env.sh"
load_repo_dotenv "$root"
SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)

if [[ ! -d backend/node_modules ]]; then
  echo "backend/node_modules is missing; run 'make deps' or 'pnpm -C backend install'" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! darch=$(docker info --format '{{.Architecture}}' 2>/dev/null); then
  echo "Docker is not available (make test-linux needs it)" >&2
  exit 1
fi
case "$darch" in
  x86_64 | amd64) target=bun-linux-x64-baseline ;;
  aarch64 | arm64) target=bun-linux-arm64 ;;
  *) echo "Docker on $darch: unsupported architecture" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/x" "$tmp/stage"
(cd "$tmp/stage" && bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target="$target" \
  "$root/e2e/fakes/xclient.ts" --outfile "$tmp/x/e2e-xclient" >/dev/null)

image="${SLUG}-linux-test"
docker build -q --label "${SLUG}.test-linux=1" -t "$image" - >/dev/null <<'EOF'
FROM oven/bun:1.4.5
RUN apt-get update && apt-get install -y --no-install-recommends xvfb git openssh-client ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m tester
EOF

user_args=(-u tester)
home_env=()
if [[ "$(uname -s)" == Linux && "$(id -u)" != 0 ]]; then
  user_args=(-u "$(id -u):$(id -g)")
  home_env=(-e HOME=/tmp/linux-test-home)
fi

if [[ $# -gt 0 ]]; then
  tests=("$@")
elif [[ "${LINUX_TEST_ALL:-}" == 1 ]]; then
  tests=()
else
  tests=(
    machine/sys/sys.test.ts
    machine/agents/sessions.test.ts
    features/gui/machine/pick.test.ts
    features/gui/machine/display.test.ts
    features/gui/integration.test.ts
  )
fi

echo "==> Linux container tests ($darch): ${tests[*]:-all backend tests}"
docker run --rm --label "${SLUG}.test-linux=1" \
  -v "$PWD:/w:ro" -v "$tmp/x:/x:ro" \
  -e EXTENDED_TESTS="${EXTENDED_TESTS:-1}" \
  -e GUI_TEST_XCLIENT=/x/e2e-xclient \
  "${home_env[@]+"${home_env[@]}"}" "${user_args[@]}" \
  -w /w/backend "$image" \
  sh -c 'mkdir -p "${HOME:-/tmp}" && exec bun test "$@"' -- "${tests[@]+"${tests[@]}"}"

#!/usr/bin/env bash
# Runs the integration test suite (make it) on macOS and Linux without
# silent skips:
#   - fetches (or reuses from dist/hc) the pinned herdr-core for this host
#     into dist/it/ unless HC_TEST_BIN is already set (IT_SKIP_FETCH=1
#     disables auto-fetching);
#   - runs the four herdr-core integration tests;
#   - runs program windows' integration test natively on Linux with Xvfb, or
#     inside Docker via scripts/gui-it.sh on macOS / Xvfb-less Linux
#     (IT_NO_DOCKER=1 disables the Docker fallback);
#   - runs VS Code's integration test when E2E_CODE_SERVER_SEED is set, or
#     seeds it automatically with IT_WITH_VSCODE=1.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/load-env.sh
source "$PWD/scripts/load-env.sh"
load_repo_dotenv "$PWD"

HOST_PLATFORM=$(scripts/platform.sh)
HOST_SLASH=$(scripts/platform.sh --slash)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-docker) IT_NO_DOCKER=1; shift ;;
    --with-vscode) IT_WITH_VSCODE=1; shift ;;
    --skip-fetch) IT_SKIP_FETCH=1; shift ;;
    *) echo "usage: $0 [--no-docker] [--with-vscode] [--skip-fetch]" >&2; exit 2 ;;
  esac
done

if [[ -z "${HC_TEST_BIN:-}" && -z "${IT_SKIP_FETCH:-}" ]]; then
  hc_out="$PWD/dist/it/herdr-core-$HOST_PLATFORM"
  echo "==> pinned herdr-core ($HOST_SLASH)"
  bun backend/scripts/fetch-hc.ts --exe "$hc_out" "$HOST_SLASH"
  export HC_TEST_BIN="$hc_out"
fi

if [[ -z "${E2E_CODE_SERVER_SEED:-}" && "${IT_WITH_VSCODE:-}" == 1 ]]; then
  case "$HOST_PLATFORM" in
    darwin-arm64) cs_plat=macos-arm64 ;;
    darwin-amd64) cs_plat=macos-amd64 ;;
    linux-arm64) cs_plat=linux-arm64 ;;
    linux-amd64) cs_plat=linux-amd64 ;;
    *) echo "no code-server asset for $HOST_PLATFORM" >&2; exit 1 ;;
  esac
  seed_dir="$PWD/dist/it/code-server"
  tmp_home=$(mktemp -d)
  trap 'rm -rf "$tmp_home"' EXIT
  echo "==> pinned code-server seed ($cs_plat)"
  HOME="$tmp_home" XDG_CACHE_HOME="$tmp_home/.cache" \
    bun backend/hosts/bun/main.ts fetch-assets --platforms "$cs_plat" --seed-dir "$seed_dir" "$seed_dir"
  export E2E_CODE_SERVER_SEED="$seed_dir"
fi

echo "==> herdr-core integration tests"
(cd backend && bun test features/terminals/integration.test.ts)
(cd backend && bun test features/history/integration.test.ts)
(cd backend && bun test features/agents/integration.test.ts)
(cd backend && bun test machine/integration.test.ts)

echo "==> GUI integration test"
if [[ "$(uname -s)" == Linux ]] && (command -v Xvfb >/dev/null 2>&1 || [[ -x /usr/bin/Xvfb ]]); then
  [[ -n "${IT_SKIP_FETCH:-}" ]] || bun backend/scripts/fetch-deps.ts --only gui-helper
  (cd backend && bun test features/gui/integration.test.ts)
elif [[ -z "${IT_NO_DOCKER:-}" ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "    (running in Linux Docker container via scripts/gui-it.sh)"
  scripts/gui-it.sh
else
  echo "    skipped: requires Linux+Xvfb or Docker (set IT_NO_DOCKER=1 to silence)" >&2
  (cd backend && bun test features/gui/integration.test.ts)
fi

echo "==> VS Code integration test"
if [[ -z "${E2E_CODE_SERVER_SEED:-}" ]]; then
  echo "    (pass E2E_CODE_SERVER_SEED=<dir> or IT_WITH_VSCODE=1 make it to run with a real code-server release)"
fi
(cd backend && bun test features/vscode/integration.test.ts)

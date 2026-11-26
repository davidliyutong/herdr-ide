#!/usr/bin/env bash
# Runs .github/workflows/ci.yml jobs locally through nektos/act on macOS and
# Linux, with clean container lifecycle (--rm), cached act toolcache, an
# Xvfb-equipped Ubuntu 24.04 image for integration/desktop jobs, and proper
# handling of the e2e Docker-out-of-Docker loopback boundary.
#
#   make ci-local                     # runs `check`
#   make ci-local JOB=integration     # runs `integration` (with Xvfb)
#   make ci-local JOB=cross-compile   # runs `cross-compile`
#   make ci-local JOB=desktop         # runs Linux `desktop` job
#   make ci-local JOB=e2e             # Linux: act --network host; macOS: native make e2e
#   ACT_ARCH=linux/amd64 scripts/ci-local.sh check
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/load-env.sh
source "$PWD/scripts/load-env.sh"
load_repo_dotenv "$PWD"

SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
JOB=${1:-${JOB:-check}}
shift 2>/dev/null || true

if ! command -v docker >/dev/null 2>&1 || ! darch=$(docker info --format '{{.Architecture}}' 2>/dev/null); then
  echo "Docker is not available (make ci-local needs it)" >&2
  exit 1
fi
case "$darch" in
  x86_64 | amd64) default_arch=linux/amd64 ;;
  aarch64 | arm64) default_arch=linux/arm64 ;;
  *) echo "unsupported Docker architecture: $darch" >&2; exit 1 ;;
esac
ACT_ARCH=${ACT_ARCH:-$default_arch}
BASE_IMAGE=${ACT_BASE_IMAGE:-catthehacker/ubuntu:act-24.04}
EXT_IMAGE="${SLUG}-act-ubuntu:24.04"
ARTIFACTS_DIR="${ACT_ARTIFACTS_DIR:-$PWD/dist/act-artifacts}"
mkdir -p "$ARTIFACTS_DIR"

require_act() {
  if ! command -v act >/dev/null 2>&1; then
    echo "nektos/act is not installed (macOS: brew install act; Linux: https://nektosact.com)" >&2
    exit 1
  fi
}

# Builds a thin cached derivative of catthehacker/ubuntu:act-24.04 with Xvfb
# and desktop libraries so `integration` (GUI) and Linux `desktop` jobs match
# GitHub's ubuntu-24.04 runner instead of silently skipping.
ensure_gui_image() {
  echo "==> preparing act runner image $EXT_IMAGE ($ACT_ARCH)"
  docker build -q --platform "$ACT_ARCH" --label "${SLUG}.act=1" \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$EXT_IMAGE" - >/dev/null <<'EOF'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth lsof libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0 libsecret-1-0 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*
EOF
}

run_act() {
  local job=$1 image=$2 container_opts=$3
  shift 3
  require_act
  echo "==> act job=$job arch=$ACT_ARCH image=$image"
  act pull_request \
    -W .github/workflows/ci.yml \
    -j "$job" \
    --rm \
    --pull=false \
    --env-file "${ACT_ENV_FILE:-/dev/null}" \
    --container-architecture "$ACT_ARCH" \
    --container-options "$container_opts" \
    --env pnpm_config_store_dir=/root/.local/share/pnpm/store \
    --artifact-server-path "$ARTIFACTS_DIR" \
    -P "ubuntu-24.04=$image" \
    "$@"
}

case "$JOB" in
  check | cross-compile)
    run_act "$JOB" "$BASE_IMAGE" "--init" "$@"
    ;;
  integration)
    ensure_gui_image
    run_act integration "$EXT_IMAGE" "--init" "$@"
    ;;
  desktop | desktop-linux)
    ensure_gui_image
    run_act desktop "$EXT_IMAGE" "--init" --matrix os:ubuntu-24.04 "$@"
    ;;
  e2e)
    if [[ "$(uname -s)" == Darwin && "${ACT_FORCE_E2E:-}" != 1 ]]; then
      echo "==> macOS note: inside Docker-out-of-Docker act containers, 127.0.0.1:<port>"
      echo "    for e2e-sshd binds on the VM host, not the act container. Running native"
      echo "    E2E_REQUIRE_DOCKER=1 make e2e (set ACT_FORCE_E2E=1 to force act)."
      exec env E2E_REQUIRE_DOCKER=1 scripts/e2e.sh "$@"
    fi
    ensure_gui_image
    # On Linux, host networking lets the act container reach e2e-sshd containers
    # published on 127.0.0.1:<port> via the host Docker daemon.
    run_act e2e "$EXT_IMAGE" "--init --network host" "$@"
    ;;
  all)
    "$0" check
    "$0" integration
    "$0" desktop-linux
    "$0" cross-compile
    ;;
  *)
    echo "usage: $0 [check|integration|desktop|e2e|cross-compile|all] [act args...]" >&2
    exit 2
    ;;
esac

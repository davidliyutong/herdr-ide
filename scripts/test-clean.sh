#!/usr/bin/env bash
# Safely cleans test containers, disposable VMs, leftover /tmp/hie-* homes,
# and test build directories without touching the user's real instance or
# unrelated containers (AGENTS.md Rule 1).
#
#   make test-clean                  # clean containers, VMs, dist/e2e*, dist/it, .machines-work
#   scripts/test-clean.sh --dry-run  # preview without deleting
#   scripts/test-clean.sh --keep-cache  # keep downloaded cloud images & herdr-core/code-server caches
#   scripts/test-clean.sh --images   # also remove locally built test Docker images
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
DRY_RUN=0
KEEP_CACHE=0
CLEAN_IMAGES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --keep-cache) KEEP_CACHE=1; shift ;;
    --images) CLEAN_IMAGES=1; shift ;;
    *) echo "usage: $0 [--dry-run] [--keep-cache] [--images]" >&2; exit 2 ;;
  esac
done

act_cmd() {
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "==> stopping disposable matrix & Windows VMs"
if command -v python3 >/dev/null 2>&1; then
  if [[ "$DRY_RUN" == 1 ]]; then
    python3 e2e/machines/machines.py status || true
    python3 e2e/machines/winvm.py status || true
  else
    if [[ "$KEEP_CACHE" == 1 ]]; then
      python3 e2e/machines/machines.py clean --keep-cache || true
      python3 e2e/machines/winvm.py clean --keep-cache || true
    else
      python3 e2e/machines/machines.py clean || true
      python3 e2e/machines/winvm.py clean || true
    fi
  fi
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "==> cleaning labelled test containers"
  for lbl in "${SLUG}.e2e" "${SLUG}-machines.image" "${SLUG}-winvm.vm"; do
    ids=$(docker ps -aq --filter "label=$lbl")
    if [[ -n "$ids" ]]; then
      # shellcheck disable=SC2086
      act_cmd docker rm -f -v $ids
    fi
  done
  for lbl in "${SLUG}.test-linux" "${SLUG}.gui-it"; do
    ids=$(docker ps -aq --filter "label=$lbl" --filter 'status=exited' --filter 'status=created' --filter 'status=dead')
    if [[ -n "$ids" ]]; then
      # shellcheck disable=SC2086
      act_cmd docker rm -f -v $ids
    fi
  done
  # Only remove stopped/exited act-ci-* containers so a concurrent `make ci-local` is not killed.
  act_ids=$(docker ps -aq --filter 'name=^act-ci-' --filter 'status=exited' --filter 'status=created' --filter 'status=dead')
  if [[ -n "$act_ids" ]]; then
    echo "==> cleaning stopped act-ci-* containers"
    # shellcheck disable=SC2086
    act_cmd docker rm -f -v $act_ids
  fi
  if [[ "$CLEAN_IMAGES" == 1 ]]; then
    echo "==> removing built test images"
    for img in "${SLUG}-e2e-sshd" "${SLUG}-e2e-screenshots" "${SLUG}-gui-it" "${SLUG}-linux-test" "${SLUG}-act-ubuntu:24.04"; do
      if docker image inspect "$img" >/dev/null 2>&1; then
        act_cmd docker rmi "$img" || true
      fi
    done
  fi
fi

echo "==> checking stale /tmp/hie-* test homes"
for d in /tmp/hie-*; do
  [[ -d "$d" ]] || continue
  marker="$d/e2e-instance.json"
  [[ -f "$marker" ]] || continue
  pid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid", 0))' "$marker" 2>/dev/null || echo 0)
  if [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]] && kill -0 "$pid" 2>/dev/null; then
    echo "    keeping active $d (pid $pid)"
    continue
  fi
  act_cmd rm -rf "$d"
done

echo "==> cleaning test build outputs"
shopt -s nullglob
targets=(dist/e2e-* dist/act-artifacts)
if [[ "$KEEP_CACHE" == 1 ]]; then
  for sub in dist/e2e/*; do
    [[ "$(basename "$sub")" == "code-server" ]] && continue
    targets+=("$sub")
  done
  for sub in dist/it/*; do
    [[ "$(basename "$sub")" == "code-server" ]] && continue
    targets+=("$sub")
  done
else
  targets+=(dist/e2e dist/it)
fi
shopt -u nullglob
for t in "${targets[@]}"; do
  [[ -e "$t" ]] && act_cmd rm -rf "$t"
done
echo "==> done"

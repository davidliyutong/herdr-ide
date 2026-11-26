#!/usr/bin/env bash
# Ships the current working tree (excluding gitignored files such as `.env`,
# `node_modules/`, `dist/`, `.machines-work/`) to a remote Linux physical host
# over SSH, runs the selected test suite in an isolated temporary directory,
# and removes the remote directory on exit.
#
# Configure `LINUX_TEST_HOST` (and optional `LINUX_TEST_SSH_OPTS`) in `.env`
# (gitignored; see `.env.example`) or pass them in the environment:
#
#   make test-remote                         # runs `make test-doctor` on LINUX_TEST_HOST
#   make test-remote SUITE=it                # runs `make it` (native Xvfb/herdr-core)
#   make test-remote SUITE=test-linux        # runs `make test-linux`
#   make test-remote SUITE=e2e               # runs `E2E_REQUIRE_DOCKER=1 make e2e`
#   make test-remote SUITE=ci-e2e            # runs `make ci-local JOB=e2e` (Linux host net)
#   make test-remote SUITE=win-dockur        # runs `make test-win WIN_ARGS='--dockur'`
#   make test-remote SUITE=check             # runs `make check && make test`
#   scripts/test-remote.sh --host linux-kvm -- make test-doctor
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

# shellcheck source=scripts/load-env.sh
source "$ROOT/scripts/load-env.sh"
load_repo_dotenv "$ROOT"

SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
HOST="${LINUX_TEST_HOST:-}"
SSH_OPTS_RAW="${LINUX_TEST_SSH_OPTS:-${MACHINES_SSH_OPTS:-}}"
SUITE="${SUITE:-${REMOTE_SUITE:-doctor}}"
KEEP_REMOTE="${KEEP_REMOTE:-0}"
CUSTOM_CMD=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --suite) SUITE="$2"; shift 2 ;;
    --keep) KEEP_REMOTE=1; shift ;;
    --) shift; CUSTOM_CMD=("$@"); break ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      SUITE="$1"
      shift
      ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "LINUX_TEST_HOST is not set (set it in gitignored .env or pass --host <ssh-alias>)" >&2
  exit 2
fi

ssh_cmd=(ssh -o ServerAliveInterval=15)
if [[ -n "$SSH_OPTS_RAW" ]]; then
  # Split SSH_OPTS_RAW safely via python3 shlex (handles quoted paths and ~).
  while IFS= read -r -d '' tok; do
    if [[ "$tok" == "~/"* ]]; then tok="$HOME/${tok#\~/}"; fi
    ssh_cmd+=("$tok")
  done < <(python3 -c 'import shlex, sys; sys.stdout.buffer.write(b"\0".join(t.encode() for t in shlex.split(sys.argv[1])) + b"\0")' "$SSH_OPTS_RAW")
fi
ssh_cmd+=("$HOST")

run_id=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
rdir_rel="${SLUG}-remote-test-${run_id}"
flist=$(mktemp)
remote_clean() {
  rm -f "$flist"
  if [[ "$KEEP_REMOTE" != 1 ]]; then
    echo "==> remote $HOST: cleaning ~/$rdir_rel" >&2
    "${ssh_cmd[@]}" "rm -rf \"\$HOME/$rdir_rel\"" </dev/null >/dev/null 2>&1 || true
  else
    echo "==> remote $HOST: kept ~/$rdir_rel (--keep)" >&2
  fi
}
trap remote_clean EXIT

tar_cmd=(tar)
if [[ "$(uname -s)" == Darwin ]]; then
  tar_cmd+=(--no-xattrs --no-mac-metadata)
fi

# Packages tracked + untracked non-ignored files only; `.env` is always excluded.
git -C "$ROOT" ls-files -co --exclude-standard -z | tr '\0' '\n' > "$flist"

echo "==> remote $HOST: uploading working tree snapshot to ~/$rdir_rel"
# Initialize a single-commit Git repository containing all uploaded snapshot
# files so tools like `act` and `git ls-files` see a populated repository.
# Note: commit history and remotes are intentionally absent from the snapshot.
COPYFILE_DISABLE=1 "${tar_cmd[@]}" -C "$ROOT" -T "$flist" -cf - \
  | "${ssh_cmd[@]}" "mkdir -p \"\$HOME/$rdir_rel\" && tar -xf - -C \"\$HOME/$rdir_rel\" && git -C \"\$HOME/$rdir_rel\" init -q && git -C \"\$HOME/$rdir_rel\" add -A && git -C \"\$HOME/$rdir_rel\" -c user.name=remote -c user.email=remote@local commit -q -m snapshot"

if [[ ${#CUSTOM_CMD[@]} -gt 0 ]]; then
  quoted_custom=$(python3 -c 'import shlex, sys; print(shlex.join(sys.argv[1:]))' "${CUSTOM_CMD[@]}")
  body="$quoted_custom"
else
  case "$SUITE" in
    doctor)
      body='make test-doctor'
      ;;
    check)
      body='make deps && make check && make test'
      ;;
    test-linux)
      body='pnpm -C backend install --frozen-lockfile && make test-linux'
      ;;
    it)
      body='pnpm -C backend install --frozen-lockfile && make it'
      ;;
    e2e)
      body='make deps && E2E_REQUIRE_DOCKER=1 make e2e'
      ;;
    ci-e2e)
      body='make ci-local JOB=e2e'
      ;;
    ci-local)
      body='make ci-local JOB=check && make ci-local JOB=integration'
      ;;
    win-dockur)
      body='make test-win WIN_ARGS="--dockur --suite all"'
      ;;
    *)
      echo "unknown suite: $SUITE (expected doctor|check|test-linux|it|e2e|ci-e2e|ci-local|win-dockur, or pass -- <cmd>)" >&2
      exit 2
      ;;
  esac
fi

echo "==> remote $HOST: running suite=$SUITE"
# Login shell loads profile PATH; also pick up standard user-local installs
# (~/.bun/bin, ~/.local/share/pnpm, ~/.local/bin, ~/.nvm default) which
# non-interactive SSH skips when initialized in ~/.bashrc. DOTENV_DISABLE=1
# guarantees no stray remote .env interferes.
remote_env='export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi'
printf 'set -euo pipefail\ncd "$HOME/%s"\n%s\nexport DOTENV_DISABLE=1\n%s\n' "$rdir_rel" "$remote_env" "$body" \
  | "${ssh_cmd[@]}" 'bash -l -s'

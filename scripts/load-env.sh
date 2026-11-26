#!/usr/bin/env bash
# Safely loads KEY=VALUE pairs from the repository's gitignored `.env` file
# without executing arbitrary shell code (no `source`/`eval` of `.env`).
# Delegates to `scripts/dotenv.py` (the single canonical parser shared with
# `e2e/machines/machines.py` and `e2e/machines/winvm.py`) whenever `python3`
# is available, with a matching pure-shell fallback for minimal containers.
#
# - Explicit environment variables always take precedence over `.env`.
# - Set DOTENV_DISABLE=1 to skip loading `.env`.
# - Intended for test/harness scripts only; never loaded by `make test`.

load_repo_dotenv() {
  [[ "${DOTENV_DISABLE:-}" == 1 ]] && return 0
  local root="${1:-$PWD}"
  local envfile="$root/.env"
  [[ -f "$envfile" ]] || return 0

  local key val is_set
  _dotenv_export_if_unset() {
    local k="$1" v="$2" set_flag
    if [[ -n "${ZSH_VERSION:-}" ]]; then
      set_flag="${(P)k+x}"
    else
      set_flag="${!k+x}"
    fi
    if [[ -z "$set_flag" ]]; then
      export "$k=$v"
    fi
  }

  # Canonical path: share exact parsing semantics with scripts/dotenv.py.
  if command -v python3 >/dev/null 2>&1 && [[ -f "$root/scripts/dotenv.py" ]]; then
    while IFS= read -r -d '' key && IFS= read -r -d '' val; do
      _dotenv_export_if_unset "$key" "$val"
    done < <(python3 -I "$root/scripts/dotenv.py" "$envfile")
    return 0
  fi

  # Fallback when python3 is absent (must stay in sync with scripts/dotenv.py).
  local line first last
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if (( ${#val} >= 2 )); then
      first="${val%"${val#?}"}"
      last="${val#"${val%?}"}"
      if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
        val="${val#?}"
        val="${val%?}"
      fi
    fi
    if [[ "$val" == "~" ]]; then
      val="$HOME"
    elif [[ "$val" == "~/"* ]]; then
      val="$HOME/${val#\~/}"
    fi
    _dotenv_export_if_unset "$key" "$val"
  done < "$envfile"
}

#!/usr/bin/env bash
# Prints this host's platform as the build names it, <os>-<arch>
# (darwin-arm64, linux-amd64, windows-amd64); with --slash, <os>/<arch>.
set -euo pipefail
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) echo "unsupported system $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
if [[ "${1:-}" == --slash ]]; then echo "$os/$arch"; else echo "$os-$arch"; fi

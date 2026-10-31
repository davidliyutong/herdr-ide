#!/usr/bin/env bash
# Native macOS packaging. ARCH=arm64|x64; VERSION must be a semver.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "Desktop packaging requires macOS." >&2; exit 1; }
mode=${1:-dmg}
case "$mode" in app|dmg|dev) ;; *) echo "usage: $0 app|dmg|dev" >&2; exit 2 ;; esac
DESKTOP_ARCH=${ARCH:-$(node -p process.arch)}
case "$DESKTOP_ARCH" in
  arm64) go_arch=arm64 ;;
  x64) go_arch=amd64 ;;
  *) echo "ARCH must be arm64 or x64" >&2; exit 2 ;;
esac
if [[ "$mode" == dev && "$DESKTOP_ARCH" != "$(node -p process.arch)" ]]; then
  echo "Development requires the host Node/Electron architecture." >&2
  exit 2
fi
export DESKTOP_ARCH
export VERSION=${VERSION:-$(node -p 'require("./desktop/package.json").version')}

pnpm -C desktop install --frozen-lockfile
TARGETS="darwin/$go_arch" scripts/build.sh
pnpm -C desktop build

case "$mode" in
  dev)
    slug=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
    prefix=$(echo "$slug" | tr 'a-z-' 'A-Z_')
    env "${prefix}_DESKTOP_DEV=1" pnpm -C desktop start
    ;;
  app) pnpm -C desktop exec electron-builder --mac --dir "--$DESKTOP_ARCH" --publish never ;;
  dmg) pnpm -C desktop exec electron-builder --mac dmg "--$DESKTOP_ARCH" --publish never ;;
esac

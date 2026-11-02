#!/usr/bin/env bash
# Native macOS packaging. ARCH=arm64|x64; VERSION, when set, must be a semver,
# optionally with the release tag's leading v (dropped for the app metadata).
#
#   app      the .app in dist/desktop/mac[-arm64]/
#   dmg      the .app and a DMG
#   install  the .app, copied over INSTALL_DIR/<app> (default /Applications).
#            A copy running from there is quit first (its core stops, herdr's
#            sessions keep running) and started again afterwards.
#   dev      unpackaged Electron in development mode
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "Desktop packaging requires macOS." >&2; exit 1; }
mode=${1:-dmg}
case "$mode" in app|dmg|install|dev) ;; *) echo "usage: $0 app|dmg|install|dev" >&2; exit 2 ;; esac
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
INSTALL_DIR=${INSTALL_DIR:-/Applications}
if [[ "$mode" == install && ! ( -d "$INSTALL_DIR" && -w "$INSTALL_DIR" ) ]]; then
  echo "$INSTALL_DIR is not a writable directory." >&2
  exit 1
fi
# VERSION is optional. Without it the core reports `git describe` like
# scripts/build.sh, and the app metadata uses desktop/package.json.

pnpm -C desktop install --frozen-lockfile
TARGETS="darwin/$go_arch" scripts/build.sh
pnpm -C desktop build

case "$mode" in
  dev) pnpm -C desktop start ;; # unpackaged Electron always runs in development mode
  app|install) pnpm -C desktop exec electron-builder --mac --dir "--$DESKTOP_ARCH" --publish never ;;
  dmg) pnpm -C desktop exec electron-builder --mac dmg "--$DESKTOP_ARCH" --publish never ;;
esac
[[ "$mode" == install ]] || exit 0

name=$(sed -n "s/^export const APP_NAME = '\\(.*\\)';$/\\1/p" web/src/brand.ts)
built=dist/desktop/mac$([[ "$DESKTOP_ARCH" == x64 ]] || echo "-$DESKTOP_ARCH")/$name.app
dest=$INSTALL_DIR/$name.app
test -d "$built"
# The installed app's main process; its helpers and core run from other paths.
main="^$dest/Contents/MacOS/$name( |\$)"
reopen=
if pgrep -f "$main" >/dev/null; then
  echo "==> quitting $dest"
  reopen=1
  # SIGTERM quits like the menu: the app stops its core (up to 20 s) first.
  pkill -TERM -f "$main" || true
  for _ in $(seq 60); do
    pgrep -f "$main" >/dev/null || break
    sleep 0.5
  done
  if pgrep -f "$main" >/dev/null; then
    echo "$name did not quit within 30 s; quit it and run this again." >&2
    exit 1
  fi
fi
echo "==> installing $dest"
# Copied beside the old app first, so a failed copy leaves that one in place.
tmp=$INSTALL_DIR/.$name.app.installing
rm -rf "$tmp"
ditto "$built" "$tmp"
rm -rf "$dest"
mv "$tmp" "$dest"
if [[ -n "$reopen" ]]; then
  echo "==> reopening $name"
  open "$dest"
fi

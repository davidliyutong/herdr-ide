#!/usr/bin/env bash
# The Electron desktop app on macOS, Windows and Linux, for this machine's
# system (DESKTOP_OS=mac|win|linux packages another one's --dir app, to
# check the packaging; installers are built on their own system).
# ARCH=arm64|x64 (default: this machine's); VERSION, when set, must be a
# semver, optionally with the release tag's leading v (dropped for the app
# metadata).
#
#   build    the web UI, the payloads the core carries (machine builds,
#            herdr-core, encoders, the VS Code extension) and the shell with
#            the core bundled for its utility process
#   app      build, then the unpacked app in dist/desktop/<os>[-<arch>][-unpacked]/
#   dist     build, then the installers: macOS DMG and zip, Windows NSIS
#            setup, Linux AppImage and deb
#   install  (macOS) the .app, copied over INSTALL_DIR/<app> (default
#            /Applications). A copy running from there is quit first (its
#            core stops, the terminal cores keep running) and started again
#            afterwards.
#   dev      build, then unpackaged Electron in development mode
#
# SKIP_BUILD=1 packages what `build` made (the release workflow's signing
# step, the only one with the secrets, runs only electron-builder).
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${1:-dist}
case "$mode" in build|app|dist|install|dev) ;; *) echo "usage: $0 build|app|dist|install|dev" >&2; exit 2 ;; esac
case "$(uname -s)" in
  Darwin) host=mac ;;
  Linux) host=linux ;;
  MINGW*|MSYS*|CYGWIN*) host=win ;;
  *) echo "unsupported system $(uname -s)" >&2; exit 1 ;;
esac
os=${DESKTOP_OS:-$host}
case "$os" in
  mac|win|linux) ;;
  *) echo "DESKTOP_OS must be mac, win or linux" >&2; exit 2 ;;
esac
DESKTOP_ARCH=${ARCH:-$(node -p process.arch)}
case "$DESKTOP_ARCH" in
  arm64|x64) ;;
  *) echo "ARCH must be arm64 or x64" >&2; exit 2 ;;
esac
if [[ "$os" == win && "$DESKTOP_ARCH" != x64 ]]; then
  echo "The Windows app is built for x64." >&2
  exit 2
fi
if [[ "$os" != "$host" && "$mode" != build && "$mode" != app ]]; then
  echo "Installers and development runs are built on their own system ($os)." >&2
  exit 2
fi
if [[ "$mode" == dev && "$DESKTOP_ARCH" != "$(node -p process.arch)" ]]; then
  echo "Development requires the host Node/Electron architecture." >&2
  exit 2
fi
if [[ "$mode" == install && "$os" != mac ]]; then
  echo "install copies the macOS app; use the installers elsewhere (mode dist)." >&2
  exit 2
fi
export DESKTOP_ARCH
# The app carries its own platform's executable of the TypeScript build
# (scripts/build.sh; not with MACHINE=go), for the local machine (none on
# Windows, where no machine side runs); other machines get theirs from the
# release.
case "$os" in
  mac) PAYLOAD_MACHINES="darwin-${DESKTOP_ARCH/x64/amd64}" ;;
  linux) PAYLOAD_MACHINES="linux-${DESKTOP_ARCH/x64/amd64}" ;;
  win) PAYLOAD_MACHINES="" ;;
esac
export PAYLOAD_MACHINES
INSTALL_DIR=${INSTALL_DIR:-/Applications}
if [[ "$mode" == install && ! ( -d "$INSTALL_DIR" && -w "$INSTALL_DIR" ) ]]; then
  echo "$INSTALL_DIR is not a writable directory." >&2
  exit 1
fi
# VERSION is optional. Without it the core reports `git describe` like
# scripts/build.sh, and the app metadata uses desktop/package.json.

if [[ -z "${SKIP_BUILD:-}" ]]; then
  pnpm -C desktop install --frozen-lockfile
  pnpm -C backend install --frozen-lockfile
  PAYLOAD_ONLY=1 scripts/build.sh
  pnpm -C desktop build
fi

# Signing secrets the release workflow passes are empty when they are not
# set; electron-builder would take an empty CSC_LINK as a path (the current
# directory) instead of signing ad hoc.
for v in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
  [[ -n "${!v:-}" ]] || unset "$v"
done
builder=(pnpm -C desktop exec electron-builder "--$os" "--$DESKTOP_ARCH" --publish never)
case "$mode" in
  build) ;;
  dev) pnpm -C desktop start ;; # unpackaged Electron always runs in development mode
  app|install) "${builder[@]}" --dir ;;
  dist) "${builder[@]}" ;;
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

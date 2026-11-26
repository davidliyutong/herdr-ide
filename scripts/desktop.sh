#!/usr/bin/env bash
# Stage 2: The Electron desktop app on macOS, Windows and Linux.
#
# Runs the Stage 1 compiled Bun hub executable (`<slug> desktop`) directly
# and bundles all 6 Stage 1 machine release archives (<slug>-<platform>.tar.gz
# + SHA256SUMS) into the app (release and dev alike), so Desktop and CLI
# share the exact same hub runtime and remote deployment binaries.
#
#   build    ensures Stage 1 archives exist (runs scripts/build.sh unless
#            STAGE1_ARCHIVES is provided), stages the host hub binary + all
#            6 machine archives + licenses into dist/desktop-stage, and
#            builds the Electron shell
#   app      build, then the unpacked app in dist/desktop/<os>[-<arch>][-unpacked]/
#   dist     build, then the installers: macOS DMG and zip, Windows NSIS
#            setup, Linux AppImage and deb
#   install  (macOS) the .app, copied over INSTALL_DIR/<app> (default
#            /Applications)
#   dev      build, then unpackaged Electron in development mode
#
# Stage 2 CI inputs:
#   STAGE1_ARCHIVES=<dir>  directory holding Stage 1's 6 *.tar.gz + SHA256SUMS
#   STAGE1_HUB_EXE=<file>  explicit Stage 1 hub binary (required when os=win
#                          and STAGE1_ARCHIVES is used)
#   SKIP_BUILD=1           package what `build` already staged
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
export DESKTOP_OS="$os"
export DESKTOP_ARCH

INSTALL_DIR=${INSTALL_DIR:-/Applications}
if [[ "$mode" == install && ! ( -d "$INSTALL_DIR" && -w "$INSTALL_DIR" ) ]]; then
  echo "$INSTALL_DIR is not a writable directory." >&2
  exit 1
fi

# The app's version is its hub's (electron-builder.cjs reads VERSION).
source scripts/version.sh

slug=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
cpu=${DESKTOP_ARCH/x64/amd64}
stage=dist/desktop-stage

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if [[ -n "${STAGE1_ARCHIVES:-}" && -z "${STAGE1_HUB_EXE:-}" && "$os" == win ]]; then
    echo "STAGE1_HUB_EXE is required when STAGE1_ARCHIVES is set for Windows." >&2
    exit 2
  fi
  archives_dir=${STAGE1_ARCHIVES:-}
  if [[ -z "$archives_dir" ]]; then
    echo "==> Stage 1: building full cross-platform binaries"
    WITH_WINDOWS=$([[ "$os" == win ]] && echo 1 || echo 0) scripts/build.sh
    archives_dir=dist/release
  fi

  rm -rf "$stage"
  mkdir -p "$stage/bin" "$stage/machines" "$stage/licenses"

  # Copy all 6 Stage 1 machine release archives + SHA256SUMS.
  cp "$archives_dir/SHA256SUMS" "$stage/machines/SHA256SUMS"
  for k in linux-amd64 linux-arm64 linux-amd64-musl linux-arm64-musl darwin-amd64 darwin-arm64; do
    cp "$archives_dir/$slug-$k.tar.gz" "$stage/machines/$slug-$k.tar.gz"
  done

  # Extract third-party licenses from a Stage 1 archive so Stage 2 needs no
  # separate backend/web build when STAGE1_ARCHIVES is supplied.
  ref_pkg="$slug-linux-amd64"
  tmp_lic=$(mktemp -d)
  tar -xzf "$archives_dir/$ref_pkg.tar.gz" -C "$tmp_lic" "$ref_pkg/licenses.md" "$ref_pkg/licenses"
  cp "$tmp_lic/$ref_pkg/licenses.md" "$stage/licenses/licenses.md"
  cp -R "$tmp_lic/$ref_pkg/licenses/herdr-core" "$stage/licenses/herdr-core"
  cp -R "$tmp_lic/$ref_pkg/licenses/herdr-detect" "$stage/licenses/herdr-detect"
  cp -R "$tmp_lic/$ref_pkg/licenses/encoder" "$stage/licenses/encoder"
  rm -rf "$tmp_lic"

  # Place this desktop target's Stage 1 compiled Bun hub executable.
  # Unless STAGE1_HUB_EXE is explicitly given, POSIX targets always extract
  # the hub from the selected Stage 1 archive so an older dist/<slug>-<key>
  # from a previous local build cannot be mixed with newer machine archives.
  if [[ -n "${STAGE1_HUB_EXE:-}" ]]; then
    if [[ "$os" == win ]]; then
      cp "$STAGE1_HUB_EXE" "$stage/bin/$slug.exe"
    else
      cp "$STAGE1_HUB_EXE" "$stage/bin/$slug"
      chmod 755 "$stage/bin/$slug"
    fi
  elif [[ "$os" == win ]]; then
    cp "dist/$slug-windows-amd64.exe" "$stage/bin/$slug.exe"
  else
    hub_os=$([[ "$os" == mac ]] && echo darwin || echo linux)
    hub_key="$hub_os-$cpu"
    tar -xzf "$archives_dir/$slug-$hub_key.tar.gz" -O "$slug-$hub_key/$slug" > "$stage/bin/$slug"
    chmod 755 "$stage/bin/$slug"
  fi

  pnpm -C desktop install --frozen-lockfile
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
  dev)
    env_prefix=$(node -p "'${slug}'.toUpperCase().replaceAll('-', '_') + '_'")
    hub_bin_var="${env_prefix}HUB_BIN"
    agent_dir_var="${env_prefix}AGENT_DIR"
    hub_exe="$slug$([[ "$os" == win ]] && echo .exe || true)"
    export "${hub_bin_var}=${!hub_bin_var:-$PWD/$stage/bin/$hub_exe}"
    export "${agent_dir_var}=${!agent_dir_var:-$PWD/$stage/machines}"
    pnpm -C desktop start
    ;;
  app|install) "${builder[@]}" --dir ;;
  dist) "${builder[@]}" ;;
esac
[[ "$mode" == install ]] || exit 0

name=$(sed -n "s/^export const APP_NAME = '\\(.*\\)';$/\\1/p" web/src/brand.ts)
built=dist/desktop/mac$([[ "$DESKTOP_ARCH" == x64 ]] || echo "-$DESKTOP_ARCH")/$name.app
dest=$INSTALL_DIR/$name.app
if [[ ! -d "$built" ]]; then
  echo "electron-builder made no $built (ARCH=$DESKTOP_ARCH); nothing installed." >&2
  exit 1
fi
main="^$dest/Contents/MacOS/$name( |\$)"
reopen=
if pgrep -f "$main" >/dev/null; then
  echo "==> quitting $dest"
  reopen=1
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
tmp=$INSTALL_DIR/.$name.app.installing
rm -rf "$tmp"
ditto "$built" "$tmp"
rm -rf "$dest"
mv "$tmp" "$dest"
if [[ -n "$reopen" ]]; then
  echo "==> reopening $name"
  open "$dest"
fi

#!/usr/bin/env bash
# Builds the macOS application: the Swift package in macos/ around the core.
#
#   scripts/macos-app.sh         dist/macos/<name>.app with the core inside
#   scripts/macos-app.sh sign    signs (and notarizes) that bundle again
#   scripts/macos-app.sh test    the package's unit tests
#   scripts/macos-app.sh build   the package only (debug), for development
#
# The .app is built by Xcode from macos/xcode/project.yml (XcodeGen) for
# this machine's architecture, like the core inside it, and signed here. SKIP_CORE=1 reuses the core already in dist/ instead of
# running scripts/build.sh; OUT_DIR puts the bundle somewhere else than
# dist/macos (a copy in use there is not replaced); SIGN_IDENTITY and
# NOTARY_PROFILE select a
# Developer ID signature and notarization (see below). The release workflow
# builds the bundle ad hoc and signs it with `sign` in a step of its own,
# the only one that holds the signing secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "The macOS application is built on macOS." >&2; exit 1; }
mode=${1:-app}
case "$mode" in app|sign|test|build) ;; *) echo "usage: $0 [app|sign|test|build]" >&2; exit 2 ;; esac

# Swift needs Xcode's toolchain; use the installed Xcode when the active
# developer directory is the command line tools.
if [[ -z "${DEVELOPER_DIR:-}" ]] && ! xcodebuild -version >/dev/null 2>&1 && [[ -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
NAME=$(sed -n 's/^[[:space:]]*Name = "\(.*\)"$/\1/p' internal/brand/brand.go)
out=${OUT_DIR:-dist/macos}
app="$out/$NAME.app"
res="$app/Contents/Resources"

# Sign from the inside out: the core in Resources, then the bundle, which
# seals everything in it. SIGN_IDENTITY is a certificate's name
# ("Developer ID Application: ..."); the default "-" signs ad hoc, which
# runs on this machine and on others after the user allows it.
# NOTARY_PROFILE names a keychain profile of `xcrun notarytool
# store-credentials`: with a Developer ID signature the bundle is notarized
# and the ticket stapled.
sign() {
  identity=${SIGN_IDENTITY:--}
  echo "==> codesign ($identity)"
  stamp=(--timestamp)
  [[ "$identity" == "-" ]] && stamp=(--timestamp=none)
  codesign --force --options runtime "${stamp[@]}" --sign "$identity" "$res/bin/$SLUG"
  codesign --force --options runtime "${stamp[@]}" --sign "$identity" "$app"
  codesign --verify --deep --strict "$app"
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then
    [[ "$identity" != "-" ]] || { echo "notarization needs SIGN_IDENTITY" >&2; exit 1; }
    echo "==> notarize"
    zip=$out/$SLUG-notarize.zip
    ditto -c -k --keepParent "$app" "$zip"
    xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    rm -f "$zip"
    xcrun stapler staple "$app"
  fi
}

if [[ "$mode" == sign ]]; then
  [[ -d "$app" ]] || { echo "missing $app: run $0 first" >&2; exit 1; }
  sign
  exit 0
fi

scripts/fetch-ghostty.sh
case "$mode" in
  test) exec swift test --package-path macos ;;
  build) exec swift build --package-path macos ;;
esac

case "$(uname -m)" in
  arm64) go_arch=arm64 ;;
  x86_64) go_arch=amd64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
VERSION=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
short=${VERSION#v}
[[ "$short" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || short=0.0.0

if [[ -z "${SKIP_CORE:-}" ]]; then
  TARGETS="darwin/$go_arch" scripts/build.sh
fi
core=dist/$SLUG-darwin-$go_arch
for f in "$core" dist/hc/licenses/LICENSE web/dist/licenses.md; do
  [[ -e "$f" ]] || { echo "missing $f: run scripts/build.sh" >&2; exit 1; }
done

command -v xcodegen >/dev/null || { echo "xcodegen is required (brew install xcodegen)" >&2; exit 1; }
echo "==> xcodebuild"
export APP_NAME="$NAME" APP_SLUG="$SLUG" APP_VERSION="$short"
(cd macos/xcode && xcodegen generate --quiet)
derived=macos/.build/xcode
xcodebuild -project macos/xcode/MacApp.xcodeproj -scheme App -configuration Release \
  -derivedDataPath "$derived" -skipPackagePluginValidation -quiet \
  ARCHS="$(uname -m)" ONLY_ACTIVE_ARCH=YES build

rm -rf "$app"
mkdir -p "$out"
cp -R "$derived/Build/Products/Release/$NAME.app" "$app"
mkdir -p "$res/bin" "$res/licenses/ghostty"
cp "$core" "$res/bin/$SLUG"
chmod 755 "$res/bin/$SLUG"
# The notices of everything the core embeds, as in the release archives
# and the Electron app: its Go modules, the web UI's bundle (licenses.md),
# the agent detection's manifests, the video encoder and herdr-core.
cp LICENSE THIRD_PARTY_NOTICES.md web/dist/licenses.md "$res/licenses/"
cp -R licenses/herdr-detect "$res/licenses/herdr-detect"
cp -R licenses/encoder "$res/licenses/encoder"
cp -R dist/hc/licenses "$res/licenses/herdr-core"
# Ghostty's own license (the renderer is Ghostty built by libghostty-spm,
# at the commit the web UI's emulator is built from), the package's and
# that of its color schemes.
cp web/src/vt/LICENSE "$res/licenses/ghostty/LICENSE"
cp macos/.deps/libghostty-spm/LICENSE "$res/licenses/ghostty/LICENSE-libghostty-spm"
cp macos/.deps/libghostty-spm/Sources/GhosttyTheme/LICENSE "$res/licenses/ghostty/LICENSE-themes"

sign
echo "==> $app ($(du -sh "$app" | cut -f1))"

#!/usr/bin/env bash
# Builds the macOS application: the Swift package in macos/ around the core.
#
#   scripts/macos-app.sh         dist/macos/<name>.app with the core inside
#   scripts/macos-app.sh test    the package's unit tests
#   scripts/macos-app.sh build   the package only (debug), for development
#
# The .app is built by Xcode from macos/xcode/project.yml (XcodeGen) for
# this machine's architecture, like the core inside it, and signed here. SKIP_CORE=1 reuses the core already in dist/ instead of
# running scripts/build.sh; OUT_DIR puts the bundle somewhere else than
# dist/macos (a copy in use there is not replaced); SIGN_IDENTITY and
# NOTARY_PROFILE select a
# Developer ID signature and notarization (see below).
set -euo pipefail
cd "$(dirname "$0")/.."

[[ $(uname -s) == Darwin ]] || { echo "The macOS application is built on macOS." >&2; exit 1; }
mode=${1:-app}
case "$mode" in app|test|build) ;; *) echo "usage: $0 [app|test|build]" >&2; exit 2 ;; esac

# Swift needs Xcode's toolchain; use the installed Xcode when the active
# developer directory is the command line tools.
if [[ -z "${DEVELOPER_DIR:-}" ]] && ! xcodebuild -version >/dev/null 2>&1 && [[ -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

scripts/fetch-ghostty.sh
case "$mode" in
  test) exec swift test --package-path macos ;;
  build) exec swift build --package-path macos ;;
esac

SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
NAME=$(sed -n 's/^[[:space:]]*Name = "\(.*\)"$/\1/p' internal/brand/brand.go)
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
herdr=dist/herdr/herdr-darwin-$go_arch
for f in "$core" "$herdr" dist/hc/licenses/LICENSE; do
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

out=${OUT_DIR:-dist/macos}
app="$out/$NAME.app"
rm -rf "$app"
mkdir -p "$out"
cp -R "$derived/Build/Products/Release/$NAME.app" "$app"
res="$app/Contents/Resources"
mkdir -p "$res/bin" "$res/licenses/ghostty"
cp "$core" "$res/bin/$SLUG"
# Beside the core, where it finds the bundled herdr (docs/features/15).
cp "$herdr" "$res/bin/herdr"
chmod 755 "$res/bin/"*
cp LICENSE THIRD_PARTY_NOTICES.md "$res/licenses/"
cp -R licenses/herdr "$res/licenses/herdr"
cp -R licenses/herdr-detect "$res/licenses/herdr-detect"
cp -R dist/hc/licenses "$res/licenses/herdr-core"
cp macos/.deps/libghostty-spm/LICENSE "$res/licenses/ghostty/LICENSE-libghostty-spm"
cp macos/.deps/libghostty-spm/Sources/GhosttyTheme/LICENSE "$res/licenses/ghostty/LICENSE-themes"

# Sign from the inside out: the executables in Resources, then the bundle,
# which seals everything in it. SIGN_IDENTITY is a certificate's name
# ("Developer ID Application: ..."); the default "-" signs ad hoc, which
# runs on this machine and on others after the user allows it.
identity=${SIGN_IDENTITY:--}
echo "==> codesign ($identity)"
stamp=(--timestamp)
[[ "$identity" == "-" ]] && stamp=(--timestamp=none)
for exe in "$res/bin/$SLUG" "$res/bin/herdr"; do
  codesign --force --options runtime "${stamp[@]}" --sign "$identity" "$exe"
done
codesign --force --options runtime "${stamp[@]}" --sign "$identity" "$app"
codesign --verify --deep --strict "$app"

# NOTARY_PROFILE names a keychain profile of `xcrun notarytool
# store-credentials`: with a Developer ID signature the bundle is notarized
# and the ticket stapled.
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  [[ "$identity" != "-" ]] || { echo "notarization needs SIGN_IDENTITY" >&2; exit 1; }
  echo "==> notarize"
  zip=$out/$SLUG-notarize.zip
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
  rm -f "$zip"
  xcrun stapler staple "$app"
fi
echo "==> $app ($(du -sh "$app" | cut -f1))"

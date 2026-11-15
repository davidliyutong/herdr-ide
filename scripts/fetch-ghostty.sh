#!/usr/bin/env bash
# Fetches the terminal renderer of the macOS application into macos/.deps/:
# the libghostty-spm Swift package at a pinned tag, accepted only when the
# tag is the pinned commit (all 40 hex digits), and the GhosttyKit
# XCFramework its manifest names, checked against the pinned SHA-256. The
# package is then used by path with the framework beside it, so SwiftPM
# downloads nothing itself. A checkout fetched before is used again only
# while it is still that commit.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=2.2.2026111302
COMMIT=41694d165597b356ed30e2c76b68cc83c8442682
ASSET=upstream.cf5519b22f91
SHA256=220e1efeeb28cdffb815f82849940fd60b8050e4515e7fb9f6ec28ec9e88baeb
REPO=https://github.com/Lakr233/libghostty-spm

deps=macos/.deps
pkg=$deps/libghostty-spm
stamp=$pkg/.fetched
want="$TAG $COMMIT $ASSET $SHA256"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "COMMIT must be a full commit id" >&2; exit 1; }
if [[ -f "$stamp" && "$(cat "$stamp")" == "$want" && "$(git -C "$pkg" rev-parse HEAD 2>/dev/null)" == "$COMMIT" ]]; then
  exit 0
fi

mkdir -p "$deps"
zip=$deps/GhosttyKit-$ASSET.xcframework.zip
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
if [[ ! -f "$zip" || "$(sum "$zip")" != "$SHA256" ]]; then
  echo "==> GhosttyKit $ASSET"
  curl -fL --retry 3 -o "$zip.part" "$REPO/releases/download/$ASSET/GhosttyKit.xcframework.zip"
  if [[ "$(sum "$zip.part")" != "$SHA256" ]]; then
    echo "GhosttyKit.xcframework.zip: sha256 $(sum "$zip.part") does not match $SHA256" >&2
    rm -f "$zip.part"
    exit 1
  fi
  mv "$zip.part" "$zip"
fi

echo "==> libghostty-spm $TAG"
rm -rf "$pkg"
git -c advice.detachedHead=false clone -q --depth 1 --branch "$TAG" "$REPO.git" "$pkg"
got=$(git -C "$pkg" rev-parse HEAD)
if [[ "$got" != "$COMMIT" ]]; then
  echo "libghostty-spm $TAG is $got, expected $COMMIT" >&2
  rm -rf "$pkg"
  exit 1
fi
mkdir -p "$pkg/BinaryTarget"
unzip -q -o "$zip" -d "$pkg/BinaryTarget"
# The manifest that takes the framework from BinaryTarget/ instead of a URL.
cp "$pkg/Package.local.swift" "$pkg/Package.swift"
echo "$want" > "$stamp"

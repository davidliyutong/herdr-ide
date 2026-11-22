#!/usr/bin/env bash
# Builds the web UI, the VS Code bridge extension, the machine builds of the
# one binary for every agent platform (the tag "machine": the commands a
# machine runs, without the server, the UI and what the core embeds; embedded
# gzip), fetches the pinned herdr-core of each agent platform
# (embedded gzip), then builds the core for TARGETS (default: host platform),
# packaged with its license notices (a Windows core, which goes into the
# desktop installer only, gets no archive). Names come from internal/brand.
#
#   scripts/build.sh                       # host archive in dist/release/
#   TARGETS="linux/amd64 darwin/arm64" scripts/build.sh
#   SKIP_WEB=1 scripts/build.sh            # reuse web/dist
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
# Local edits at the same commit need distinct versions too: the chat host
# outlives an app reinstall and only makes way for a newer build. Release
# versions stay reproducible; dirty builds are ordered by their build time.
if [[ "$VERSION" == *-dirty ]]; then
  VERSION="$VERSION.$(date -u +%s)"
fi
MODULE=$(go list -m)
SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
LDFLAGS="-s -w -X ${MODULE}/internal/agentproto.Version=${VERSION}"
AGENT_PLATFORMS=${AGENT_PLATFORMS:-"linux/amd64 linux/arm64 darwin/amd64 darwin/arm64"}
TARGETS=${TARGETS:-"$(go env GOOS)/$(go env GOARCH)"}

if [[ -z "${SKIP_WEB:-}" ]]; then
  echo "==> web"
  (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null && touch dist/.gitkeep)
fi

if [[ -z "${SKIP_EXT:-}" && -d "extensions/${SLUG}-bridge" ]]; then
  echo "==> vscode bridge extension"
  # Fixed timestamps keep the VSIX (and so the core binary) reproducible.
  (cd "extensions/${SLUG}-bridge" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null &&
    find . -path ./node_modules -prune -o -type f -exec touch -h -t 198001010000 {} + &&
    pnpm exec vsce package --no-dependencies --allow-missing-repository -o "${SLUG}-bridge.vsix" >/dev/null)
  go run ./scripts/zipnorm "extensions/${SLUG}-bridge/${SLUG}-bridge.vsix"
  cp "extensions/${SLUG}-bridge/${SLUG}-bridge.vsix" internal/embedded/ext/
fi

echo "==> machine builds"
mkdir -p dist/agents internal/embedded/agents
rm -f internal/embedded/agents/*.gz
for p in $AGENT_PLATFORMS; do
  os=${p%/*}; arch=${p#*/}
  out=dist/agents/${SLUG}-$os-$arch
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -tags machine -ldflags "$LDFLAGS" -o "$out" "./cmd/${SLUG}"
  gzip -9 -n -c "$out" > "internal/embedded/agents/${SLUG}-$os-$arch.gz"
  echo "    $os/$arch $(du -h "$out" | cut -f1)"
done

# herdr-core for machines: the pinned upstream release of every agent
# platform, verified and embedded; the build fails without it.
echo "==> herdr-core for machines"
mkdir -p internal/embedded/hc
rm -f internal/embedded/hc/*.gz
go run ./scripts/fetch-hc $AGENT_PLATFORMS

# The encoder Linux machines send program windows as video with, built by
# scripts/build-ffmpeg.sh; without it windows are always pictures.
# REQUIRE_ENCODER=1 (release builds) fails when one is missing.
rm -f internal/embedded/encoder/*.gz
for plat in linux-amd64 linux-arm64; do
  f=dist/ffmpeg/$plat/encoder.gz
  if [[ -f "$f" ]]; then
    cp "$f" "internal/embedded/encoder/encoder-$plat.gz"
    echo "==> video encoder $plat embedded"
  elif [[ "${REQUIRE_ENCODER:-}" == 1 ]]; then
    echo "missing $f: run scripts/build-ffmpeg.sh" >&2
    exit 1
  else
    echo "==> no video encoder for $plat (scripts/build-ffmpeg.sh): its machines get pictures"
  fi
done

echo "==> ${SLUG}"
for p in $TARGETS; do
  os=${p%/*}; arch=${p#*/}
  exe=
  [[ $os == windows ]] && exe=.exe
  out=dist/${SLUG}-$os-$arch$exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "$LDFLAGS" -o "$out" "./cmd/${SLUG}"
  echo "    $out $(du -h "$out" | cut -f1)"
done

echo "==> release packages"
TARGETS="$TARGETS" scripts/package.sh

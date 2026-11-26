#!/usr/bin/env bash
# Stage 1: Builds the complete headless Bun executables (hub + machine side)
# for every supported platform and packages them into dist/release/ with
# SHA256SUMS.
#
# Fetches and verifies the pinned native submodules (vt, encoder, gpupick,
# gui-helper via backend/scripts/fetch-deps.ts) and herdr-core (via
# backend/scripts/fetch-hc.ts), builds the web UI and the VS Code bridge
# extension, compiles full-featured Bun binaries with every payload
# embedded (including both Linux video encoders in every hub binary), and
# packages dist/release/<slug>-<platform>.tar.gz + dist/release/SHA256SUMS.
#
#   scripts/build.sh                       # all 6 POSIX platforms (+ windows/amd64 on Windows or WITH_WINDOWS=1)
#   TARGETS="darwin/arm64" scripts/build.sh
#   SKIP_WEB=1 scripts/build.sh            # reuse web/dist
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/version.sh
SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
HC_PLATFORMS=${HC_PLATFORMS:-"linux/amd64 linux/arm64 darwin/amd64 darwin/arm64"}
DEFAULT_TARGETS="linux/amd64 linux/arm64 linux/amd64-musl linux/arm64-musl darwin/amd64 darwin/arm64"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) DEFAULT_TARGETS="$DEFAULT_TARGETS windows/amd64" ;;
esac
if [[ "${WITH_WINDOWS:-}" == 1 && " $DEFAULT_TARGETS " != *" windows/amd64 "* ]]; then
  DEFAULT_TARGETS="$DEFAULT_TARGETS windows/amd64"
fi
TARGETS=${TARGETS:-"$DEFAULT_TARGETS"}
PAYLOAD=dist/payload
RELEASE_URL=${RELEASE_URL:-}

bun_target() {
  case "$1" in
    linux/amd64) echo bun-linux-x64-baseline ;;
    linux/arm64) echo bun-linux-arm64 ;;
    darwin/amd64) echo bun-darwin-x64 ;;
    darwin/arm64) echo bun-darwin-arm64 ;;
    linux/amd64-musl) echo bun-linux-x64-musl-baseline ;;
    linux/arm64-musl) echo bun-linux-arm64-musl ;;
    windows/amd64) echo bun-windows-x64-baseline ;;
    *) echo "unsupported hub platform: $1" >&2; return 1 ;;
  esac
}
for p in $TARGETS; do bun_target "$p" >/dev/null; done

echo "==> native submodules (vt, encoder, gpupick, gui-helper)"
bun backend/scripts/fetch-deps.ts

if [[ -z "${SKIP_WEB:-}" ]]; then
  echo "==> web"
  (cd web && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
fi

mkdir -p "$PAYLOAD/ext"
if [[ -z "${SKIP_EXT:-}" && -d "extensions/${SLUG}-bridge" ]]; then
  echo "==> vscode bridge extension"
  # Fixed timestamps keep the VSIX (and so the hub binary) reproducible.
  (cd "extensions/${SLUG}-bridge" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null &&
    find . -path ./node_modules -prune -o -type f -exec touch -h -t 198001010000 {} + &&
    pnpm exec vsce package --no-dependencies --allow-missing-repository -o "${SLUG}-bridge.vsix" >/dev/null)
  bun backend/scripts/zipnorm.ts "extensions/${SLUG}-bridge/${SLUG}-bridge.vsix"
  cp "extensions/${SLUG}-bridge/${SLUG}-bridge.vsix" "$PAYLOAD/ext/"
fi

echo "==> herdr-core for the executables"
mkdir -p dist/machines-hc
# shellcheck disable=SC2086
bun backend/scripts/fetch-hc.ts --out dist/machines-hc $HC_PLATFORMS

echo "==> ${SLUG} (${TARGETS})"
(cd backend && pnpm install --frozen-lockfile >/dev/null)
for p in $TARGETS; do
  os=${p%/*}; arch=${p#*/}
  exe=
  [[ $os == windows ]] && exe=.exe
  out=dist/${SLUG}-$os-$arch$exe
  bun backend/scripts/build.ts --out "$out" --target "$(bun_target "$p")" --version "$VERSION" \
    --web web/dist --hc dist/machines-hc --release-url "$RELEASE_URL" --ext "$PAYLOAD/ext" \
    --encoder dist/deps/encoder --gui dist/deps/gui-helper --gpupick dist/deps/gpupick >/dev/null
  echo "    $out $(du -h "$out" | cut -f1)"
done

echo "==> release packages"
TARGETS="$TARGETS" scripts/package.sh

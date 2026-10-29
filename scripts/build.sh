#!/usr/bin/env bash
# Builds the web UI, the VS Code bridge extension, the per-platform agents
# (embedded gzip), then the core for TARGETS (default: host platform). Names
# come from internal/brand and the module path from go.mod.
#
#   scripts/build.sh                       # host binary in dist/
#   TARGETS="linux/amd64 darwin/arm64" scripts/build.sh
#   SKIP_WEB=1 scripts/build.sh            # reuse web/dist
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
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

echo "==> agents"
mkdir -p dist/agents internal/embedded/agents
rm -f internal/embedded/agents/*.gz
for p in $AGENT_PLATFORMS; do
  os=${p%/*}; arch=${p#*/}
  out=dist/agents/${SLUG}-agent-$os-$arch
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "$LDFLAGS" -o "$out" "./cmd/${SLUG}-agent"
  gzip -9 -n -c "$out" > "internal/embedded/agents/${SLUG}-agent-$os-$arch.gz"
  echo "    $os/$arch $(du -h "$out" | cut -f1)"
done

echo "==> ${SLUG}"
for p in $TARGETS; do
  os=${p%/*}; arch=${p#*/}
  out=dist/${SLUG}-$os-$arch
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "$LDFLAGS" -o "$out" "./cmd/${SLUG}"
  echo "    $out $(du -h "$out" | cut -f1)"
done

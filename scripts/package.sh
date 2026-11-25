#!/usr/bin/env bash
# Package each core with its license notices, including those of the
# herdr-core the core embeds (scripts/fetch-hc), into
# dist/release/<slug>-<platform>.tar.gz, and dist/release/SHA256SUMS: the
# archives' digests and those of the executables in them
# (<slug>-<platform>/<slug>), which a core of the TypeScript build checks
# its machines' builds against (MACHINE=ts: the archives are also what
# machines download).
set -euo pipefail
cd "$(dirname "$0")/.."
SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
HC_VERSION=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' internal/hcdist/release.go)
test -n "$HC_VERSION"
TARGETS=${TARGETS:-"$(go env GOOS)/$(go env GOARCH)"}
mkdir -p dist/packages dist/release
packaged=
for p in $TARGETS; do
  case "$p" in
    linux/amd64|linux/arm64|darwin/amd64|darwin/arm64) ;;
    linux/amd64-musl|linux/arm64-musl) [[ "${MACHINE:-go}" == ts ]] || { echo "$p is a platform of the TypeScript build (MACHINE=ts)" >&2; exit 1; } ;;
    # No Windows archive: there the core runs inside the desktop app.
    windows/amd64) continue ;;
    *) echo "unsupported release platform: $p" >&2; exit 1 ;;
  esac
  packaged=1
  os=${p%/*}; arch=${p#*/}
  name=${SLUG}-${os}-${arch}
  dir=dist/packages/$name
  test -f "dist/$name"
  test -f dist/hc/licenses/LICENSE
  test -f dist/hc/licenses/THIRD-PARTY-NOTICES
  rm -rf "$dir"
  mkdir -p "$dir/licenses/herdr-core" "$dir/licenses/herdr-detect" "$dir/licenses/encoder"
  cp "dist/$name" "$dir/$SLUG"
  cp LICENSE THIRD_PARTY_NOTICES.md web/dist/licenses.md "$dir/"
  cp dist/hc/licenses/LICENSE dist/hc/licenses/THIRD-PARTY-NOTICES "$dir/licenses/herdr-core/"
  cp licenses/herdr-detect/* "$dir/licenses/herdr-detect/"
  cp licenses/encoder/* "$dir/licenses/encoder/"
  cat > "$dir/README.txt" <<EOF
$SLUG release for $p

Start the Web IDE:
  ./$SLUG

$SLUG contains the unmodified herdr-core $HC_VERSION executable$([[ "${MACHINE:-go}" == ts ]] && echo " of its
platform" || echo "s for Linux
and macOS machines")
(https://github.com/herdrdev/herdr-core, Apache-2.0).

Licenses: LICENSE, THIRD_PARTY_NOTICES.md, licenses.md, licenses/herdr-core/,
licenses/herdr-detect/, licenses/encoder/.
EOF
  tar -C dist/packages -czf "dist/release/$name.tar.gz" "$name"
  echo "    dist/release/$name.tar.gz"
done
# The archives and the executables in them.
[[ -z "$packaged" ]] || (cd dist/release && {
  shasum -a 256 ./*.tar.gz | sed 's| \./| |'
  for a in *.tar.gz; do
    n=${a%.tar.gz}
    s=$(tar -xzf "$a" -O "$n/$SLUG" | shasum -a 256 | cut -d' ' -f1)
    echo "$s  $n/$SLUG"
  done
} > SHA256SUMS)

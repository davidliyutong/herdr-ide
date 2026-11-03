#!/usr/bin/env bash
# Package each core with only its native herdr companion and license notices.
set -euo pipefail
cd "$(dirname "$0")/.."
SLUG=$(sed -n 's/^[[:space:]]*Slug = "\(.*\)"$/\1/p' internal/brand/brand.go)
HERDR_VERSION=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' internal/herdrdist/release.go)
test -n "$HERDR_VERSION"
TARGETS=${TARGETS:-"$(go env GOOS)/$(go env GOARCH)"}
mkdir -p dist/packages dist/release
for p in $TARGETS; do
  case "$p" in
    linux/amd64|linux/arm64|darwin/amd64|darwin/arm64) ;;
    *) echo "unsupported release platform: $p" >&2; exit 1 ;;
  esac
  os=${p%/*}; arch=${p#*/}
  name=${SLUG}-${os}-${arch}
  dir=dist/packages/$name
  test -f "dist/$name"
  test -f "dist/herdr/herdr-$os-$arch"
  rm -rf "$dir"
  mkdir -p "$dir/licenses/herdr" "$dir/licenses/encoder"
  cp "dist/$name" "$dir/$SLUG"
  cp "dist/herdr/herdr-$os-$arch" "$dir/herdr"
  cp LICENSE THIRD_PARTY_NOTICES.md web/dist/licenses.md "$dir/"
  cp licenses/herdr/* "$dir/licenses/herdr/"
  cp licenses/encoder/* "$dir/licenses/encoder/"
  cat > "$dir/README.txt" <<EOF
$SLUG release for $p

Keep this directory together. Start the Web IDE:
  ./$SLUG

./herdr is herdr $HERDR_VERSION, included so this host does not need a
separate herdr installation. It is used only when no herdr is installed and
behaves exactly like an installed herdr (same configuration, sessions and
machines). Run it directly or through $SLUG, for example:
  ./$SLUG herdr                                   open the herdr TUI
  ./$SLUG herdr machine add user@host --label gpu

Remote machines need their own installed herdr.

Licenses: LICENSE, THIRD_PARTY_NOTICES.md, licenses.md, licenses/herdr/, licenses/encoder/.
EOF
  tar -C dist/packages -czf "dist/release/$name.tar.gz" "$name"
  echo "    dist/release/$name.tar.gz"
done
(cd dist/release && shasum -a 256 *.tar.gz > SHA256SUMS)

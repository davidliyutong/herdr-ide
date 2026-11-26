#!/usr/bin/env bash
# Builds Ghostty's terminal emulator library (libghostty-vt) as WebAssembly
# for the web UI's terminals (docs/features/26-web-terminals.md):
# web/src/vt/ghostty-vt.wasm, from a pinned Ghostty commit. The module and
# its license are committed, so builds and CI need no zig; `make check`
# compares the module with the digest recorded beside it.
#
#   scripts/fetch-ghostty-vt.sh           build with zig 0.17 and write the module, its digest and license
#   scripts/fetch-ghostty-vt.sh --check   verify the committed module against the recorded digest
#
# GHOSTTY_SRC names a checkout of the commit to build from; otherwise the
# public repository is cloned into web/.deps/ghostty (ignored by git).
set -euo pipefail
cd "$(dirname "$0")/.."

COMMIT=cf5519b22f910ddc7885d2ef62deb94d38d43f22
REPO=https://github.com/ghostty-org/ghostty
# What the web UI uses: render state, input encoders, selections, colors,
# text of selections, find, and cells' hyperlinks. Kitty graphics are never
# built for wasm.
FEATURES=-all,+render-state,+input-encode,+selection,+color,+formatter,+search,+grid-introspection

dir=web/src/vt
out=$dir/ghostty-vt.wasm
digest=$dir/ghostty-vt.wasm.sha256
sum() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

if [[ "${1:-}" == "--check" ]]; then
  want=$(cut -d' ' -f1 "$digest")
  got=$(sum "$out")
  if [[ "$got" != "$want" ]]; then
    echo "$out: sha256 $got does not match $digest ($want); run scripts/fetch-ghostty-vt.sh" >&2
    exit 1
  fi
  exit 0
fi

src=${GHOSTTY_SRC:-web/.deps/ghostty}
if [[ -z "${GHOSTTY_SRC:-}" && ! -d "$src/.git" ]]; then
  echo "==> clone ghostty $COMMIT"
  mkdir -p web/.deps
  git init -q "$src"
  git -C "$src" fetch -q --depth 1 "$REPO.git" "$COMMIT"
  git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
got=$(git -C "$src" rev-parse HEAD)
if [[ "$got" != "$COMMIT" ]]; then
  echo "$src is at $got, expected $COMMIT" >&2
  exit 1
fi

echo "==> zig build ghostty-vt.wasm ($FEATURES)"
prefix=$(mktemp -d)
trap '/bin/rm -rf "$prefix"' EXIT
(cd "$src" && zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall "-Dvt-features=$FEATURES" --prefix "$prefix")
cp "$prefix/bin/ghostty-vt.wasm" "$out"
cp "$src/LICENSE" "$dir/LICENSE"
echo "$(sum "$out")  ghostty-vt.wasm" > "$digest"
echo "wrote $out ($(wc -c < "$out" | tr -d ' ') bytes, sha256 $(sum "$out"))"

#!/usr/bin/env bash
# Builds the GUI helper of Linux machines (scripts/gui-helper, Zig): its
# tests on this host, then one static executable per architecture
# machines have (linux/amd64, linux/arm64; no C library, so for glibc and
# musl alike) into scripts/gui-helper/bin, where the TypeScript machine
# build takes it from (backend/scripts/build.ts). The executables are
# committed with the digests of the sources they were built from and of
# themselves; `scripts/build-gui-helper.sh --check` (make check) verifies
# them, so builds and CI need no zig.
#
# Needs zig 0.17, as for `make vt-wasm` and `make gpupick`.
set -euo pipefail
cd "$(dirname "$0")/.."
src=scripts/gui-helper
bin=$src/bin
digest=$bin/gui-helper.sha256

sum() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

# The sources the executables are built from, in a stable order.
sources() { (cd "$src" && { echo build.zig; find src -type f -name '*.zig' | LC_ALL=C sort; }); }

if [[ "${1:-}" == "--check" ]]; then
  fail=0
  want_sources=$(sources)
  got_sources=$(awk '$2 !~ /^gui-helper-linux-/ {print $2}' "$digest")
  if [[ "$want_sources" != "$got_sources" ]]; then
    echo "$digest does not list the helper's sources as they are; run scripts/build-gui-helper.sh" >&2
    fail=1
  fi
  while read -r want name; do
    f=$src/$name
    [[ "$name" == gui-helper-linux-* ]] && f=$bin/$name
    if [[ ! -f "$f" ]]; then
      echo "$f is missing; run scripts/build-gui-helper.sh" >&2
      fail=1
      continue
    fi
    got=$(sum "$f")
    if [[ "$got" != "$want" ]]; then
      echo "$f: sha256 $got does not match $digest ($want); run scripts/build-gui-helper.sh" >&2
      fail=1
    fi
  done < "$digest"
  exit $fail
fi

command -v zig >/dev/null || { echo "zig is needed to build the GUI helper (https://ziglang.org)" >&2; exit 1; }
case "$(zig version)" in
  0.17.*) ;;
  *) echo "zig 0.17 is needed, not $(zig version)" >&2; exit 1 ;;
esac
echo "==> tests"
(cd "$src" && zig build test)
echo "==> executables"
rm -rf "$src/zig-out"
(cd "$src" && zig build)
mkdir -p "$bin"
for arch in amd64 arm64; do
  cp "$src/zig-out/bin/gui-helper-linux-$arch" "$bin/"
  chmod 755 "$bin/gui-helper-linux-$arch"
done
rm -rf "$src/zig-out" "$src/.zig-cache"
{
  for f in $(sources); do echo "$(sum "$src/$f")  $f"; done
  for arch in amd64 arm64; do echo "$(sum "$bin/gui-helper-linux-$arch")  gui-helper-linux-$arch"; done
} > "$digest"
cat "$digest"
ls -l "$bin"

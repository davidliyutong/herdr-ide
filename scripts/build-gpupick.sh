#!/usr/bin/env bash
# Builds gpupick, the library that shows a program of a terminal only the
# NVIDIA GPUs of its CUDA_VISIBLE_DEVICES (scripts/gpupick/gpupick.c), for
# the Linux platforms machines have, into scripts/gpupick/bin, where the
# build of the machine side takes it (backend/scripts/build.ts --gpupick). The libraries are committed with the digests of the
# source they were built from and of themselves; `scripts/build-gpupick.sh
# --check` (make check) verifies them.
#
# Needs zig (0.17, as for `make vt-wasm`): its C compiler builds for both
# platforms against glibc 2.17, the oldest machines have.
set -euo pipefail
cd "$(dirname "$0")/.."
src=scripts/gpupick/gpupick.c
dir=scripts/gpupick/bin
digest=$dir/gpupick.sha256

sum() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

if [[ "${1:-}" == "--check" ]]; then
  fail=0
  while read -r want name; do
    f=$dir/$name
    [[ "$name" == gpupick.c ]] && f=$src
    got=$(sum "$f")
    if [[ "$got" != "$want" ]]; then
      echo "$f: sha256 $got does not match $digest ($want); run scripts/build-gpupick.sh" >&2
      fail=1
    fi
  done < "$digest"
  exit $fail
fi

command -v zig >/dev/null || { echo "zig is needed to build gpupick (https://ziglang.org)" >&2; exit 1; }
for pair in x86_64:amd64 aarch64:arm64; do
  out=$dir/gpupick-linux-${pair#*:}.so
  echo "==> $out"
  zig cc -target "${pair%:*}-linux-gnu.2.17" -shared -fPIC -O2 -s -Wall -Wextra -Werror -o "$out" "$src" -ldl
  chmod 644 "$out"
done
{
  echo "$(sum "$src")  gpupick.c"
  for arch in amd64 arm64; do
    echo "$(sum "$dir/gpupick-linux-$arch.so")  gpupick-linux-$arch.so"
  done
} > "$digest"
cat "$digest"

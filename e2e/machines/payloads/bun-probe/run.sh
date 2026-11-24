#!/bin/sh
# Runs probe.ts with each Bun runtime in rt/ that fits this machine: the
# musl one on musl, the glibc baseline one, and the AVX2 one if the CPU has
# AVX2. RUNTIMES="name ..." picks others. Exit status: 0 if all passed.
cd "$(dirname "$0")" || exit 2
libc=glibc
ls /lib/ld-musl-* >/dev/null 2>&1 && libc=musl
avx2=no
grep -qw avx2 /proc/cpuinfo && avx2=yes
echo "machine ${MACHINE_NAME:-?} kernel $(uname -r) libc $libc avx2 $avx2 cpu$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2)"
if [ $libc = musl ]; then
  rts=bun-linux-x64-musl-baseline
else
  rts=bun-linux-x64-baseline
  [ $avx2 = yes ] && rts="$rts bun-linux-x64"
fi
rc=0
for r in ${RUNTIMES:-$rts}; do
  echo
  echo "=== runtime $r"
  if [ ! -x "rt/$r/bun" ]; then
    echo "=== missing rt/$r/bun (run fetch-runtimes.sh)"
    rc=1
    continue
  fi
  "./rt/$r/bun" --version 2>&1
  "./rt/$r/bun" ./probe.ts 2>&1
  e=$?
  echo "=== exit $e"
  [ $e = 0 ] || rc=1
done
exit $rc

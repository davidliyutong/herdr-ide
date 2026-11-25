#!/bin/sh
# Runs the TypeScript build's machine side on this machine: the driver (driver.js,
# built with build.sh) with the executable of this machine's C
# library (exe/: musl's on musl, glibc's elsewhere) acting as Bun
# (BUN_BE_BUN=1), which drives that executable's node as a core does
# (MACHINE_EXE names another build: run-go.sh). The run has a home of its
# own, removed after. Exit status: 0 if it passed.
cd "$(dirname "$0")" || exit 2
# glibc's getconf answers on glibc whatever else is there (a glibc system
# with musl's package has musl's loader in /lib too).
libc=glibc
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || { ls /lib/ld-musl-* >/dev/null 2>&1 && libc=musl; }
echo "machine ${MACHINE_NAME:-?} kernel $(uname -r) libc $libc"
suffix=
[ $libc = musl ] && suffix=-musl
own=$(ls exe/*-linux-amd64$suffix 2>/dev/null | head -1)
[ -x "$own" ] || { echo "FAIL no machine executable for linux-amd64$suffix in exe/ (build.sh)"; exit 1; }
# What the core's probe refuses (kernel/machines/transport/ssh.ts
# checkRuntimeRuns): musl without libstdc++ and libgcc, an x86-64 processor
# without SSE4.2. Such a machine passes when it is refused as the probe
# would refuse it.
libs=yes
for f in libstdc++.so.6 libgcc_s.so.1; do
  found=
  for d in /lib /usr/lib /lib64 /usr/lib64 /usr/local/lib; do [ -e "$d/$f" ] && found=1; done
  [ -n "$found" ] || libs=no
done
if [ $libc = musl ] && [ $libs = no ]; then
  echo "PASS refused as the core's probe refuses it: libs_missing (musl without libstdc++ and libgcc)"
  exit 0
fi
if [ "$(uname -m)" = x86_64 ] && ! grep -qw sse4_2 /proc/cpuinfo; then
  echo "PASS refused as the core's probe refuses it: cpu_unsupported (no SSE4.2)"
  exit 0
fi
home=$(mktemp -d /tmp/hmx-XXXXXX)
echo "=== $(basename "${MACHINE_EXE:-$own}")"
HOME=$home MACHINE_EXE=${MACHINE_EXE:-$PWD/$own} BUN_BE_BUN=1 "./$own" --no-env-file --no-install --config=/dev/null ./driver.js 2>&1
e=$?
rm -rf "$home"
echo "=== exit $e"
exit $e

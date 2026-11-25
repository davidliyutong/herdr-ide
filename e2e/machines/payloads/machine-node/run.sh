#!/bin/sh
# Runs the TypeScript machine side on this machine (driver.js, built with
# build.sh) with each Bun runtime in rt/ that fits it: the musl one on
# musl, the glibc baseline one elsewhere (RUNTIMES="name ..." picks others).
# Each run has a home of its own, removed after. Exit status: 0 if all
# passed.
cd "$(dirname "$0")" || exit 2
# glibc's getconf answers on glibc whatever else is there (a glibc system
# with musl's package has musl's loader in /lib too).
libc=glibc
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || { ls /lib/ld-musl-* >/dev/null 2>&1 && libc=musl; }
echo "machine ${MACHINE_NAME:-?} kernel $(uname -r) libc $libc"
if [ $libc = musl ]; then rts=bun-linux-x64-musl-baseline; else rts=bun-linux-x64-baseline; fi
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
if [ $libc = musl ] && [ $libs = no ] && [ -z "${RUNTIMES:-}" ]; then
  echo "PASS refused as the core's probe refuses it: libs_missing (musl without libstdc++ and libgcc)"
  exit 0
fi
if [ "$(uname -m)" = x86_64 ] && ! grep -qw sse4_2 /proc/cpuinfo && [ -z "${RUNTIMES:-}" ]; then
  echo "PASS refused as the core's probe refuses it: cpu_unsupported (no SSE4.2)"
  exit 0
fi
rc=0
for r in ${RUNTIMES:-$rts}; do
  echo
  echo "=== runtime $r"
  if [ ! -x "rt/$r/bun" ]; then
    echo "=== missing rt/$r/bun (build.sh)"
    rc=1
    continue
  fi
  home=$(mktemp -d /tmp/hmx-XXXXXX)
  HOME=$home "./rt/$r/bun" --no-env-file --no-install --config=/dev/null ./driver.js 2>&1
  e=$?
  rm -rf "$home"
  echo "=== exit $e"
  [ $e = 0 ] || rc=1
done
exit $rc

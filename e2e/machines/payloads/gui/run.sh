#!/bin/sh
# Runs the program windows of the TypeScript machine side on this machine:
# the driver (driver.js, built with build.sh) with the executable of this
# machine's C library (exe/) acting as Bun (BUN_BE_BUN=1), which drives
# that executable's node as a core does: the display (the distribution's
# Xvfb, installed here first when it is missing: the machines are
# throwaway), a program's window through the GUI helper, input, the
# keeper; the GPU display too where the machine has Xwayland and a render
# node it may open. The run has a home of its own, removed after. Exit
# status: 0 if it passed.
cd "$(dirname "$0")" || exit 2
libc=glibc
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || { ls /lib/ld-musl-* >/dev/null 2>&1 && libc=musl; }
echo "machine ${MACHINE_NAME:-?} kernel $(uname -r) libc $libc"
suffix=
[ $libc = musl ] && suffix=-musl
own=$(ls exe/*-linux-amd64$suffix 2>/dev/null | head -1)
[ -x "$own" ] || { echo "FAIL no machine executable for linux-amd64$suffix in exe/ (build.sh)"; exit 1; }
sudo=
[ "$(id -u)" = 0 ] || sudo="sudo -n"
# Only on a throwaway machine; elsewhere the machine side fetches Xvfb
# itself where it can (apt-get download, in the run's home).
if [ "${MACHINE_KIND:-}" != local ] && ! command -v Xvfb >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    $sudo apk add --no-cache xvfb libstdc++ libgcc >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    # CentOS 7's mirrors are gone: its vault serves the packages.
    if grep -qs '^mirrorlist=http://mirrorlist.centos.org' /etc/yum.repos.d/CentOS-Base.repo; then
      $sudo sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|' /etc/yum.repos.d/CentOS-*.repo
    fi
    $sudo yum install -q -y xorg-x11-server-Xvfb >/dev/null
  elif command -v apt-get >/dev/null 2>&1; then
    $sudo apt-get update -qq >/dev/null && $sudo apt-get install -qq -y xvfb >/dev/null
  fi
fi
home=$(mktemp -d /tmp/hmg-XXXXXX)
cp bin/e2e-xclient "$home/"
echo "=== $(basename "$own") (Xvfb: $(command -v Xvfb || echo none))"
enc=
[ -f enc/encoder.gz ] && enc=$PWD/enc/encoder.gz
HOME=$home MACHINE_EXE=$PWD/$own XCLIENT=$home/e2e-xclient ENCODER=$enc BUN_BE_BUN=1 "./$own" --no-env-file --no-install --config=/dev/null ./driver.js 2>&1
e=$?
rm -rf "$home"
echo "=== exit $e"
exit $e

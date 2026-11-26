#!/usr/bin/env bash
# Diagnoses local test, container, VM and CI capabilities on macOS and Linux.
# Read-only: never modifies user instances, containers or files.
#
#   make test-doctor
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/load-env.sh
source "$PWD/scripts/load-env.sh"
load_repo_dotenv "$PWD"

SLUG=$(sed -n "s/^export const SLUG = '\(.*\)';$/\1/p" backend/shared/lib/brand.ts)
OS=$(uname -s)
ARCH=$(uname -m)
HOST_PLATFORM=$(scripts/platform.sh)
case "$ARCH" in
  x86_64 | amd64) NARCH=amd64 ;;
  aarch64 | arm64) NARCH=arm64 ;;
  *) NARCH=$ARCH ;;
esac

ok()   { printf '  [OK]   %-24s %s\n' "$1" "$2"; }
warn() { printf '  [WARN] %-24s %s\n' "$1" "$2"; }
miss() { printf '  [MISS] %-24s %s\n' "$1" "$2"; }

echo "=== Host ==="
ok "platform" "$OS/$ARCH ($HOST_PLATFORM)"

echo
echo "=== Core toolchain ==="
if command -v bun >/dev/null 2>&1; then
  v=$(bun --version)
  if [[ "$v" == "1.4.5" ]]; then ok "bun" "$v"; else warn "bun" "$v (pinned: 1.4.5)"; fi
else
  miss "bun" "required for backend/build/tests (1.4.5)"
fi

if command -v node >/dev/null 2>&1; then
  v=$(node --version 2>/dev/null | head -1 || true)
  major=${v#v}; major=${major%%.*}
  if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
    ok "node" "$v"
  elif [[ -n "$v" ]]; then
    warn "node" "$v (requires >= 22.12)"
  else
    warn "node" "$(command -v node) (could not read version)"
  fi
else
  miss "node" "required (>= 22.12)"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm" "$(pnpm --version)"
else
  miss "pnpm" "required"
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3" "$(python3 --version 2>&1)"
else
  warn "python3" "needed for e2e/machines and winvm.py"
fi

for t in git ssh ssh-keygen curl tar gzip; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t" "$(command -v "$t")"; else miss "$t" "required"; fi
done

if command -v sha256sum >/dev/null 2>&1; then
  ok "sha256" "sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  ok "sha256" "shasum -a 256"
else
  miss "sha256" "need sha256sum or shasum"
fi

if command -v lsof >/dev/null 2>&1; then
  ok "tcp-probe" "lsof"
elif [[ "$OS" == Linux ]] && command -v ss >/dev/null 2>&1; then
  ok "tcp-probe" "ss (lsof fallback on Linux)"
elif [[ "$OS" == Linux ]]; then
  ok "tcp-probe" "/proc/net/tcp fallback"
else
  warn "tcp-probe" "lsof missing (needed by e2e/tests/desktop.spec.ts)"
fi

echo
echo "=== Display & Playwright / Electron ==="
if [[ "$OS" == Linux ]]; then
  if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    ok "display" "DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"
  elif command -v xvfb-run >/dev/null 2>&1; then
    ok "display" "headless, xvfb-run available (scripts/e2e.sh wraps automatically)"
  else
    warn "display" "headless without xvfb-run (install xvfb for desktop e2e & screenshots)"
  fi
  if command -v Xvfb >/dev/null 2>&1 || [[ -x /usr/bin/Xvfb ]]; then
    ok "Xvfb" "$(command -v Xvfb || echo /usr/bin/Xvfb)"
  else
    warn "Xvfb" "not installed (make it will fall back to Docker if available)"
  fi
else
  ok "display" "macOS native graphical session"
fi

if [[ -d desktop/node_modules/electron ]]; then
  ok "electron" "installed in desktop/node_modules/electron"
else
  warn "electron" "not installed (run make deps without ELECTRON_SKIP_BINARY_DOWNLOAD)"
fi

if [[ -d e2e/node_modules/@playwright ]]; then
  chromium=$(pnpm -C e2e exec playwright install --dry-run --no-shell chromium 2>/dev/null | sed -n 's/^ *Install location: *//p' | head -1 || true)
  if [[ -n "$chromium" && -f "$chromium/INSTALLATION_COMPLETE" ]]; then
    ok "playwright-chromium" "$chromium"
  else
    warn "playwright-chromium" "not downloaded yet (make e2e installs it on first run)"
  fi
else
  warn "e2e-deps" "e2e/node_modules missing (run make deps)"
fi

echo
echo "=== Containers (Docker) & Local CI (act) ==="
if command -v docker >/dev/null 2>&1 && dinfo=$(docker info --format '{{.Name}} ({{.OperatingSystem}}, {{.Architecture}}, v{{.ServerVersion}})' 2>/dev/null); then
  ok "docker" "$dinfo"
  for img in "${SLUG}-e2e-sshd" "${SLUG}-e2e-screenshots" "${SLUG}-gui-it" "${SLUG}-linux-test" "${SLUG}-act-ubuntu:24.04" "catthehacker/ubuntu:act-24.04"; do
    if iarch=$(docker image inspect "$img" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null); then
      ok "image:$img" "$iarch"
    fi
  done
else
  warn "docker" "not running (SSH e2e, gui-it, test-linux, ci-local need Docker)"
fi

if command -v act >/dev/null 2>&1; then
  ok "act" "$(act --version 2>&1 | head -1)"
else
  warn "act" "not installed (optional: make ci-local)"
fi

echo
echo "=== Virtualization (e2e/machines & winvm.py) ==="
if [[ "$OS" == Linux ]]; then
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then
    ok "kvm" "/dev/kvm accessible (native KVM VMs + dockurr/windows ready)"
  elif [[ -e /dev/kvm ]]; then
    warn "kvm" "/dev/kvm exists but not r/w by $(id -un) (add user to group kvm)"
  else
    warn "kvm" "/dev/kvm missing (VMs need --emulate TCG or machines.py remote <kvm-host>)"
  fi
elif [[ "$OS" == Darwin ]]; then
  qnative=$( [[ "$NARCH" == arm64 ]] && echo qemu-system-aarch64 || echo qemu-system-x86_64 )
  if command -v "$qnative" >/dev/null 2>&1 && "$qnative" -accel help 2>/dev/null | grep -qx hvf; then
    ok "hvf" "$qnative supports macOS HVF hardware acceleration ($NARCH VMs)"
  else
    warn "hvf" "install qemu (brew install qemu) for native macOS HVF Linux/Windows VMs"
  fi
fi

for q in qemu-system-x86_64 qemu-system-aarch64 qemu-img; do
  if command -v "$q" >/dev/null 2>&1; then
    ok "$q" "$("$q" --version | head -1)"
  else
    warn "$q" "not installed"
  fi
done

uefi_arm=""
for p in /opt/homebrew/share/qemu/edk2-aarch64-code.fd /usr/local/share/qemu/edk2-aarch64-code.fd \
         /usr/share/AAVMF/AAVMF_CODE.no-secboot.fd /usr/share/AAVMF/AAVMF_CODE.fd \
         /usr/share/edk2/aarch64/QEMU_EFI-pflash.raw /usr/share/qemu-efi-aarch64/QEMU_EFI.fd; do
  [[ -f "$p" ]] && { uefi_arm=$p; break; }
done
if [[ -n "$uefi_arm" ]]; then ok "uefi-arm64" "$uefi_arm"; else warn "uefi-arm64" "not found (needed for arm64 VMs)"; fi

uefi_x64=""
for p in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/edk2/x64/OVMF_CODE.4m.fd \
         /opt/homebrew/share/qemu/edk2-x86_64-code.fd /usr/local/share/qemu/edk2-x86_64-code.fd; do
  [[ -f "$p" ]] && { uefi_x64=$p; break; }
done
if [[ -n "$uefi_x64" ]]; then ok "uefi-amd64" "$uefi_x64"; else warn "uefi-amd64" "not found (needed for UEFI Windows x64 VMs)"; fi

if command -v swtpm >/dev/null 2>&1; then
  ok "swtpm" "$(swtpm --version 2>&1 | head -1) (TPM 2.0 for Windows 11 VMs)"
else
  warn "swtpm" "optional (winvm.py bypasses TPM check when absent)"
fi

echo
echo "=== Test Leftovers & Disk Usage ==="
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  left_e2e=$(docker ps -a --filter "label=${SLUG}.e2e" --format '{{.Names}}' | wc -l | tr -d ' ')
  left_mx=$(docker ps -a --filter "label=${SLUG}-machines.image" --format '{{.Names}}' | wc -l | tr -d ' ')
  left_act=$(docker ps -a --filter 'name=act-ci-' --format '{{.Names}} ({{.Status}})' || true)
  [[ "$left_e2e" == 0 ]] && ok "e2e-containers" "none" || warn "e2e-containers" "$left_e2e leftover (run make test-clean)"
  [[ "$left_mx" == 0 ]] && ok "matrix-containers" "none" || warn "matrix-containers" "$left_mx running/leftover"
  [[ -z "$left_act" ]] && ok "act-containers" "none" || warn "act-containers" "$(echo "$left_act" | tr '\n' '; ') (run make test-clean)"
fi

hie_count=$(find /tmp -maxdepth 1 -name 'hie-*' 2>/dev/null | wc -l | tr -d ' ')
[[ "$hie_count" == 0 ]] && ok "tmp-e2e-homes" "none" || warn "tmp-e2e-homes" "$hie_count directories in /tmp/hie-*"

if [[ -d dist ]]; then
  ok "dist-size" "$(du -sh dist | awk '{print $1}')"
else
  ok "dist-size" "0 (not built yet)"
fi

echo
echo "=== Local .env & Remote Targets ==="
if [[ -f .env ]]; then
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    miss "dotenv" ".env is TRACKED by git! Run: git rm --cached .env"
  elif git check-ignore -q .env 2>/dev/null; then
    ok "dotenv" ".env present and gitignored"
  else
    warn "dotenv" ".env present (verify .gitignore excludes it)"
  fi
else
  warn "dotenv" "not created yet (cp .env.example .env to configure remote hosts / VM paths)"
fi
if [[ -n "${LINUX_TEST_HOST:-}" ]]; then
  ok "LINUX_TEST_HOST" "$LINUX_TEST_HOST (make test-remote / machines.py remote -)"
else
  warn "LINUX_TEST_HOST" "unset (optional: set in .env to offload KVM/GPU/Linux tests)"
fi
if [[ -n "${WIN_TEST_HOST:-}" ]]; then
  ok "WIN_TEST_HOST" "$WIN_TEST_HOST (make test-win)"
elif [[ -n "${WINVM_BASE:-}" ]]; then
  if [[ -f "$WINVM_BASE" ]]; then
    ok "WINVM_BASE" "$WINVM_BASE (make test-win)"
  else
    warn "WINVM_BASE" "$WINVM_BASE (file not found; run winvm.py bootstrap)"
  fi
else
  warn "windows-target" "unset (optional: set WIN_TEST_HOST or WINVM_BASE in .env, or use --dockur on Linux KVM)"
fi

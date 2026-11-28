#!/usr/bin/env -S python3 -I
"""Disposable Windows test VMs for macOS (HVF), Linux (KVM), and remote SSH hosts.

Runs Windows hub, web, desktop and packaging checks without leaving state
behind. Three backends share one interface:

  1. QEMU CoW overlay (--base <golden.qcow2>):
     - Linux: KVM hardware acceleration (x86_64 or arm64);
     - macOS: HVF hardware acceleration (Apple Silicon arm64 Windows 11/Server,
       or Intel x86_64);
     - never writes to the golden base image; boots a disposable overlay with
       loopback-only SSH (127.0.0.1:<port> -> :22) and optional RDP.
  2. Ephemeral Linux KVM container (--dockur):
     - Linux with /dev/kvm + Docker: starts a temporary dockurr/windows
       container with loopback-only ports and automated OpenSSH + toolchain
       provisioning via /oem/install.bat, destroyed on exit.
  3. Remote Windows SSH host (--host <ssh-alias> or $WIN_TEST_HOST):
     - works from macOS or Linux against an existing Proxmox/lab Windows VM;
     - or one on Google Compute Engine that `gce create` makes and prepares
       (winvm-gce-startup.ps1), reached through IAP, started for `test` when
       stopped and stopped again after.

Commands:
  winvm.py bootstrap --iso WIN.iso [--virtio VIRTIO.iso] [--out BASE.qcow2] [--arch amd64|arm64]
  winvm.py up (--base BASE.qcow2 | --dockur) [--arch amd64|arm64] [--rdp] [--display]
  winvm.py ssh [--host ALIAS] [-- CMD...]
  winvm.py test [--base BASE.qcow2 | --dockur | --host ALIAS] [--suite all|hub|web|desktop|app] [--dist] [--keep]
  winvm.py gce create|check|start|stop|status|update-script|delete
  winvm.py status
  winvm.py down
  winvm.py clean [--keep-cache]
"""
import argparse
import atexit
import base64
import importlib.util
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from xml.sax.saxutils import escape as xml_escape

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def _load_repo_dotenv():
    """Delegates `.env` parsing to the single canonical scripts/dotenv.py."""
    mod_path = os.path.join(REPO_ROOT, 'scripts', 'dotenv.py')
    if not os.path.isfile(mod_path):
        return
    spec = importlib.util.spec_from_file_location('_repo_dotenv', mod_path)
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.load_dotenv(os.path.join(REPO_ROOT, '.env'))


_load_repo_dotenv()

WORK = os.path.abspath(os.environ.get('WINVM_WORK') or os.path.join(os.environ.get('MACHINES_WORK') or '.machines-work', 'winvm'))
TTL = int(os.environ.get('WINVM_TTL') or os.environ.get('MACHINES_TTL') or 7200)
DEVNULL = subprocess.DEVNULL
ENV = {**{k: v for k, v in os.environ.items() if k != 'SSH_AUTH_SOCK'}, 'COPYFILE_DISABLE': '1'}

HOST_OS = 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else sys.platform
_raw_arch = platform.machine().lower()
HOST_ARCH = 'arm64' if _raw_arch in ('arm64', 'aarch64') else 'amd64' if _raw_arch in ('x86_64', 'amd64') else _raw_arch
BUN_VERSION = '1.4.5'
DOCKUR_IMAGE = os.environ.get('WINVM_DOCKUR_IMAGE') or 'dockurr/windows:latest'


def default_prefix():
    try:
        with open(os.path.join(REPO_ROOT, 'backend', 'shared', 'lib', 'brand.ts')) as f:
            m = re.search(r"^export const SLUG = '(.*)';$", f.read(), re.M)
        if m:
            return m.group(1) + '-winvm'
    except OSError:
        pass
    return 'winvm'


PREFIX = os.environ.get('WINVM_PREFIX') or default_prefix()
LABEL = PREFIX + '.vm'
VM_NAME = f'{PREFIX}-guest'
WIN_USER = os.environ.get('WINVM_USER') or 'runner'


def resolve_win_pass():
    """Returns WINVM_PASS if set, otherwise generates a fresh random password
    meeting Windows complexity rules for this disposable VM run."""
    return os.environ.get('WINVM_PASS') or f'Wv!{secrets.token_hex(12)}'

_started_kind = None  # 'qemu' | 'dockur'


def log(msg):
    print(f'[{PREFIX}] {msg}', file=sys.stderr, flush=True)


class Fail(Exception):
    pass


def run(argv, **kw):
    kw.setdefault('env', ENV)
    r = subprocess.run(argv, **kw)
    if r.returncode != 0:
        raise Fail(f'{shlex.join(argv)}: exit {r.returncode}')
    return r


def norm_arch(a):
    if not a:
        return HOST_ARCH
    a = a.lower()
    if a in ('x86_64', 'amd64', 'x64'):
        return 'amd64'
    if a in ('aarch64', 'arm64'):
        return 'arm64'
    raise Fail(f'unsupported architecture: {a}')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def ensure_key():
    os.makedirs(WORK, mode=0o700, exist_ok=True)
    key = os.path.join(WORK, 'id_ed25519')
    if not os.path.exists(key):
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', PREFIX, '-f', key])
    return key


def spawn_ttl_watchdog(pid, pidfile, ttl):
    script = (
        "import os, signal, time\n"
        f"pid, pf, ttl = {pid}, {pidfile!r}, {int(ttl)}\n"
        "time.sleep(ttl)\n"
        "try:\n"
        "  with open(pf) as f:\n"
        "    if int(f.read().strip()) != pid: raise SystemExit(0)\n"
        "except Exception:\n"
        "  raise SystemExit(0)\n"
        "for sig, wait in ((signal.SIGTERM, 30), (signal.SIGKILL, 1)):\n"
        "  try: os.kill(pid, sig)\n"
        "  except ProcessLookupError: break\n"
        "  time.sleep(wait)\n"
    )
    subprocess.Popen([sys.executable, '-I', '-c', script], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, start_new_session=True)


def qemu_bin_for(arch):
    return 'qemu-system-aarch64' if arch == 'arm64' else 'qemu-system-x86_64'


def qemu_has_accel(qemu_bin, accel):
    if not shutil.which(qemu_bin):
        return False
    r = subprocess.run([qemu_bin, '-accel', 'help'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return r.returncode == 0 and any(line.strip() == accel for line in r.stdout.splitlines())


def select_accel(arch, emulate=False):
    qbin = qemu_bin_for(arch)
    if not shutil.which(qbin):
        raise Fail(f'{qbin} is not installed')
    if HOST_OS == 'linux' and arch == HOST_ARCH:
        if os.access('/dev/kvm', os.R_OK | os.W_OK) and qemu_has_accel(qbin, 'kvm'):
            return 'kvm'
        if emulate and qemu_has_accel(qbin, 'tcg'):
            return 'tcg'
        raise Fail(f'/dev/kvm is not readable/writable for {arch} Windows VM (add user to kvm group, or pass --emulate)')
    if HOST_OS == 'darwin' and arch == HOST_ARCH:
        if qemu_has_accel(qbin, 'hvf'):
            return 'hvf'
        if emulate and qemu_has_accel(qbin, 'tcg'):
            return 'tcg'
        raise Fail(f'{qbin} lacks HVF support on macOS (pass --emulate for slow TCG)')
    if emulate and qemu_has_accel(qbin, 'tcg'):
        return 'tcg'
    raise Fail(
        f'Windows {arch} VM cannot use hardware acceleration on {HOST_OS}/{HOST_ARCH}; '
        f'use {HOST_ARCH} Windows image for native {"HVF" if HOST_OS == "darwin" else "KVM"}, '
        f'pass --emulate, or use --host <win-ssh-alias>'
    )


def find_uefi(arch):
    env_code = os.environ.get('WINVM_UEFI_CODE')
    env_vars = os.environ.get('WINVM_UEFI_VARS')
    if env_code and os.path.exists(env_code):
        return env_code, (env_vars if (env_vars and os.path.exists(env_vars)) else None)
    if arch == 'arm64':
        candidates = [
            ('/opt/homebrew/share/qemu/edk2-aarch64-code.fd', '/opt/homebrew/share/qemu/edk2-arm-vars.fd'),
            ('/usr/local/share/qemu/edk2-aarch64-code.fd', '/usr/local/share/qemu/edk2-arm-vars.fd'),
            ('/usr/share/AAVMF/AAVMF_CODE.no-secboot.fd', '/usr/share/AAVMF/AAVMF_VARS.fd'),
            ('/usr/share/AAVMF/AAVMF_CODE.fd', '/usr/share/AAVMF/AAVMF_VARS.fd'),
            ('/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw', '/usr/share/edk2/aarch64/vars-template-pflash.raw'),
            ('/usr/share/qemu-efi-aarch64/QEMU_EFI.fd', None),
        ]
    else:
        candidates = [
            ('/usr/share/OVMF/OVMF_CODE_4M.fd', '/usr/share/OVMF/OVMF_VARS_4M.fd'),
            ('/usr/share/OVMF/OVMF_CODE.fd', '/usr/share/OVMF/OVMF_VARS.fd'),
            ('/usr/share/edk2/x64/OVMF_CODE.4m.fd', '/usr/share/edk2/x64/OVMF_VARS.4m.fd'),
            ('/usr/share/edk2/ovmf/OVMF_CODE.fd', '/usr/share/edk2/ovmf/OVMF_VARS.fd'),
            ('/opt/homebrew/share/qemu/edk2-x86_64-code.fd', '/opt/homebrew/share/qemu/edk2-i386-vars.fd'),
            ('/usr/local/share/qemu/edk2-x86_64-code.fd', '/usr/local/share/qemu/edk2-i386-vars.fd'),
        ]
    for code, v in candidates:
        if os.path.exists(code):
            return code, (v if (v and os.path.exists(v)) else None)
    return None, None


def qemu_procs():
    out = {}
    if os.path.isdir('/proc'):
        for d in os.listdir('/proc'):
            if not d.isdigit():
                continue
            try:
                if os.stat(f'/proc/{d}').st_uid != os.getuid():
                    continue
                with open(f'/proc/{d}/cmdline', 'rb') as f:
                    args = [a.decode(errors='replace') for a in f.read().split(b'\0')]
            except OSError:
                continue
            if args and 'qemu-system' in os.path.basename(args[0]) and '-name' in args[:-1]:
                if args[args.index('-name') + 1] == VM_NAME:
                    out[int(d)] = VM_NAME
        return out
    r = subprocess.run(['ps', '-wwaxo', 'pid=,uid=,command='], stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
    if r.returncode != 0:
        return out
    uid = os.getuid()
    for line in r.stdout.splitlines():
        m = re.match(r'^\s*(\d+)\s+(\d+)\s+(.*)$', line)
        if m and int(m.group(2)) == uid and 'qemu-system' in m.group(3) and f'-name {VM_NAME}' in m.group(3):
            out[int(m.group(1))] = VM_NAME
    return out


def dockur_ids():
    if not shutil.which('docker'):
        return []
    r = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label={LABEL}=1'], stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
    return r.stdout.split() if r.returncode == 0 else []


# ---------------------------------------------------------------- provisioning files

PROVISION_PS1 = r"""$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Start-Transcript -Path 'C:\winvm-provision.log' -Append | Out-Null

# 1. OpenSSH Server + authorized key
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue | Out-Null
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name 'WinVM-SSH' -DisplayName 'OpenSSH Server (WinVM)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -ErrorAction SilentlyContinue | Out-Null

$pubKey = Get-Content -Raw 'PLACEHOLDER_KEY_PATH'
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content -Path $adminKeys -Value $pubKey.Trim() -Encoding ascii
icacls $adminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
$userSsh = Join-Path $env:USERPROFILE '.ssh'
New-Item -ItemType Directory -Force -Path $userSsh | Out-Null
Set-Content -Path (Join-Path $userSsh 'authorized_keys') -Value $pubKey.Trim() -Encoding ascii
Restart-Service sshd

# 2. Toolchain: Git for Windows, Node 22, pnpm, Bun
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
}
$env:PATH = "$env:ProgramFiles\Git\cmd;$env:ProgramFiles\Git\usr\bin;$env:ProgramFiles\nodejs;$env:USERPROFILE\.bun\bin;$env:PATH"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  corepack enable
  corepack prepare pnpm@12.8.1 --activate
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $bunZip = "$env:TEMP\bun-windows-x64-baseline.zip"
  Invoke-WebRequest -UseBasicParsing "https://github.com/oven-sh/bun/releases/download/bun-vPLACEHOLDER_BUN/bun-windows-x64-baseline.zip" -OutFile $bunZip
  Expand-Archive -Force $bunZip "$env:USERPROFILE\.bun"
  New-Item -ItemType Directory -Force "$env:USERPROFILE\.bun\bin" | Out-Null
  Copy-Item -Force "$env:USERPROFILE\.bun\bun-windows-x64-baseline\bun.exe" "$env:USERPROFILE\.bun\bin\bun.exe"
}
# Make Git Bash + Bun + Node available to non-interactive SSH sessions
$sysPath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
foreach ($dir in @("$env:ProgramFiles\Git\cmd", "$env:ProgramFiles\Git\bin", "$env:ProgramFiles\nodejs", "$env:USERPROFILE\.bun\bin")) {
  if ($sysPath -notlike "*$dir*") { $sysPath = "$sysPath;$dir" }
}
[Environment]::SetEnvironmentVariable('Path', $sysPath, 'Machine')
New-Item -ItemType File -Force 'C:\winvm-ready' | Out-Null
Stop-Transcript | Out-Null
"""


def render_autounattend(arch, user, password):
    warch = 'arm64' if arch == 'arm64' else 'amd64'
    x_user = xml_escape(user)
    x_pass = xml_escape(password)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="{warch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale><InputLocale>en-US</InputLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="{warch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>1</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>2</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>3</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
        </OSImage>
      </ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><ProductKey><WillShowUI>Never</WillShowUI></ProductKey></UserData>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="{warch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation><ProtectYourPC>3</ProtectYourPC><SkipMachineOOBE>true</SkipMachineOOBE><SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
            <Name>{x_user}</Name><Group>Administrators</Group>
            <Password><Value>{x_pass}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled><Username>{x_user}</Username>
        <Password><Value>{x_pass}</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
          <Order>1</Order>
          <CommandLine>powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-PSDrive -PSProvider FileSystem | ForEach-Object {{ $p = Join-Path $_.Root 'provision.ps1'; if (Test-Path $p) {{ &amp; $p }} }}"</CommandLine>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
"""


def write_oem_dir(oem_dir, arch, pub_key_text, password):
    os.makedirs(oem_dir, mode=0o700, exist_ok=True)
    with open(os.path.join(oem_dir, 'authorized_key.pub'), 'w') as f:
        f.write(pub_key_text.strip() + '\n')
    ps1 = (PROVISION_PS1
           .replace('PLACEHOLDER_KEY_PATH', r'${PSScriptRoot}\authorized_key.pub')
           .replace('PLACEHOLDER_BUN', BUN_VERSION))
    with open(os.path.join(oem_dir, 'provision.ps1'), 'w') as f:
        f.write(ps1)
    with open(os.path.join(oem_dir, 'autounattend.xml'), 'w') as f:
        f.write(render_autounattend(arch, WIN_USER, password))
    # dockurr/windows executes C:\OEM\install.bat automatically after setup.
    with open(os.path.join(oem_dir, 'install.bat'), 'w', newline='\r\n') as f:
        f.write('@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0provision.ps1"\r\n')


# ---------------------------------------------------------------- QEMU backend (KVM / HVF)

def start_swtpm(state_dir):
    if not shutil.which('swtpm'):
        return None, None
    tpm_dir = os.path.join(state_dir, 'tpm')
    os.makedirs(tpm_dir, mode=0o700, exist_ok=True)
    sock = os.path.join(tpm_dir, 'swtpm-sock')
    p = subprocess.Popen(
        ['swtpm', 'socket', '--tpmstate', f'dir={tpm_dir}', '--ctrl', f'type=unixio,path={sock}', '--tpm2'],
        stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, start_new_session=True,
    )
    for _ in range(30):
        if os.path.exists(sock):
            return p, sock
        time.sleep(0.1)
    return p, None


def build_win_qemu_argv(arch, accel, disk, d, ssh_port, rdp_port, mem, cpus, display,
                        iso=None, virtio=None, oem_dir=None, tpm_sock=None):
    qbin = qemu_bin_for(arch)
    argv = [qbin, '-name', VM_NAME, '-m', str(mem), '-smp', str(cpus)]
    if arch == 'arm64':
        if accel == 'hvf':
            argv += ['-M', 'virt,highmem=on', '-accel', 'hvf', '-cpu', 'host']
        elif accel == 'kvm':
            argv += ['-M', 'virt,gic-version=host', '-accel', 'kvm', '-cpu', 'host']
        else:
            argv += ['-M', 'virt', '-accel', 'tcg,thread=multi', '-cpu', 'cortex-a72']
        argv += ['-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet']
        if display:
            argv += ['-device', 'ramfb']
    else:
        if accel == 'kvm':
            argv += ['-M', 'q35', '-accel', 'kvm', '-cpu', 'host,hv_relaxed,hv_spinlocks=0x1fff,hv_vapic,hv_time']
        elif accel == 'hvf':
            argv += ['-M', 'q35', '-accel', 'hvf', '-cpu', 'host']
        else:
            argv += ['-M', 'q35', '-accel', 'tcg,thread=multi', '-cpu', 'Nehalem']
        argv += ['-device', 'qemu-xhci', '-device', 'usb-kbd', '-device', 'usb-tablet']

    code, vars_tpl = find_uefi(arch)
    if code:
        vars_dst = os.path.join(d, 'efivars.fd')
        if vars_tpl and os.path.exists(vars_tpl) and (arch != 'arm64' or os.path.getsize(code) == (64 << 20)):
            shutil.copyfile(vars_tpl, vars_dst)
            argv += ['-drive', f'if=pflash,format=raw,readonly=on,file={code}',
                     '-drive', f'if=pflash,format=raw,file={vars_dst}']
        elif arch == 'arm64' and os.path.getsize(code) == (64 << 20):
            with open(vars_dst, 'wb') as vf:
                vf.truncate(64 << 20)
            argv += ['-drive', f'if=pflash,format=raw,readonly=on,file={code}',
                     '-drive', f'if=pflash,format=raw,file={vars_dst}']
        else:
            argv += ['-bios', code]
    elif arch == 'arm64':
        raise Fail('ARM64 UEFI firmware is required to boot Windows ARM64 (install qemu / qemu-efi-aarch64)')

    if tpm_sock:
        dev = 'tpm-tis-device' if arch == 'arm64' else 'tpm-tis'
        argv += ['-chardev', f'socket,id=chrtpm,path={tpm_sock}', '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
                 '-device', f'{dev},tpmdev=tpm0']

    argv += [
        '-display', 'default' if display else 'none',
        '-monitor', 'none',
        '-pidfile', f'{d}/qemu.pid',
        '-drive', f'file={disk},if=virtio,format=qcow2',
        '-device', 'virtio-rng-pci',
    ]
    # Attach CD-ROMs and OEM VVFAT over USB mass storage (qemu-xhci) so both
    # arm64 `virt` (which has no IDE bus) and WinPE (which has built-in USB
    # storage drivers before VirtIO drivers load) can boot and read
    # autounattend.xml reliably.
    if iso:
        argv += ['-drive', f'id=winiso,if=none,media=cdrom,readonly=on,file={os.path.abspath(iso)}',
                 '-device', 'usb-storage,drive=winiso,removable=on']
    if virtio:
        argv += ['-drive', f'id=virtioiso,if=none,media=cdrom,readonly=on,file={os.path.abspath(virtio)}',
                 '-device', 'usb-storage,drive=virtioiso,removable=on']
    if oem_dir:
        # oem_dir is a disposable per-run directory; fat:rw satisfies usb-storage's writable block check.
        argv += ['-drive', f'id=oem,if=none,format=raw,file=fat:rw:{oem_dir}',
                 '-device', 'usb-storage,drive=oem,removable=on']

    fwd = f'user,id=n0,hostfwd=tcp:127.0.0.1:{ssh_port}-:22'
    if rdp_port:
        fwd += f',hostfwd=tcp:127.0.0.1:{rdp_port}-:3389'
    argv += ['-netdev', fwd, '-device', 'virtio-net-pci,netdev=n0']
    return argv


def local_ssh_argv(state, tty=False):
    opts = ['IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes', 'StrictHostKeyChecking=no',
            'UserKnownHostsFile=/dev/null', 'LogLevel=ERROR', 'ConnectTimeout=10', 'ServerAliveInterval=15']
    argv = ['ssh', '-F', '/dev/null', '-i', os.path.join(WORK, 'id_ed25519'), '-p', str(state['port'])]
    for o in opts:
        argv += ['-o', o]
    return argv + ['-t' if tty else '-T', f"{state['user']}@127.0.0.1"]


def wait_for_win_ssh(state, proc=None, timeout=900, require_ready_file=False):
    t0 = time.time()
    deadline = t0 + timeout
    check_cmd = 'cmd /c "if exist C:\\winvm-ready (exit 0) else (exit 1)"' if require_ready_file else 'cmd /c echo ok'
    while time.time() < deadline:
        if proc is not None and proc.poll() is not None:
            raise Fail(f'Windows VM exited early ({proc.returncode}); check {WORK}/qemu.log')
        r = subprocess.run(local_ssh_argv(state) + [check_cmd], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=ENV)
        if r.returncode == 0:
            log(f'Windows SSH ready after {time.time() - t0:.0f}s')
            return
        time.sleep(5)
    raise Fail(f'Windows SSH did not become ready within {timeout}s')


def up_qemu(base, arch, mem, cpus, rdp, display, emulate, boot_timeout, iso=None, virtio=None, bootstrap_out=None):
    global _started_kind
    if qemu_procs():
        raise Fail('a Windows VM is already running (run `winvm.py down` first)')
    arch = norm_arch(arch)
    accel = select_accel(arch, emulate=emulate)
    key = ensure_key()
    d = os.path.join(WORK, 'run')
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, mode=0o700)
    oem_dir = None
    if bootstrap_out:
        disk = os.path.abspath(bootstrap_out)
        os.makedirs(os.path.dirname(disk), exist_ok=True)
        run(['qemu-img', 'create', '-f', 'qcow2', disk, '64G'])
        with open(key + '.pub') as f:
            pub = f.read().strip()
        oem_dir = os.path.join(d, 'oem')
        write_oem_dir(oem_dir, arch, pub, resolve_win_pass())
    else:
        base = os.path.abspath(base)
        if not os.path.exists(base):
            raise Fail(f'base image not found: {base}')
        info = json.loads(run(['qemu-img', 'info', '--output=json', base], stdout=subprocess.PIPE).stdout)
        disk = os.path.join(d, 'overlay.qcow2')
        run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', base, '-F', info.get('format', 'qcow2'), disk])

    ssh_port = free_port()
    rdp_port = free_port() if rdp else None
    tpm_proc, tpm_sock = start_swtpm(d)
    state = {'kind': 'qemu', 'port': ssh_port, 'rdp': rdp_port, 'user': WIN_USER, 'arch': arch, 'accel': accel,
             'tpm_pid': tpm_proc.pid if tpm_proc else None}
    with open(os.path.join(WORK, 'state.json'), 'w') as f:
        json.dump(state, f)
    argv = build_win_qemu_argv(arch, accel, disk, d, ssh_port, rdp_port, mem, cpus, display,
                               iso=iso, virtio=virtio, oem_dir=oem_dir, tpm_sock=tpm_sock)
    _started_kind = 'qemu'
    with open(os.path.join(WORK, 'qemu.log'), 'w') as qlog:
        p = subprocess.Popen(argv, stdin=DEVNULL, stdout=qlog, stderr=subprocess.STDOUT, start_new_session=True, env=ENV)
    spawn_ttl_watchdog(p.pid, os.path.join(d, 'qemu.pid'), TTL)
    rdp_note = f', rdp 127.0.0.1:{rdp_port}' if rdp_port else ''
    log(f'booting Windows VM ({arch}, {accel}, ssh 127.0.0.1:{ssh_port}{rdp_note}, log {WORK}/qemu.log)')
    wait_for_win_ssh(state, proc=p, timeout=boot_timeout, require_ready_file=bool(bootstrap_out))
    return state


# ---------------------------------------------------------------- Linux KVM dockurr/windows backend

def up_dockur(mem, cpus, rdp, version, boot_timeout):
    global _started_kind
    if HOST_OS != 'linux' or not os.access('/dev/kvm', os.R_OK | os.W_OK):
        raise Fail('--dockur requires Linux with readable/writable /dev/kvm')
    if not shutil.which('docker'):
        raise Fail('--dockur requires Docker')
    if dockur_ids():
        raise Fail('a dockur Windows container is already running (run `winvm.py down` first)')
    key = ensure_key()
    with open(key + '.pub') as f:
        pub = f.read().strip()
    oem_dir = os.path.join(WORK, 'dockur-oem')
    shutil.rmtree(oem_dir, ignore_errors=True)
    password = resolve_win_pass()
    write_oem_dir(oem_dir, 'amd64', pub, password)
    ssh_port = free_port()
    web_port = free_port()
    rdp_port = free_port() if rdp else None
    # Pass credentials via a 0600 env-file rather than -e PASSWORD=... so the
    # password never appears in the host process list (`ps`).
    env_fd, env_path = tempfile.mkstemp(prefix='dockur-', suffix='.env', dir=WORK)
    try:
        os.chmod(env_path, 0o600)
        with os.fdopen(env_fd, 'w') as ef:
            ef.write(f'USERNAME={WIN_USER}\nPASSWORD={password}\n')
        argv = [
            'docker', 'run', '-d', '--rm',
            '--name', VM_NAME, '--label', f'{LABEL}=1',
            '--device=/dev/kvm', '--cap-add', 'NET_ADMIN',
            '-p', f'127.0.0.1:{ssh_port}:22',
            '-p', f'127.0.0.1:{web_port}:8006',
            '-e', f'VERSION={version}',
            '-e', f'RAM_SIZE={mem}M',
            '-e', f'CPU_CORES={cpus}',
            '--env-file', env_path,
            '-v', f'{oem_dir}:/oem:ro',
        ]
        if rdp_port:
            argv += ['-p', f'127.0.0.1:{rdp_port}:3389']
        cache_vol = f'{PREFIX}-dockur-storage'
        argv += ['-v', f'{cache_vol}:/storage', DOCKUR_IMAGE]
        _started_kind = 'dockur'
        run(argv, stdout=DEVNULL)
    finally:
        try:
            os.remove(env_path)
        except OSError:
            pass
    state = {'kind': 'dockur', 'port': ssh_port, 'web': web_port, 'rdp': rdp_port, 'user': WIN_USER,
             'arch': 'amd64', 'accel': 'kvm'}
    with open(os.path.join(WORK, 'state.json'), 'w') as f:
        json.dump(state, f)
    log(f'dockurr/windows started (ssh 127.0.0.1:{ssh_port}, console http://127.0.0.1:{web_port})')
    wait_for_win_ssh(state, timeout=boot_timeout, require_ready_file=True)
    return state


# ---------------------------------------------------------------- test runner (local VM or remote SSH host)

def win_ssh_prefix(host=None, state=None):
    if host:
        ssh_opts = [os.path.expanduser(t) for t in shlex.split(os.environ.get('WINVM_SSH_OPTS', ''))]
        return ['ssh', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', *ssh_opts, host]
    if state:
        return local_ssh_argv(state)
    raise Fail('no Windows target specified (pass --base, --dockur, or --host / WIN_TEST_HOST)')


def tar_create_cmd():
    return ['tar', '--no-xattrs', '--no-mac-metadata'] if HOST_OS == 'darwin' else ['tar']


def run_windows_tests(ssh_base, suite, dist):
    """Archives the working tree, uploads it to Windows over SSH, runs the
    selected tests in Git Bash, and removes the remote temp directory."""
    run_id = secrets.token_hex(4)
    rdir = f'{PREFIX}-test-{run_id}'
    log(f'uploading repository snapshot to Windows ({rdir})')
    # Package tracked + untracked non-ignored files cleanly without node_modules/dist.
    files = subprocess.run(
        ['git', '-C', REPO_ROOT, 'ls-files', '-co', '--exclude-standard', '-z'],
        stdout=subprocess.PIPE, check=True,
    ).stdout.split(b'\0')
    files = [f.decode('utf-8') for f in files if f]
    with tempfile.NamedTemporaryFile('w', delete=False) as flist:
        flist.write('\n'.join(files) + '\n')
        flist_path = flist.name
    try:
        tar = subprocess.Popen(tar_create_cmd() + ['-C', REPO_ROOT, '-T', flist_path, '-cf', '-'], stdout=subprocess.PIPE, env=ENV)
        try:
            r = subprocess.run(
                ssh_base + [f'cmd /c "mkdir %USERPROFILE%\\{rdir} && tar -xf - -C %USERPROFILE%\\{rdir}"'],
                stdin=tar.stdout,
            )
        finally:
            tar.stdout.close()
            tar.wait()
        if tar.returncode or r.returncode:
            raise Fail(f'upload to Windows failed (tar={tar.returncode}, ssh={r.returncode})')
    finally:
        os.remove(flist_path)

    steps = []
    if suite in ('all', 'hub'):
        steps.append('pnpm -C backend install --frozen-lockfile && EXTENDED_TESTS=1 pnpm -C backend test:hub')
    if suite in ('all', 'web'):
        steps.append('pnpm -C web install --frozen-lockfile && EXTENDED_TESTS=1 pnpm -C web test')
    if suite in ('all', 'desktop'):
        steps.append('pnpm -C desktop install --frozen-lockfile && EXTENDED_TESTS=1 pnpm -C desktop test')
    if suite in ('all', 'app'):
        steps.append('scripts/desktop.sh ' + ('dist' if dist else 'app'))
    script_body = '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\n' + '\n'.join(steps) + '\n'
    with tempfile.TemporaryDirectory() as sdir:
        spath = os.path.join(sdir, '.winvm-run.sh')
        with open(spath, 'w', newline='\n') as sf:
            sf.write(script_body)
        os.chmod(spath, 0o755)
        tar2 = subprocess.Popen(tar_create_cmd() + ['-C', sdir, '-cf', '-', '.winvm-run.sh'], stdout=subprocess.PIPE, env=ENV)
        try:
            r_put = subprocess.run(
                ssh_base + [f'cmd /c "tar -xf - -C %USERPROFILE%\\{rdir}"'],
                stdin=tar2.stdout,
            )
        finally:
            tar2.stdout.close()
            tar2.wait()
        if tar2.returncode or r_put.returncode:
            raise Fail(f'failed to upload runner script to Windows (tar={tar2.returncode}, ssh={r_put.returncode})')

    rc = 1
    try:
        log(f'running Windows suite={suite} (dist={dist})')
        rc = subprocess.run(
            ssh_base + [f'cmd /c "cd /d %USERPROFILE%\\{rdir} && "%ProgramFiles%\\Git\\bin\\bash.exe" -l .winvm-run.sh"'],
        ).returncode
    finally:
        log(f'cleaning remote Windows dir {rdir}')
        subprocess.run(ssh_base + [f'cmd /c "rmdir /s /q %USERPROFILE%\\{rdir}"'], stdout=DEVNULL, stderr=DEVNULL)
    return rc


# ---------------------------------------------------------------- GCE Windows host

GCE_PROJECT = os.environ.get('WINVM_GCE_PROJECT') or ''
GCE_ZONE = os.environ.get('WINVM_GCE_ZONE') or ''
GCE_INSTANCE = os.environ.get('WINVM_GCE_INSTANCE') or ''
GCE_MACHINE = os.environ.get('WINVM_GCE_MACHINE_TYPE') or 'e2-standard-4'
GCE_IMAGE_FAMILY = os.environ.get('WINVM_GCE_IMAGE_FAMILY') or 'windows-2025'
GCE_DISK_GB = os.environ.get('WINVM_GCE_DISK_GB') or '100'
# A host left running stops by itself after this much running time.
GCE_MAX_RUN = os.environ.get('WINVM_GCE_MAX_RUN') or '4h'
GCE_SSH_CONFIG = os.path.expanduser(os.environ.get('WINVM_GCE_SSH_CONFIG') or '~/.config/test-hosts/ssh.config')
# Google's IAP TCP forwarding range: the only source admitted to ssh and RDP.
IAP_RANGE = '35.235.240.0/20'
GCE_STARTUP = os.path.join(HERE, 'winvm-gce-startup.ps1')


def gce_cfg():
    missing = [k for k, v in (('WINVM_GCE_PROJECT', GCE_PROJECT), ('WINVM_GCE_ZONE', GCE_ZONE), ('WINVM_GCE_INSTANCE', GCE_INSTANCE)) if not v]
    if missing:
        raise Fail(f'set {", ".join(missing)} (in .env) for a GCE Windows host')
    if not shutil.which('gcloud'):
        raise Fail('gcloud (Google Cloud SDK) is not on PATH')
    return GCE_PROJECT, GCE_ZONE, GCE_INSTANCE


def gcloud(*args, check=True, capture=False, quiet=False):
    argv = ['gcloud', *args, f'--project={GCE_PROJECT}', '--quiet']
    r = subprocess.run(argv, env=ENV, text=True,
                       stdout=subprocess.PIPE if capture else (DEVNULL if quiet else None),
                       stderr=subprocess.PIPE if (capture or quiet) else None)
    if check and r.returncode != 0:
        raise Fail(f'{shlex.join(argv)}: exit {r.returncode}{": " + r.stderr.strip()[-600:] if r.stderr else ""}')
    return r


def gce_key():
    return os.path.expanduser(os.environ.get('WINVM_GCE_KEY') or f'~/.ssh/{GCE_INSTANCE}_ed25519')


def repo_versions():
    """The Node major of the CI workflow, the pnpm of backend/package.json,
    and BUN_VERSION: the host gets what CI's Windows runners get."""
    with open(os.path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml')) as f:
        m = re.search(r'node-version:\s*["\']?(\d+)', f.read())
    node = m.group(1) if m else '22'
    with open(os.path.join(REPO_ROOT, 'backend', 'package.json')) as f:
        pm = json.load(f).get('packageManager', '')
    pnpm = pm.split('@', 1)[1] if pm.startswith('pnpm@') else ''
    if not pnpm:
        raise Fail('backend/package.json names no pnpm in packageManager')
    return node, pnpm, BUN_VERSION


def gce_startup_script():
    node, pnpm, bun = repo_versions()
    with open(GCE_STARTUP) as f:
        text = f.read()
    return (text.replace('PLACEHOLDER_USER', WIN_USER).replace('PLACEHOLDER_NODE_MAJOR', node)
            .replace('PLACEHOLDER_PNPM', pnpm).replace('PLACEHOLDER_BUN', bun))


def gce_status():
    r = gcloud('compute', 'instances', 'describe', GCE_INSTANCE, f'--zone={GCE_ZONE}', '--format=value(status)',
               check=False, capture=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def gce_ssh_block():
    """The ssh config of the host: through IAP (it has no external
    address), with its own key and known_hosts."""
    known = os.path.join(os.path.dirname(GCE_SSH_CONFIG), 'known_hosts')
    proxy = (f'{shutil.which("gcloud")} compute start-iap-tunnel {GCE_INSTANCE} 22 --listen-on-stdin '
             f'--project {GCE_PROJECT} --zone {GCE_ZONE} --verbosity=warning')
    return (f'# {PREFIX} gce: {GCE_INSTANCE} ({GCE_PROJECT}, {GCE_ZONE}), ssh through IAP\n'
            f'Host {GCE_INSTANCE}\n  HostName {GCE_INSTANCE}\n  User {WIN_USER}\n  IdentityFile {gce_key()}\n'
            f'  IdentitiesOnly yes\n  ProxyCommand {proxy}\n  StrictHostKeyChecking accept-new\n'
            f'  UserKnownHostsFile {known}\n  ServerAliveInterval 30\n')


def gce_write_ssh_config():
    """Puts the host's block into GCE_SSH_CONFIG in place of any earlier
    block for it (ssh takes the first that matches)."""
    os.makedirs(os.path.dirname(GCE_SSH_CONFIG), mode=0o700, exist_ok=True)
    old = open(GCE_SSH_CONFIG).read() if os.path.exists(GCE_SSH_CONFIG) else ''
    kept, inside = [], False
    for line in old.splitlines(keepends=True):
        if line.startswith(f'# {PREFIX} gce: {GCE_INSTANCE} '):
            continue
        if line.split()[:2] == ['Host', GCE_INSTANCE] and len(line.split()) == 2:
            inside = True
            continue
        if inside and (line[:1] in (' ', '\t') or not line.strip()):
            continue
        inside = False
        kept.append(line)
    text = ''.join(kept).rstrip('\n')
    with open(GCE_SSH_CONFIG, 'w') as f:
        f.write((text + '\n\n' if text else '') + gce_ssh_block())
    os.chmod(GCE_SSH_CONFIG, 0o600)
    opts = os.environ.get('WINVM_SSH_OPTS', '')
    if os.path.expanduser(GCE_SSH_CONFIG) not in [os.path.expanduser(t) for t in shlex.split(opts)]:
        log(f'add to .env: WIN_TEST_HOST={GCE_INSTANCE} and WINVM_SSH_OPTS="-F {GCE_SSH_CONFIG}"')


def gce_serial_since(since):
    """The startup script's lines of the serial console after since (UTC,
    ISO seconds), and whether it finished."""
    r = gcloud('compute', 'instances', 'get-serial-port-output', GCE_INSTANCE, f'--zone={GCE_ZONE}', check=False, capture=True)
    lines = [l for l in r.stdout.splitlines() if l[:19] > since and ('startup-script' in l or 'startup scripts' in l)]
    return lines, any('Finished running startup scripts' in l for l in lines)


def gce_wait_prepared(since, timeout):
    """Waits for the boot's startup script; its errors fail the wait."""
    log(f'waiting for {GCE_INSTANCE} to prepare itself (first boot takes 10-15 minutes)')
    end = time.time() + timeout
    while time.time() < end:
        lines, done = gce_serial_since(since)
        if done:
            errors = [l for l in lines if '[ERROR]' in l or 'failed with error' in l]
            if errors:
                raise Fail('the startup script failed (C:\\winvm-provision.log on the host):\n' + '\n'.join(errors[-20:]))
            return
        time.sleep(20)
    raise Fail(f'{GCE_INSTANCE} did not finish its startup script within {timeout}s')


def gce_ssh_argv():
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=60', '-F', GCE_SSH_CONFIG, GCE_INSTANCE]


def gce_wait_ssh(timeout=600):
    end = time.time() + timeout
    while time.time() < end:
        if subprocess.run(gce_ssh_argv() + ['cmd /c exit 0'], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=ENV).returncode == 0:
            return
        time.sleep(10)
    raise Fail(f'no ssh to {GCE_INSTANCE} within {timeout}s')


GCE_CHECK_PS1 = r"""$ErrorActionPreference = 'Continue'
function V($cmd, $arg) { try { ((& $cmd $arg) | Select-Object -First 1).ToString().Trim() } catch { '' } }
$o = [ordered]@{
  git = V git --version
  bash = Test-Path "$env:ProgramFiles\Git\bin\bash.exe"
  node = V node --version
  corepack = V corepack --version
  pnpm = V pnpm --version
  bun = V bun --version
  pwsh = V pwsh -v
  longPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem').LongPathsEnabled
  corepackPrompt = [Environment]::GetEnvironmentVariable('COREPACK_ENABLE_DOWNLOAD_PROMPT', 'Machine')
  ready = Test-Path 'C:\winvm-ready'
}
$o | ConvertTo-Json -Compress
"""


def gce_check():
    """Checks over ssh that the host has what the suites need, at the
    versions of the repository."""
    node, pnpm, bun = repo_versions()
    # As one argument (UTF-16LE in base64): Windows PowerShell runs nothing
    # of a script piped to `-Command -` over ssh, and says nothing either;
    # and with its input left open it waits for that input's end.
    encoded = base64.b64encode(GCE_CHECK_PS1.encode('utf-16-le')).decode()
    r = subprocess.run(gce_ssh_argv() + [f'powershell -NoProfile -NonInteractive -EncodedCommand {encoded}'],
                       stdin=DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=ENV, timeout=300)
    if r.returncode != 0:
        raise Fail(f'ssh to {GCE_INSTANCE} failed: {r.stderr.strip()[-600:]}')
    try:
        got = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise Fail(f'unexpected answer from {GCE_INSTANCE}: {r.stdout[-600:]}')
    wants = [
        ('git', bool(got.get('git'))), ('bash', got.get('bash') is True),
        (f'node v{node}', str(got.get('node', '')).startswith(f'v{node}.')),
        ('corepack', bool(got.get('corepack'))),
        # Where no package.json pins it: the suites run `pnpm -C <dir>` at the root.
        (f'pnpm {pnpm} by default', got.get('pnpm') == pnpm),
        (f'bun {bun}', got.get('bun') == bun),
        ('pwsh 7', str(got.get('pwsh', '')).startswith('PowerShell 7')),
        ('long paths', got.get('longPaths') == 1), ('corepack without prompt', got.get('corepackPrompt') == '0'),
        ('prepared', got.get('ready') is True),
    ]
    for name, ok in wants:
        log(f'  {"ok  " if ok else "MISS"} {name}')
    bad = [n for n, ok in wants if not ok]
    if bad:
        raise Fail(f'{GCE_INSTANCE} lacks: {", ".join(bad)} ({json.dumps(got)})')


def gce_create(timeout):
    project, zone, name = gce_cfg()
    region = zone.rsplit('-', 1)[0]
    if gce_status():
        raise Fail(f'{name} exists already (`winvm.py gce delete` first, or `gce start`)')
    log('enabling the Compute Engine and IAP APIs')
    gcloud('services', 'enable', 'compute.googleapis.com', 'iap.googleapis.com', quiet=True)
    # Ssh and RDP only through IAP. A tag-scoped deny of everything else
    # outranks default rules that admit 0.0.0.0/0 to every instance.
    rules = gcloud('compute', 'firewall-rules', 'list', '--format=value(name)', capture=True).stdout.split()
    if f'{name}-allow-iap' not in rules:
        gcloud('compute', 'firewall-rules', 'create', f'{name}-allow-iap', '--network=default', '--direction=INGRESS',
               '--priority=800', '--action=ALLOW', '--rules=tcp:22,tcp:3389', f'--source-ranges={IAP_RANGE}',
               f'--target-tags={name}', quiet=True)
    if f'{name}-deny-public' not in rules:
        gcloud('compute', 'firewall-rules', 'create', f'{name}-deny-public', '--network=default', '--direction=INGRESS',
               '--priority=900', '--action=DENY', '--rules=tcp:22,tcp:3389', '--source-ranges=0.0.0.0/0',
               f'--target-tags={name}', quiet=True)
    # No external address (an organization may forbid one, and none is
    # needed): the downloads leave through Cloud NAT, unless the region has
    # one already.
    nats = gcloud('compute', 'routers', 'list', f'--regions={region}', '--format=value(nats[].name)', capture=True).stdout.split()
    if not any(nats):
        log(f'creating Cloud NAT {name}-nat in {region} for the host\'s downloads')
        gcloud('compute', 'routers', 'create', f'{name}-router', '--network=default', f'--region={region}', quiet=True)
        gcloud('compute', 'routers', 'nats', 'create', f'{name}-nat', f'--router={name}-router', f'--region={region}',
               '--auto-allocate-nat-external-ips', '--nat-all-subnet-ip-ranges', quiet=True)
    key = gce_key()
    if not os.path.exists(key):
        os.makedirs(os.path.dirname(key), mode=0o700, exist_ok=True)
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key])
    with tempfile.TemporaryDirectory() as d:
        script = os.path.join(d, 'startup.ps1')
        with open(script, 'w', newline='\r\n') as f:
            f.write(gce_startup_script())
        since = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())
        log(f'creating {name} ({GCE_MACHINE}, {GCE_IMAGE_FAMILY}, {zone}; stops itself after {GCE_MAX_RUN} running)')
        gcloud('compute', 'instances', 'create', name, f'--zone={zone}', f'--machine-type={GCE_MACHINE}',
               f'--image-family={GCE_IMAGE_FAMILY}', '--image-project=windows-cloud',
               f'--boot-disk-size={GCE_DISK_GB}GB', '--boot-disk-type=pd-balanced', '--no-address', f'--tags={name}',
               '--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring',
               f'--max-run-duration={GCE_MAX_RUN}', '--instance-termination-action=STOP',
               f'--metadata-from-file=windows-startup-script-ps1={script},winvm-ssh-key={key}.pub',
               f'--labels=purpose={PREFIX}-windows-tests', quiet=True)
    gce_write_ssh_config()
    # A host made anew under the name has another host key.
    known = os.path.join(os.path.dirname(GCE_SSH_CONFIG), 'known_hosts')
    if os.path.exists(known):
        subprocess.run(['ssh-keygen', '-R', name, '-f', known], stdout=DEVNULL, stderr=DEVNULL, env=ENV)
    gce_wait_prepared(since, timeout)
    gce_wait_ssh()
    gce_check()
    log(f'{name} is ready; `winvm.py gce stop` stops it (only its disk is billed then)')


def gce_update_script():
    """Sends the startup script of the working tree to the host: it runs at
    the next boot."""
    gce_cfg()
    with tempfile.TemporaryDirectory() as d:
        script = os.path.join(d, 'startup.ps1')
        with open(script, 'w', newline='\r\n') as f:
            f.write(gce_startup_script())
        gcloud('compute', 'instances', 'add-metadata', GCE_INSTANCE, f'--zone={GCE_ZONE}',
               f'--metadata-from-file=windows-startup-script-ps1={script}', quiet=True)


def gce_start(timeout):
    """Starts the host with the startup script of the working tree and waits
    until it has prepared itself and answers ssh. True when it was stopped."""
    gce_cfg()
    st = gce_status()
    if not st:
        raise Fail(f'no instance {GCE_INSTANCE} (`winvm.py gce create`)')
    if st == 'RUNNING':
        return False
    gce_update_script()
    since = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())
    log(f'starting {GCE_INSTANCE}')
    gcloud('compute', 'instances', 'start', GCE_INSTANCE, f'--zone={GCE_ZONE}', quiet=True)
    gce_wait_prepared(since, timeout)
    gce_wait_ssh()
    return True


def gce_stop():
    gce_cfg()
    if gce_status() in ('RUNNING', 'STAGING', 'PROVISIONING'):
        log(f'stopping {GCE_INSTANCE}')
        gcloud('compute', 'instances', 'stop', GCE_INSTANCE, f'--zone={GCE_ZONE}', quiet=True)


def gce_delete():
    """Deletes the host and what `gce create` made for it (its firewall
    rules, and its Cloud NAT when it made one)."""
    _project, zone, name = gce_cfg()
    region = zone.rsplit('-', 1)[0]
    if gce_status():
        gcloud('compute', 'instances', 'delete', name, f'--zone={zone}', quiet=True)
    rules = gcloud('compute', 'firewall-rules', 'list', '--format=value(name)', capture=True).stdout.split()
    for rule in (f'{name}-allow-iap', f'{name}-deny-public'):
        if rule in rules:
            gcloud('compute', 'firewall-rules', 'delete', rule, quiet=True)
    routers = gcloud('compute', 'routers', 'list', f'--regions={region}', '--format=value(name)', capture=True).stdout.split()
    if f'{name}-router' in routers:
        gcloud('compute', 'routers', 'delete', f'{name}-router', f'--region={region}', quiet=True)
    log(f'deleted {name}; its key {gce_key()} and the ssh config stay')


# ---------------------------------------------------------------- lifecycle

def down():
    global _started_kind
    _started_kind = None
    for pid in list(qemu_procs()):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
            for _ in range(40):
                if not pid_alive(pid):
                    break
                time.sleep(0.2)
    st_path = os.path.join(WORK, 'state.json')
    if os.path.exists(st_path):
        try:
            st = json.load(open(st_path))
            if st.get('tpm_pid'):
                os.kill(st['tpm_pid'], signal.SIGTERM)
        except Exception:
            pass
        os.remove(st_path)
    ids = dockur_ids()
    if ids:
        subprocess.run(['docker', 'rm', '-f'] + ids, stdout=DEVNULL, stderr=DEVNULL)
    shutil.rmtree(os.path.join(WORK, 'run'), ignore_errors=True)
    shutil.rmtree(os.path.join(WORK, 'dockur-oem'), ignore_errors=True)


def status():
    for pid in qemu_procs():
        try:
            st = json.load(open(os.path.join(WORK, 'state.json')))
            rdp = f" rdp 127.0.0.1:{st['rdp']}" if st.get('rdp') else ''
            print(f"qemu    {VM_NAME:24} pid {pid} ssh 127.0.0.1:{st['port']}{rdp} ({st['arch']}/{st['accel']})")
        except OSError:
            print(f'qemu    {VM_NAME:24} pid {pid}')
    if shutil.which('docker'):
        r = subprocess.run(['docker', 'ps', '--filter', f'label={LABEL}=1', '--format', '{{.Names}} {{.Status}}'],
                           stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
        for line in r.stdout.splitlines():
            print(f'dockur  {line}')


def clean(keep_cache):
    down()
    if not keep_cache and shutil.which('docker'):
        subprocess.run(['docker', 'volume', 'rm', f'{PREFIX}-dockur-storage'], stdout=DEVNULL, stderr=DEVNULL)
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)


def _cleanup_started():
    if _started_kind:
        down()


def _on_signal(sig, _frame):
    _cleanup_started()
    raise SystemExit(128 + sig)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('bootstrap', help='install a reusable golden Windows qcow2 base image from an ISO')
    p.add_argument('--iso', required=True, help='Windows installation ISO')
    p.add_argument('--virtio', help='virtio-win ISO (recommended for VirtIO disk/network drivers)')
    p.add_argument('--out', default=os.path.join(WORK, 'windows-base.qcow2'), help='output golden qcow2 path')
    p.add_argument('--arch', default=HOST_ARCH, help='amd64 or arm64 (default: host arch)')
    p.add_argument('--memory', type=int, default=4096)
    p.add_argument('--cpus', type=int, default=4)
    p.add_argument('--rdp', action='store_true')
    p.add_argument('--display', action='store_true', help='show QEMU display window during install')
    p.add_argument('--emulate', action='store_true')
    p.add_argument('--timeout', type=int, default=3600)

    p = sub.add_parser('up', help='boot a disposable Windows VM (CoW overlay or Linux KVM dockur)')
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--base', help='golden qcow2/vhdx base image (never modified; boots CoW overlay)')
    g.add_argument('--dockur', action='store_true', help='Linux KVM ephemeral dockurr/windows container')
    p.add_argument('--arch', default=HOST_ARCH)
    p.add_argument('--memory', type=int, default=4096)
    p.add_argument('--cpus', type=int, default=4)
    p.add_argument('--version', default='11', help='Windows version for --dockur (default: 11)')
    p.add_argument('--rdp', action='store_true')
    p.add_argument('--display', action='store_true')
    p.add_argument('--emulate', action='store_true')
    p.add_argument('--timeout', type=int, default=900)

    p = sub.add_parser('ssh', help='open SSH shell or run a command on the running/remote Windows VM')
    p.add_argument('--host', default=os.environ.get('WIN_TEST_HOST'))
    p.add_argument('command', nargs=argparse.REMAINDER)

    p = sub.add_parser('test', help='run Windows tests against a disposable VM or remote Windows host')
    p.add_argument('--base', default=os.environ.get('WINVM_BASE'), help='golden Windows qcow2 base image')
    p.add_argument('--dockur', action='store_true', help='Linux KVM ephemeral dockurr/windows container')
    p.add_argument('--host', default=os.environ.get('WIN_TEST_HOST'), help='existing SSH Windows host alias')
    p.add_argument('--suite', choices=['all', 'hub', 'web', 'desktop', 'app'], default='all')
    p.add_argument('--dist', action='store_true', help='build NSIS installer (scripts/desktop.sh dist) instead of unpacked app')
    p.add_argument('--keep', action='store_true', help='leave disposable VM running after tests')
    p.add_argument('--arch', default=HOST_ARCH)
    p.add_argument('--memory', type=int, default=4096)
    p.add_argument('--cpus', type=int, default=4)
    p.add_argument('--version', default='11')
    p.add_argument('--rdp', action='store_true')
    p.add_argument('--emulate', action='store_true')
    p.add_argument('--timeout', type=int, default=1200)

    p = sub.add_parser('gce', help='a Windows test host on Google Compute Engine (WINVM_GCE_* in .env)')
    p.add_argument('action', choices=['create', 'check', 'start', 'stop', 'status', 'update-script', 'delete'])
    p.add_argument('--timeout', type=int, default=1800)

    sub.add_parser('status')
    sub.add_parser('down')
    p = sub.add_parser('clean')
    p.add_argument('--keep-cache', action='store_true')
    a = ap.parse_args()

    atexit.register(_cleanup_started)
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, _on_signal)

    if a.cmd == 'bootstrap':
        up_qemu(None, a.arch, a.memory, a.cpus, a.rdp, a.display, a.emulate, a.timeout,
                iso=a.iso, virtio=a.virtio, bootstrap_out=a.out)
        down()
        log(f'golden Windows base image ready at {os.path.abspath(a.out)}')
    elif a.cmd == 'up':
        if a.dockur:
            up_dockur(a.memory, a.cpus, a.rdp, a.version, a.timeout)
        else:
            up_qemu(a.base, a.arch, a.memory, a.cpus, a.rdp, a.display, a.emulate, a.timeout)
        global _started_kind
        _started_kind = None  # asked to keep running until TTL or `down`
    elif a.cmd == 'ssh':
        cmd = a.command[1:] if a.command[:1] == ['--'] else a.command
        if a.host:
            ssh_opts = [os.path.expanduser(t) for t in shlex.split(os.environ.get('WINVM_SSH_OPTS', ''))]
            ssh_base = ['ssh', '-t' if not cmd else '-T', *ssh_opts, a.host]
        else:
            st_path = os.path.join(WORK, 'state.json')
            if not os.path.exists(st_path):
                raise Fail('no running Windows VM (start one with `winvm.py up` or pass --host)')
            ssh_base = local_ssh_argv(json.load(open(st_path)), tty=not cmd)
        return subprocess.run(ssh_base + ([' '.join(cmd)] if cmd else [])).returncode
    elif a.cmd == 'test':
        if a.host:
            # The GCE host (WINVM_GCE_INSTANCE) is started when stopped, and
            # stopped again after the tests unless --keep.
            started = a.host == GCE_INSTANCE and gce_start(a.timeout)
            try:
                if a.host == GCE_INSTANCE:
                    gce_check()
                return run_windows_tests(win_ssh_prefix(host=a.host), a.suite, a.dist)
            finally:
                if started and not a.keep:
                    gce_stop()
        st = None
        if a.dockur:
            st = up_dockur(a.memory, a.cpus, a.rdp, a.version, a.timeout)
        elif a.base:
            st = up_qemu(a.base, a.arch, a.memory, a.cpus, a.rdp, False, a.emulate, a.timeout)
        else:
            st_path = os.path.join(WORK, 'state.json')
            if os.path.exists(st_path):
                st = json.load(open(st_path))
            else:
                raise Fail('specify --base <windows.qcow2>, --dockur (Linux KVM), or --host <ssh-alias> / WIN_TEST_HOST')
        try:
            return run_windows_tests(win_ssh_prefix(state=st), a.suite, a.dist)
        finally:
            if a.keep:
                _started_kind = None
    elif a.cmd == 'gce':
        if a.action == 'create':
            gce_create(a.timeout)
        elif a.action == 'check':
            gce_cfg()
            gce_check()
        elif a.action == 'start':
            gce_start(a.timeout)
            gce_check()
        elif a.action == 'stop':
            gce_stop()
        elif a.action == 'status':
            gce_cfg()
            print(f'{GCE_INSTANCE} {gce_status() or "absent"}')
        elif a.action == 'update-script':
            gce_update_script()
            log('the startup script runs at the next boot')
        elif a.action == 'delete':
            gce_delete()
    elif a.cmd == 'status':
        status()
    elif a.cmd == 'down':
        down()
    elif a.cmd == 'clean':
        clean(a.keep_cache)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Fail as e:
        log(f'error: {e}')
        sys.exit(1)

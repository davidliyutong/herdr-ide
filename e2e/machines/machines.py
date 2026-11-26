#!/usr/bin/env -S python3 -I
"""Disposable test machines for what the host itself cannot answer.

Containers (kind "docker") share the host's kernel and vary the C library;
virtual machines (kind "vm") boot their own kernels from official cloud images
using KVM on Linux or HVF on macOS (and TCG when --emulate / MACHINES_EMULATE=1
is set); "local" is the host itself. images.json lists them.

  machines.py fetch IMAGE... [--arch ARCH]
  machines.py up IMAGE... [--arch ARCH] [--emulate]
  machines.py ssh IMAGE [-- CMD...]
  machines.py copy IMAGE FILE... [--to DIR]
  machines.py down IMAGE...|--all
  machines.py status
  machines.py run-matrix SCRIPT [IMAGE...] [--payload DIR] [--results DIR] [-j N] [--keep] [--arch ARCH] [--emulate] [--all-arch]
  machines.py remote HOST SCRIPT [IMAGE...] [--payload DIR] [--results DIR] [-j N] [--keep] [--arch ARCH] [--emulate] [--all-arch]
  machines.py clean [--keep-cache]

Everything it creates lives under $MACHINES_WORK (default ./.machines-work).
VMs and containers are named <prefix>-<image> ($MACHINES_PREFIX; by default
the product's slug plus "-machines"), containers carry the label
<prefix>.image, and `down --all` touches nothing else. What a command starts
is stopped when it exits or is interrupted, except what `up` was asked to leave
running; that ends by itself after $MACHINES_TTL seconds (default 7200).
"""
import argparse
import atexit
import functools
import hashlib
import http.server
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
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def _load_repo_dotenv():
    """Delegates `.env` parsing to the single canonical scripts/dotenv.py
    when present (machines.py may also run standalone on a remote host)."""
    mod_path = os.path.join(REPO_ROOT, 'scripts', 'dotenv.py')
    if not os.path.isfile(mod_path):
        return
    spec = importlib.util.spec_from_file_location('_repo_dotenv', mod_path)
    if spec and spec.loader:
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.load_dotenv(os.path.join(REPO_ROOT, '.env'))


_load_repo_dotenv()

MANIFEST = os.environ.get('MACHINES_MANIFEST') or os.path.join(HERE, 'images.json')
WORK = os.path.abspath(os.environ.get('MACHINES_WORK') or '.machines-work')
CACHE = os.path.abspath(os.environ.get('MACHINES_CACHE') or os.path.join(WORK, 'cache'))
TTL = int(os.environ.get('MACHINES_TTL') or 7200)
DEFAULT_EMULATE = os.environ.get('MACHINES_EMULATE') == '1'
DEFAULT_ARCH = os.environ.get('MACHINES_ARCH') or None
DEVNULL = subprocess.DEVNULL
# Never ask the user's ssh agent: VMs get a key of their own.
# COPYFILE_DISABLE=1 stops macOS tar from emitting Apple xattr headers to Linux.
ENV = {**{k: v for k, v in os.environ.items() if k != 'SSH_AUTH_SOCK'}, 'COPYFILE_DISABLE': '1'}

HOST_OS = 'darwin' if sys.platform == 'darwin' else 'linux' if sys.platform.startswith('linux') else sys.platform
_raw_arch = platform.machine().lower()
HOST_ARCH = 'arm64' if _raw_arch in ('arm64', 'aarch64') else 'amd64' if _raw_arch in ('x86_64', 'amd64') else _raw_arch


def default_prefix():
    """The product's slug (backend/shared/lib/brand.ts) plus "-machines"."""
    try:
        with open(os.path.join(HERE, '..', '..', 'backend', 'shared', 'lib', 'brand.ts')) as f:
            m = re.search(r"^export const SLUG = '(.*)';$", f.read(), re.M)
        if m:
            return m.group(1) + '-machines'
    except OSError:
        pass
    return 'machines'


PREFIX = os.environ.get('MACHINES_PREFIX') or default_prefix()
LABEL = PREFIX + '.image'

_lock = threading.Lock()
_stopping = threading.Event()
_started = {}  # name -> image: stopped at exit unless kept
_docker_arch_cache = None
_qemu_accel_cache = {}


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


def load_images():
    with open(MANIFEST) as f:
        return {i['name']: i for i in json.load(f)['images']}


def cname(img):
    return f"{PREFIX}-{img['name']}"


def norm_arch(a):
    if not a:
        return None
    a = a.lower()
    if a in ('x86_64', 'amd64', 'x64'):
        return 'amd64'
    if a in ('aarch64', 'arm64'):
        return 'arm64'
    raise Fail(f'unsupported architecture: {a}')


def docker_host_arch():
    global _docker_arch_cache
    if _docker_arch_cache is not None:
        return _docker_arch_cache
    r = subprocess.run(['docker', 'info', '--format', '{{.Architecture}}'], stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
    if r.returncode != 0:
        _docker_arch_cache = ''
    else:
        raw = r.stdout.strip().lower()
        _docker_arch_cache = 'arm64' if raw in ('aarch64', 'arm64') else 'amd64' if raw in ('x86_64', 'amd64') else raw
    return _docker_arch_cache


def docker_arch_for(img, requested_arch=None):
    """Target architecture for a docker image entry."""
    if img.get('arch'):
        pinned = norm_arch(img['arch'])
        if requested_arch and requested_arch != pinned:
            log(f"{img['name']}: image is {pinned}-only; ignoring --arch {requested_arch}")
        return pinned
    arches = [norm_arch(a) for a in img.get('arches', ['amd64'])]
    if requested_arch:
        if requested_arch not in arches:
            raise Fail(f"{img['name']}: does not support arch {requested_arch} (has {', '.join(arches)})")
        return requested_arch
    darch = docker_host_arch()
    if darch in arches:
        return darch
    return arches[0]


def vm_arch_for(img):
    return norm_arch(img.get('arch', 'amd64'))


def qemu_bin_for(arch):
    return 'qemu-system-aarch64' if arch == 'arm64' else 'qemu-system-x86_64'


def qemu_has_accel(qemu_bin, accel):
    key = (qemu_bin, accel)
    if key in _qemu_accel_cache:
        return _qemu_accel_cache[key]
    if not shutil.which(qemu_bin):
        _qemu_accel_cache[key] = False
        return False
    r = subprocess.run([qemu_bin, '-accel', 'help'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    ok = r.returncode == 0 and any(line.strip() == accel for line in r.stdout.splitlines())
    _qemu_accel_cache[key] = ok
    return ok


def select_vm_accel(arch, emulate=False):
    """Picks hardware acceleration (KVM on Linux, HVF on macOS) or TCG when allowed."""
    qemu_bin = qemu_bin_for(arch)
    if not shutil.which(qemu_bin):
        raise Fail(f'{qemu_bin} is not installed')
    if HOST_OS == 'linux' and arch == HOST_ARCH:
        if os.access('/dev/kvm', os.R_OK | os.W_OK) and qemu_has_accel(qemu_bin, 'kvm'):
            return 'kvm'
        if emulate and qemu_has_accel(qemu_bin, 'tcg'):
            return 'tcg'
        raise Fail(f'/dev/kvm is not accessible for {arch} VMs (add user to group kvm, or pass --emulate for slow TCG)')
    if HOST_OS == 'darwin' and arch == HOST_ARCH:
        if qemu_has_accel(qemu_bin, 'hvf'):
            return 'hvf'
        if emulate and qemu_has_accel(qemu_bin, 'tcg'):
            return 'tcg'
        raise Fail(f'{qemu_bin} does not support macOS HVF acceleration (pass --emulate for TCG)')
    if emulate and qemu_has_accel(qemu_bin, 'tcg'):
        return 'tcg'
    raise Fail(
        f"{arch} VM cannot use hardware acceleration on {HOST_OS}/{HOST_ARCH}; "
        f"use a native {HOST_ARCH} image, pass --emulate (TCG), or run via `machines.py remote <kvm-host>`"
    )


def find_arm64_uefi():
    """Finds (code_path, vars_template_or_none) for ARM64 UEFI boot."""
    env_code = os.environ.get('MACHINES_UEFI_CODE')
    env_vars = os.environ.get('MACHINES_UEFI_VARS')
    if env_code and os.path.exists(env_code):
        return env_code, env_vars if (env_vars and os.path.exists(env_vars)) else None
    candidates = [
        ('/opt/homebrew/share/qemu/edk2-aarch64-code.fd', '/opt/homebrew/share/qemu/edk2-arm-vars.fd'),
        ('/usr/local/share/qemu/edk2-aarch64-code.fd', '/usr/local/share/qemu/edk2-arm-vars.fd'),
        ('/usr/share/AAVMF/AAVMF_CODE.no-secboot.fd', '/usr/share/AAVMF/AAVMF_VARS.fd'),
        ('/usr/share/AAVMF/AAVMF_CODE.fd', '/usr/share/AAVMF/AAVMF_VARS.fd'),
        ('/usr/share/edk2/aarch64/QEMU_EFI-pflash.raw', '/usr/share/edk2/aarch64/vars-template-pflash.raw'),
        ('/usr/share/edk2-armvirt/aarch64/QEMU_EFI.fd', None),
        ('/usr/share/qemu-efi-aarch64/QEMU_EFI.fd', None),
    ]
    for code, v in candidates:
        if os.path.exists(code):
            return code, (v if (v and os.path.exists(v)) else None)
    raise Fail(
        'ARM64 UEFI firmware not found (install qemu-efi-aarch64 on Debian/Ubuntu, edk2-aarch64 on Fedora, '
        'or Homebrew qemu on macOS; or set MACHINES_UEFI_CODE)'
    )


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def spawn_ttl_watchdog(pid, pidfile, ttl):
    """Detached timer that stops pid after ttl seconds if pidfile still names it."""
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


# ---------------------------------------------------------------- fetch

def docker_ref(img):
    name = img['image']
    if ':' in name.split('/')[-1]:
        name = name.rsplit(':', 1)[0]
    return f"{name}@{img['digest']}"


def verify(path, img):
    algos = [a for a in ('sha256', 'sha512') if img.get(a)]
    if not algos:
        raise Fail(f"{img['name']}: no pinned sha256 in the manifest")
    for algo in algos:
        h = hashlib.new(algo)
        with open(path, 'rb') as f:
            for block in iter(lambda: f.read(1 << 20), b''):
                h.update(block)
        if h.hexdigest() != img[algo]:
            raise Fail(f"{img['name']}: {algo} {h.hexdigest()} is not the pinned {img[algo]}")


def fetch(img, requested_arch=None):
    """Returns the image's local reference: a qcow2 path or a (docker ref, arch) tuple."""
    with _lock:
        os.makedirs(WORK, exist_ok=True)
        if img['kind'] == 'local':
            return None
        if img['kind'] == 'docker':
            ref = docker_ref(img)
            arch = docker_arch_for(img, requested_arch)
            plat = f'linux/{arch}'
            insp = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Architecture}}', ref],
                                  stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
            got_arch = insp.stdout.strip().lower() if insp.returncode == 0 else ''
            got_arch = 'arm64' if got_arch in ('aarch64', 'arm64') else 'amd64' if got_arch in ('x86_64', 'amd64') else got_arch
            if got_arch != arch:
                if got_arch:
                    # Docker refuses to overwrite a cached multi-arch digest ref with another platform.
                    log(f"{img['name']}: replacing local {got_arch} copy of {ref} with {plat}")
                    subprocess.run(['docker', 'rmi', ref], stdout=DEVNULL, stderr=DEVNULL)
                log(f"{img['name']}: pulling {ref} ({plat})")
                run(['docker', 'pull', '-q', '--platform', plat, ref], stdout=DEVNULL)
                with open(os.path.join(WORK, 'docker-pulled'), 'a') as f:
                    f.write(ref + '\n')  # `clean` removes only what we pulled
            return (ref, arch)
        # named by digest: images may share a file, a new pin downloads again
        digest = img.get('sha256') or img.get('sha512') or ''
        path = os.path.join(CACHE, f"{digest[:16]}-{os.path.basename(img['url'])}")
        if digest and os.path.exists(path):
            return path
        os.makedirs(CACHE, exist_ok=True)
        part = path + '.part'
        for url in [img['url']] + img.get('fallback', []):
            log(f"{img['name']}: downloading {url}")
            if subprocess.run(['curl', '-fL', '-sS', '--retry', '3', '--connect-timeout', '30', '-o', part, url]).returncode == 0:
                break
        else:
            raise Fail(f"{img['name']}: no URL could be downloaded")
        try:
            verify(part, img)
        except Fail:
            os.remove(part)
            raise
        os.rename(part, path)
        return path


# ---------------------------------------------------------------- VMs

def vmdir(img):
    return os.path.join(WORK, 'vms', img['name'])


def qemu_procs():
    """Our qemu processes (this user, -name <prefix>-*): pid -> image name."""
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
            if not args or 'qemu-system' not in os.path.basename(args[0]) or '-name' not in args[:-1]:
                continue
            name = args[args.index('-name') + 1]
            if name.startswith(PREFIX + '-'):
                out[int(d)] = name[len(PREFIX) + 1:]
        return out
    # macOS / POSIX without /proc: inspect processes via ps (-ww prevents truncation).
    r = subprocess.run(['ps', '-wwaxo', 'pid=,uid=,command='], stdout=subprocess.PIPE, stderr=DEVNULL, text=True)
    if r.returncode != 0:
        return out
    uid = os.getuid()
    for line in r.stdout.splitlines():
        m = re.match(r'^\s*(\d+)\s+(\d+)\s+(.*)$', line)
        if not m or int(m.group(2)) != uid:
            continue
        pid, cmd = int(m.group(1)), m.group(3)
        if 'qemu-system' not in cmd or f'-name {PREFIX}-' not in cmd:
            continue
        nm = re.search(rf'-name\s+{re.escape(PREFIX)}-(\S+)', cmd)
        if nm:
            out[pid] = nm.group(1)
    return out


def ensure_key():
    key = os.path.join(WORK, 'id_ed25519')
    if not os.path.exists(key):
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', PREFIX, '-f', key])
    return key


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def ssh_argv(img, tty=False):
    with open(os.path.join(vmdir(img), 'ssh.json')) as f:
        st = json.load(f)
    opts = ['IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes', 'StrictHostKeyChecking=no',
            'UserKnownHostsFile=/dev/null', 'LogLevel=ERROR', 'ConnectTimeout=10', 'ServerAliveInterval=15']
    argv = ['ssh', '-F', '/dev/null', '-i', os.path.join(WORK, 'id_ed25519'), '-p', str(st['port'])]
    for o in opts:
        argv += ['-o', o]
    return argv + ['-t' if tty else '-T', f"{st['user']}@127.0.0.1"]


USER_DATA = """#cloud-config
ssh_authorized_keys:
  - {key}
ssh_pwauth: false
manage_etc_hosts: true
package_update: false
package_upgrade: false
"""


class SeedHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        with open(os.path.join(self.directory, '..', 'seed.log'), 'a') as f:
            f.write(fmt % args + '\n')


def tail(path, n=25):
    try:
        with open(path, errors='replace') as f:
            return ''.join(f.readlines()[-n:])
    except OSError:
        return ''


def build_qemu_argv(img, arch, accel, overlay, d, port, seed_port):
    qemu_bin = qemu_bin_for(arch)
    mem = str(img.get('memory', 2048))
    cpus = str(img.get('cpus', 2))
    argv = [qemu_bin, '-name', cname(img)]
    if arch == 'arm64':
        if accel == 'hvf':
            argv += ['-M', 'virt,highmem=on', '-accel', 'hvf', '-cpu', img.get('cpu', 'host')]
        elif accel == 'kvm':
            argv += ['-M', 'virt,gic-version=host', '-accel', 'kvm', '-cpu', img.get('cpu', 'host')]
        else:
            argv += ['-M', 'virt', '-accel', 'tcg,thread=multi', '-cpu', img.get('cpu', 'cortex-a72')]
        code, vars_tpl = find_arm64_uefi()
        if os.path.getsize(code) == (64 << 20):
            vars_dst = os.path.join(d, 'efivars.fd')
            if vars_tpl and os.path.getsize(vars_tpl) == (64 << 20):
                shutil.copyfile(vars_tpl, vars_dst)
            else:
                with open(vars_dst, 'wb') as vf:
                    vf.truncate(64 << 20)
            argv += ['-drive', f'if=pflash,format=raw,readonly=on,file={code}',
                     '-drive', f'if=pflash,format=raw,file={vars_dst}']
        else:
            argv += ['-bios', code]
    else:
        if accel == 'kvm':
            argv += ['-accel', 'kvm', '-cpu', img.get('cpu', 'host')]
        elif accel == 'hvf':
            argv += ['-accel', 'hvf', '-cpu', img.get('cpu', 'host')]
        else:
            # qemu64 lacks SSE4.2 which Bun requires; Nehalem provides it under TCG.
            argv += ['-accel', 'tcg,thread=multi', '-cpu', img.get('cpu', 'Nehalem')]
    argv += [
        '-m', mem, '-smp', cpus, '-display', 'none', '-monitor', 'none',
        '-serial', f'file:{d}/console.log', '-pidfile', f'{d}/qemu.pid',
        '-drive', f'file={overlay},if=virtio,format=qcow2',
        '-device', 'virtio-rng-pci',
        '-netdev', f'user,id=n0,hostfwd=tcp:127.0.0.1:{port}-:22',
        '-device', 'virtio-net-pci,netdev=n0',
        '-smbios', f'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:{seed_port}/',
    ]
    return argv


def up_vm(img, emulate=False):
    name = img['name']
    if name in qemu_procs().values():
        return False
    arch = vm_arch_for(img)
    accel = select_vm_accel(arch, emulate=emulate)
    base = fetch(img)
    with _lock:
        key = ensure_key()
    d = vmdir(img)
    shutil.rmtree(d, ignore_errors=True)
    seed = os.path.join(d, 'seed')
    os.makedirs(seed)
    with open(key + '.pub') as f:
        pub = f.read().strip()
    with open(os.path.join(seed, 'user-data'), 'w') as f:
        f.write(USER_DATA.format(key=pub))
    with open(os.path.join(seed, 'meta-data'), 'w') as f:
        # a dot would make the rest a domain name sudo then fails to resolve
        f.write(f"instance-id: {PREFIX}-{name}-{secrets.token_hex(4)}\nlocal-hostname: {name.replace('.', '-')}\n")
    info = json.loads(run(['qemu-img', 'info', '--output=json', base], stdout=subprocess.PIPE).stdout)
    overlay = os.path.join(d, 'overlay.qcow2')
    run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', base, '-F', info.get('format', 'qcow2'), overlay,
         str(max(info['virtual-size'], 8 << 30))])
    # The NoCloud seed over HTTP (no ISO tools needed): the guest reaches the
    # host's loopback at 10.0.2.2 and finds the URL in the SMBIOS serial.
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SeedHandler, directory=seed))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with _lock:
            port = free_port()
            with open(os.path.join(d, 'ssh.json'), 'w') as f:
                json.dump({'port': port, 'user': img['user'], 'arch': arch, 'accel': accel}, f)
            argv = build_qemu_argv(img, arch, accel, overlay, d, port, srv.server_address[1])
            _started[name] = img
            with open(os.path.join(d, 'qemu.log'), 'w') as qlog:
                p = subprocess.Popen(argv, stdin=DEVNULL, stdout=qlog, stderr=subprocess.STDOUT,
                                     start_new_session=True, env=ENV)
            spawn_ttl_watchdog(p.pid, os.path.join(d, 'qemu.pid'), TTL)
        log(f'{name}: booting ({arch}, {accel}, ssh on 127.0.0.1:{port}, console {d}/console.log)')
        t0 = time.time()
        boot_timeout = img.get('boot_timeout', 600)
        if accel == 'tcg':
            boot_timeout = max(boot_timeout, 1200)
        deadline = t0 + boot_timeout
        while time.time() < deadline:
            if p.poll() is not None:
                raise Fail(f'{name}: qemu exited {p.returncode}:\n{tail(os.path.join(d, "qemu.log"))}')
            r = subprocess.run(ssh_argv(img) + ['true'], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=ENV)
            if r.returncode == 0:
                log(f'{name}: up after {time.time() - t0:.0f}s ({accel})')
                return True
            time.sleep(3)
        raise Fail(f'{name}: no ssh after {boot_timeout}s; console:\n{tail(os.path.join(d, "console.log"))}')
    finally:
        srv.shutdown()
        srv.server_close()


def down_vm(img):
    pids = [pid for pid, n in qemu_procs().items() if n == img['name']]
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        for _ in range(50):
            pids = [p for p in pids if pid_alive(p)]
            if not pids:
                break
            time.sleep(0.2)
    shutil.rmtree(vmdir(img), ignore_errors=True)


# ---------------------------------------------------------------- containers

def docker_ids(name=None):
    flt = ['--filter', f'label={LABEL}={name}' if name else f'label={LABEL}']
    return run(['docker', 'ps', '-aq'] + flt, stdout=subprocess.PIPE, text=True).stdout.split()


def up_docker(img, payload=None, requested_arch=None):
    if docker_ids(img['name']):
        return False
    ref, arch = fetch(img, requested_arch=requested_arch)
    argv = ['docker', 'run', '-d', '--rm', '--platform', f'linux/{arch}', '--name', cname(img),
            '--label', f"{LABEL}={img['name']}"]
    if payload:
        argv += ['-v', f'{payload}:/payload:ro']
    _started[img['name']] = img
    run(argv + [ref, 'sleep', str(TTL)], stdout=DEVNULL)
    if img.get('prepare'):
        log(f"{img['name']}: {img['prepare']}")
        run(exec_argv(img, img['prepare'], root=True), stdout=DEVNULL)
    return True


# ---------------------------------------------------------------- any kind

def localdir(img):
    return os.path.join(WORK, 'local', img['name'])


def is_up(img):
    if img['kind'] == 'vm':
        return img['name'] in qemu_procs().values()
    if img['kind'] == 'docker':
        return bool(docker_ids(img['name']))
    return os.path.isdir(localdir(img))


def up(img, payload=None, requested_arch=None, emulate=False):
    if img['kind'] == 'vm':
        return up_vm(img, emulate=emulate)
    if img['kind'] == 'docker':
        return up_docker(img, payload, requested_arch=requested_arch)
    os.makedirs(localdir(img), exist_ok=True)
    _started[img['name']] = img
    return True


def down(img):
    _started.pop(img['name'], None)
    if img['kind'] == 'vm':
        down_vm(img)
    elif img['kind'] == 'docker':
        ids = docker_ids(img['name'])
        if ids:
            subprocess.run(['docker', 'rm', '-f'] + ids, stdout=DEVNULL, stderr=DEVNULL)
    else:
        shutil.rmtree(localdir(img), ignore_errors=True)


def exec_argv(img, cmd, tty=False, root=False, env=None):
    """argv that runs the shell command cmd in the machine (its home or workdir)."""
    env = env or {}
    if img['kind'] == 'docker':
        argv = ['docker', 'exec', '-i'] + (['-t'] if tty else []) + (['-u', '0'] if root else [])
        for k, v in env.items():
            argv += ['-e', f'{k}={v}']
        return argv + [cname(img), 'sh', '-c', cmd]
    inner = ' '.join(['env'] + [shlex.quote(f'{k}={v}') for k, v in env.items()] + ['sh', '-c', shlex.quote(cmd)])
    if img['kind'] == 'vm':
        return ssh_argv(img, tty) + [('sudo ' if root else '') + inner]
    return ['sh', '-c', f'cd {shlex.quote(localdir(img))} && {inner}']


def tar_create_cmd():
    return ['tar', '--no-xattrs', '--no-mac-metadata'] if HOST_OS == 'darwin' else ['tar']


def copy_in(img, files, dest):
    files = [os.path.abspath(f) for f in files]
    tar = tar_create_cmd() + ['-cf', '-']
    for f in files:
        tar += ['-C', os.path.dirname(f), os.path.basename(f)]
    q = shlex.quote(dest)
    p = subprocess.Popen(tar, stdout=subprocess.PIPE, env=ENV)
    try:
        r = subprocess.run(exec_argv(img, f'mkdir -p {q} && tar -xf - -C {q}'), stdin=p.stdout, env=ENV)
    finally:
        p.stdout.close()  # tar gets SIGPIPE if the other side gave up
        p.wait()
    if r.returncode or p.returncode:
        raise Fail(f"copy into {img['name']}: tar exited {p.returncode}, extraction {r.returncode}")


# ---------------------------------------------------------------- the matrix

def default_matrix_images(known, requested_arch=None, emulate=False, all_arch=False):
    """Selects images runnable on this host when none were named explicitly."""
    imgs = []
    skipped = []
    has_docker = bool(shutil.which('docker') and docker_host_arch())
    target_arch = requested_arch or HOST_ARCH
    for img in known.values():
        if img['kind'] == 'local':
            imgs.append(img)
        elif img['kind'] == 'docker':
            if not has_docker:
                skipped.append(f"{img['name']} (no docker)")
                continue
            arches = [norm_arch(img['arch'])] if img.get('arch') else [norm_arch(a) for a in img.get('arches', ['amd64'])]
            if all_arch or not requested_arch or requested_arch in arches:
                imgs.append(img)
            else:
                skipped.append(f"{img['name']} (not {requested_arch})")
        elif img['kind'] == 'vm':
            arch = vm_arch_for(img)
            if not all_arch and arch != target_arch:
                skipped.append(f"{img['name']} ({arch})")
                continue
            try:
                select_vm_accel(arch, emulate=emulate)
                imgs.append(img)
            except Fail:
                skipped.append(f"{img['name']} (no accel)")
    if skipped:
        log(f"default matrix on {HOST_OS}/{HOST_ARCH}: skipping {', '.join(skipped)} (pass names, --all-arch --emulate, or use `remote <host>`)")
    return imgs


def run_one(img, script, payload, results, keep, timeout, requested_arch=None, emulate=False):
    name, kind = img['name'], img['kind']
    out = os.path.join(results, name + '.txt')
    was_up = is_up(img)
    t0 = time.time()
    code = None
    with open(out, 'w') as f:
        src = img.get('url') or (docker_ref(img) if kind == 'docker' else 'this host')
        f.write(f'# {name} ({kind}) {src}\n# expected: {json.dumps(img.get("expect", {}))}\n')
        f.flush()
        try:
            up(img, payload if kind == 'docker' else None, requested_arch=requested_arch, emulate=emulate)
            if kind == 'docker' and not was_up:
                wdir = '/payload'  # mounted read-only
            else:
                wdir = '/tmp/payload' if kind == 'docker' else 'payload'
                run(exec_argv(img, f'rm -rf {wdir}'))
                copy_in(img, [os.path.join(payload, e) for e in sorted(os.listdir(payload))], wdir)
            sysinfo = run(exec_argv(img, 'uname -srm; (ldd --version 2>&1 || true) | head -1'),
                          stdout=subprocess.PIPE, text=True).stdout.strip()
            f.write(''.join(f'# {line}\n' for line in sysinfo.splitlines()))
            want = img.get('expect', {}).get('kernel')
            if kind == 'vm' and want and not sysinfo.split()[1].startswith(want):
                f.write(f'# WARNING: kernel is not the expected {want}\n')
            f.write('\n')
            f.flush()
            r = subprocess.run(exec_argv(img, f'cd {shlex.quote(wdir)} && sh ./{shlex.quote(script)}',
                                         env={'MACHINE_NAME': name, 'MACHINE_KIND': kind}),
                               stdin=DEVNULL, stdout=f, stderr=subprocess.STDOUT, timeout=timeout, env=ENV)
            code = r.returncode
        except Exception as e:
            f.write(f'\n# HARNESS ERROR: {e}\n')
        finally:
            f.write(f'\n# exit {code} after {time.time() - t0:.0f}s\n')
            if not keep and not was_up:
                down(img)
    log(f'{name}: exit {code} ({time.time() - t0:.0f}s) -> {out}')
    return code


def run_matrix(images, script, payload, results, jobs, keep, timeout, requested_arch=None, emulate=False):
    payload = os.path.abspath(payload or os.path.dirname(os.path.abspath(script)))
    script = os.path.relpath(os.path.abspath(script), payload)
    if script.startswith('..'):
        raise Fail('the script must be inside the payload directory')
    results = os.path.abspath(results or os.path.join(WORK, 'results'))
    os.makedirs(results, exist_ok=True)
    for img in images:  # downloads first, one at a time
        fetch(img, requested_arch=requested_arch)
    if any(i['kind'] == 'vm' for i in images):
        ensure_key()
    todo, codes = list(images), {}

    def worker():
        while True:
            with _lock:
                if not todo or _stopping.is_set():
                    return
                img = todo.pop(0)
            codes[img['name']] = run_one(img, script, payload, results, keep, timeout,
                                         requested_arch=requested_arch, emulate=emulate)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, jobs))]
    for t in threads:
        t.start()
    for t in threads:
        while t.is_alive():
            t.join(1)  # wakes up for signals
    print(f'{"image":32} exit')
    for img in images:
        print(f'{img["name"]:32} {codes.get(img["name"])}')
    return 0 if all(codes.get(i['name']) == 0 for i in images) else 1


# ---------------------------------------------------------------- remote KVM/GPU host

def run_remote(host, script, images, payload, results, jobs, keep, timeout, requested_arch, emulate, all_arch, keep_remote):
    """Ships the harness and payload to a remote SSH host (e.g. Linux KVM/GPU),
    runs run-matrix there, pulls results back and cleans the remote run dir."""
    payload = os.path.abspath(payload or os.path.dirname(os.path.abspath(script)))
    rel_script = os.path.relpath(os.path.abspath(script), payload)
    if rel_script.startswith('..'):
        raise Fail('the script must be inside the payload directory')
    results = os.path.abspath(results or os.path.join(WORK, f'results-{re.sub(r"[^A-Za-z0-9._-]", "_", host)}'))
    os.makedirs(results, exist_ok=True)
    run_id = secrets.token_hex(4)
    rdir = f'~/{PREFIX}-remote-{run_id}'
    rcache = f'~/{PREFIX}-cache'
    # Use the user's normal ssh environment for connecting to the remote host.
    raw_opts = os.environ.get('MACHINES_SSH_OPTS') or os.environ.get('LINUX_TEST_SSH_OPTS') or ''
    ssh_opts = [os.path.expanduser(t) for t in shlex.split(raw_opts)]
    ssh_base = ['ssh', '-o', 'ServerAliveInterval=15', *ssh_opts, host]
    log(f'remote {host}: uploading harness + payload to {rdir}')
    p1 = subprocess.Popen(tar_create_cmd() + ['-C', HERE, '--exclude=.machines-work', '--exclude=__pycache__',
                           '--exclude=payloads', '-cf', '-', 'machines.py', 'images.json'], stdout=subprocess.PIPE, env=ENV)
    try:
        r1 = subprocess.run(ssh_base + [f'mkdir -p {rdir}/payload && tar -xf - -C {rdir}'], stdin=p1.stdout)
    finally:
        p1.stdout.close()
        p1.wait()
    if p1.returncode or r1.returncode:
        raise Fail(f'remote {host}: uploading harness failed')
    p2 = subprocess.Popen(tar_create_cmd() + ['-C', payload, '-cf', '-', '.'], stdout=subprocess.PIPE, env=ENV)
    try:
        r2 = subprocess.run(ssh_base + [f'tar -xf - -C {rdir}/payload'], stdin=p2.stdout)
    finally:
        p2.stdout.close()
        p2.wait()
    if p2.returncode or r2.returncode:
        raise Fail(f'remote {host}: uploading payload failed')

    rc = 1
    try:
        rm_args = [
            './machines.py', 'run-matrix', f'payload/{rel_script}', *images,
            '--payload', 'payload', '--results', '.work/results',
            '-j', str(jobs), '--timeout', str(timeout),
        ]
        if keep:
            rm_args.append('--keep')
        if requested_arch:
            rm_args += ['--arch', requested_arch]
        if emulate:
            rm_args.append('--emulate')
        if all_arch:
            rm_args.append('--all-arch')
        remote_cmd = (
            f'cd {rdir} && '
            f'MACHINES_PREFIX={shlex.quote(PREFIX)} '
            f'MACHINES_WORK={rdir}/.work '
            f'MACHINES_CACHE={rcache} '
            f'{shlex.join(rm_args)}'
        )
        log(f'remote {host}: running {shlex.join(rm_args)}')
        rc = subprocess.run(ssh_base + [remote_cmd]).returncode
        log(f'remote {host}: fetching results into {results}')
        p3 = subprocess.Popen(ssh_base + [f'tar -C {rdir}/.work/results -cf - . 2>/dev/null || true'], stdout=subprocess.PIPE)
        try:
            subprocess.run(['tar', '-xf', '-', '-C', results], stdin=p3.stdout)
        finally:
            p3.stdout.close()
            p3.wait()
    finally:
        if not keep_remote:
            log(f'remote {host}: cleaning {rdir} (keeping {rcache})')
            subprocess.run(
                ssh_base + [
                    f'if [ -d {rdir} ]; then cd {rdir} && MACHINES_PREFIX={shlex.quote(PREFIX)} '
                    f'MACHINES_WORK={rdir}/.work MACHINES_CACHE={rcache} ./machines.py clean --keep-cache; fi; '
                    f'rm -rf {rdir}'
                ],
                stdout=DEVNULL, stderr=DEVNULL,
            )
    return rc


# ---------------------------------------------------------------- cleanup

def down_all():
    for pid in qemu_procs():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if shutil.which('docker'):
        ids = docker_ids()
        if ids:
            subprocess.run(['docker', 'rm', '-f'] + ids, stdout=DEVNULL, stderr=DEVNULL)
    for sub in ('vms', 'local'):
        shutil.rmtree(os.path.join(WORK, sub), ignore_errors=True)


def clean(keep_cache):
    down_all()
    pulled = os.path.join(WORK, 'docker-pulled')
    if os.path.exists(pulled):
        with open(pulled) as f:
            for ref in sorted(set(f.read().split())):
                log(f'removing image {ref}')
                subprocess.run(['docker', 'rmi', ref], stdout=DEVNULL, stderr=DEVNULL)
    if not os.path.isdir(WORK):
        return
    for e in os.listdir(WORK):
        p = os.path.join(WORK, e)
        if keep_cache and p == CACHE:
            continue
        if os.path.isdir(p):
            shutil.rmtree(p)
        else:
            os.remove(p)
    if not keep_cache:
        shutil.rmtree(CACHE, ignore_errors=True)
        if os.path.isdir(WORK) and not os.listdir(WORK):
            os.rmdir(WORK)


def _stop_started():
    for img in list(_started.values()):
        try:
            down(img)
        except Exception as e:  # keep stopping the others
            log(f"{img['name']}: stopping failed: {e}")


def _on_signal(sig, _frame):
    _stopping.set()
    _stop_started()
    raise SystemExit(128 + sig)


def status():
    for pid, name in sorted(qemu_procs().items(), key=lambda x: x[1]):
        try:
            with open(os.path.join(WORK, 'vms', name, 'ssh.json')) as f:
                st = json.load(f)
            port, extra = st.get('port', '?'), f" ({st.get('arch', '?')}/{st.get('accel', '?')})"
        except OSError:
            port, extra = '?', ''
        print(f'vm      {name:28} pid {pid} ssh 127.0.0.1:{port}{extra}')
    if shutil.which('docker'):
        for line in run(['docker', 'ps', '--filter', f'label={LABEL}', '--format', '{{.Names}} {{.Status}}'],
                        stdout=subprocess.PIPE, text=True).stdout.splitlines():
            print(f'docker  {line}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('fetch')
    p.add_argument('images', nargs='+')
    p.add_argument('--arch', default=DEFAULT_ARCH, help='target arch for multi-arch docker images (amd64|arm64)')
    p = sub.add_parser('up')
    p.add_argument('images', nargs='+')
    p.add_argument('--arch', default=DEFAULT_ARCH, help='target arch for multi-arch docker images (amd64|arm64)')
    p.add_argument('--emulate', action='store_true', default=DEFAULT_EMULATE, help='allow TCG emulation when KVM/HVF is unavailable')
    p = sub.add_parser('ssh')
    p.add_argument('image')
    p.add_argument('command', nargs=argparse.REMAINDER)
    p = sub.add_parser('copy')
    p.add_argument('image')
    p.add_argument('files', nargs='+')
    p.add_argument('--to', default='.')
    p = sub.add_parser('down')
    p.add_argument('images', nargs='*')
    p.add_argument('--all', action='store_true')
    sub.add_parser('status')
    for cname_sub in ('run-matrix', 'remote'):
        p = sub.add_parser(cname_sub)
        if cname_sub == 'remote':
            p.add_argument('host', help='SSH host alias (e.g. a Linux KVM or GPU server)')
        p.add_argument('script', help='shell script run with sh in each machine, from the payload directory')
        p.add_argument('images', nargs='*', help='default: images natively runnable on the host')
        p.add_argument('--payload', help="directory copied (or mounted) in; default: the script's")
        p.add_argument('--results', help='default: $MACHINES_WORK/results')
        p.add_argument('-j', '--jobs', type=int, default=1)
        p.add_argument('--keep', action='store_true', help='leave the machines running')
        p.add_argument('--timeout', type=int, default=1800, help='seconds per machine')
        p.add_argument('--arch', default=DEFAULT_ARCH, help='target arch for docker images / default selection (amd64|arm64)')
        p.add_argument('--emulate', action='store_true', default=DEFAULT_EMULATE, help='allow TCG emulation for cross-arch or non-KVM VMs')
        p.add_argument('--all-arch', action='store_true', help='include all architectures when no image names are given')
        if cname_sub == 'remote':
            p.add_argument('--keep-remote', action='store_true', help='do not remove the temporary remote run directory')
    p = sub.add_parser('clean')
    p.add_argument('--keep-cache', action='store_true')
    a = ap.parse_args()

    known = load_images()

    def pick(names):
        missing = [n for n in names if n not in known]
        if missing:
            raise Fail(f'unknown image(s): {", ".join(missing)} (known: {", ".join(known)})')
        return [known[n] for n in names]

    atexit.register(_stop_started)
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, _on_signal)
    if a.cmd == 'fetch':
        arch = norm_arch(a.arch)
        for img in pick(a.images):
            print(img['name'], fetch(img, requested_arch=arch))
    elif a.cmd == 'up':
        arch = norm_arch(a.arch)
        for img in pick(a.images):
            up(img, requested_arch=arch, emulate=a.emulate)
        _started.clear()  # asked for: leave them running
    elif a.cmd == 'ssh':
        img = pick([a.image])[0]
        cmd = a.command[1:] if a.command[:1] == ['--'] else a.command
        if not is_up(img):
            raise Fail(f'{a.image} is not up')
        if not cmd:
            argv = exec_argv(img, 'exec ${SHELL:-sh} -l' if img['kind'] != 'docker' else 'exec sh', tty=True)
        else:
            argv = exec_argv(img, shlex.join(cmd) if len(cmd) > 1 else cmd[0])
        return subprocess.run(argv, env=ENV).returncode
    elif a.cmd == 'copy':
        copy_in(pick([a.image])[0], a.files, a.to)
    elif a.cmd == 'down':
        if a.all:
            down_all()
        for img in pick(a.images):
            down(img)
    elif a.cmd == 'status':
        status()
    elif a.cmd == 'run-matrix':
        arch = norm_arch(a.arch)
        imgs = pick(a.images) if a.images else default_matrix_images(known, requested_arch=arch, emulate=a.emulate, all_arch=a.all_arch)
        return run_matrix(imgs, a.script, a.payload, a.results, a.jobs, a.keep, a.timeout, requested_arch=arch, emulate=a.emulate)
    elif a.cmd == 'remote':
        host = os.environ.get('LINUX_TEST_HOST') if a.host == '-' else a.host
        if not host:
            raise Fail('remote host is "-" but LINUX_TEST_HOST is not set (set it in gitignored .env or pass a host alias)')
        arch = norm_arch(a.arch)
        if a.images:
            pick(a.images)  # validate names locally first
        return run_remote(host, a.script, a.images, a.payload, a.results, a.jobs, a.keep, a.timeout,
                          arch, a.emulate, a.all_arch, a.keep_remote)
    elif a.cmd == 'clean':
        clean(a.keep_cache)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Fail as e:
        log(f'error: {e}')
        sys.exit(1)

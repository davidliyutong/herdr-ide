#!/usr/bin/env -S python3 -I
"""Disposable test machines for what the host itself cannot answer.

Containers (kind "docker") share the host's kernel and vary the C library;
KVM virtual machines (kind "vm") boot their own kernels from official cloud
images; "local" is the host itself. images.json lists them.

  machines.py fetch IMAGE...           download and verify into the cache
  machines.py up IMAGE...              start (a VM: boot it and wait for ssh)
  machines.py ssh IMAGE [-- CMD...]    run a command in it (a shell without one)
  machines.py copy IMAGE FILE... [--to DIR]
  machines.py down IMAGE...|--all
  machines.py status
  machines.py run-matrix SCRIPT [IMAGE...] [--payload DIR] [--results DIR] [-j N] [--keep]
  machines.py clean [--keep-cache]     down --all, remove pulled images and the work dir

Everything it creates lives under $MACHINES_WORK (default ./.machines-work).
VMs and containers are named <prefix>-<image> ($MACHINES_PREFIX; by default
the product's slug plus "-machines"), containers carry
the label <prefix>.image, and `down --all` touches nothing else. What a
command starts is stopped when it exits or is interrupted, except what `up`
was asked to leave running; that ends by itself after $MACHINES_TTL seconds
(default 7200).
"""
import argparse
import atexit
import functools
import hashlib
import http.server
import json
import os
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
MANIFEST = os.environ.get('MACHINES_MANIFEST') or os.path.join(HERE, 'images.json')
WORK = os.path.abspath(os.environ.get('MACHINES_WORK') or '.machines-work')
CACHE = os.path.abspath(os.environ.get('MACHINES_CACHE') or os.path.join(WORK, 'cache'))
TTL = int(os.environ.get('MACHINES_TTL') or 7200)
DEVNULL = subprocess.DEVNULL
# Never ask the user's ssh agent: VMs get a key of their own.
ENV = {k: v for k, v in os.environ.items() if k != 'SSH_AUTH_SOCK'}


def default_prefix():
    """The product's slug (backend/shared/lib/brand.ts, else the Go
    program's internal/brand) plus "-machines"."""
    root = os.path.join(HERE, '..', '..')
    for rel, pat in ((('backend', 'shared', 'lib', 'brand.ts'), r"^export const SLUG = '(.*)';$"),
                     (('internal', 'brand', 'brand.go'), r'^\s*Slug = "(.*)"$')):
        try:
            with open(os.path.join(root, *rel)) as f:
                m = re.search(pat, f.read(), re.M)
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


def fetch(img):
    """Returns the image's local reference: a qcow2 path or a docker ref."""
    with _lock:
        os.makedirs(WORK, exist_ok=True)
        if img['kind'] == 'local':
            return None
        if img['kind'] == 'docker':
            ref = docker_ref(img)
            if subprocess.run(['docker', 'image', 'inspect', ref], stdout=DEVNULL, stderr=DEVNULL).returncode != 0:
                log(f"{img['name']}: pulling {ref}")
                run(['docker', 'pull', '-q', ref], stdout=DEVNULL)
                with open(os.path.join(WORK, 'docker-pulled'), 'a') as f:
                    f.write(ref + '\n')  # `clean` removes only what we pulled
            return ref
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
    if not os.path.isdir('/proc'):
        return out  # not Linux: no VMs here (containers still work)
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
        if 'qemu-system' not in os.path.basename(args[0]) or '-name' not in args[:-1]:
            continue
        name = args[args.index('-name') + 1]
        if name.startswith(PREFIX + '-'):
            out[int(d)] = name[len(PREFIX) + 1:]
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


def up_vm(img):
    name = img['name']
    if name in qemu_procs().values():
        return False
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
    run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', base, '-F', 'qcow2', overlay,
         str(max(info['virtual-size'], 8 << 30))])
    # The NoCloud seed over HTTP (no ISO tools needed): the guest reaches the
    # host's loopback at 10.0.2.2 and finds the URL in the SMBIOS serial.
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(SeedHandler, directory=seed))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with _lock:
            port = free_port()
            with open(os.path.join(d, 'ssh.json'), 'w') as f:
                json.dump({'port': port, 'user': img['user']}, f)
            argv = ['timeout', '-k', '30', str(TTL), 'qemu-system-x86_64', '-name', cname(img),
                    '-enable-kvm', '-cpu', img.get('cpu', 'host'), '-m', str(img.get('memory', 2048)),
                    '-smp', str(img.get('cpus', 2)), '-display', 'none', '-monitor', 'none',
                    '-serial', f'file:{d}/console.log', '-pidfile', f'{d}/qemu.pid',
                    '-drive', f'file={overlay},if=virtio,format=qcow2',
                    '-netdev', f'user,id=n0,hostfwd=tcp:127.0.0.1:{port}-:22',
                    '-device', 'virtio-net-pci,netdev=n0',
                    '-smbios', f'type=1,serial=ds=nocloud-net;s=http://10.0.2.2:{srv.server_address[1]}/']
            _started[name] = img
            with open(os.path.join(d, 'qemu.log'), 'w') as qlog:
                p = subprocess.Popen(argv, stdin=DEVNULL, stdout=qlog, stderr=subprocess.STDOUT,
                                     start_new_session=True, env=ENV)
        log(f'{name}: booting (ssh on 127.0.0.1:{port}, console {d}/console.log)')
        t0 = time.time()
        deadline = t0 + img.get('boot_timeout', 600)
        while time.time() < deadline:
            if p.poll() is not None:
                raise Fail(f'{name}: qemu exited {p.returncode}:\n{tail(os.path.join(d, "qemu.log"))}')
            r = subprocess.run(ssh_argv(img) + ['true'], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, env=ENV)
            if r.returncode == 0:
                log(f'{name}: up after {time.time() - t0:.0f}s')
                return True
            time.sleep(3)
        raise Fail(f'{name}: no ssh after {img.get("boot_timeout", 600)}s; console:\n{tail(os.path.join(d, "console.log"))}')
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
            pids = [p for p in pids if os.path.exists(f'/proc/{p}')]
            if not pids:
                break
            time.sleep(0.2)
    shutil.rmtree(vmdir(img), ignore_errors=True)


# ---------------------------------------------------------------- containers

def docker_ids(name=None):
    flt = ['--filter', f'label={LABEL}={name}' if name else f'label={LABEL}']
    return run(['docker', 'ps', '-aq'] + flt, stdout=subprocess.PIPE, text=True).stdout.split()


def up_docker(img, payload=None):
    if docker_ids(img['name']):
        return False
    ref = fetch(img)
    argv = ['docker', 'run', '-d', '--rm', '--name', cname(img), '--label', f"{LABEL}={img['name']}"]
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


def up(img, payload=None):
    if img['kind'] == 'vm':
        return up_vm(img)
    if img['kind'] == 'docker':
        return up_docker(img, payload)
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


def copy_in(img, files, dest):
    files = [os.path.abspath(f) for f in files]
    tar = ['tar', '-cf', '-']
    for f in files:
        tar += ['-C', os.path.dirname(f), os.path.basename(f)]
    q = shlex.quote(dest)
    p = subprocess.Popen(tar, stdout=subprocess.PIPE)
    try:
        r = subprocess.run(exec_argv(img, f'mkdir -p {q} && tar -xf - -C {q}'), stdin=p.stdout, env=ENV)
    finally:
        p.stdout.close()  # tar gets SIGPIPE if the other side gave up
        p.wait()
    if r.returncode or p.returncode:
        raise Fail(f"copy into {img['name']}: tar exited {p.returncode}, extraction {r.returncode}")


# ---------------------------------------------------------------- the matrix

def run_one(img, script, payload, results, keep, timeout):
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
            up(img, payload if kind == 'docker' else None)
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


def run_matrix(images, script, payload, results, jobs, keep, timeout):
    payload = os.path.abspath(payload or os.path.dirname(os.path.abspath(script)))
    script = os.path.relpath(os.path.abspath(script), payload)
    if script.startswith('..'):
        raise Fail('the script must be inside the payload directory')
    results = os.path.abspath(results or os.path.join(WORK, 'results'))
    os.makedirs(results, exist_ok=True)
    for img in images:  # downloads first, one at a time
        fetch(img)
    if any(i['kind'] == 'vm' for i in images):
        ensure_key()
    todo, codes = list(images), {}

    def worker():
        while True:
            with _lock:
                if not todo or _stopping.is_set():
                    return
                img = todo.pop(0)
            codes[img['name']] = run_one(img, script, payload, results, keep, timeout)

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
                subprocess.run(['docker', 'rmi', ref], stdout=DEVNULL)
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
        if not os.listdir(WORK):
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
                port = json.load(f)['port']
        except OSError:
            port = '?'
        print(f'vm      {name:28} pid {pid} ssh 127.0.0.1:{port}')
    if shutil.which('docker'):
        for line in run(['docker', 'ps', '--filter', f'label={LABEL}', '--format', '{{.Names}} {{.Status}}'],
                        stdout=subprocess.PIPE, text=True).stdout.splitlines():
            print(f'docker  {line}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for c in ('fetch', 'up'):
        sub.add_parser(c).add_argument('images', nargs='+')
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
    p = sub.add_parser('run-matrix')
    p.add_argument('script', help='shell script run with sh in each machine, from the payload directory')
    p.add_argument('images', nargs='*', help='default: all of the manifest')
    p.add_argument('--payload', help="directory copied (or mounted) in; default: the script's")
    p.add_argument('--results', help='default: $MACHINES_WORK/results')
    p.add_argument('-j', '--jobs', type=int, default=1)
    p.add_argument('--keep', action='store_true', help='leave the machines running')
    p.add_argument('--timeout', type=int, default=1800, help='seconds per machine')
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
        for img in pick(a.images):
            print(img['name'], fetch(img))
    elif a.cmd == 'up':
        for img in pick(a.images):
            up(img)
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
        imgs = pick(a.images) if a.images else list(known.values())
        return run_matrix(imgs, a.script, a.payload, a.results, a.jobs, a.keep, a.timeout)
    elif a.cmd == 'clean':
        clean(a.keep_cache)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Fail as e:
        log(f'error: {e}')
        sys.exit(1)

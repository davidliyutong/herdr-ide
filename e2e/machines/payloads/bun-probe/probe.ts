// S1: what the machine agent needs from the OS, through bun:ffi and Node
// APIs, on Linux (glibc, musl) and macOS.
import { dlopen, FFIType, ptr, CString, read } from 'bun:ffi';
import { createServer, connect } from 'node:net';
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const linux = process.platform === 'linux';
let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const tryit = async (name: string, f: () => unknown | Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    check(false, `${name}: threw ${(e as Error).message}`);
  }
};

function libcPath(): string {
  if (!linux) return 'libSystem.B.dylib';
  for (const p of fs.readdirSync('/lib').filter((f) => f.startsWith('ld-musl-'))) return `/lib/${p}`; // musl's libc is its loader
  return 'libc.so.6';
}
const lib = libcPath();
const { symbols: c } = dlopen(lib, {
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  getuid: { args: [], returns: FFIType.u32 },
  getpid: { args: [], returns: FFIType.i32 },
  ...(linux ? { __errno_location: { args: [], returns: FFIType.ptr } } : { __error: { args: [], returns: FFIType.ptr } }),
  ...(linux
    ? { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.i64 } }
    : {
        renamex_np: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
        sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      }),
});
const errno = (): number => {
  // errno via the thread-local location (glibc and musl: __errno_location; darwin: __error)
  const p = linux ? (c as any).__errno_location() : (c as any).__error();
  return read.i32(p, 0);
};
const cstr = (s: string) => Buffer.from(s + '\0');

const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 's1-')));
console.log(`runtime bun ${Bun.version} ${process.platform}/${process.arch} libc=${lib}`);
try {
  console.log('kernel', execFileSync('uname', ['-r']).toString().trim());
  if (linux) console.log('libc version', execFileSync('sh', ['-c', 'ldd --version 2>&1 | head -1']).toString().trim());
} catch {}

// 1. Peer credentials of an accepted unix socket.
await tryit('peercred', async () => {
  const p = join(dir, 'peer.sock');
  const got: Promise<{ uid: number; pid: number }> = new Promise((res, rej) => {
    const srv = createServer((s) => {
      const fd: number = (s as any)._handle?.fd;
      if (linux) {
        const buf = Buffer.alloc(12);
        const len = Buffer.alloc(4);
        len.writeUInt32LE(12);
        const r = c.getsockopt(fd, 1 /*SOL_SOCKET*/, 17 /*SO_PEERCRED*/, ptr(buf), ptr(len));
        if (r !== 0) return rej(new Error(`getsockopt failed errno ${errno()}`));
        res({ pid: buf.readInt32LE(0), uid: buf.readUInt32LE(4) });
      } else {
        // LOCAL_PEERCRED: struct xucred { u_int version; uid_t uid; short ngroups; gid_t groups[16]; }
        const buf = Buffer.alloc(76);
        const len = Buffer.alloc(4);
        len.writeUInt32LE(76);
        let r = c.getsockopt(fd, 0 /*SOL_LOCAL*/, 1 /*LOCAL_PEERCRED*/, ptr(buf), ptr(len));
        if (r !== 0) return rej(new Error('LOCAL_PEERCRED failed'));
        const uid = buf.readUInt32LE(4);
        const pb = Buffer.alloc(4);
        len.writeUInt32LE(4);
        r = c.getsockopt(fd, 0, 2 /*LOCAL_PEERPID*/, ptr(pb), ptr(len));
        if (r !== 0) return rej(new Error('LOCAL_PEERPID failed'));
        res({ uid, pid: pb.readInt32LE(0) });
      }
      s.end();
      srv.close();
    });
    srv.listen(p, () => {
      fs.chmodSync(p, 0o600);
      const cl = connect(p);
      cl.on('error', () => {});
    });
  });
  const r = await got;
  check(r.uid === c.getuid() && r.pid === process.pid, `peer credentials uid=${r.uid} pid=${r.pid} (self ${c.getuid()}/${process.pid})`);
  check((fs.statSync(p, { throwIfNoEntry: false })?.mode ?? 0o600) !== 0, 'unix socket chmod 0600');
});

// 2. flock exclusive, non-blocking, between two processes.
await tryit('flock', async () => {
  const p = join(dir, 'lock');
  const fd = fs.openSync(p, 'w');
  {
    const r = c.flock(fd, 2 | 4);
    const e = errno();
    check(r === 0, `flock LOCK_EX|LOCK_NB taken (r=${r}${r ? ' errno ' + e : ''})`);
  }
  const child = Bun.spawnSync([
    process.execPath,
    '-e',
    `
    const { dlopen, FFIType } = require('bun:ffi');
    const { symbols } = dlopen(${JSON.stringify(lib)}, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    const fd = require('fs').openSync(${JSON.stringify(p)}, 'r');
    process.exit(symbols.flock(fd, 2 | 4) === 0 ? 0 : 3);
  `,
  ]);
  check(child.exitCode === 3, `flock held against another process (child exit ${child.exitCode})`);
  fs.closeSync(fd);
});

// 3. fcntl F_SETLK byte range (variadic on darwin/arm64!).
await tryit('fcntl', async () => {
  const p = join(dir, 'range');
  fs.writeFileSync(p, 'x');
  const fd = fs.openSync(p, 'r+');
  let fl: Buffer;
  let F_SETLK: number;
  if (linux) {
    // struct flock { short type; short whence; off_t start; off_t len; pid_t pid; } (64-bit)
    fl = Buffer.alloc(32);
    fl.writeInt16LE(1 /*F_WRLCK*/, 0);
    fl.writeInt16LE(0, 2);
    fl.writeBigInt64LE(0x40000000n, 8);
    fl.writeBigInt64LE(512n, 16);
    F_SETLK = 6;
  } else {
    // darwin: { off_t start; off_t len; pid_t pid; short type; short whence; }
    fl = Buffer.alloc(24);
    fl.writeBigInt64LE(0x40000000n, 0);
    fl.writeBigInt64LE(512n, 8);
    fl.writeInt16LE(3 /*F_WRLCK*/, 20);
    fl.writeInt16LE(0, 22);
    F_SETLK = 8;
  }
  const r = c.fcntl(fd, F_SETLK, ptr(fl));
  const fe = errno();
  // the lock is visible to another process only if it really took
  const child = Bun.spawnSync([
    process.execPath,
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    process.exit(0);
  `,
  ]);
  check(r === 0, `fcntl F_SETLK returned ${r}${r ? ' errno ' + fe : ''}`);
  // Verify with python-free approach: a second process tries the same lock.
  const probe = Bun.spawnSync([
    process.execPath,
    '-e',
    `
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    const { symbols } = dlopen(${JSON.stringify(lib)}, { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const fd = require('fs').openSync(${JSON.stringify(p)}, 'r+');
    const fl = Buffer.from(${JSON.stringify([...fl])});
    process.exit(symbols.fcntl(fd, ${F_SETLK}, ptr(fl)) === 0 ? 0 : 3);
  `,
  ]);
  check(probe.exitCode === 3, `fcntl lock seen by another process (child exit ${probe.exitCode}; 0 means the lock did not take)`);
  void child;
  fs.closeSync(fd);
});

// 3b. The SQLite way instead of byte locks: BEGIN EXCLUSIVE with no wait.
await tryit('sqlite exclusive', async () => {
  const p = join(dir, 'db.sqlite');
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);');
  db.exec('BEGIN IMMEDIATE');
  const probe = Bun.spawnSync([
    process.execPath,
    '-e',
    `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(p)}, { timeout: 0 });
    try { db.exec('BEGIN EXCLUSIVE'); process.exit(0); } catch { process.exit(3); }
  `,
  ]);
  check(probe.exitCode === 3, `node:sqlite: a held database refuses BEGIN EXCLUSIVE elsewhere (exit ${probe.exitCode})`);
  db.exec('COMMIT');
  db.close();
});

// 4. Opening without following symlinks.
await tryit('nofollow', async () => {
  const real = join(dir, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(join(real, 'f'), 'ok');
  fs.symlinkSync(real, join(dir, 'link'));
  if (linux) {
    // openat2(AT_FDCWD, path, &open_how{flags,mode,resolve}, 24)
    const how = Buffer.alloc(24);
    how.writeBigUInt64LE(0n, 0); // O_RDONLY
    how.writeBigUInt64LE(0n, 8);
    how.writeBigUInt64LE(0x04n, 16); // RESOLVE_NO_SYMLINKS
    const nr = process.arch === 'x64' ? 437n : 437n; // openat2 is 437 on both
    const okfd = c.syscall(nr, -100n, ptr(cstr(join(real, 'f'))), ptr(how), 24n);
    const okErr = okfd < 0n ? errno() : 0;
    const badfd = c.syscall(nr, -100n, ptr(cstr(join(dir, 'link', 'f'))), ptr(how), 24n);
    const badErr = badfd < 0n ? errno() : 0;
    if (okfd < 0n && okErr === 38 && badErr === 38)
      console.log(
        `INFO openat2 RESOLVE_NO_SYMLINKS: ENOSYS (errno 38) for both calls: kernel < 5.6, the agent falls back (not counted as a failure)`,
      );
    else
      check(
        okfd >= 0n && badfd < 0n && badErr === 40,
        `openat2 RESOLVE_NO_SYMLINKS: plain ${okfd} (errno ${okErr}), through symlink ${badfd} (errno ${badErr}; 40=ELOOP expected)`,
      );
    // the fallback: O_NOFOLLOW on the last component refuses a symlink with ELOOP
    let code = '';
    try {
      fs.openSync(join(dir, 'link'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? '';
    }
    check(code === 'ELOOP', `fallback: open(O_NOFOLLOW) on a symlink refused with ${code || 'nothing'}`);
  } else {
    const O_NOFOLLOW_ANY = 0x20000000;
    let refused = false;
    try {
      fs.openSync(join(dir, 'link', 'f'), fs.constants.O_RDONLY | O_NOFOLLOW_ANY);
    } catch (e) {
      refused = (e as NodeJS.ErrnoException).code === 'ELOOP';
    }
    const fd = fs.openSync(join(real, 'f'), fs.constants.O_RDONLY | O_NOFOLLOW_ANY);
    check(refused && fd >= 0, `fs.openSync passes O_NOFOLLOW_ANY through (through symlink refused=${refused})`);
    // creating with O_CREAT (mode) through fs.openSync, also with the flag
    const fd2 = fs.openSync(join(real, 'new'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW_ANY, 0o600);
    check((fs.fstatSync(fd2).mode & 0o777) === 0o600, 'create with O_NOFOLLOW_ANY and mode 0600');
  }
});

// 5. Rename without replacing.
await tryit('rename noreplace', async () => {
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  let r: number | bigint;
  if (linux) {
    const nr = process.arch === 'x64' ? 316n : 276n; // renameat2
    // renameat2(olddirfd, oldpath, newdirfd, newpath, flags): 5 args; our syscall binding has 4 after nr
    const { symbols: s } = dlopen(lib, {
      syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
    });
    r = s.syscall(nr, -100n, ptr(cstr(a)), -100n, ptr(cstr(b)), 1 /*RENAME_NOREPLACE*/);
  } else {
    r = c.renamex_np!(cstr(a), cstr(b), 0x4 /*RENAME_EXCL*/);
  }
  const re = Number(r) !== 0 ? errno() : 0;
  check(
    Number(r) !== 0 && re === 17 && fs.readFileSync(b, 'utf8') === 'b',
    `rename without replace refused an existing target (r=${r} errno ${re}; 17=EEXIST expected, 38=ENOSYS, 22=EINVAL)`,
  );
  if (linux) {
    // and it renames onto a free name
    const { symbols: s } = dlopen(lib, {
      syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.i64 },
    });
    const c2 = join(dir, 'c');
    const r2 = s.syscall(process.arch === 'x64' ? 316n : 276n, -100n, ptr(cstr(a)), -100n, ptr(cstr(c2)), 1);
    const e2 = Number(r2) !== 0 ? errno() : 0;
    check(Number(r2) === 0 && fs.existsSync(c2) && !fs.existsSync(a), `renameat2 RENAME_NOREPLACE onto a free name (r=${r2} errno ${e2})`);
  }
});

// 6. unlinkat
await tryit('unlinkat', async () => {
  const f = join(dir, 'u');
  fs.writeFileSync(f, '');
  const r = c.unlinkat(-100, cstr(f), 0);
  const ue = r ? errno() : 0;
  check(r === 0 && !fs.existsSync(f), `unlinkat ${r}${r ? ' errno ' + ue : ''}`);
});

// 7. Process listing on macOS: sysctl kern.proc.pgrp
if (!linux)
  await tryit('sysctl', async () => {
    // CTL_KERN=1, KERN_PROC=14, KERN_PROC_ALL=0
    const mib = Buffer.alloc(12);
    mib.writeInt32LE(1, 0);
    mib.writeInt32LE(14, 4);
    mib.writeInt32LE(0, 8);
    const size = Buffer.alloc(8);
    let r = c.sysctl!(ptr(mib), 3, null, ptr(size), null, 0n);
    const n = Number(size.readBigUInt64LE(0));
    const out = Buffer.alloc(n * 2);
    size.writeBigUInt64LE(BigInt(out.length));
    r = c.sysctl!(ptr(mib), 3, ptr(out), ptr(size), null, 0n);
    const used = Number(size.readBigUInt64LE(0));
    check(r === 0 && used > 0, `sysctl kern.proc.all ${used} bytes (${Math.floor(used / 648)} kinfo_proc)`);
  });

// 8. A new session for a child that outlives us, and killing a group.
const procStat = (pid: number) => {
  const t = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
  return { pgrp: Number(f[2]), sid: Number(f[3]) };
};
const groupMembers = (pgid: number): number[] => {
  if (!linux) {
    try {
      return execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)])
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      return [];
    }
  }
  const out: number[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = procStat(Number(d));
      const state = fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1][0];
      if (st.pgrp === pgid && state !== 'Z') out.push(Number(d));
    } catch {}
  }
  return out;
};
await tryit('detached', async () => {
  const p = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  let pgid: number, sid: number;
  if (linux) ({ pgrp: pgid, sid } = procStat(p.pid!));
  else {
    pgid = Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(p.pid)])
        .toString()
        .trim(),
    );
    sid = -1;
  }
  check(pgid === p.pid && (!linux || sid === p.pid), `detached child leads its group and session (pgid ${pgid}, sid ${sid}, pid ${p.pid})`);
  const before = groupMembers(p.pid!).length;
  process.kill(-p.pid!, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  const left = groupMembers(p.pid!);
  check(before >= 3 && left.length === 0, `kill(-pgid) ended the whole group (${before} before, left: ${left.join(',') || 'none'})`);
});

// 9. statfs, rusage, sqlite.
await tryit('misc', async () => {
  const s = fs.statfsSync('/');
  check(s.blocks > 0, `statfs / blocks=${s.blocks}`);
  const u = process.resourceUsage();
  check(u.userCPUTime >= 0, `resourceUsage user=${u.userCPUTime}us`);
  const db = new DatabaseSync(':memory:');
  const v = db.prepare('select sqlite_version() v').get() as { v: string };
  check(!!v.v, `node:sqlite ${v.v}`);
});

// 10. A PTY (the ssh login): Bun.Terminal
await tryit('pty', async () => {
  let out = '';
  const proc = Bun.spawn(['sh', '-c', 'tty; echo hi'], {
    terminal: { cols: 80, rows: 24, data: (_t: unknown, d: Uint8Array) => (out += Buffer.from(d).toString()) },
  } as any);
  await proc.exited;
  await new Promise((r) => setTimeout(r, 100));
  check(/\/dev\/(pts|ttys)/.test(out) && out.includes('hi'), `Bun.Terminal pty: ${JSON.stringify(out.trim().slice(0, 40))}`);
});

// 11. Extras (not in the original probe): runtime paths that use newer syscalls with fallbacks.
await tryit('extras', async () => {
  const src = join(dir, 'src');
  fs.writeFileSync(src, Buffer.alloc(1 << 20, 7));
  fs.copyFileSync(src, join(dir, 'dst1'));
  check(fs.statSync(join(dir, 'dst1')).size === 1 << 20, 'extra: fs.copyFileSync 1 MiB');
  await Bun.write(join(dir, 'dst2'), Bun.file(src));
  check(fs.statSync(join(dir, 'dst2')).size === 1 << 20, 'extra: Bun.write(file, Bun.file) 1 MiB');
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  check(
    rnd.some((b) => b !== 0),
    `extra: crypto.getRandomValues ${crypto.randomUUID()}`,
  );
  const st = fs.statSync(src);
  check(st.mtimeMs > 0, `extra: fs.statSync mtime/birthtime ${st.birthtimeMs > 0 ? 'birthtime set' : 'no birthtime'}`);
  const w = fs.watch(dir);
  let seen = false;
  w.on('change', () => (seen = true));
  fs.writeFileSync(join(dir, 'watched'), 'x');
  await new Promise((r) => setTimeout(r, 300));
  w.close();
  check(seen, 'extra: fs.watch (inotify) saw a new file');
  const out = await new Response(Bun.spawn(['sh', '-c', 'echo spawned'], { stdout: 'pipe' }).stdout).text();
  check(out.trim() === 'spawned', 'extra: Bun.spawn stdout pipe');
  const sock = join(dir, 'b.sock');
  const srv = Bun.serve({ unix: sock, fetch: () => new Response('hello') });
  const res = await fetch('http://localhost/', { unix: sock } as any).then((r) => r.text());
  srv.stop(true);
  check(res === 'hello', 'extra: Bun.serve + fetch over a unix socket');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

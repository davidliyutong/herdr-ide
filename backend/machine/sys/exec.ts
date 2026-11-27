// Replaces this process image with another program and environment via
// execve(2), preserving PID, process group, session and controlling terminal.
import { ptr } from 'bun:ffi';
import { posix } from 'node:path';
import { E, SysError, cstr, errno, libc } from './libc.ts';

/** Builds a NULL-terminated 64-bit pointer array referencing bufs. */
function ptrArray(bufs: readonly Buffer[]): BigUint64Array {
  const out = new BigUint64Array(bufs.length + 1);
  for (let i = 0; i < bufs.length; i++) out[i] = BigInt(ptr(bufs[i]));
  return out;
}

/** Module-level root pinning backing Buffers across execve(2) FFI calls so GC
 * cannot collect or move memory referenced by raw pointer arrays. */
let pinnedExecBuffers: readonly unknown[] | null = null;

/** Replaces the calling process with argv and env, searching PATH when
 * argv[0] contains no "/" and falling back to /bin/sh on ENOEXEC as POSIX
 * execvp(3) specifies. Always throws on failure; never returns on success. */
export function execReplace(argv: readonly string[], env: Record<string, string>): never {
  if (argv.length === 0 || argv[0] === '') throw new SysError(E('ENOENT'), 'execve', argv[0] ?? '');
  for (const a of argv) if (a.includes('\0')) throw new SysError(E('EINVAL'), 'execve', argv[0]);
  const argBufs = argv.map(cstr);
  const argPtrs = ptrArray(argBufs);
  const envBufs: Buffer[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (k === '' || k.includes('=') || k.includes('\0') || v.includes('\0')) throw new SysError(E('EINVAL'), 'execve', k);
    envBufs.push(cstr(`${k}=${v}`));
  }
  const envPtrs = ptrArray(envBufs);
  const l = libc();

  const tryExec = (file: string): number => {
    const fileBuf = cstr(file);
    pinnedExecBuffers = [fileBuf, argBufs, argPtrs, envBufs, envPtrs];
    l.execve(fileBuf, argPtrs, envPtrs);
    const err = errno();
    if (err === E('ENOEXEC')) {
      const shBuf = cstr('/bin/sh');
      const shArgBufs = [shBuf, fileBuf, ...argBufs.slice(1)];
      const shArgPtrs = ptrArray(shArgBufs);
      pinnedExecBuffers = [shBuf, fileBuf, argBufs, shArgBufs, shArgPtrs, envBufs, envPtrs];
      l.execve(shBuf, shArgPtrs, envPtrs);
      const shErr = errno();
      return shErr === E('ENOENT') ? err : shErr;
    }
    return err;
  };

  try {
    pinnedExecBuffers = [argBufs, argPtrs, envBufs, envPtrs];
    const prog = argv[0];
    if (prog.includes('/')) throw new SysError(tryExec(prog), 'execve', prog);

    const pathVar = env.PATH ?? process.env.PATH ?? '/usr/bin:/bin';
    let denied = false;
    for (const rawDir of pathVar.split(':')) {
      const cand = posix.join(rawDir || '.', prog);
      const err = tryExec(cand);
      if (err === E('EACCES')) {
        denied = true;
        continue;
      }
      if (err === E('ENOENT') || err === E('ENOTDIR') || err === E('ELOOP') || err === E('ENAMETOOLONG')) continue;
      throw new SysError(err, 'execve', prog);
    }
    throw new SysError(denied ? E('EACCES') : E('ENOENT'), 'execve', prog);
  } finally {
    if (pinnedExecBuffers) pinnedExecBuffers = null;
  }
}

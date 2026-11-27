// The C library through bun:ffi, for the system calls Node lacks
// (docs/features/42-typescript-backend.md, "The machine side"). Only
// functions with a fixed argument list are bound: on macOS/arm64 the
// variadic arguments of open, openat or fcntl go on the stack, where a
// call through FFI does not put them. On Linux the system calls without a
// wrapper in every C library (openat2, renameat2, openat relative to a
// directory) go through syscall(2) with integer arguments only, which both
// of Linux's ABIs (x86-64 and AAPCS64) pass in the registers of a fixed
// argument list, as the S1 probe ran it on every machine of the matrix.
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';

export const linux = process.platform === 'linux';
export const darwin = process.platform === 'darwin';

/** The C library this process runs on, to open: macOS's libSystem; on
 * Linux the one the process has mapped (its /proc/self/maps): musl's,
 * which is its loader (/lib/ld-musl-<arch>.so.1), else glibc's libc.so.6.
 * Not by what /lib holds: a glibc system with musl's package installed
 * has musl's loader there too, and loading musl's libc into a glibc
 * process corrupts it at the first failing call (its errno is somewhere
 * else in the thread). */
export function libcPath(maps: string | null = readMaps()): string {
  if (darwin) return 'libSystem.B.dylib';
  for (const line of (maps ?? '').split('\n')) {
    const path = line.slice(line.indexOf('/'));
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (line.includes('/') && /^ld-musl-[^/]+\.so(\.\d+)*$/.test(name)) return path.trim();
  }
  return 'libc.so.6';
}

function readMaps(): string | null {
  try {
    return readFileSync('/proc/self/maps', 'utf8');
  } catch {
    return null;
  }
}

const common = {
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
} as const;

const linuxOnly = {
  __errno_location: { args: [], returns: FFIType.ptr },
} as const;

/** syscall(2) for each call it makes, typed: pointers as FFIType.ptr (the
 * call holds the buffer it is given), integers as i64 (the registers of a
 * long), the result as i64_fast (a number: nothing is allocated, so
 * nothing runs between a failing call and errno's read). */
const SYSCALLS = {
  /** openat2(dirfd, path, how, size) */
  openat2: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.i64],
  /** openat(dirfd, path, flags, mode) */
  openat: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.i64],
  /** renameat2(olddirfd, old, newdirfd, new, flags) */
  renameat2: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i64],
} as const;

type Syscalls = { [K in keyof typeof SYSCALLS]: (...args: unknown[]) => number };
let syscalls: Syscalls | undefined;

/** The typed syscall(2) bindings (Linux). */
export function sys(): Syscalls {
  if (!syscalls) {
    const path = libcPath();
    const bind = (args: readonly FFIType[]) =>
      dlopen(path, { syscall: { args: [...args], returns: FFIType.i64_fast } }).symbols.syscall as unknown as (...a: unknown[]) => number;
    syscalls = { openat2: bind(SYSCALLS.openat2), openat: bind(SYSCALLS.openat), renameat2: bind(SYSCALLS.renameat2) };
  }
  return syscalls;
}

const darwinOnly = {
  __error: { args: [], returns: FFIType.ptr },
  renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
} as const;

type Lib = ReturnType<typeof dlopen<typeof common & typeof linuxOnly & typeof darwinOnly>>['symbols'];

let lib: Lib | undefined;

/** The bound functions, opened on first use. */
export function libc(): Lib {
  if (!lib) {
    if (!linux && !darwin) throw new Error(`no system calls for ${process.platform}`);
    lib = dlopen(libcPath(), { ...common, ...(linux ? linuxOnly : darwinOnly) } as typeof common &
      typeof linuxOnly &
      typeof darwinOnly).symbols;
  }
  return lib;
}

/** The calling thread's errno, read right after the call that failed: the
 * failing calls return numbers (i32, i64_fast), so no allocation, and so
 * no collection or other libc call, comes between. */
export function errno(): number {
  const l = libc();
  const p = linux ? l.__errno_location() : l.__error();
  return read.i32(p as Pointer, 0);
}

const errnoNames = new Map<number, string>(Object.entries(constants.errno).map(([k, v]) => [v as number, k]));

/** An error as Node's fs reports one: code (ENOENT…), errno (negative), the
 * call and the path. */
export class SysError extends Error {
  readonly code: string;
  readonly errno: number;
  readonly syscall: string;
  readonly path?: string;

  constructor(e: number, syscall: string, path?: string) {
    const code = errnoNames.get(e) ?? `E${e}`;
    super(`${code}: ${syscall}${path === undefined ? '' : ` '${path}'`}`);
    this.code = code;
    this.errno = -e;
    this.syscall = syscall;
    this.path = path;
  }
}

/** The errno of name on this system (constants.errno). */
export const E = (name: keyof typeof constants.errno): number => constants.errno[name] as number;

/** A C string's bytes, NUL-terminated. */
export const cstr = (s: string): Buffer => Buffer.from(s + '\0', 'utf8');

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
import { readdirSync } from 'node:fs';
import { constants } from 'node:os';

export const linux = process.platform === 'linux';
export const darwin = process.platform === 'darwin';

/** The C library to open: musl's is its loader (/lib/ld-musl-<arch>.so.1),
 * glibc's libc.so.6, macOS's libSystem. */
function libcPath(): string {
  if (darwin) return 'libSystem.B.dylib';
  try {
    for (const f of readdirSync('/lib')) if (f.startsWith('ld-musl-')) return `/lib/${f}`;
  } catch {
    // no /lib
  }
  return 'libc.so.6';
}

const common = {
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const;

const linuxOnly = {
  __errno_location: { args: [], returns: FFIType.ptr },
  syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
} as const;

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

/** The calling thread's errno, read right after the call that failed. */
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

// Whose a file is (owner_unix.go and owner_windows.go).
import { constants, type BigIntStats, type Stats } from 'node:fs';

const windows = process.platform === 'win32';

/** Whether the files' mode bits keep other users out: not on Windows,
 * which has no group and other mode bits; the user's profile's access
 * control list keeps its files the user's. */
export const MODE_BITS = !windows;

/** Makes an open of a link fail (0 on Windows, where an open with O_CREAT
 * and O_EXCL does not follow a link). */
export const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** Whether st is of a file of this user; on Windows, whether it is not a
 * link. */
export function owned(st: Stats | BigIntStats): boolean {
  if (windows) return !st.isSymbolicLink();
  return Number(st.uid) === process.getuid!();
}

/** Whether a and b are of the same file (os.SameFile). */
export function sameFile(a: Stats | BigIntStats, b: Stats | BigIntStats): boolean {
  return BigInt(a.dev) === BigInt(b.dev) && BigInt(a.ino) === BigInt(b.ino);
}

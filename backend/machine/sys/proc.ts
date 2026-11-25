// Processes as the kernel tells them: the process and user at the other
// end of a unix socket, and a process's parent and name.
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { SysError, darwin, errno, libc, linux } from './libc.ts';

/** The descriptor of a connected unix socket of node:net (Bun's). */
export function socketFd(s: Socket): number {
  const fd = (s as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== 'number' || fd < 0) throw new Error('the socket has no descriptor');
  return fd;
}

/** The process and user at the other end of the unix socket fd (for an
 * accepted connection: the client; for a connected one: who listens). */
export function peerCred(fd: number): { pid: number; uid: number } {
  const l = libc();
  const len = Buffer.alloc(4);
  if (linux) {
    // SOL_SOCKET, SO_PEERCRED: struct ucred { pid_t pid; uid_t uid; gid_t gid; }
    const cred = Buffer.alloc(12);
    len.writeUInt32LE(12);
    if (l.getsockopt(fd, 1, 17, cred, len) !== 0) throw new SysError(errno(), 'getsockopt');
    return { pid: cred.readInt32LE(0), uid: cred.readUInt32LE(4) };
  }
  if (!darwin) throw new Error(`no peer credentials on ${process.platform}`);
  // SOL_LOCAL, LOCAL_PEERCRED: struct xucred { u_int cr_version; uid_t
  // cr_uid; short cr_ngroups; gid_t cr_groups[16]; }
  const cred = Buffer.alloc(76);
  len.writeUInt32LE(76);
  if (l.getsockopt(fd, 0, 1, cred, len) !== 0) throw new SysError(errno(), 'getsockopt');
  // LOCAL_PEERPID
  const pid = Buffer.alloc(4);
  len.writeUInt32LE(4);
  if (l.getsockopt(fd, 0, 2, pid, len) !== 0) throw new SysError(errno(), 'getsockopt');
  return { pid: pid.readInt32LE(0), uid: cred.readUInt32LE(4) };
}

/** The offsets of struct kinfo_proc (macOS, 64-bit) that parentOf reads. */
const KINFO = { size: 648, pid: 40, comm: 243, commLen: 17, ppid: 560, pgid: 564 };

/** pid's kinfo_proc (sysctl kern.proc.pid), null when the process is gone. */
function kinfo(pid: number): Buffer | null {
  // CTL_KERN, KERN_PROC, KERN_PROC_PID, pid
  const mib = Buffer.alloc(16);
  mib.writeInt32LE(1, 0);
  mib.writeInt32LE(14, 4);
  mib.writeInt32LE(1, 8);
  mib.writeInt32LE(pid, 12);
  const out = Buffer.alloc(KINFO.size);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(out.length));
  if (libc().sysctl(mib, 4, out, size, null, 0n) !== 0) return null;
  if (Number(size.readBigUInt64LE(0)) < KINFO.size || out.readInt32LE(KINFO.pid) !== pid) return null;
  return out;
}

/** pid's parent and name (Linux: its comm from /proc/<pid>/stat; macOS:
 * its p_comm, at most 16 bytes, from sysctl); null when it is gone. */
export function parentOf(pid: number): { ppid: number; name: string } | null {
  if (darwin) {
    const k = kinfo(pid);
    if (!k) return null;
    const comm = k.subarray(KINFO.comm, KINFO.comm + KINFO.commLen);
    const end = comm.indexOf(0);
    return { ppid: k.readInt32LE(KINFO.ppid), name: comm.subarray(0, end < 0 ? comm.length : end).toString('utf8') };
  }
  let s: string;
  try {
    s = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // "pid (comm) state ppid …": the name may hold spaces and parentheses.
  const open = s.indexOf('(');
  const end = s.lastIndexOf(')');
  if (open < 0 || end < open) return null;
  const f = s
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (f.length < 2) return null;
  return { ppid: Number(f[1]) || 0, name: s.slice(open + 1, end) };
}

/** pid's process group on macOS (kinfo_proc's e_pgid), null when gone. */
export function pgidOf(pid: number): number | null {
  if (!darwin) {
    try {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(
        s
          .slice(s.lastIndexOf(')') + 1)
          .trim()
          .split(/\s+/)[2],
      );
    } catch {
      return null;
    }
  }
  const k = kinfo(pid);
  return k ? k.readInt32LE(KINFO.pgid) : null;
}

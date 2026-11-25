// The processes the sessions are found from (sessions.ts): the process
// table (a terminal's program may be a wrapper or a launcher whose child
// is the agent), when a process started, and on Linux its environment and
// the files it holds open, read from /proc; macOS gives the table and the
// start times through sysctl, and neither another process's environment
// nor its open files.
import { posix } from 'node:path';
import { readlink } from 'node:fs/promises';
import { pgidOf, processGroup, startOf as sysStart } from '#machine/sys/proc.ts';
import type { Files } from './files.ts';

/** A process of the table. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
}

/** The variables of a process's environment that are read; no others are
 * kept. */
export const ENVIRON_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_HOME'] as const;

export interface ProcSource {
  /** Whether a process's environment and open files can be read (Linux's
   * /proc): environ and fds answer null otherwise. */
  readonly readsFiles: boolean;
  /** At least the processes of pid's process group. */
  table(pid: number): Promise<ProcEntry[]>;
  /** When pid started (ms since the epoch); null when it is gone. */
  start(pid: number): Promise<number | null>;
  /** ENVIRON_KEYS of pid's environment; null when it cannot be read (macOS,
   * another user's process). */
  environ(pid: number): Promise<Map<string, string> | null>;
  /** The targets of the files pid holds open; null where they cannot be
   * read (macOS). */
  fds(pid: number): Promise<string[] | null>;
}

/** Bounds of what is read of the processes. */
export const PROC_LIMITS = {
  /** Entries of /proc read for the table. */
  procs: 1 << 16,
  /** Open files of a process looked at. */
  fds: 4096,
  /** What is read of a process's environment. */
  environ: 1 << 20,
  /** What is read of /proc/stat (the interrupt counters' line is long on a
   * large machine). */
  stat: 4 << 20,
};

/** The unit of /proc's times (USER_HZ), 100 on every architecture Linux
 * reports them for. */
const CLOCK_TICKS = 100;

/** The processes of this system: /proc on Linux, sysctl on macOS. */
export function systemProcs(files: Files): ProcSource {
  if (process.platform === 'linux') return procfs('/proc', files);
  return {
    readsFiles: false,
    table: async (pid) => {
      const pgid = pid > 0 ? pgidOf(pid) : null;
      return pgid === null ? [] : (processGroup(pgid, PROC_LIMITS.procs) ?? []);
    },
    start: async (pid) => (pid > 0 ? sysStart(pid) : null),
    environ: async () => null,
    fds: async () => null,
  };
}

/** The processes of a /proc mounted at root (tests give a fake one). */
export function procfs(root: string, files: Files): ProcSource {
  const stat = async (pid: number) => {
    let b: Buffer;
    try {
      b = await files.readSmall(posix.join(root, String(pid), 'stat'), 4096);
    } catch {
      return null;
    }
    return parseStat(b.toString('latin1'));
  };
  const boot = async (): Promise<number | null> => {
    let b: Buffer;
    try {
      b = await files.readSmall(posix.join(root, 'stat'), PROC_LIMITS.stat);
    } catch {
      return null;
    }
    const m = /^btime (.*)$/m.exec(b.toString('latin1'));
    if (!m || !/^\d+$/.test(m[1].trim())) return null;
    const sec = Number(m[1].trim());
    return sec > 0 ? sec * 1000 : null;
  };
  return {
    readsFiles: true,
    async table() {
      const names = (await files.readDir(root, PROC_LIMITS.procs)).map((e) => e.name).filter((n) => /^[1-9]\d*$/.test(n));
      const out: ProcEntry[] = [];
      // A few at a time: thousands of small reads.
      for (let i = 0; i < names.length; i += 32) {
        const batch = await Promise.all(names.slice(i, i + 32).map(async (n) => ({ pid: Number(n), st: await stat(Number(n)) })));
        for (const { pid, st } of batch) if (st) out.push({ pid, ppid: st.ppid, pgid: st.pgid });
      }
      return out;
    },
    async start(pid) {
      if (pid <= 0) return null;
      const st = await stat(pid);
      if (!st) return null;
      const b = await boot();
      if (b === null) return null;
      return b + Math.floor(st.start / CLOCK_TICKS) * 1000 + ((st.start % CLOCK_TICKS) * 1000) / CLOCK_TICKS;
    },
    async environ(pid) {
      if (pid <= 0) return null;
      let b: Buffer;
      try {
        b = await files.readSmall(posix.join(root, String(pid), 'environ'), PROC_LIMITS.environ);
      } catch {
        return null;
      }
      const env = new Map<string, string>();
      for (const kv of b.toString('utf8').split('\0')) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.slice(0, eq);
        if ((ENVIRON_KEYS as readonly string[]).includes(k)) env.set(k, kv.slice(eq + 1));
      }
      return env;
    },
    async fds(pid) {
      if (pid <= 0) return [];
      const dir = posix.join(root, String(pid), 'fd');
      const out: string[] = [];
      for (const e of await files.readDir(dir, PROC_LIMITS.fds)) {
        try {
          const t = await readlink(posix.join(dir, e.name));
          if (t.startsWith('/')) out.push(posix.normalize(t));
        } catch {
          // closed meanwhile
        }
      }
      return out;
    },
  };
}

/** /proc/<pid>/stat's parent, process group and start time in clock ticks
 * after boot; null when it is not one. */
export function parseStat(s: string): { ppid: number; pgid: number; start: number } | null {
  // The command name (field 2) is in parentheses and may hold anything,
  // ") " too: the other fields follow the last ')'.
  const i = s.lastIndexOf(')');
  if (i < 0) return null;
  // f[0] is field 3 (state): the parent is field 4, the process group
  // field 5 and the start time field 22.
  const f = s
    .slice(i + 1)
    .trim()
    .split(/\s+/);
  if (f.length < 20) return null;
  const [ppid, pgid, start] = [f[1], f[2], f[19]];
  if (!/^-?\d+$/.test(ppid) || !/^-?\d+$/.test(pgid) || !/^\d+$/.test(start)) return null;
  return { ppid: Number(ppid), pgid: Number(pgid), start: Number(start) };
}

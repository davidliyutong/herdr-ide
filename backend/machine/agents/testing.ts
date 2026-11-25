// Helpers of the sessions' tests: a temporary home, the agent's
// environment, a process table and a clock of the test's, and a Resolver
// over them that reads no real process, environment or home; the files
// Claude Code and Codex write, as their versions write them.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { Files } from './files.ts';
import { procfs, type ProcSource } from './procs.ts';
import { Resolver, claudeEscape } from './sessions.ts';

/** A session id made from n. */
export const sid = (n: number): string => `${n.toString(16).padStart(8, '0')}-abcd-4ef0-8abc-${n.toString(16).padStart(12, '0')}`;

/** A local time, as Go's time.Date(…, time.Local). */
export const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime();

const iso = (t: number): string => new Date(t).toISOString();

/** A temporary directory, real (macOS's /tmp is a link), short. */
export function tempDir(): string {
  return realpathSync(mkdtempSync('/tmp/hs-'));
}

export interface FakeProc {
  ppid: number;
  pgid: number;
  /** ms; undefined: the process is gone. */
  start?: number;
}

export class TestEnv {
  readonly home = tempDir();
  readonly vars = new Map<string, string>();
  procs = new Map<number, FakeProc>();
  now = local(2026, 11, 22, 15);
  peers = 0;
  /** Every path the package opened. */
  readonly opened: string[] = [];
  private taken = 0;
  uid = process.getuid!();
  gid = process.getgid!();
  /** A /proc of the test's (newProcfs) in place of the fake table. */
  procRoot = '';
  private readonly dirs: string[] = [this.home];
  private cached?: Resolver;

  /** The Resolver; made again after uid, gid or procRoot changed. */
  get r(): Resolver {
    if (!this.cached) {
      const files = new Files({ uid: this.uid, gid: this.gid, onOpen: (p) => this.opened.push(p) });
      const fake: ProcSource = {
        readsFiles: false,
        table: async () => [...this.procs].map(([pid, p]) => ({ pid, ppid: p.ppid, pgid: p.pgid })),
        start: async (pid) => this.procs.get(pid)?.start ?? null,
        environ: async () => null,
        fds: async () => null,
      };
      this.cached = new Resolver({
        home: this.home,
        getenv: (k) => this.vars.get(k),
        peers: () => this.peers,
        files,
        procs: this.procRoot ? procfs(this.procRoot, files) : fake,
        now: () => this.now,
      });
    }
    return this.cached;
  }

  /** Makes the next r a new Resolver (with what changed since). */
  renew(): void {
    this.cached = undefined;
  }

  /** Another temporary directory, removed with the env. */
  tempDir(): string {
    const d = tempDir();
    this.dirs.push(d);
    return d;
  }

  /** The paths opened since the last take. */
  take(): string[] {
    const out = this.opened.slice(this.taken);
    this.taken = this.opened.length;
    return out;
  }

  /** Writes a file under the home (rel) or at an absolute path, with mtime
   * mod (ms; undefined: now). */
  write(rel: string, content: string, mod?: number): string {
    const p = rel.startsWith('/') ? rel : posix.join(this.home, rel);
    mkdirSync(posix.dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, content, { mode: 0o600 });
    if (mod !== undefined) utimesSync(p, mod / 1000, mod / 1000);
    return p;
  }

  /** Claude Code's record of process pid in the claude dir dir ("" is
   * ~/.claude), as Claude Code 2.1.330 writes it. */
  record(dir: string, pid: number, id: string, cwd: string, startedAt: number): string {
    dir ||= posix.join(this.home, '.claude');
    const body = JSON.stringify({
      pid,
      sessionId: id,
      cwd,
      startedAt,
      procStart: new Date(startedAt).toUTCString(),
      version: '2.1.330',
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'idle',
      updatedAt: startedAt,
    });
    return this.write(posix.join(dir, 'sessions', `${pid}.json`), body);
  }

  /** A Claude Code transcript of cwd in the claude dir dir ("" is
   * ~/.claude): stub lines, an attachment line longer than the reader's
   * buffer naming another directory, then the first prompt. */
  claudeTranscript(dir: string, cwd: string, id: string, at: number, mod?: number): string {
    return this.claudeTranscriptIn(dir, claudeEscape(cwd), cwd, id, at, mod);
  }

  claudeTranscriptIn(dir: string, project: string, cwd: string, id: string, at: number, mod?: number): string {
    dir ||= posix.join(this.home, '.claude');
    const user = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: '78850659-556e-420f-a477-038716d01f20',
      timestamp: iso(at),
      cwd,
      sessionId: id,
    });
    const lines = [
      `{"type":"mode","sessionId":"${id}"}`,
      `{"type":"permission-mode","sessionId":"${id}"}`,
      `{"type":"attachment","cwd":"/elsewhere","content":"${'x'.repeat(300 << 10)}"}`,
      user,
      `{"type":"assistant","cwd":"${cwd}","message":{"content":[]}}`,
    ];
    return this.write(posix.join(dir, 'projects', project, `${id}.jsonl`), lines.join('\n') + '\n', mod);
  }

  /** A Codex rollout made at created in its dated directory under the
   * Codex home home ("" is ~/.codex), whose session_meta carries pad bytes
   * of instructions after the members resolve reads. */
  rollout(home: string, id: string, cwd: string, created: number, mod: number | undefined, pad = 0): string {
    return this.subRollout(home, id, id, cwd, created, mod, pad);
  }

  /** The rollout of thread id of session (a subagent's, as Codex 0.171.0
   * writes it, when they differ). */
  subRollout(home: string, id: string, session: string, cwd: string, created: number, mod: number | undefined, pad = 0): string {
    home ||= posix.join(this.home, '.codex');
    const parent = session !== id ? `"parent_thread_id":${JSON.stringify(session)},` : '';
    const source = session !== id ? '{"subagent":"review"}' : '"cli"';
    const meta =
      `{"timestamp":"${iso(created + 1000)}","ordinal":0,"type":"session_meta","payload":{"session_id":${JSON.stringify(session)},` +
      `"id":${JSON.stringify(id)},${parent}"timestamp":"${iso(created)}","cwd":${JSON.stringify(cwd)},"originator":"codex-tui",` +
      `"cli_version":"0.171.0","source":${source},"base_instructions":{"text":"${'i'.repeat(pad)}"}}}`;
    const body = meta + '\n' + '{"timestamp":"2026-11-22T14:00:00Z","type":"event_msg","payload":{"type":"task_started"}}\n';
    const d = new Date(created);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    return this.write(posix.join(home, 'sessions', day, `rollout-${stamp}-${id}.jsonl`), body, mod);
  }

  remove(): void {
    for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
  }
}

/** A fake /proc: its stat has btime boot (ms). */
export class FakeProcfs {
  readonly root = tempDir();
  readonly boot: number;

  constructor(boot: number) {
    this.boot = boot;
    writeFileSync(
      posix.join(this.root, 'stat'),
      `cpu  1 2 3 4\ncpu0 1 2 3 4\nintr 12 0 0 1\nctxt 99\nbtime ${Math.floor(boot / 1000)}\nprocesses 7\n`,
    );
  }

  /** A process started at start with the command name comm, the
   * environment env and open files fds (fd number → target). */
  add(pid: number, ppid: number, pgid: number, comm: string, start: number, env: string[] | null, fds: Record<string, string> = {}): void {
    const dir = posix.join(this.root, String(pid));
    mkdirSync(posix.join(dir, 'fd'), { recursive: true });
    const ticks = Math.floor((start - this.boot) / 10);
    writeFileSync(
      posix.join(dir, 'stat'),
      `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 34816 ${pgid} 4194304 100 0 0 0 5 3 0 0 20 0 1 0 ${ticks} 10000 200 18446744073709551615\n`,
    );
    if (env) writeFileSync(posix.join(dir, 'environ'), env.join('\0') + '\0');
    for (const [n, target] of Object.entries(fds)) symlinkSync(target, posix.join(dir, 'fd', n));
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** p, or fails when it does not settle within ms (something blocked). */
export async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error('blocked')), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

/** Makes a FIFO at p. */
export function mkfifo(p: string): void {
  mkdirSync(posix.dirname(p), { recursive: true });
  const r = Bun.spawnSync(['mkfifo', '-m', '600', p]);
  if (r.exitCode !== 0) throw new Error(`mkfifo ${p}: ${r.stderr.toString()}`);
}

// The agents' processes: every program the chat host runs (an agent of a
// chat, an agent asked for its sessions, the login shell) starts here, in a
// process group of its own (a session of its own: detached), with pipes to
// its standard input and output and the end of its standard error kept.
// The host keeps every live one (AgentProcesses), so that it can signal
// their groups as it stops, and each is ended gracefully: its input closes,
// SIGTERM goes to its group after a grace period, SIGKILL after another,
// and what the program left running in its group goes once it is gone.
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

/** How much of the end of a program's standard error is kept. */
export const STDERR_KEEP = 16 << 10;

/** The times of a process's end. */
export interface StopTiming {
  /** How long a program whose input closed may take to exit before its
   * group gets SIGTERM. */
  grace: number;
  /** How long after SIGTERM before SIGKILL; also how long what is left of
   * the group after the program exited has after SIGTERM. */
  term: number;
  /** How long the rest of the standard error is read once the group is
   * gone: a program that left the group may hold the pipe open. */
  drain?: number;
}

/** How often stop looks whether a group is gone. */
const GROUP_POLL_MS = 20;

/** Keeps the last max bytes written to it. */
export class Tail {
  private buf = Buffer.alloc(0);
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  write(b: Uint8Array): void {
    if (b.length >= this.max) {
      this.buf = Buffer.from(b.subarray(b.length - this.max));
      return;
    }
    const keep = Math.max(0, this.buf.length + b.length - this.max);
    this.buf = Buffer.concat([this.buf.subarray(keep), b]);
  }

  /** What it holds as text: bytes that are no UTF-8, and a character cut at
   * its start, become U+FFFD. */
  toString(): string {
    return this.buf.toString('utf8');
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether p settles within ms. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => (t = setTimeout(() => r(false), Math.max(ms, 0))));
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** Sends sig to process group pgid; false when none of it is there. */
export function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  if (pgid <= 1) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    // ESRCH: gone; EPERM: only zombies left (macOS), or no longer ours.
    return false;
  }
}

/** A program the host started: its own process group, its pipes, the end
 * of its standard error. Whoever started it ends it with stop, also when it
 * exited by itself: what it left running in its group goes then. */
export class AgentProcess {
  /** The program's process id, which is its group's. */
  readonly pid: number;
  /** Its standard output, and its standard input (the write end). */
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;
  /** Settles once the program exited and was waited for. */
  readonly exited: Promise<void>;
  /** Settles once its standard error was read to its end. */
  private readonly drained: Promise<void>;
  private readonly tail = new Tail(STDERR_KEEP);
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private hasExited = false;
  private stopping: Promise<void> | null = null;
  private readonly child: ChildProcess;

  /** @internal Use AgentProcesses.spawn. */
  constructor(child: ChildProcess) {
    this.child = child;
    this.pid = child.pid ?? 0;
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        this.hasExited = true;
        this.exitCode = code;
        this.exitSignal = signal;
        resolve();
      }),
    );
    this.drained = new Promise((resolve) => {
      if (!child.stderr) return resolve();
      child.stderr.on('data', (b: Buffer) => this.tail.write(b));
      child.stderr.once('close', () => resolve());
      child.stderr.once('error', () => resolve());
    });
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    this.stdout = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    this.stdin = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
  }

  /** Whether the program exited. */
  get gone(): boolean {
    return this.hasExited;
  }

  /** The end of what the program wrote to its standard error. */
  stderr(): string {
    return this.tail.toString();
  }

  /** How the program ended ("exit status 1", "signal: SIGKILL"), once it did;
   * "" while it runs. */
  status(): string {
    if (!this.hasExited) return '';
    if (this.exitSignal) return `signal: ${this.exitSignal}`;
    return `exit status ${this.exitCode ?? 0}`;
  }

  /** Sends sig to the program's group. */
  signal(sig: NodeJS.Signals): void {
    signalGroup(this.pid, sig);
  }

  /** Whether a process of the program's group is still there. */
  groupAlive(): boolean {
    return signalGroup(this.pid, 0);
  }

  /** Closes the program's input (its end of stdin). */
  closeInput(): void {
    this.child.stdin?.end();
    this.child.stdin?.destroy();
  }

  /** Ends the program's group gracefully, once: its input closes; a program
   * still there grace later gets SIGTERM, with the rest of its group, and
   * SIGKILL term after that. A group the program left behind gets the same
   * from SIGTERM on. The pipes are closed then. Resolves once all of it is
   * done; every call returns the same promise. */
  stop(t: StopTiming): Promise<void> {
    this.stopping ??= this.end(t);
    return this.stopping;
  }

  private async end(t: StopTiming): Promise<void> {
    this.closeInput();
    if (!(await within(this.exited, t.grace))) {
      this.signal('SIGTERM');
      if (!(await within(this.exited, t.term))) this.signal('SIGKILL');
      await this.exited;
    }
    // The program is gone; what it started in its group goes too.
    if (this.groupAlive()) {
      this.signal('SIGTERM');
      const deadline = Date.now() + t.term;
      while (this.groupAlive() && Date.now() < deadline) await wait(GROUP_POLL_MS);
      if (this.groupAlive()) this.signal('SIGKILL');
    }
    if (!(await within(this.drained, t.drain ?? 1000))) this.child.stderr?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}

/** The processes the host started that have not ended, and the way they
 * are started. */
export class AgentProcesses {
  private readonly live = new Set<AgentProcess>();

  /** Runs argv (argv[0] an absolute path) in cwd with env as the whole
   * environment, in a process group of its own. Rejects when the program
   * cannot be started. */
  spawn(argv: string[], o: { cwd: string; env: Record<string, string> }): Promise<AgentProcess> {
    if (argv.length === 0 || !argv[0]!.startsWith('/')) return Promise.reject(new Error('the program is not an absolute path'));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        return reject(e as Error);
      }
      // Every error after the start (a signal to a process gone) is passed
      // over: the process's end is what tells.
      child.on('error', (e) => reject(e));
      child.once('spawn', () => {
        const p = new AgentProcess(child);
        this.live.add(p);
        void p.exited.then(() => {
          // Kept while its group may hold what it started.
          if (!p.groupAlive()) this.live.delete(p);
        });
        resolve(p);
      });
    });
  }

  /** Sends sig to the group of every process started that is not known to
   * be gone with its group. */
  signal(sig: NodeJS.Signals): void {
    for (const p of [...this.live]) {
      if (p.gone && !p.groupAlive()) {
        this.live.delete(p);
        continue;
      }
      p.signal(sig);
    }
  }

  /** The processes not known to be gone with their groups. */
  get size(): number {
    for (const p of [...this.live]) if (p.gone && !p.groupAlive()) this.live.delete(p);
    return this.live.size;
  }
}

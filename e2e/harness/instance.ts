// One isolated instance of the hub for a test, run from the command
// line: a home of its own (home.ts: instance name, settings, environment,
// nothing of the user's), a free loopback port and --local-only.
//
// The hub runs with --parent-stdio: it stops when its stdin closes, also
// when the test runner dies. The local machine's node and terminal core
// outlive it, so stop() stops them: the terminal core first through the
// instance's own API, then the home's remove() (the node with `node stop
// --instance <name>`, and failing the API the terminal core with the
// instance's own herdr-core executable on the instance's own socket).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TestHome } from './home';
import { paths } from './paths';
import { waitFor } from './wait';

export interface Machine {
  id: string;
  status: string;
  /** What the machine's node reported in its last hello. */
  info?: { version: string };
}

/** The command lines of the instance's node processes. */
export function nodeProcesses(name: string): string[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(`node --instance ${name}`) && !l.includes(' node dial '));
}

export class Instance {
  readonly name: string;
  readonly home: string;
  /** A directory for the test's files (the workspace the tests open). */
  readonly work: string;
  /** First in the hub's PATH: the ssh of SSH machines (harness/sshd.ts). */
  readonly bin: string;
  private readonly h: TestHome;
  private stopped?: Promise<void>;
  baseURL = '';
  private proc?: ChildProcess;
  private log: string[] = [];
  private exited?: Promise<void>;

  /** Another hub of the instance (second()) leaves the instance's node,
   * terminal core and home to the first. */
  private readonly shares: boolean;

  private constructor(of?: Instance) {
    this.shares = !!of;
    this.h = of?.h ?? new TestHome();
    this.name = this.h.name;
    this.home = this.h.dir;
    this.work = this.h.work;
    this.bin = this.h.bin;
  }

  /** Starts a second hub of this instance (its name and home): another UI
   * of the same machines, which reaches the same local node, and with
   * stored the machines the first one added. Its stop() stops that hub
   * only. */
  async second(stored = false, exe = paths.hub): Promise<Instance> {
    const inst = new Instance(this);
    try {
      await inst.launch(stored, exe);
      await waitFor(async () => (await inst.machine()).status === 'ready', { what: 'the second hub to connect', timeout: 20_000 });
    } catch (e) {
      await inst.stop();
      throw e;
    }
    return inst;
  }

  /** Starts a hub on a new instance and waits until its terminal core runs. */
  static async start(): Promise<Instance> {
    const inst = new Instance();
    try {
      await inst.launch();
      await inst.ready();
    } catch (e) {
      await inst.stop();
      throw e;
    }
    return inst;
  }

  private async launch(stored = false, exe = paths.hub) {
    // --local-only leaves out stored machines only: the SSH machines a
    // test adds while the hub runs connect. --agent-dir holds the Linux
    // machine build they get (scripts/e2e.sh).
    const args = ['--instance', this.name, '--listen', '127.0.0.1:0', '--parent-stdio', '--agent-dir', paths.agentsOf(exe)];
    if (!stored) args.push('--local-only');
    const proc = spawn(exe, args, {
      cwd: this.home,
      env: this.h.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()));
    createInterface({ input: proc.stderr! }).on('line', (l) => this.log.push(l));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the hub did not get ready:\n' + this.logs())), 20_000);
      createInterface({ input: proc.stdout! }).on('line', (l) => {
        try {
          const m = JSON.parse(l) as { event?: string; url?: string };
          if (m.event === 'ready' && m.url) {
            clearTimeout(timer);
            resolve(m.url);
          }
        } catch {
          this.log.push(l);
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the hub exited (${code}):\n${this.logs()}`));
      });
    });
    this.baseURL = url;
  }

  private async ready() {
    // The instance's settings were read (home.ts): the keychain stays shut.
    const st = await this.api<{ values?: Record<string, { value?: unknown }> }>('GET', '/api/settings');
    for (const [k, v] of Object.entries(this.h.settings)) {
      const got = st.values?.[k]?.value;
      if (got !== v) throw new Error(`setting ${k} is ${JSON.stringify(got)}, not ${JSON.stringify(v)}`);
    }
    await waitFor(async () => (await this.machine()).status === 'ready', { what: 'the local machine to connect', timeout: 20_000 });
    await this.api('POST', '/api/m/local/hc/start');
    await waitFor(async () => (await this.api<{ running: boolean }>('GET', '/api/m/local/hc')).running, {
      what: 'the terminal core to run',
      timeout: 30_000,
    });
  }

  logs(): string {
    return this.log.slice(-60).join('\n');
  }

  async machine(): Promise<Machine> {
    const list = await this.api<Machine[]>('GET', '/api/machines');
    const m = list.find((x) => x.id === 'local');
    if (!m) throw new Error('no local machine');
    return m;
  }

  /** A request to the hub's API, its JSON answer; throws on an error status. */
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A request to the hub's API, its response as it came. */
  fetch(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(this.baseURL + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  /** The machines of the hub, as GET /api/machines lists them. */
  async machines(): Promise<(Machine & Record<string, unknown>)[]> {
    return this.api('GET', '/api/machines');
  }

  /** Stops the local terminal core, then the hub and the node, and
   * removes the home directory; once, however often it is called. */
  stop(): Promise<void> {
    this.stopped ??= this.stopOnce();
    return this.stopped;
  }

  private async stopOnce() {
    if (this.shares) {
      await this.stopHub(false);
      return;
    }
    await this.stopHub();
    await this.h.remove();
  }

  /** Stops the local terminal core (unless terminalCore is false) and the
   * hub, keeping the home directory (what a test checks after the hub is
   * gone). */
  async stopHub(terminalCore = true) {
    if (terminalCore && this.baseURL && this.proc?.exitCode === null) {
      try {
        await this.api('POST', '/api/m/local/hc/stop');
      } catch {
        // stopped below with its own executable
      }
    }
    if (this.proc && this.proc.exitCode === null) {
      this.proc.stdin?.end();
      const killed = await Promise.race([this.exited!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
      if (!killed) {
        this.proc.kill('SIGKILL');
        await this.exited;
      }
    }
  }
}

// One isolated instance of the core for a test: its own home directory
// (a short path below /tmp: macOS limits unix socket paths to 104 bytes),
// its own --instance name and so its own terminal core session, a free
// loopback port, --local-only and an environment built from scratch, so
// nothing of the user's (their instances, terminal cores, settings, agents
// and shell startup files) is read or touched.
//
// The core runs with --parent-stdio: it stops when its stdin closes, also
// when the test runner dies. The local machine's node and terminal core
// outlive it, so stop() stops them: the terminal core first through the
// instance's own API, the node with `node stop --instance <name>`, and
// failing the API the terminal core with the instance's own herdr-core
// executable on the instance's own socket.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { paths } from './paths';
import { waitFor } from './wait';

/** The marker that makes a directory below /tmp one of ours, and its owner. */
export const MARKER = 'e2e-instance.json';
export const HOME_PREFIX = '/tmp/hie-';
/** A proxy nothing listens on (the discard port). */
const DEAD_PROXY = 'http://127.0.0.1:9';
/** Settings every instance starts with. */
const SETTINGS = { 'usage.claudeKeychain': false };

export interface Machine {
  id: string;
  status: string;
}

export class Instance {
  readonly name: string;
  readonly home: string;
  /** A directory for the test's files (the workspace the tests open). */
  readonly work: string;
  /** First in the core's PATH: the ssh of SSH machines (harness/sshd.ts). */
  readonly bin: string;
  private stopped?: Promise<void>;
  baseURL = '';
  private proc?: ChildProcess;
  private log: string[] = [];
  private exited?: Promise<void>;

  /** Another core of the instance (second()) leaves the instance's node,
   * terminal core and home to the first. */
  private readonly shares: boolean;

  private constructor(of?: Instance) {
    this.shares = !!of;
    this.name = of?.name ?? 'e2e-' + randomBytes(4).toString('hex');
    // The real path: the terminal core reports directories resolved (/private/tmp on macOS).
    this.home = of?.home ?? realpathSync(mkdtempSync(HOME_PREFIX));
    this.work = join(this.home, 'work');
    this.bin = join(this.home, 'bin');
  }

  /** Starts a second core of this instance (its name and home): another UI
   * of the same machines, which reaches the same local node. Its stop()
   * stops that core only. */
  async second(): Promise<Instance> {
    const inst = new Instance(this);
    try {
      await inst.launch();
      await waitFor(async () => (await inst.machine()).status === 'ready', { what: 'the second core to connect', timeout: 20_000 });
    } catch (e) {
      await inst.stop();
      throw e;
    }
    return inst;
  }

  /** Starts a core on a new instance and waits until its terminal core runs. */
  static async start(): Promise<Instance> {
    const inst = new Instance();
    try {
      inst.prepare();
      await inst.launch();
      await inst.ready();
    } catch (e) {
      await inst.stop();
      throw e;
    }
    return inst;
  }

  private prepare() {
    mkdirSync(join(this.home, 'tmp'), { recursive: true });
    mkdirSync(this.work, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    // Login and interactive shells: the chat host reads the login shell's
    // PATH ($SHELL -l -i -c env), which puts the fake agent first.
    const rc = [`export PATH="${paths.fakeBin}:$PATH"`, `PS1='$ '`, ''].join('\n');
    writeFileSync(join(this.home, '.bash_profile'), rc);
    writeFileSync(join(this.home, '.bashrc'), rc);
    writeFileSync(join(this.home, MARKER), JSON.stringify({ name: this.name, pid: process.pid }));
    // The instance's settings: nothing of the user's outside the home
    // directory is read (Claude's credentials in the macOS keychain).
    const config = process.platform === 'darwin' ? join(this.home, 'Library', 'Application Support') : join(this.home, '.config');
    mkdirSync(join(config, paths.slug), { recursive: true });
    writeFileSync(join(config, paths.slug, `settings-${this.name}.json`), JSON.stringify(SETTINGS, null, 2));
  }

  /** The environment of the core: nothing inherited but the user's name. */
  private env(): NodeJS.ProcessEnv {
    const user = process.env.USER || process.env.LOGNAME || 'e2e';
    return {
      HOME: this.home,
      USER: user,
      LOGNAME: user,
      SHELL: '/bin/bash',
      PATH: `${this.bin}:${paths.fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: join(this.home, 'tmp'),
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      // Offline: HTTP clients that honor the proxy variables (the usage
      // plugin's polls, downloads) fail at once instead of going out.
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    };
  }

  private async launch() {
    // --local-only leaves out stored machines only: the SSH machines a
    // test adds while the core runs connect. --agent-dir holds the Linux
    // machine build they get (scripts/e2e.sh).
    const args = ['--instance', this.name, '--local-only', '--listen', '127.0.0.1:0', '--parent-stdio', '--agent-dir', paths.agents];
    const proc = spawn(paths.core, args, {
      cwd: this.home,
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()));
    createInterface({ input: proc.stderr! }).on('line', (l) => this.log.push(l));
    proc.stdin!.write('{}\n');
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the core did not get ready:\n' + this.logs())), 20_000);
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
        reject(new Error(`the core exited (${code}):\n${this.logs()}`));
      });
    });
    this.baseURL = url;
  }

  private async ready() {
    // The instance's settings were read (prepare): the keychain stays shut.
    const st = await this.api<{ values?: Record<string, { value?: unknown }> }>('GET', '/api/settings');
    for (const [k, v] of Object.entries(SETTINGS)) {
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

  /** A request to the core's API, its JSON answer; throws on an error status. */
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** A request to the core's API, its response as it came. */
  fetch(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(this.baseURL + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  /** The machines of the core, as GET /api/machines lists them. */
  async machines(): Promise<(Machine & Record<string, unknown>)[]> {
    return this.api('GET', '/api/machines');
  }

  /** Stops the local terminal core, then the core and the node, and
   * removes the home directory; once, however often it is called. */
  stop(): Promise<void> {
    this.stopped ??= this.stopOnce();
    return this.stopped;
  }

  private async stopOnce() {
    if (this.shares) {
      await this.stopCore(false);
      return;
    }
    await this.stopCore();
    stopNodes(this.home, this.name);
    stopTerminalCore(this.home, this.name);
    rmSync(this.home, { recursive: true, force: true });
    rmSync(controlDir(this.name), { recursive: true, force: true });
  }

  /** Stops the local terminal core (unless terminalCore is false) and the
   * core, keeping the home directory (what a test checks after the core is
   * gone). */
  async stopCore(terminalCore = true) {
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

/** Stops the nodes of an instance of ours, with its own name and home. */
export function stopNodes(home: string, name: string) {
  if (!existsSync(paths.core)) return;
  spawnSync(paths.core, ['node', 'stop', '--instance', name], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    timeout: 15_000,
    stdio: 'ignore',
  });
}

/** Stops the terminal core of an instance of ours, if it still runs: with
 * the instance's own executable, session and socket, nothing else. */
export function stopTerminalCore(home: string, name: string) {
  const base = readdirSync(home).find((d) => d.startsWith('.') && d.endsWith('-' + name));
  if (!base) return;
  const bin = join(home, base, 'hc', 'herdr-core');
  const socket = join(home, base, 'run', 'hc.sock');
  if (!existsSync(bin) || !existsSync(socket)) return;
  const slug = base.slice(1, -(name.length + 1));
  spawnSync(bin, ['server', 'stop', '--json'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', HC_SESSION: `${slug}-${name}`, HC_SOCKET: socket },
    timeout: 15_000,
    stdio: 'ignore',
  });
}

/** Removes what earlier runs that were killed left: directories with our
 * marker whose runner is gone, their terminal cores stopped first. */
export function sweepLeftovers() {
  for (const d of readdirSync('/tmp')) {
    const home = join('/tmp', d);
    if (!home.startsWith(HOME_PREFIX)) continue;
    let owner: { name: string; pid: number };
    try {
      owner = JSON.parse(readFileSync(join(home, MARKER), 'utf8'));
    } catch {
      continue;
    }
    if (alive(owner.pid)) continue;
    stopNodes(home, owner.name);
    stopTerminalCore(home, owner.name);
    rmSync(home, { recursive: true, force: true });
    rmSync(controlDir(owner.name), { recursive: true, force: true });
  }
}

/** The instance's ssh control directory (transport.ControlDir; e2e
 * instance names are short enough to be used as they are). */
function controlDir(name: string): string {
  return join('/tmp', `${paths.slug}-${process.getuid?.() ?? 0}`, `s-${name}`);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

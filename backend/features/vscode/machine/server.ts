// code-server of an instance on a machine: the executable a request names
// (the release in the releases' directory, or one installed on the machine),
// whether one answers on the instance's socket and serves VS Code, starting
// it and ending it.
//
// It listens only on <run>/cs.sock (--socket-mode 600, in the 0700 run
// directory; --auth none is safe only so), its port proxy off
// (--disable-proxy: it would serve any program of the machine on the UI's
// origin), telemetry and update checks off.
//
// Ownership: <run>/cs.pid names the process and the agent (its process,
// the node) that started it, as the Go machine build writes it. The node
// that owns it ends it when the node ends (close), when a core asks (stop)
// or lets it go (release, its idle end) while no other core of the node has
// a connection to it; a node that gives way hands it to the next (handOver);
// one whose owner is gone (a node killed) is ended by the next node
// (reapOrphan), or adopted when that node finds it serving. code-server
// also exits by itself after IDLE_SECONDS without connections.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { posix } from 'node:path';
import { env as brandEnv } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { CSStatus, Header } from '#shared/proto/agentproto/index.ts';
import { inode } from '#machine/sockets.ts';
import { peerCred, socketFd } from '#machine/sys/proc.ts';
import { releaseBin, releaseDir, type Layout } from './layout.ts';
import { alive, isExecutable, lastN, lookPath, stopGroup } from './process.ts';

/** A disconnected window's extension host is kept this long. */
export const GRACE_SECONDS = 300;
/** code-server exits by itself after this long without connections. */
export const IDLE_SECONDS = 3600;

export interface ServerTiming {
  /** How long a start waits for the socket to answer. */
  startMs: number;
  /** How often it looks. */
  pollMs: number;
  /** How long the probe of the workbench may take. */
  probeMs: number;
  /** How long an ended process has after SIGTERM before SIGKILL. */
  termMs: number;
}

export const SERVER_TIMING: ServerTiming = { startMs: 90_000, pollMs: 250, probeMs: 10_000, termMs: 5000 };

/** The pid file, as both machine builds write it. */
export interface PidRecord {
  pid: number;
  /** The agent's process that started it, or took it over. */
  owner: number;
  version: string;
  /** Unix seconds. */
  started: number;
}

export interface ServerOptions {
  home: string;
  logger: Logger;
  /** The environment of the programs it starts (cleanEnv). */
  environ: () => Record<string, string>;
  timing?: Partial<ServerTiming>;
  /** Where an installed code-server is looked for besides PATH (tests
   * give others). */
  installedDirs?: (home: string) => string[];
}

/** Where the install script, Homebrew and distributions' packages put
 * code-server: the agent's PATH comes from a non-interactive ssh session. */
const INSTALLED_DIRS = (home: string) => [
  posix.join(home, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/snap/bin',
];

/** The arguments of the code-server process. */
export function serveArgs(l: Layout): string[] {
  return [
    '--socket',
    l.socket,
    '--socket-mode',
    '600',
    '--auth',
    'none',
    // The port proxy (/proxy/<port>/, /absproxy/<port>/) would serve
    // whatever listens on the machine with the UI's origin.
    '--disable-proxy',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-workspace-trust',
    '--disable-getting-started-override',
    '--ignore-last-opened',
    '--reconnection-grace-time',
    String(GRACE_SECONDS),
    '--idle-timeout-seconds',
    String(IDLE_SECONDS),
    ...dirArgs(l),
  ];
}

/** VS Code's settings and extensions: the instance's on this host. */
export const dirArgs = (l: Layout): string[] => ['--user-data-dir', l.data, '--extensions-dir', l.ext];

/** Whether something accepts a connection on the unix socket path within
 * timeoutMs. */
function answers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const c = connect(path);
    const t = setTimeout(() => {
      c.destroy();
      res(false);
    }, timeoutMs);
    c.once('connect', () => {
      clearTimeout(t);
      c.destroy();
      res(true);
    });
    c.once('error', () => {
      clearTimeout(t);
      res(false);
    });
  });
}

/** The status of GET / on the unix socket path, null when it does not
 * answer in time. One request on a connection of its own, which closes with
 * the answer; a redirect is an answer. */
export function probe(path: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      req.destroy();
      resolve(v);
    };
    const req = request({ socketPath: path, path: '/', method: 'GET', agent: false, headers: { host: 'localhost', connection: 'close' } });
    const t = setTimeout(() => done(null), timeoutMs);
    req.on('response', (res) => {
      res.resume();
      done(res.statusCode ?? null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

/** Ends the process listening on the unix socket path, if any: the
 * socket's peer is the process that accepted the connection. */
async function stopListener(path: string, termMs: number): Promise<void> {
  const pid = await new Promise<number>((res) => {
    const c = connect(path);
    const t = setTimeout(() => {
      c.destroy();
      res(0);
    }, 1000);
    c.once('connect', () => {
      clearTimeout(t);
      let pid = 0;
      try {
        pid = peerCred(socketFd(c)).pid;
      } catch {
        // unknown
      }
      c.destroy();
      res(pid);
    });
    c.once('error', () => {
      clearTimeout(t);
      res(0);
    });
  });
  if (pid > 0) await stopGroup(pid, termMs);
}

export class CodeServer {
  readonly layout: Layout;
  private readonly o: ServerOptions;
  private readonly t: ServerTiming;
  /** Starting, ending and the pid file's changes, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(layout: Layout, o: ServerOptions) {
    this.layout = layout;
    this.o = o;
    this.t = { ...SERVER_TIMING, ...o.timing };
  }

  /** Runs fn after what runs already. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async readPid(): Promise<PidRecord | null> {
    try {
      const p = JSON.parse(await readFile(this.layout.pidFile, 'utf8')) as PidRecord;
      return p && typeof p.pid === 'number' && typeof p.owner === 'number' ? p : null;
    } catch {
      return null;
    }
  }

  private async writePid(p: PidRecord): Promise<void> {
    await writeFile(this.layout.pidFile, JSON.stringify(p), { mode: 0o600 }).catch(() => {});
  }

  /** Ends the recorded process group and removes its pid file and socket,
   * while they are still its own: another node of the instance may have
   * started a code-server meanwhile. */
  private async kill(p: PidRecord): Promise<void> {
    const sock = inode(this.layout.socket);
    await stopGroup(p.pid, this.t.termMs);
    if ((await this.readPid())?.pid === p.pid) await rm(this.layout.pidFile, { force: true });
    if (sock !== null && inode(this.layout.socket) === sock) await rm(this.layout.socket, { force: true });
  }

  /** Whether something answers on the socket. */
  alive(): Promise<boolean> {
    return answers(this.layout.socket);
  }

  /** Whether what answers on the socket serves VS Code's workbench: a
   * code-server whose installation was moved or removed still accepts
   * connections (and answers /healthz), but answers 404 for every page. */
  async serves(): Promise<boolean> {
    const status = await probe(this.layout.socket, this.t.probeMs);
    return status !== null && status < 400;
  }

  /** Ends whatever listens on the socket: the recorded process, else the
   * socket's peer (a code-server this node has no pid file for). */
  private async replace(): Promise<void> {
    const p = await this.readPid();
    if (p && alive(p.pid)) return this.kill(p);
    await stopListener(this.layout.socket, this.t.termMs);
    await rm(this.layout.pidFile, { force: true });
    await rm(this.layout.socket, { force: true });
  }

  /** Ends a code-server whose owner is gone (its node was killed). */
  reapOrphan(): Promise<void> {
    return this.locked(async () => {
      const p = await this.readPid();
      if (!p || alive(p.owner)) return;
      if (alive(p.pid)) this.o.logger(`stopping orphaned code-server pid ${p.pid} (owner ${p.owner} gone)`);
      await this.kill(p);
    });
  }

  /** Ends code-server (a core asked, or let it go). */
  stop(): Promise<void> {
    return this.locked(async () => {
      const p = await this.readPid();
      if (p) await this.kill(p);
    });
  }

  /** Makes the node pid the owner of the code-server this node owns (the
   * node that took over), which close then leaves running. */
  handOver(pid: number): Promise<void> {
    return this.locked(async () => {
      const p = await this.readPid();
      if (p && p.owner === process.pid && pid > 0) await this.writePid({ ...p, owner: pid });
    });
  }

  /** The node ends: only a code-server it owns is ended, so another node's
   * (a core of another build connected meanwhile) keeps working. */
  close(): Promise<void> {
    return this.locked(async () => {
      const p = await this.readPid();
      if (p && p.owner === process.pid) await this.kill(p);
    });
  }

  /** Keeps the release of a running code-server from its retention: what a
   * start does, again while it runs. */
  async touchRunning(now: Date): Promise<void> {
    const p = await this.readPid();
    if (!p || !alive(p.pid) || !p.version || /[/\\]|\.\./.test(p.version)) return;
    await utimes(releaseDir(this.layout, p.version), now, now).catch(() => {});
  }

  /** The executable a request names: the release in the releases'
   * directory (no bin), or one installed on the machine (bin: a path,
   * "~/…", or "auto" for PATH and the usual places). */
  async binFor(h: Header): Promise<string> {
    const bin = h.bin ?? '';
    if (bin === '') {
      const p = releaseBin(this.layout, h.version ?? '');
      if (!(await isExecutable(p))) throw new Error('code-server is not installed');
      return p;
    }
    if (bin !== 'auto') {
      const p = bin.startsWith('~/') ? posix.join(this.o.home, bin.slice(2)) : bin;
      if (!p.startsWith('/')) throw new Error(`code-server path ${JSON.stringify(bin)} is not absolute`);
      if (!(await isExecutable(p))) throw new Error(`${p} is not an executable`);
      return p;
    }
    const found = await lookPath('code-server', this.o.environ().PATH ?? '');
    if (found) return found;
    const dirs = (this.o.installedDirs ?? INSTALLED_DIRS)(this.o.home);
    for (const d of dirs) {
      const p = posix.join(d, 'code-server');
      if (await isExecutable(p)) return p;
    }
    throw new Error(`no code-server on PATH or in ${dirs.join(', ')}`);
  }

  async status(h: Header): Promise<CSStatus> {
    const st: CSStatus = { installed: false, running: false, socket: this.layout.socket };
    if (h.version) st.version = h.version;
    try {
      st.bin = await this.binFor(h);
      st.installed = true;
    } catch (e) {
      if (h.bin) st.error = (e as Error).message;
    }
    st.running = await this.alive();
    return st;
  }

  /** Starts code-server unless one serves on the socket already; resolves
   * once its socket answers. signal ends the wait (the process goes on). */
  start(h: Header, signal: AbortSignal): Promise<void> {
    return this.locked(async () => {
      const l = this.layout;
      if (await this.alive()) {
        if (await this.serves()) {
          // A running one whose owner is gone is adopted, so that it is
          // still ended eventually.
          const p = await this.readPid();
          if (p && !alive(p.owner)) await this.writePid({ ...p, owner: process.pid });
          return;
        }
        this.o.logger(`the code-server on ${l.socket} does not serve VS Code (moved or deleted installation?); replacing it`);
        await this.replace();
      }
      const stale = await this.readPid();
      if (stale) await this.kill(stale); // stale or hung
      const bin = await this.binFor(h);
      if (!h.bin) {
        // In use: kept by the releases' retention.
        const now = new Date();
        await utimes(releaseDir(l, h.version ?? ''), now, now).catch(() => {});
      }
      await rm(l.socket, { force: true });
      for (const d of [l.data, l.ext]) await mkdir(d, { recursive: true, mode: 0o700 });
      const log = await open(l.log, 'w', 0o600);
      let child;
      try {
        child = spawn(bin, serveArgs(l), {
          // The bridge extension finds the agent's socket through this
          // variable; VSCODE_PROXY_URI empty: no port proxy to offer.
          env: { ...this.o.environ(), VSCODE_PROXY_URI: '', [brandEnv('BRIDGE_SOCKET')]: l.bridge },
          cwd: this.o.home,
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
        });
      } finally {
        await log.close();
      }
      const exited = new Promise<string>((resolve) => {
        child.once('error', (e) => resolve(e.message));
        child.once('exit', (code, sig) => resolve(sig ? `killed by ${sig}` : `exit status ${code}`));
      });
      // Nothing of the node waits for it.
      child.unref();
      const pid = child.pid ?? 0;
      if (pid > 0) {
        await this.writePid({ pid, owner: process.pid, version: h.version ?? '', started: Math.floor(Date.now() / 1000) });
        // The pid file goes with the process, while it still names it.
        void exited.then(() =>
          this.locked(async () => {
            if ((await this.readPid())?.pid === pid) await rm(l.pidFile, { force: true });
          }),
        );
      }
      const deadline = Date.now() + this.t.startMs;
      let ended: string | null = null;
      void exited.then((why) => (ended = why));
      for (;;) {
        if (await this.alive()) return;
        if (ended !== null) {
          if (pid > 0 && (await this.readPid())?.pid === pid) await rm(l.pidFile, { force: true });
          const out = await readFile(l.log, 'utf8').catch(() => '');
          throw new Error(`code-server exited: ${ended}: ${lastN(out, 800)}`);
        }
        if (Date.now() > deadline) throw new Error(`code-server did not start within ${Math.round(this.t.startMs / 1000)}s (see ${l.log})`);
        signal.throwIfAborted();
        await new Promise((r) => setTimeout(r, this.t.pollMs));
      }
    });
  }
}

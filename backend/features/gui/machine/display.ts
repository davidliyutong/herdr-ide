// The virtual display that programs in terminals draw their windows on
// (docs/features/14-gui-windows.md; the Go agent's gui.go and guigpu.go).
// It is an X server of one of two kinds: Xwayland drawing with a GPU, with
// the GUI helper as its compositor, where the machine has an Xwayland and
// a GPU; else Xvfb, found on the machine or unpacked from the
// distribution's package in user space. Neither needs a privileged
// installation.
//
// Ownership and reclamation: the display number is reserved in
// run/gui.json, so panes keep a valid environment across restarts; each
// start writes a new cookie to run/xauth.server (the server's) and
// run/xauth (the panes'). The server runs in its own session and outlives
// the agent (programs would die with their display); it exits by itself
// IDLE_SECONDS after its last client disconnected (-terminate), and
// Xwayland's compositor with it. The display keeper (keep.ts) is a client
// while the instance's terminal core runs.
//
// Other users can bind X sockets in /tmp, abstract ones included, and X
// clients cannot tell which server they reach. So a display number is only
// used while no other user's lock file, socket or listener is on it, and
// the cookie goes only to a server whose peer credentials are the one this
// instance started (the helper checks them on every connection).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { posix } from 'node:path';
import { HUB_BIN, DATA_DIR_NAME } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { HOSTS_DIR } from '#shared/host/hostdirs.ts';
import { GUIDisplay, type GUIProc, type GUIStatus } from '#shared/proto/agentproto/index.ts';
import { tryLock, unlock } from '#machine/sys/fs.ts';
import { peerCred, socketFd, socketPair } from '#machine/sys/proc.ts';
import { GPU_PATHS, findXwayland, gpuNode, isExecutable, lookPath, nvidiaGPUs, type GPUPaths } from './gpu.ts';
import { lastLine, runHelper } from './helper.ts';
import { lastN, run } from './run.ts';

/** The display server exits this long after its last client left. */
export const IDLE_SECONDS = 60;
/** The virtual screen; windows larger than it still work, but input
 * reaches only the part on the screen. */
export const WIDTH = 2560;
export const HEIGHT = 1440;
/** Leaves the low numbers to real X servers. */
export const FIRST_DISPLAY = 20;
/** Downloads left by a killed agent are removed after this. */
export const STAGING_RETENTION_MS = 60 * 60_000;
/** Unpacked packages unused for this long are removed. */
export const VERSION_RETENTION_MS = 14 * 24 * 60 * 60_000;

export const linux = process.platform === 'linux';

/** run/gui.json. */
export interface State {
  display: number;
  pid?: number;
  bin?: string;
  /** The kind of the server pid (servers of earlier builds were Xvfb);
   * the GPU a GPU display draws with: its render node and NVIDIA minor. */
  kind?: string;
  node?: string;
  minor?: number;
}

export const kindOf = (st: State) => st.kind || GUIDisplay.Xvfb;

export interface DisplayOptions {
  home: string;
  /** This host's directory of the instance, and its run directory. */
  host: string;
  run: string;
  /** The instance's terminal core's socket. */
  hcSocket: string;
  environ: () => Record<string, string>;
  logger: Logger;
  /** The GUI helper's path (placed on first use). */
  helper: () => Promise<string>;
  /** The installed GPU selection library, '' without one. */
  pickPath?: () => Promise<string>;
  /** Where X servers put their sockets and lock files (tests give their own). */
  xTmp?: string;
  gpu?: GPUPaths;
  /** PATH to look programs up in (tests give their own). */
  path?: string;
  /** Whether the machine is Linux (tests on other systems). */
  linux?: boolean;
}

/** The GPU display a machine could run: Xwayland, the render node, whether
 * NVIDIA's driver runs it, and its minor. */
export interface GPUDisplay {
  bin: string;
  node: string;
  nvidia: boolean;
  minor?: number;
}

interface VGL {
  run: string;
  preload: string;
  gpu: boolean;
}

/** Bounds the processes of a shells request. */
const MAX_SHELLS = 512;
const VERSION_NAME = /^[0-9][A-Za-z0-9.+~_-]*$/;
const UNSAFE_VERSION = /[^A-Za-z0-9.+~-]/g;
const XAUTH_NAME = 'MIT-MAGIC-COOKIE-1';

/** One Xauthority record for display n with family FamilyWild, which libXau
 * matches whatever the host name. */
export function xauthEntry(cookie: Uint8Array, n: number): Buffer {
  const field = (b: Uint8Array) => {
    const h = Buffer.alloc(2);
    h.writeUInt16BE(b.length);
    return Buffer.concat([h, b]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xff]),
    field(Buffer.alloc(0)),
    field(Buffer.from(String(n))),
    field(Buffer.from(XAUTH_NAME)),
    field(cookie),
  ]);
}

/** The cookie of an Xauthority file of one MIT-MAGIC-COOKIE-1. */
export function parseXauth(b: Buffer): Buffer | null {
  let o = 2;
  const fields: Buffer[] = [];
  for (let i = 0; i < 4; i++) {
    if (o + 2 > b.length) return null;
    const n = b.readUInt16BE(o);
    o += 2;
    if (o + n > b.length) return null;
    fields.push(b.subarray(o, o + n));
    o += n;
  }
  if (fields[2].toString() !== XAUTH_NAME || fields[3].length !== 16) return null;
  return fields[3];
}

/** Whether pid is a process, also another user's. */
export function pidExists(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process and user listening on a unix socket ("@name": abstract). */
export function peerOf(path: string, timeoutMs = 1000): Promise<{ pid: number; uid: number } | null> {
  return new Promise((resolve) => {
    const c = connect({ path: path.startsWith('@') ? '\0' + path.slice(1) : path });
    const done = (v: { pid: number; uid: number } | null) => {
      clearTimeout(t);
      c.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(null), timeoutMs);
    c.once('error', () => done(null));
    c.once('connect', () => {
      try {
        done(peerCred(socketFd(c)));
      } catch {
        done(null);
      }
    });
  });
}

/** Resolves p and reports whether the file and every directory above it
 * can be changed by root only: libraries preloaded into every program of
 * a pane must not be replaceable by other users. */
export async function rootOnly(p: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    return null;
  }
  for (let q = real; ; q = posix.dirname(q)) {
    let st;
    try {
      st = await stat(q);
    } catch {
      return null;
    }
    if (st.uid !== 0 || ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)) return null;
    if (q === '/') return real;
  }
}

/** Whether pid is one of the instance's own processes that uses the display
 * without showing anything: this node, an agent of either build, a display
 * keeper or the GUI helper. */
export async function ownClient(pid: number): Promise<boolean> {
  if (pid === process.pid) return true;
  let argv: string[];
  try {
    argv = (await readFile(`/proc/${pid}/cmdline`, 'latin1')).split('\0');
  } catch {
    return false;
  }
  if (argv.length < 2 || !posix.basename(argv[0]).startsWith(HUB_BIN)) return false;
  return ['gui-keep', 'gui-wm', 'gui-probe', 'agent', 'node'].includes(argv[1]);
}

export class Display {
  private readonly xTmp: string;
  private readonly me = process.getuid?.() ?? -1;
  /** Why the GPU display did not start, since when this agent starts the
   * plain one (the next agent tries again). */
  accelErr = '';
  private vgl: Promise<VGL> | null = null;
  /** Serializes the display's changes within this process; the lock file
   * between agents. */
  private chain: Promise<unknown> = Promise.resolve();

  private readonly o: DisplayOptions;

  constructor(o: DisplayOptions) {
    this.o = o;
    this.xTmp = o.xTmp ?? '/tmp';
  }

  /** Unpacked Xvfb packages, shared by the instances of this host (the
   * default instance's host directory): a package is of the host's
   * distribution and architecture. */
  root(): string {
    return posix.join(this.o.home, DATA_DIR_NAME, HOSTS_DIR, posix.basename(this.o.host), 'xvfb');
  }
  statePath = () => posix.join(this.o.run, 'gui.json');
  /** The Xauthority file panes get (XAUTHORITY), and the server's own copy,
   * so that programs changing theirs cannot leave the server without a
   * cookie (an X server with none accepts any local user). */
  xauthPath = () => posix.join(this.o.run, 'xauth');
  serverAuthPath = () => posix.join(this.o.run, 'xauth.server');
  xSocket = (n: number) => `${this.xTmp}/.X11-unix/X${n}`;
  xLock = (n: number) => `${this.xTmp}/.X${n}-lock`;

  /** The sockets an X client may reach for display n: on Linux libxcb
   * tries the abstract name first, and anyone can bind it. */
  listeners(n: number): string[] {
    return linux ? ['@' + this.xSocket(n), this.xSocket(n)] : [this.xSocket(n)];
  }

  /** Runs f alone: within this process and, with the lock file, between
   * agents of the same instance (two hubs, or a node taking over). */
  locked<T>(f: () => Promise<T>): Promise<T> {
    const run = async () => {
      const fd = openSync(posix.join(this.o.run, 'gui.lock'), constants.O_CREAT | constants.O_RDWR, 0o600);
      try {
        for (let i = 0; !tryLock(fd); i++) {
          if (i > 1200) throw new Error('gui: the display lock is held by another agent');
          await new Promise((r) => setTimeout(r, 50));
        }
        return await f();
      } finally {
        try {
          unlock(fd);
        } catch {
          // closed below anyway
        }
        closeSync(fd);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async readState(): Promise<State> {
    try {
      const v = JSON.parse(await readFile(this.statePath(), 'utf8')) as Partial<State>;
      const num = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) ? x : undefined);
      const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
      return { display: num(v.display) ?? 0, pid: num(v.pid), bin: str(v.bin), kind: str(v.kind), node: str(v.node), minor: num(v.minor) };
    } catch {
      return { display: 0 };
    }
  }

  async writeState(st: State): Promise<void> {
    // Members as the Go agent writes them, empty ones left out.
    const out: Record<string, unknown> = { display: st.display };
    if (st.pid) out.pid = st.pid;
    if (st.bin) out.bin = st.bin;
    if (st.kind) out.kind = st.kind;
    if (st.node) out.node = st.node;
    if (st.minor !== undefined) out.minor = st.minor;
    await writeFile(this.statePath(), JSON.stringify(out), { mode: 0o600 });
  }

  private async ownerOf(path: string): Promise<number | null> {
    try {
      return (await lstat(path)).uid;
    } catch {
      return null;
    }
  }

  private async lockPid(n: number): Promise<number> {
    try {
      return Number.parseInt((await readFile(this.xLock(n), 'utf8')).trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /** Whether the socket directory cannot be used to mislead us: a real
   * directory owned by root or us, sticky if group or others may write it.
   * The X server creates it when it is missing. */
  async x11DirSafe(): Promise<boolean> {
    let st;
    try {
      st = await lstat(`${this.xTmp}/.X11-unix`);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!st.isDirectory()) return false;
    if (st.uid !== 0 && st.uid !== this.me) return false;
    return (st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0;
  }

  /** Whether display n can serve this instance: no lock file, socket or
   * listener of another user (who could pose as our X server and receive
   * the cookie and the user's keystrokes), and any live server on it is
   * the one this instance started (st.pid). */
  async usable(n: number, st: State, me = this.me): Promise<boolean> {
    const lockOwner = await this.ownerOf(this.xLock(n));
    if (lockOwner !== null) {
      if (lockOwner !== me) return false;
      const pid = await this.lockPid(n);
      if (pid > 0 && pidExists(pid) && pid !== st.pid) return false;
    }
    const sockOwner = await this.ownerOf(this.xSocket(n));
    if (sockOwner !== null && sockOwner !== me) return false;
    for (const l of this.listeners(n)) {
      const p = await peerOf(l);
      if (p && (p.uid !== me || p.pid !== st.pid)) return false;
    }
    return true;
  }

  /** The reserved display number, reserving another one when the previous
   * one is in someone else's hands. Call while locked. */
  async display(): Promise<number> {
    if (!(await this.x11DirSafe()))
      throw new Error(`${this.xTmp}/.X11-unix is not a directory owned by root or the user with the sticky bit`);
    const st = await this.readState();
    if (st.display > 0 && (await this.usable(st.display, st))) return st.display;
    for (let n = FIRST_DISPLAY; n < FIRST_DISPLAY + 500; n++) {
      if ((await this.ownerOf(this.xSocket(n))) !== null || (await this.ownerOf(this.xLock(n))) !== null) continue;
      if (await this.usable(n, { display: 0 })) {
        await this.writeState({ display: n });
        return n;
      }
    }
    throw new Error('no free X display number');
  }

  /** Whether the server this instance started serves display n: every
   * socket a client may reach answers with that process and our user. */
  async running(n: number): Promise<boolean> {
    const st = await this.readState();
    if (!st.pid || st.display !== n) return false;
    for (const l of this.listeners(n)) {
      const p = await peerOf(l);
      if (!p || p.uid !== this.me || p.pid !== st.pid) return false;
    }
    return true;
  }

  /** The server's Xauthority file: its own, or the panes' for a display
   * started by an earlier build. */
  async serverAuth(): Promise<string> {
    try {
      if (parseXauth(await readFile(this.serverAuthPath()))) return this.serverAuthPath();
    } catch {
      // none
    }
    return this.xauthPath();
  }

  /** Writes a fresh cookie for display n to the server's and the panes'
   * Xauthority files. Each start gets a new one. */
  private async newCookie(n: number): Promise<void> {
    const entry = xauthEntry(randomBytes(16), n);
    for (const p of [this.serverAuthPath(), this.xauthPath()]) {
      await writeFile(p + '.tmp', entry, { mode: 0o600 });
      await rename(p + '.tmp', p);
    }
  }

  /** Unpacked Xvfb packages, most recently used first. */
  async unpacked(): Promise<string[]> {
    let ents;
    try {
      ents = await readdir(this.root(), { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: Array<{ path: string; mod: number }> = [];
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = posix.join(this.root(), e.name);
      try {
        dirs.push({ path: p, mod: (await stat(p)).mtimeMs });
      } catch {
        // gone
      }
    }
    return dirs.sort((a, b) => b.mod - a.mod).map((d) => d.path);
  }

  /** An Xvfb on the machine or one unpacked earlier. */
  async findXvfb(): Promise<string> {
    const p = await lookPath('Xvfb', this.o.path);
    if (p) return p;
    for (const c of ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb']) if (await isExecutable(c)) return c;
    for (const d of await this.unpacked()) {
      const x = posix.join(d, 'usr', 'bin', 'Xvfb');
      if (await isExecutable(x)) return x;
    }
    return '';
  }

  /** Whether the distribution's Xvfb package can be fetched without
   * privileges (Debian and derivatives). */
  async installable(): Promise<boolean> {
    if (!linux) return false;
    return (await lookPath('apt-get', this.o.path)) !== '' && (await lookPath('dpkg-deb', this.o.path)) !== '';
  }

  /** Fetches the distribution's xvfb package with apt-get download
   * (verified against apt's signed package lists) and unpacks it below
   * root. It relies on the libraries, xkbcomp and keyboard data an X
   * server or Xwayland already brought onto the machine. */
  async install(signal?: AbortSignal): Promise<void> {
    if (!(await this.installable())) throw new Error('Xvfb is not installed and cannot be fetched without apt-get and dpkg-deb');
    await mkdir(this.root(), { recursive: true, mode: 0o755 });
    const tmp = await mkdtemp(posix.join(this.root(), '.fetch-'));
    const env = this.o.environ();
    const deadline = Date.now() + 5 * 60_000;
    const left = () => Math.max(1, deadline - Date.now());
    try {
      const dl = await run(['apt-get', 'download', 'xvfb'], { env, cwd: tmp, timeoutMs: left(), signal });
      if (dl.code !== 0) throw new Error(`apt-get download xvfb: exit status ${dl.code}: ${lastN(dl.out, 400)}`);
      const debs = (await readdir(tmp)).filter((n) => n.startsWith('xvfb_') && n.endsWith('.deb'));
      if (debs.length !== 1) throw new Error('apt-get download xvfb produced no package');
      const deb = posix.join(tmp, debs[0]);
      const f = await run(['dpkg-deb', '-f', deb, 'Version'], { env, timeoutMs: left(), signal });
      if (f.code !== 0) throw new Error(`dpkg-deb: ${lastN(f.out, 400)}`);
      const ver = f.out.trim().replace(UNSAFE_VERSION, '_');
      if (!VERSION_NAME.test(ver)) throw new Error(`xvfb package with an unexpected version ${JSON.stringify(ver)}`);
      const dest = posix.join(this.root(), ver);
      if (await isExecutable(posix.join(dest, 'usr', 'bin', 'Xvfb'))) {
        const now = new Date();
        await utimes(dest, now, now);
        return;
      }
      const stage = posix.join(tmp, 'root');
      const x = await run(['dpkg-deb', '-x', deb, stage], { env, timeoutMs: left(), signal });
      if (x.code !== 0) throw new Error(`dpkg-deb: ${lastN(x.out, 400)}`);
      if (!(await isExecutable(posix.join(stage, 'usr', 'bin', 'Xvfb')))) throw new Error('the xvfb package contains no usr/bin/Xvfb');
      await rm(dest, { recursive: true, force: true });
      await rename(stage, dest);
      await this.prune(dest);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Removes unpacked packages other than keep that were not used for
   * VERSION_RETENTION_MS, and downloads that did not finish. */
  async prune(keep = '', now = Date.now(), stagingOnly = false): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root());
    } catch {
      return;
    }
    for (const name of names) {
      const p = posix.join(this.root(), name);
      if (p === keep) continue;
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      const limit = name.startsWith('.fetch-')
        ? STAGING_RETENTION_MS
        : name.startsWith('.') || stagingOnly
          ? Infinity
          : VERSION_RETENTION_MS;
      if (now - st.mtimeMs > limit) await rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** What the GPU display would run with; null where there can be none, or
   * after an attempt failed (the next agent tries again). */
  async gpuDisplay(): Promise<GPUDisplay | null> {
    if (!linux || this.accelErr) return null;
    const bin = await findXwayland(this.o.path);
    if (!bin) return null;
    const g = await gpuNode(await nvidiaGPUs(this.o.gpu ?? GPU_PATHS), this.o.gpu ?? GPU_PATHS);
    if (!g.node) return null;
    return { bin, node: g.node, nvidia: g.nvidia, ...(g.minor !== undefined ? { minor: g.minor } : {}) };
  }

  /** The kind of display to start for what the hub asked for. */
  async wanted(asked: string): Promise<string> {
    if (asked !== GUIDisplay.Xvfb && (await this.gpuDisplay())) return GUIDisplay.Xwayland;
    return GUIDisplay.Xvfb;
  }

  /** Runs the helper's probe of display n: whether it has DRI3 and its
   * clients' processes. */
  async probe(n: number): Promise<{ dri3: boolean; res: boolean; pids: number[] }> {
    const st = await this.readState();
    return runHelper(
      await this.o.helper(),
      ['gui-probe', '--socket', this.xSocket(n), '--pid', String(st.pid ?? 0), '--xauth', await this.serverAuth()],
      {
        env: this.o.environ(),
        cwd: this.o.home,
        logger: this.o.logger,
        timeoutMs: 15_000,
      },
    );
  }

  /** A process that uses display n besides the instance's own (0 when there
   * is none, -1 when that cannot be told). Only an unused display may be
   * replaced by one of another kind, which ends its clients' connections. */
  async user(n: number): Promise<number> {
    let r;
    try {
      r = await this.probe(n);
    } catch {
      return -1;
    }
    if (!r.res) return -1;
    const own = (await this.readState()).pid;
    for (const pid of r.pids) {
      if (pid === 0) return -1;
      // The server counts itself among its clients.
      if (pid !== own && !(await ownClient(pid))) return pid;
    }
    return 0;
  }

  /** Ends the display server of st on display n and waits until it is gone,
   * so that another one can take the number. */
  async stop(n: number, st: State): Promise<void> {
    if (!st.pid || st.pid <= 1 || !(await this.running(n))) return;
    const pid = st.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
    const deadline = Date.now() + 5000;
    while (pidExists(pid)) {
      if (Date.now() > deadline) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
        await new Promise((r) => setTimeout(r, 200));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // A server that was killed leaves its files; they are this user's.
    if (!pidExists(pid)) {
      await rm(this.xSocket(n), { force: true }).catch(() => {});
      await rm(this.xLock(n), { force: true }).catch(() => {});
    }
  }

  /** Makes a display server exit IDLE_SECONDS after its last client left;
   * the delay needs xorg-server 21.1, older servers exit at once. */
  async terminateArgs(bin: string): Promise<{ args: string[]; delay: boolean }> {
    const r = await run([bin, '-help'], { env: this.o.environ(), timeoutMs: 5000 });
    if (r.out.includes('-terminate [delay]')) return { args: ['-terminate', String(IDLE_SECONDS)], delay: true };
    return { args: ['-terminate'], delay: false };
  }

  /** Runs a display server on the reserved display unless one runs: the
   * GPU display when asked is not xvfb and the machine can run it, Xvfb
   * otherwise and when the GPU display does not come up. A display of the
   * other kind is replaced while no program uses it. */
  start(asked: string): Promise<void> {
    return this.locked(async () => {
      const n = await this.display();
      const kind = await this.wanted(asked);
      if (await this.running(n)) {
        const st = await this.readState();
        if (kindOf(st) === kind) return;
        const pid = await this.user(n);
        if (pid !== 0) {
          const comm = pid > 0 ? (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() : '';
          this.o.logger(`gui: display :${n} stays ${kindOf(st)} while process ${pid} (${comm}) uses it`);
          return;
        }
        this.o.logger(`gui: replacing the ${kindOf(st)} display :${n} by ${kind}`);
        await this.stop(n, st);
      }
      if (kind === GUIDisplay.Xwayland) {
        try {
          await this.startServer(n, kind);
          return;
        } catch (e) {
          // Not tried again by this agent: the plain display serves until
          // the machine connects anew.
          const msg = (e as Error).message;
          this.o.logger(`gui: the GPU display did not start, using Xvfb: ${msg}`);
          this.accelErr = msg;
          if (!(await this.findXvfb())) throw new Error(`the GPU display did not start (${msg}) and Xvfb is not installed`);
        }
      }
      await this.startServer(n, GUIDisplay.Xvfb);
    });
  }

  /** Starts a display server of kind on display n and waits until it serves
   * it. */
  private async startServer(n: number, kind: string): Promise<void> {
    const st: State = { display: n, kind };
    let gpu: GPUDisplay | null = null;
    if (kind === GUIDisplay.Xwayland) {
      gpu = await this.gpuDisplay();
      if (!gpu) throw new Error('no Xwayland or no GPU that can be opened');
      st.bin = gpu.bin;
      st.node = gpu.node;
      if (gpu.minor !== undefined) st.minor = gpu.minor;
    } else {
      st.bin = await this.findXvfb();
      if (!st.bin) throw new Error('Xvfb is not installed');
    }
    const bin = st.bin;
    const name = posix.basename(bin);
    await this.newCookie(n);
    const rel = posix.relative(this.root(), bin);
    if (!rel.startsWith('..') && !posix.isAbsolute(rel)) {
      const now = new Date();
      await utimes(posix.join(this.root(), rel.split('/')[0]), now, now).catch(() => {}); // in use
    }
    const term = await this.terminateArgs(bin);
    // The check that it draws with the GPU is a client that leaves.
    if (gpu && !term.delay) throw new Error('this Xwayland exits with its first client (no -terminate delay)');
    const args = [`:${n}`, '-nolisten', 'tcp', '-auth', this.serverAuthPath()];
    if (gpu) args.push('-geometry', `${WIDTH}x${HEIGHT}`);
    else args.push('-screen', '0', `${WIDTH}x${HEIGHT}x24`);
    args.push(...term.args);
    const logPath = posix.join(this.o.host, gpu ? 'xwayland.log' : 'xvfb.log');
    const log = openSync(logPath, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_APPEND, 0o600);
    let env = this.o.environ();
    const stdio: Array<'ignore' | number> = ['ignore', log, log];
    let pair: [number, number] | null = null;
    try {
      if (gpu) {
        // The compositor and Xwayland talk over a socket pair: no Wayland
        // socket exists that another program could connect to. Each has
        // its end as file descriptor 3; both ends are close-on-exec here,
        // so no other program the node starts meanwhile inherits one.
        pair = socketPair();
        const compArgs = ['gui-wl', '--device', gpu.node, ...(gpu.nvidia ? ['--nvidia'] : [])];
        const comp = spawn(await this.o.helper(), compArgs, {
          env,
          cwd: this.o.home,
          detached: true,
          stdio: ['ignore', 'ignore', log, pair[0]],
        });
        comp.once('error', (e) => this.o.logger(`gui: the compositor did not start: ${e.message}`));
        // It ends when Xwayland does, also one that never starts: the other
        // end of the pair is then closed everywhere.
        comp.unref();
        env = { WAYLAND_SOCKET: '3', ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('WAYLAND_'))) };
        stdio.push(pair[1]);
      }
      // Its own session: it survives the agent and the ssh connection.
      const child = spawn(bin, args, { env, cwd: this.o.home, detached: true, stdio });
      const exited = new Promise<string>((res) => {
        child.once('error', (e) => res(e.message));
        child.once('exit', () => res(''));
      });
      child.unref();
      if (!child.pid) throw new Error(`${name}: ${await exited}`);
      st.pid = child.pid;
      await this.writeState(st);
      let gone = false;
      void exited.then(() => (gone = true));
      const deadline = Date.now() + 15_000;
      while (!(await this.running(n))) {
        if (gone) {
          const out = await readFile(logPath, 'utf8').catch(() => '');
          throw new Error(`${name} exited: ${lastN(out, 600)}`);
        }
        if (Date.now() > deadline) {
          // Not answering, or someone else answers on one of its sockets.
          child.kill('SIGKILL');
          throw new Error(`${name} did not take display :${n} within 15 s`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!gpu) {
        // -terminate counts from the last client leaving: one connection
        // arms it, so a display nobody attaches to still exits.
        if (term.delay) await this.probe(n).catch(() => {});
        return;
      }
      // Without DRI3 Xwayland draws on the CPU (its GPU did not work): Xvfb
      // does the same with less.
      const giveUp = async () => {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(t);
        await rm(this.xSocket(n), { force: true }).catch(() => {});
        await rm(this.xLock(n), { force: true }).catch(() => {});
      };
      let dri3 = false;
      try {
        dri3 = (await this.probe(n)).dri3;
      } catch (e) {
        await giveUp();
        throw new Error(lastLine((e as Error).message));
      }
      if (!dri3) {
        await giveUp();
        const out = await readFile(logPath, 'utf8').catch(() => '');
        throw new Error(`Xwayland does not draw with the GPU of ${gpu.node}: ${lastN(out, 600)}`);
      }
    } finally {
      closeSync(log);
      if (pair) {
        closeSync(pair[0]);
        closeSync(pair[1]);
      }
    }
  }

  /** VirtualGL found once per agent, with its EGL back end checked. */
  virtualGL(): Promise<VGL> {
    this.vgl ??= (async () => {
      const v: VGL = { run: '', preload: '', gpu: false };
      let runPath = await lookPath('vglrun', this.o.path);
      if (!runPath) {
        if (!(await isExecutable('/opt/VirtualGL/bin/vglrun'))) return v;
        runPath = '/opt/VirtualGL/bin/vglrun';
      }
      v.run = runPath;
      // vglrun preloads these by name; absolute paths keep working when
      // they are not on the loader's default path.
      const libs: string[] = [];
      for (const name of ['libdlfaker.so', 'libvglfaker.so'])
        for (const d of [
          '/usr/lib',
          '/usr/lib64',
          '/usr/lib/x86_64-linux-gnu',
          '/usr/lib/aarch64-linux-gnu',
          '/opt/VirtualGL/lib64',
          '/opt/VirtualGL/lib',
        ]) {
          const real = await rootOnly(posix.join(d, name));
          if (real) {
            libs.push(real);
            break;
          }
        }
      if (libs.length === 2) v.preload = libs.join(':');
      // VirtualGL's own eglinfo (not Mesa's), next to the real vglrun;
      // distributions link vglrun into /usr/bin.
      let eglinfo = '/opt/VirtualGL/bin/eglinfo';
      try {
        const real = await realpath(runPath);
        const next = posix.join(posix.dirname(real), 'eglinfo');
        if (await isExecutable(next)) eglinfo = next;
      } catch {
        // as is
      }
      if (await isExecutable(eglinfo)) v.gpu = (await run([eglinfo, 'egl0'], { env: this.o.environ(), timeoutMs: 10_000 })).code === 0;
      return v;
    })();
    return this.vgl;
  }

  /** The display's state as the hub sees it. */
  async status(): Promise<GUIStatus> {
    const isLinux = this.o.linux ?? linux;
    const st: GUIStatus = { supported: isLinux, running: false };
    if (!isLinux) return st;
    const out: GUIStatus = { supported: true } as GUIStatus;
    const xvfb = await this.findXvfb();
    if (xvfb) out.xvfb = xvfb;
    if (!xvfb && (await this.installable())) out.installable = true;
    let n: number;
    try {
      n = await this.locked(() => this.display());
    } catch (e) {
      out.running = false;
      await this.gpuFields(out);
      out.error = (e as Error).message;
      return out;
    }
    out.display = `:${n}`;
    out.xauthority = this.xauthPath();
    out.running = await this.running(n);
    if (out.running) {
      const cur = await this.readState();
      out.kind = kindOf(cur);
    }
    await this.gpuFields(out, n);
    return out;
  }

  /** The GPU members of a status, in the Go agent's order. */
  private async gpuFields(out: GUIStatus, n?: number): Promise<void> {
    const gpuDisplay = (await this.gpuDisplay()) !== null;
    if (gpuDisplay) out.gpu_display = true;
    const gpus = await nvidiaGPUs(this.o.gpu ?? GPU_PATHS);
    if (gpus.length) out.gpus = gpus;
    if (n !== undefined && out.running && out.kind === GUIDisplay.Xwayland) {
      const cur = await this.readState();
      if (cur.minor !== undefined) out.display_minor = cur.minor;
    }
    if (n === undefined) return;
    const pick = (await this.o.pickPath?.()) ?? '';
    if (pick) out.pick = pick;
    const v = await this.virtualGL();
    if (v.run) {
      out.vgl = v.run;
      if (v.gpu) out.gpu = true;
      if (v.preload) out.vgl_preload = v.preload;
    }
  }

  /** The processes among pids that are this user's: their executable's name
   * and whether they were started with display in their environment. */
  async shells(pids: readonly string[], display: string): Promise<GUIProc[]> {
    const out: GUIProc[] = [];
    for (const a of pids.slice(0, MAX_SHELLS)) {
      if (!/^\d+$/.test(a)) continue;
      const pid = Number(a);
      if (pid <= 1) continue;
      const dir = `/proc/${pid}`;
      let env: Buffer;
      try {
        env = await readFile(`${dir}/environ`);
      } catch {
        continue; // gone, or another user's
      }
      // Still in exec (the kernel sets the environment after the parent
      // sees it start), or started without any environment: unknown, so
      // the pane is left alone.
      if (env.length === 0) continue;
      const comm = (await readFile(`${dir}/comm`, 'utf8').catch(() => '')).trim();
      const p: GUIProc = { pid, comm };
      if (env.toString('latin1').split('\0').includes(`DISPLAY=${display}`)) p.display = true;
      out.push(p);
    }
    return out;
  }
}

/** For the keeper: the lock file is free (no keeper runs). */
export async function keeperFree(lockPath: string): Promise<boolean> {
  const f = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    if (!tryLock(f.fd)) return false;
    unlock(f.fd);
    return true;
  } finally {
    await f.close();
  }
}

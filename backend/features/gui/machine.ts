// Program windows' machine side (docs/features/14-gui-windows.md): the
// agent protocol's op gui, as the Go machine build serves it. The display
// (machine/display.ts), its GPU (gpu.ts), the GPU selection library
// (pick.ts), the video encoder (video.ts) and the routing of windows,
// frames and input between the cores and the display (wm.ts) are here; the
// X client that manages and captures the windows, the GPU display's
// Wayland compositor and the display keeper are the GUI helper, a native
// executable the machine build carries (machine/helper.ts,
// scripts/gui-helper).
//
// Actions (the header's action; every reply carries the display's status):
//
//   status, install (fetch Xvfb), start [kind], pick (the GPU selection
//   library), keep (the keeper), shells <pids> (which panes' shells have
//   the display), video <digest> and video-install <digest> (the encoder,
//   its gzip-compressed bytes in chunks after a first reply), attach (the
//   window stream: agentproto's GUI messages both ways until it ends).
import { closeSync, constants, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { NAME } from '#shared/lib/brand.ts';
import {
  ChunkReader,
  GUIDisplay,
  GUIMessage,
  Op,
  readGUI,
  writeGUI,
  writeLine,
  type GUICommand,
  type GUIStatus,
  type Header,
  type Reply,
} from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { defineMachine, type ActionContext, type MachineEnv } from '#machine/feature.ts';
import type { Conn } from '#machine/stream.ts';
import { Display, keeperFree, linux } from './machine/display.ts';
import { HelperFile, lastLine, messages, Out, pruneHelpers, startHelper, type Carried, type Proc } from './machine/helper.ts';
import { Pick } from './machine/pick.ts';
import { Video } from './machine/video.ts';
import { Client, WindowManager } from './machine/wm.ts';
import { guiProtocol } from './protocol.ts';

/** How long the window manager may take to come up. */
const WM_START_MS = 60_000;
/** A keeper that is about to leave is asked again after this. */
const KEEP_RETRY_MS = 6000;

export interface GUIMachineOptions {
  /** The GUI helper this build carries for its platform. */
  helper?: () => Promise<Carried | null>;
  /** The GPU selection library this build carries. */
  pick?: () => Promise<{ bytes: Uint8Array; digest: string } | null>;
  /** The video encoder this build carries (gzip-compressed). */
  encoder?: () => Promise<{ gz: Uint8Array; digest: string } | null>;
  /** Where X servers put their sockets (tests). */
  xTmp?: string;
  /** PATH to look programs up in (tests). */
  path?: string;
  /** Whether the machine is Linux (tests on other systems). */
  linux?: boolean;
  /** Starts the window manager's helper with args (tests give a fake). */
  startWM?: (args: string[]) => Proc;
}

interface Running {
  wm: WindowManager;
  proc: Proc;
  ready: Promise<void>;
}

/** Turns a command of a core into GUICommand, as Go's decoder takes it: a
 * member of the wrong type fails the command, unknown members are ignored. */
export function parseCommand(b: Buffer): GUICommand | null {
  let v: unknown;
  try {
    v = JSON.parse(b.toString('utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const c: GUICommand = { cmd: '', id: 0 };
  const int = (x: unknown, min: number, max: number) => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
  if (o.cmd !== undefined && o.cmd !== null) {
    if (typeof o.cmd !== 'string') return null;
    c.cmd = o.cmd;
  }
  for (const k of ['id', 'seq'] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!int(o[k], 0, 0xffffffff)) return null;
    c[k] = o[k] as number;
  }
  for (const k of ['x', 'y', 'button', 'keycode', 'dx', 'dy'] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!int(o[k], -(2 ** 53), 2 ** 53)) return null;
    c[k] = o[k] as number;
  }
  if (o.down !== undefined && o.down !== null) {
    if (typeof o.down !== 'boolean') return null;
    c.down = o.down;
  }
  if (o.codecs !== undefined && o.codecs !== null) {
    if (!Array.isArray(o.codecs) || !o.codecs.every((x) => typeof x === 'string')) return null;
    c.codecs = o.codecs as string[];
  }
  return c;
}

/** Program windows of one agent. */
export class GUI {
  readonly display: Display;
  readonly video: Video;
  readonly pick: Pick;
  private readonly helper: HelperFile;
  private running: Running | null = null;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly env: MachineEnv;
  private readonly o: GUIMachineOptions;

  constructor(env: MachineEnv, o: GUIMachineOptions = {}) {
    this.env = env;
    this.o = o;
    this.helper = new HelperFile(env.base, o.helper ?? (async () => null));
    this.pick = new Pick(env.home, env.environ, o.pick ?? (async () => null));
    this.video = new Video(env.home, env.environ, env.logger, o.encoder);
    this.display = new Display({
      home: env.home,
      host: env.host,
      run: env.run,
      hcSocket: env.hcSocket,
      environ: env.environ,
      logger: env.logger,
      helper: () => this.helper.path(),
      pickPath: () => this.pick.path(),
      xTmp: o.xTmp,
      path: o.path,
      linux: o.linux,
    });
  }

  /** Ends the window manager and the keeper's retry (the agent ends).
   * The display, its compositor and the keeper stay: they outlive the
   * agent, as programs on the display do. */
  close(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.endWM();
  }

  /** A newer node takes the node over: the window manager ends at once,
   * so that the next node's can take the display (one client may manage
   * it); the cores attach to that one. */
  handOver(): void {
    this.endWM();
  }

  private endWM(): void {
    const r = this.running;
    if (!r) return;
    this.running = null;
    r.wm.end();
    r.proc.end();
  }

  /** Serves one request of op gui. */
  async serve(conn: Conn, h: Header, ctx: ActionContext): Promise<void> {
    const st = conn.stream;
    const ok = async (gui?: GUIStatus) => writeLine(st, { ok: true, ...(gui ? { gui } : {}) } satisfies Reply);
    const fail = (e: unknown) => writeLine(st, { ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply);
    if (!(this.o.linux ?? linux) && h.action !== 'status') return fail(`gui: no virtual display on ${process.platform}`);
    try {
      switch (h.action) {
        case 'status':
          break;
        case 'install':
          await this.display.install(ctx.signal);
          break;
        case 'start':
          await this.display.start(h.args?.[0] ?? GUIDisplay.Auto);
          break;
        case 'pick':
          await this.pick.install();
          break;
        case 'shells': {
          const gs = await this.display.status();
          gs.procs = await this.display.shells(h.args ?? [], gs.display ?? '');
          if (!gs.procs.length) delete gs.procs;
          return ok(gs);
        }
        case 'video':
          return ok(await this.videoStatus(h.digest ?? ''));
        case 'video-install': {
          // The stream carries the gzip-compressed encoder (chunked).
          await ok();
          await this.video.install(h.digest ?? '', new ChunkReader(conn.reader));
          return ok(await this.videoStatus(h.digest ?? ''));
        }
        case 'keep':
          await this.keep();
          break;
        case 'attach':
          return await this.attach(conn, ctx);
        default:
          return fail(`gui: unknown action ${JSON.stringify(h.action ?? '')}`);
      }
    } catch (e) {
      return fail(e);
    }
    return ok(await this.display.status());
  }

  /** The display's status with whether the encoder of digest is installed
   * and which stream kinds it makes here. A core without an encoder for
   * this machine sends none: the encoder this build carries serves. */
  private async videoStatus(digest: string): Promise<GUIStatus> {
    const st = await this.display.status();
    let bin = await this.video.ready(digest);
    if (!bin && digest === '') {
      try {
        bin = await this.video.ready(await this.video.installCarried());
      } catch (e) {
        this.env.logger(`gui: video: ${(e as Error).message}`);
      }
    }
    if (bin) {
      st.video = true;
      const kinds = await this.video.kindsOf(bin);
      if (kinds.length) st.video_encoders = kinds;
    }
    return st;
  }

  // The keeper.

  /** Starts a keeper unless one runs or the display does not. A keeper may
   * be about to leave (the terminal core was gone for its grace) as the
   * request comes: then it is tried once more after KEEP_RETRY_MS. */
  async keep(): Promise<void> {
    if (await this.startKeeper()) return;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      this.startKeeper().catch((e) => this.env.logger(`gui: keeping the display: ${(e as Error).message}`));
    }, KEEP_RETRY_MS);
  }

  /** Starts a keeper unless one runs (false) or the display does not
   * (true: nothing to try again). */
  private async startKeeper(): Promise<boolean> {
    const d = this.display;
    const st = await d.readState();
    if (!st.display || !st.pid || !(await d.running(st.display))) return true;
    const lock = posix.join(this.env.run, 'gui-keep.lock');
    if (!(await keeperFree(lock))) return false; // one runs
    const bin = await this.helper.path();
    const log = openSync(posix.join(this.env.host, 'gui-keep.log'), constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC, 0o600);
    try {
      const args = ['gui-keep', '--socket', d.xSocket(st.display), '--pid', String(st.pid), '--xauth', await d.serverAuth()];
      args.push('--hc-socket', this.env.hcSocket, '--lock', lock, '--display', `:${st.display}`);
      // Its own session: it outlives the agent and the ssh connection.
      const child = spawn(bin, args, { env: this.env.environ(), cwd: this.env.home, detached: true, stdio: ['ignore', log, log] });
      child.once('error', (e) => this.env.logger(`gui: the keeper did not start: ${e.message}`));
      child.unref();
    } finally {
      closeSync(log);
    }
    return true;
  }

  // The window manager.

  /** The display's running window manager, starting one; it ends when its
   * last client leaves or the display goes away. */
  private async windowManager(n: number): Promise<WindowManager> {
    const r = this.running;
    if (r && !r.wm.ended) {
      await r.ready;
      if (!r.wm.ended) return r.wm;
    }
    const st = await this.display.readState();
    const args = ['gui-wm', '--socket', this.display.xSocket(n), '--pid', String(st.pid ?? 0), '--xauth', await this.display.serverAuth()];
    args.push('--hc-socket', this.env.hcSocket, '--name', NAME);
    const proc = this.o.startWM
      ? this.o.startWM(args)
      : startHelper(await this.helper.path(), args, { env: this.env.environ(), cwd: this.env.home, logger: this.env.logger });
    const wm = new WindowManager({
      send: (b) => {
        if (proc.child.stdin && !proc.child.stdin.destroyed) proc.child.stdin.write(b);
      },
      tools: () => this.video.tools(),
      logger: this.env.logger,
    });
    let ready!: () => void;
    const readyP = new Promise<void>((res) => (ready = res));
    void (async () => {
      try {
        for await (const m of messages(proc.reader)) {
          if (m.t === Out.Ready) ready();
          wm.onHelper(m);
        }
      } catch (e) {
        this.env.logger(`gui: window manager: ${(e as Error).message}`);
        proc.kill();
      }
      wm.end();
    })();
    void proc.exited.then(() => wm.end());
    const failed = proc.exited.then(() => {
      throw new Error(this.helperError(proc.stderr(), n));
    });
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('the window manager did not start')), WM_START_MS).unref?.(),
    );
    const entry: Running = { wm, proc, ready: Promise.race([readyP, failed, timeout]) };
    this.running = entry;
    try {
      await entry.ready;
    } catch (e) {
      proc.kill();
      wm.end();
      if (this.running === entry) this.running = null;
      throw e;
    }
    void wm.pump().catch((e) => this.env.logger(`gui: window manager: ${(e as Error).message}`));
    return wm;
  }

  /** The Go agent's words for why the window manager did not start. */
  private helperError(stderr: string, n: number): string {
    const l = lastLine(stderr);
    if (!l) return 'the window manager ended';
    return l.replace(/^display is not/, `display :${n} is not`);
  }

  /** Serves the stream as a client of the display's window manager, which
   * it starts when none runs, until the stream ends: the first core
   * controls the windows, the others view them. */
  private async attach(conn: Conn, ctx: ActionContext): Promise<void> {
    const st = conn.stream;
    let wm: WindowManager;
    try {
      const n = await this.display.locked(() => this.display.display());
      wm = await this.windowManager(n);
    } catch (e) {
      await writeLine(st, { ok: false, error: (e as Error).message } satisfies Reply);
      return;
    }
    await writeLine(st, { ok: true, gui: await this.display.status() } satisfies Reply);
    const client = new Client(ctx.session.id, ctx.client, {
      write: (m) => writeGUI(st, m.kind, ...m.parts),
      close: () => closeStream(st),
    });
    // A window manager that ended as the stream came ends the stream; the
    // core attaches again and starts the next one.
    const served = wm.attach(client);
    try {
      while (!client.closed) {
        const { kind, payload } = await readGUI(conn.reader);
        if (kind !== GUIMessage.JSON) continue;
        const cmd = parseCommand(payload);
        if (cmd) wm.command(client, cmd);
      }
    } catch {
      // the stream ended
    }
    client.close();
    await served;
    // The last client left: the window manager ends with its helper.
    if (wm.idle && this.running?.wm === wm) this.endWM();
  }

  /** The retention of what the feature put on the machine: the helpers of
   * other builds, and the downloads and installs that did not finish
   * (other Xvfb packages, encoders and libraries go when one is
   * installed, as with the Go agent). */
  async housekeep(now: Date): Promise<void> {
    const c = await this.o.helper?.().catch(() => null);
    await pruneHelpers(this.env.base, c ? c.digest.slice(0, 16) : '', now.getTime());
    await this.display.prune('', now.getTime(), true);
    await this.video.prune('', now.getTime(), true);
    await this.pick.prune('', now.getTime(), true);
  }
}

export function guiMachine(o: GUIMachineOptions = {}) {
  return defineMachine(guiProtocol, (env) => {
    const gui = new GUI(env, o);
    return {
      actions: {},
      ops: { [Op.GUI]: (conn, h, ctx) => gui.serve(conn, h, ctx) },
      housekeep: (now) => gui.housekeep(now),
      handOver: () => gui.handOver(),
      close: () => gui.close(),
    };
  });
}

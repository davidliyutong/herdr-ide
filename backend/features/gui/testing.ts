// Helpers of the feature's tests: the machine's side of op gui in memory
// (a fake agent's serve), whose display status, failures and attach
// streams a test controls, and the settings of the feature.
import { ChunkReader, GUIMessage, Op, readGUI, writeGUI, writeLine, marshalFrameHeader } from '#shared/proto/agentproto/index.ts';
import type { GUICommand, GUIFrameHeader, GUIStatus, Header, Reply } from '#shared/proto/agentproto/index.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { waitFor } from '#kernel/testing.ts';
import { settings } from './settings.ts';

/** The feature's settings in memory, with flags (by flag name). */
export const testSettings = (flags: Record<string, string> = {}) => new Settings('', { modules: [settings], flags });

/** The agent's side of one attach stream. */
export class AgentAttach {
  readonly commands: GUICommand[] = [];
  closed = false;
  private readonly conn: AgentStream;

  constructor(conn: AgentStream) {
    this.conn = conn;
  }

  /** Reads the core's commands until the core ends the stream. */
  async serve(): Promise<void> {
    try {
      for (;;) {
        const { kind, payload } = await readGUI(this.conn.reader);
        if (kind === GUIMessage.JSON) this.commands.push(JSON.parse(payload.toString('utf8')) as GUICommand);
      }
    } catch {
      // the end
    }
    this.closed = true;
    this.conn.reader.release();
    closeStream(this.conn.stream);
  }

  event(ev: object): Promise<void> {
    return writeGUI(this.conn.stream, GUIMessage.JSON, Buffer.from(JSON.stringify(ev)));
  }

  frame(h: GUIFrameHeader, data = Buffer.from('img')): Promise<void> {
    return writeGUI(this.conn.stream, GUIMessage.Frame, marshalFrameHeader(h), data);
  }

  /** Waits for the n-th command (from 0). */
  async command(n: number): Promise<GUICommand> {
    await waitFor(`command ${n}`, () => this.commands.length > n);
    return this.commands[n];
  }

  /** Ends the stream from the agent's side. */
  end(): void {
    this.conn.stream.end();
  }
}

/** The display of a fake machine: what op gui answers, and what it was
 * asked. */
export class FakeDisplay {
  status: GUIStatus;
  /** Each action asked, with its args or digest ("start auto"). */
  readonly actions: string[] = [];
  /** Actions that fail, with the error. */
  readonly failing = new Map<string, string>();
  readonly attaches: AgentAttach[] = [];
  /** What video-install received. */
  installed: Buffer | null = null;
  /** Whether the encoder is installed. */
  video = false;
  /** The processes action shells knows. */
  procs: Array<{ pid: number; comm: string; display?: boolean }> = [];

  constructor(status: Partial<GUIStatus> = {}) {
    this.status = { supported: true, running: false, xvfb: '/usr/bin/Xvfb', display: ':20', xauthority: '/h/xauth', ...status };
  }

  /** The fake agent's serve (FakeAgentOptions.serve). */
  readonly serve = async (h: Header, conn: AgentStream): Promise<void> => {
    if (h.op !== Op.GUI) {
      await writeLine(conn.stream, { ok: false, error: 'unsupported' } satisfies Reply);
      return this.done(conn);
    }
    const action = h.action ?? '';
    this.actions.push([action, ...(h.args ?? []), ...(h.digest ? [h.digest] : [])].join(' '));
    const fail = this.failing.get(action);
    if (fail !== undefined) {
      await writeLine(conn.stream, { ok: false, error: fail } satisfies Reply);
      return this.done(conn);
    }
    switch (action) {
      case 'start':
        this.status = { ...this.status, running: true, kind: h.args?.[0] === 'xvfb' || !this.status.gpu_display ? 'xvfb' : 'xwayland' };
        break;
      case 'install':
        this.status = { ...this.status, xvfb: '/h/xvfb/Xvfb' };
        break;
      case 'pick':
        this.status = { ...this.status, pick: '/h/gpupick.so' };
        break;
      case 'shells': {
        const pids = new Set((h.args ?? []).map(Number));
        await writeLine(conn.stream, {
          ok: true,
          gui: { ...this.status, procs: this.procs.filter((p) => pids.has(p.pid)) },
        } satisfies Reply);
        return this.done(conn);
      }
      case 'video':
        await writeLine(conn.stream, { ok: true, gui: { ...this.status, video: this.video || this.status.video } } satisfies Reply);
        return this.done(conn);
      case 'video-install': {
        await writeLine(conn.stream, { ok: true } satisfies Reply);
        const cr = new ChunkReader(conn.reader);
        const parts: Buffer[] = [];
        for (let b = await cr.read(); b; b = await cr.read()) parts.push(b);
        this.installed = Buffer.concat(parts);
        this.video = true;
        await writeLine(conn.stream, { ok: true, gui: { ...this.status, video: true, video_encoders: ['libvpx'] } } satisfies Reply);
        return this.done(conn);
      }
      case 'attach': {
        await writeLine(conn.stream, { ok: true, gui: this.status } satisfies Reply);
        const a = new AgentAttach(conn);
        this.attaches.push(a);
        // The window manager tells a new client its role.
        await a.event({ ev: 'role', control: true });
        return a.serve();
      }
    }
    await writeLine(conn.stream, { ok: true, gui: this.status } satisfies Reply);
    return this.done(conn);
  };

  private done(conn: AgentStream): void {
    conn.reader.release();
    closeStream(conn.stream);
  }

  /** How many times action was asked. */
  count(action: string): number {
    return this.actions.filter((a) => a === action || a.startsWith(action + ' ')).length;
  }

  /** The current attach stream, once there is one. */
  async attached(n = 0): Promise<AgentAttach> {
    await waitFor(`attach ${n}`, () => this.attaches.length > n);
    return this.attaches[n];
  }
}

// The machine's side of program windows, which the Go agent serves (op
// gui): the display's status and its preparation, the attach stream, the
// shells of panes, the video encoder. Tests stand in for it.
import { ChunkWriter, Op, readLine, type GUIProc, type GUIStatus, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { guiStatus } from './wire.ts';

export interface DisplayAgent {
  /** Runs an action (status, install, start, keep, pick) and returns the
   * display's status after it. */
  request(m: Machine, action: string, o: Bounds & { args?: string[] }): Promise<GUIStatus>;
  /** Attaches to the display's window manager: the status, and the stream
   * the window messages follow on. */
  attach(m: Machine, signal: AbortSignal): Promise<{ status?: GUIStatus; conn: AgentStream }>;
  /** Which of the processes pids exist, were started with the display, and
   * their executables' names (action shells). */
  shells(m: Machine, pids: string[], o: Bounds): Promise<GUIProc[]>;
  /** The status of the video encoder of digest (action video). */
  video(m: Machine, digest: string, o: Bounds): Promise<GUIStatus | undefined>;
  /** Installs the gzip-compressed encoder of digest (action video-install). */
  installVideo(m: Machine, digest: string, gz: Uint8Array, o: Bounds): Promise<GUIStatus | undefined>;
}

/** What ends a request: signal, and the longest its reply may take (as
 * the Go hub's context deadline did; the session's default without). */
export interface Bounds {
  signal: AbortSignal;
  timeoutMs?: number;
}

const header = (action: string, o: { args?: string[]; digest?: string } = {}): Header => ({
  op: Op.GUI,
  action,
  ...(o.args?.length ? { args: o.args } : {}),
  ...(o.digest ? { digest: o.digest } : {}),
});

/** The status a reply carries; undefined without one. */
function statusOf(rep: Reply): GUIStatus | undefined {
  if (rep.gui === undefined || rep.gui === null) return undefined;
  const r = guiStatus.safeParse(rep.gui);
  if (!r.success) throw new Error(`agent sent an invalid display status: ${r.error.issues[0]?.message ?? ''}`);
  return r.data;
}

function mustStatus(rep: Reply): GUIStatus {
  const st = statusOf(rep);
  if (!st) throw new Error('agent sent no display status');
  return st;
}

/** The agent over the machine's session. */
export const machineAgent: DisplayAgent = {
  async request(m, action, o) {
    return mustStatus(await m.request(header(action, { args: o.args }), { signal: o.signal, timeoutMs: o.timeoutMs }));
  },

  async attach(m, signal) {
    const { conn, reply } = await m.open(header('attach'), { signal });
    try {
      return { status: statusOf(reply), conn };
    } catch (e) {
      conn.reader.release();
      closeStream(conn.stream);
      throw e;
    }
  },

  async shells(m, pids, o) {
    const rep = await m.request(header('shells', { args: pids }), o);
    return statusOf(rep)?.procs ?? [];
  },

  async video(m, digest, o) {
    return statusOf(await m.request(header('video', { digest }), o));
  },

  async installVideo(m, digest, gz, { signal, timeoutMs }) {
    const { conn } = await m.open(header('video-install', { digest }), { signal, timeoutMs });
    // The reply after the upload comes when the encoder is installed:
    // within the same bounds.
    const stop = () => conn.stream.destroy(new Error('aborted'));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const cw = new ChunkWriter(conn.stream);
      await cw.write(gz);
      await cw.finish();
      const rep = await readLine<Reply>(conn.reader);
      if (!rep.ok) throw new Error(rep.error ?? 'video-install failed');
      return statusOf(rep);
    } finally {
      signal.removeEventListener('abort', stop);
      conn.reader.release();
      closeStream(conn.stream);
    }
  },
};

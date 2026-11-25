// GET /api/p/chat/hosts: every machine with its chat host, whether one runs
// and its agents' sessions, for the panel that shows them. It starts no
// host.
import * as chat from '#shared/proto/chatproto/index.ts';
import { asChatError } from './errors.ts';
import type { HostConn, Response } from './hostconn.ts';
import type { ChatSwitchboard } from './switchboard.ts';
import { NOT_RUNNING } from './protocol.ts';
import { ZERO_TIME } from './wire.ts';

/** One machine's chat host and its active sessions. */
export interface HostOverview {
  machine: string;
  label: string;
  machineStatus: string;
  running: boolean;
  /** running, stopped (no host serves), offline (the machine is not
   * connected) or error (error and message say why). */
  status: string;
  pid?: number;
  version?: string;
  proto?: number;
  terminalId?: string;
  startedAt?: string;
  socket?: string;
  base?: string;
  conns?: number;
  watchers?: number;
  liveAgents?: number;
  totalChats: number;
  totalBytes?: number;
  ending?: number;
  settings?: unknown;
  sessions: unknown[];
  error?: string;
  message?: string;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** o with the members Go leaves out when empty left out, in its order. */
function overview(o: HostOverview): HostOverview {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const always =
      k === 'machine' ||
      k === 'label' ||
      k === 'machineStatus' ||
      k === 'running' ||
      k === 'status' ||
      k === 'totalChats' ||
      k === 'sessions';
    if (always || (v !== undefined && v !== '' && v !== 0)) out[k] = v;
  }
  return out as unknown as HostOverview;
}

/** Every machine's chat host, as it is now; each asked within ms. */
export async function overviews(board: ChatSwitchboard, signal: AbortSignal, ms: number): Promise<HostOverview[]> {
  const states = board.o.machines.states();
  return Promise.all(
    states.map(async (st) => {
      const base: HostOverview = {
        machine: st.id,
        label: st.label,
        machineStatus: st.status,
        running: false,
        status: '',
        totalChats: board.watch.chatCount(st.id),
        sessions: [],
      };
      if (!board.isReady(st.id)) return overview({ ...base, status: 'offline' });
      return overview(await hostOverview(board, st.id, base, AbortSignal.any([signal, AbortSignal.timeout(ms)])));
    }),
  );
}

const failed = (base: HostOverview, e: unknown): HostOverview => {
  const pe = asChatError(e);
  if (pe.code === NOT_RUNNING) return { ...base, status: 'stopped' };
  return { ...base, status: 'error', error: pe.code, message: pe.message };
};

/** Asks one request of machine m's host without starting one. */
async function ask(
  board: ChatSwitchboard,
  m: string,
  req: chat.Request,
  signal: AbortSignal,
): Promise<{ info: chat.HostInfo; res: Response }> {
  const c: HostConn = await board.link.dial(m, { start: false, reserved: false, signal });
  try {
    return { info: c.info, res: await c.send(req) };
  } finally {
    c.close();
  }
}

async function hostOverview(board: ChatSwitchboard, m: string, base: HostOverview, signal: AbortSignal): Promise<HostOverview> {
  let err: unknown;
  try {
    const { res } = await ask(board, m, { op: chat.Op.HostStatus }, signal);
    const hs = res.hostStatus;
    if (hs) {
      const startedAt = str(hs.startedAt);
      return {
        ...base,
        running: true,
        status: 'running',
        pid: num(hs.pid),
        version: str(hs.version),
        proto: num(hs.proto),
        terminalId: str(hs.terminalId),
        startedAt: startedAt.startsWith('0001-01-01') ? '' : startedAt,
        socket: str(hs.socket),
        base: str(hs.base),
        conns: num(hs.conns),
        watchers: num(hs.watchers),
        liveAgents: num(hs.liveAgents),
        totalChats: num(hs.totalChats),
        totalBytes: num(hs.totalBytes),
        ending: num(hs.ending),
        settings: hs.settings ?? {},
        sessions: Array.isArray(hs.sessions) ? hs.sessions : [],
      };
    }
  } catch (e) {
    err = e;
    if (asChatError(e).code !== chat.Code.BadRequest) return failed(base, e);
  }
  if (err === undefined) return failed(base, new chat.ChatProtoError({ code: chat.Code.Failed, message: 'no host status' }));
  // An older chat host that does not know host_status: its chats and its
  // Hello.
  let listed: { info: chat.HostInfo; res: Response };
  try {
    listed = await ask(board, m, { op: chat.Op.Chats }, signal);
  } catch {
    return failed(base, err);
  }
  const chats = (listed.res.chats ?? []) as unknown as chat.Chat[];
  const live = chats.filter(
    (c) =>
      c.state === chat.State.Starting || c.state === chat.State.Idle || c.state === chat.State.Working || c.state === chat.State.Waiting,
  );
  return {
    ...base,
    running: true,
    status: 'running',
    pid: listed.info.pid,
    version: listed.info.version,
    proto: listed.info.proto,
    totalChats: chats.length,
    liveAgents: live.length,
    sessions: live.map((c) => ({
      chat: c.id,
      kind: c.kind,
      title: c.title,
      cwd: c.cwd,
      sessionId: c.sessionId,
      state: c.state,
      status: c.status,
      ...(c.state === chat.State.Starting ? { starting: true } : {}),
      updated: c.updated || ZERO_TIME,
      bytes: 0,
      ...(c.agentVersion ? { agentVersion: c.agentVersion } : {}),
    })),
  };
}

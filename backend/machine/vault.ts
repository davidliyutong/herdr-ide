// The variable vault's machine side: the MCP servers of the vault connect
// to <run>/vault.sock (0600, in the 0700 run directory, and only this
// user's processes), and each request is asked of every core of the
// agent's sessions over a stream with op vault, the process chain behind
// it in the header, as the kernel names it (the request's own claims about
// its client are not trusted). Values live in the cores' vaults, and the
// user may answer on any of them.
import { posix } from 'node:path';
import type { Socket } from 'node:net';
import { Reader } from '#shared/lib/streamio.ts';
import {
  MAX_VAULT_PROCESSES,
  Op,
  VaultTool,
  readLine,
  writeLine,
  type VaultProcess,
  type VaultRequest,
  type VaultResponse,
} from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import type { Agent, AgentSession } from './agent.ts';
import { serveSocket } from './sockets.ts';
import { parentOf, peerCred, socketFd } from './sys/proc.ts';

/** Bounds the MCP server connections relayed at once; more wait. */
const MAX_CONNS = 16;
/** How long a request waits for the MCP server's request, and each core
 * for its reply to the stream. */
const ASK_MS = 30_000;

/** The process pid (connected to vault.sock) and its parents, up to
 * MAX_VAULT_PROCESSES, as the kernel names them; it stops at init and at a
 * process that is gone. */
export function processChain(pid: number): VaultProcess[] {
  const chain: VaultProcess[] = [];
  while (pid > 1 && chain.length < MAX_VAULT_PROCESSES) {
    const p = parentOf(pid);
    if (!p) break;
    chain.push({ pid, name: p.name });
    if (p.ppid === pid) break;
    pid = p.ppid;
  }
  return chain;
}

/** Serves vault.sock until signal ends; the newest agent of the instance
 * serves it (sockets.ts). */
export function serveVault(
  agent: Agent,
  o: { signal: AbortSignal; everyMs?: number; peerCred?: (c: Socket) => { pid: number; uid: number } },
): Promise<void> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (active < MAX_CONNS) {
      active++;
      return;
    }
    await new Promise<void>((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return serveSocket(
    'vault',
    posix.join(agent.dirs.run, 'vault.sock'),
    (c: Socket) => {
      c.on('error', () => {});
      let cred: { pid: number; uid: number };
      try {
        cred = (o.peerCred ?? ((s: Socket) => peerCred(socketFd(s))))(c);
      } catch (e) {
        agent.logger(`vault: refused a connection (${(e as Error).message})`);
        c.destroy();
        return;
      }
      if (cred.uid !== process.getuid!()) {
        agent.logger(`vault: refused a connection from uid ${cred.uid}`);
        c.destroy();
        return;
      }
      void (async () => {
        await slot();
        try {
          await relayVault(agent.liveSessions(), c, processChain(cred.pid), agent.signal);
        } finally {
          release();
        }
      })();
    },
    { signal: o.signal, logger: agent.logger, everyMs: o.everyMs },
  );
}

/** Asks every session's core for one MCP server request (once it sent it,
 * within ASK_MS). The first core that grants get or env answers, and the
 * other cores' streams close, which withdraws their questions; list
 * answers with every core's variables. The request fails only when every
 * core refused it, with the most telling refusal. The MCP server going
 * away ends every question. */
export async function relayVault(sessions: AgentSession[], c: Socket, chain: VaultProcess[], signal: AbortSignal): Promise<void> {
  const reader = new Reader(c);
  const answer = (r: VaultResponse) => writeLine(c, r).catch(() => {});
  try {
    const t = setTimeout(() => c.destroy(), ASK_MS);
    let line: string;
    try {
      line = await reader.line(1 << 20);
    } catch {
      return;
    } finally {
      clearTimeout(t);
    }
    let raw: unknown;
    let req: VaultRequest;
    try {
      raw = JSON.parse(line);
      req = raw as VaultRequest;
      if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('not an object');
    } catch {
      return void (await answer({ ok: false, code: 'bad_request', error: 'not a request' }));
    }
    if (sessions.length === 0) return void (await answer({ ok: false, code: 'unavailable', error: 'no core is connected' }));
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal.addEventListener('abort', stop, { once: true });
    // The MCP server sends nothing more: its leaving is the end.
    const rest = reader.release();
    rest.on('end', stop).on('close', stop).on('error', stop);
    rest.resume();
    try {
      const refusals: VaultResponse[] = [];
      let list: VaultResponse | null = null;
      const pending = sessions.map((s) => askVault(s, chain, raw, ac.signal));
      const settled = new Set<number>();
      while (settled.size < pending.length) {
        const [i, resp] = await Promise.race(
          pending.map((p, i) => (settled.has(i) ? new Promise<never>(() => {}) : p.then((r) => [i, r] as const))),
        );
        settled.add(i);
        if (!resp.ok) refusals.push(resp);
        else if (req.tool === VaultTool.List) list = mergeLists(list, resp);
        else {
          ac.abort();
          return void (await answer(resp));
        }
      }
      await answer(list ?? vaultRefusal(refusals));
    } finally {
      ac.abort();
      signal.removeEventListener('abort', stop);
    }
  } finally {
    c.end();
  }
}

/** Asks the core of session s for one request: a refusal when the core does
 * not take the stream (its vault feature is off) or goes away. */
async function askVault(s: AgentSession, chain: VaultProcess[], raw: unknown, signal: AbortSignal): Promise<VaultResponse> {
  const gone: VaultResponse = { ok: false, code: 'unavailable', error: 'the core went away' };
  let conn;
  try {
    const r = await s.ask({ op: Op.Vault, process: chain }, ASK_MS, signal);
    conn = r.conn;
    if (!r.reply.ok) return { ok: false, code: r.reply.code || 'unavailable', error: r.reply.error };
  } catch {
    return gone;
  }
  const st = conn.stream;
  const end = () => st.destroy();
  signal.addEventListener('abort', end, { once: true });
  try {
    await writeLine(st, raw);
    // The core bounds the wait for the user's answer itself.
    return await readLine<VaultResponse>(conn.reader);
  } catch {
    return gone;
  } finally {
    signal.removeEventListener('abort', end);
    conn.reader.release();
    closeStream(st);
  }
}

/** list's variables with resp's: a name listed by several cores is listed
 * once, as the first answer had it. */
export function mergeLists(list: VaultResponse | null, resp: VaultResponse): VaultResponse {
  if (!list) return { ...resp, variables: [...(resp.variables ?? [])] };
  const have = new Set((list.variables ?? []).map((v) => v.name));
  for (const v of resp.variables ?? [])
    if (!have.has(v.name)) {
      (list.variables ??= []).push(v);
      have.add(v.name);
    }
  return list;
}

/** Refusals ranked: the user's own answer first, then what the user can
 * change, then what the request got wrong, then a core that could not
 * answer. */
const REFUSAL_ORDER = ['denied', 'vault_locked', 'inject_only', 'not_found', 'busy', 'bad_request'];

/** The refusal of a request every core refused. */
export function vaultRefusal(refusals: VaultResponse[]): VaultResponse {
  const rank = (code?: string) => {
    const i = REFUSAL_ORDER.indexOf(code ?? '');
    return i >= 0 ? i : REFUSAL_ORDER.length;
  };
  let best: VaultResponse = { ok: false, code: 'unavailable', error: 'no core answered' };
  refusals.forEach((r, i) => {
    if (i === 0 || rank(r.code) < rank(best.code)) best = r;
  });
  return best;
}

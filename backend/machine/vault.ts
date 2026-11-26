// The variable vault's machine side: the MCP servers of the vault connect
// to <run>/vault.sock (0600, in the 0700 run directory, and only this
// user's processes), and each request is asked of every hub of the
// agent's sessions over a stream with op vault, the process chain behind
// it in the header, as the kernel names it (the request's own claims about
// its client are not trusted). Values live in the hubs' vaults, and the
// user may answer on any of them.
//
// The vault's MCP server (the mcp command) is started by the coding agents'
// CLIs under a stable path their configurations name, which outlives
// upgrades: <data dir>/bin/<slug>-mcp, a script running the link of the
// host's system and architecture beside it, which the agent points at its
// own executable when it starts (linkMCP), as the Go agent does.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { machine, type } from 'node:os';
import { posix } from 'node:path';
import type { Socket } from 'node:net';
import { SLUG, dataDir } from '#shared/lib/brand.ts';
import { runDir } from '#shared/host/hostdirs.ts';
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
/** How long a request waits for the MCP server's request, and each hub
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

/** Asks every session's hub for one MCP server request (once it sent it,
 * within ASK_MS). The first hub that grants get or env answers, and the
 * other hubs' streams close, which withdraws their questions; list
 * answers with every hub's variables. The request fails only when every
 * hub refused it, with the most telling refusal. The MCP server going
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
    if (sessions.length === 0) return void (await answer({ ok: false, code: 'unavailable', error: 'no hub is connected' }));
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

/** Asks the hub of session s for one request: a refusal when the hub does
 * not take the stream (its vault feature is off) or goes away. */
async function askVault(s: AgentSession, chain: VaultProcess[], raw: unknown, signal: AbortSignal): Promise<VaultResponse> {
  const gone: VaultResponse = { ok: false, code: 'unavailable', error: 'the hub went away' };
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
    // The hub bounds the wait for the user's answer itself.
    return await readLine<VaultResponse>(conn.reader);
  } catch {
    return gone;
  } finally {
    signal.removeEventListener('abort', end);
    conn.reader.release();
    closeStream(st);
  }
}

/** list's variables with resp's: a name listed by several hubs is listed
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
 * change, then what the request got wrong, then a hub that could not
 * answer. */
const REFUSAL_ORDER = ['denied', 'vault_locked', 'inject_only', 'not_found', 'busy', 'bad_request'];

/** The refusal of a request every hub refused. */
export function vaultRefusal(refusals: VaultResponse[]): VaultResponse {
  const rank = (code?: string) => {
    const i = REFUSAL_ORDER.indexOf(code ?? '');
    return i >= 0 ? i : REFUSAL_ORDER.length;
  };
  let best: VaultResponse = { ok: false, code: 'unavailable', error: 'no hub answered' };
  refusals.forEach((r, i) => {
    if (i === 0 || rank(r.code) < rank(best.code)) best = r;
  });
  return best;
}

/** The stable command's name in <data dir>/bin, which MCP configurations
 * name. */
export const MCP_LINK_NAME = `${SLUG}-mcp`;

/** The name of the link to the executable of a system and architecture
 * (uname -s, uname -m) beside the stable command: a home that hosts of
 * several architectures share has a link for each. */
export const platformLink = (system: string, arch: string): string => `${MCP_LINK_NAME}-${system}-${arch}`;

/** The stable command, a POSIX shell script that runs this host's
 * platformLink; the Go agent writes the same bytes. */
export const MCP_LINK_SCRIPT = `#!/bin/sh
# The variable vault's MCP server: the agent of this host's system and
# architecture, linked beside this script.
exec "$(dirname "$0")/${MCP_LINK_NAME}-$(uname -s)-$(uname -m)" "$@"
`;

/** Whether the executable was started by the stable command's name or a
 * platform's link, which run the mcp command. */
export function isMcpLink(argv0: string): boolean {
  const b = posix.basename(argv0);
  return b === MCP_LINK_NAME || b.startsWith(MCP_LINK_NAME + '-');
}

/** The vault socket of the agent whose data directory holds the command at
 * argv0 (started as <data dir>/bin/<slug>-mcp or a platform's link beside
 * it), else of the instance's data directory in home: in that data
 * directory's runtime directory on this host (runDir). */
export function mcpSocketPath(argv0: string, home: string, instance: string): string {
  if (isMcpLink(argv0) && posix.isAbsolute(argv0) && posix.dirname(argv0) !== '.')
    return posix.join(runDir(posix.dirname(posix.dirname(argv0))), 'vault.sock');
  return posix.join(runDir(posix.join(home, dataDir(instance))), 'vault.sock');
}

/** Makes dir/<slug>-mcp the script that runs this host's platform link
 * (MCP_LINK_SCRIPT), and that link, beside it, a link to exe; each
 * replaced atomically (a file beside it renamed into place). */
export async function linkMCP(dir: string, exe: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.startsWith(MCP_LINK_NAME) || !/\.\d+\.[0-9a-f-]{36}\.new$/.test(name)) continue;
    const p = posix.join(dir, name);
    const st = await lstat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) await rm(p, { force: true }).catch(() => {});
  }
  const link = posix.join(dir, platformLink(type(), machine()));
  const cur = await readlink(link).catch(() => null);
  if (cur !== exe) {
    const tmp = `${link}.${process.pid}.${randomUUID()}.new`;
    try {
      await symlink(exe, tmp);
      await rename(tmp, link);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  const script = posix.join(dir, MCP_LINK_NAME);
  const st = await lstat(script).catch(() => null);
  if (st?.isFile() && (await readFile(script, 'utf8').catch(() => '')) === MCP_LINK_SCRIPT) return;
  const tmp = `${script}.${process.pid}.${randomUUID()}.new`;
  try {
    await writeFile(tmp, MCP_LINK_SCRIPT, { mode: 0o700, flag: 'wx' });
    await rename(tmp, script);
  } finally {
    await rm(tmp, { force: true });
  }
}

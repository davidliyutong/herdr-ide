// Ephemeral terminal environment staging on the machine's node: secrets
// injected into a new terminal live only in memory here (bounded count and
// short TTL, wiped on first read, drop or agent exit) and are retrieved once
// over <run>/env.sock (0600, same-UID peer check) by the `term-env` helper
// before it execve's the target shell or command in place. Nothing enters
// terminal.run.env or herdr-core's persisted terminals.json, and kept-terminal
// recovery never receives the secret values again.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import type { Socket } from 'node:net';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fail } from '#shared/lib/fail.ts';
import { Reader } from '#shared/lib/streamio.ts';
import {
  readBody,
  readLine,
  writeLine,
  type Header,
  type Reply,
  type TermEnvStageParams,
  type TermEnvStaged,
} from '#shared/proto/agentproto/index.ts';
import type { Agent } from './agent.ts';
import { compiled, selfCommand } from './self.ts';
import { inode, serveSocket } from './sockets.ts';
import type { Conn } from './stream.ts';
import { peerCred, socketFd } from './sys/proc.ts';

export const TERM_ENV_SOCK = 'env.sock';
export const TERM_ENV_CMD = 'term-env';
export const MAX_STAGED_ENVS = 256;
export const STAGE_TTL_MS = 30_000;
const MAX_CONNS = 32;
const TAKE_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 5000;

export interface TermEnvReply {
  ok: boolean;
  env?: Record<string, string>;
  argv?: string[];
  line?: string;
}

interface Entry {
  data: TermEnvStageParams;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const validEnvKey = (k: string): boolean => k.length > 0 && !k.includes('=') && !k.includes('\0');

export function validStageParams(v: unknown): v is TermEnvStageParams {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env)) return false;
  for (const [k, val] of Object.entries(r.env as Record<string, unknown>)) {
    if (!validEnvKey(k) || typeof val !== 'string' || val.includes('\0')) return false;
  }
  if (r.argv !== undefined) {
    if (!Array.isArray(r.argv) || !r.argv.every((a) => typeof a === 'string' && !a.includes('\0'))) return false;
    if (r.argv.length > 0 && r.argv[0] === '') return false;
  }
  if (r.line !== undefined && (typeof r.line !== 'string' || r.line.includes('\0'))) return false;
  if (r.argv && r.argv.length > 0 && r.line !== undefined) return false;
  return true;
}

function launchPrefix(): string[] {
  if (compiled()) return selfCommand();
  return [process.execPath, fileURLToPath(new URL('../hosts/bun/main.ts', import.meta.url))];
}

function wipeEnv(env: Record<string, string>): void {
  for (const k of Object.keys(env)) env[k] = '';
}

export class TermEnvStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private listening = false;
  /** Bound socket path and its inode so staging detects node takeover
   * immediately instead of issuing tokens for an env.sock owned by another node. */
  private sockPath?: string;
  private sockIno: bigint | null = null;
  private waiters: Array<() => void> = [];

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? STAGE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? MAX_STAGED_ENVS;
  }

  markReady(sockPath?: string): void {
    this.sockPath = sockPath;
    this.sockIno = sockPath ? inode(sockPath) : null;
    this.listening = true;
    for (const w of this.waiters.splice(0)) w();
  }

  markNotReady(): void {
    this.listening = false;
  }

  /** Whether this store currently owns the bound env.sock. If another node
   * replaced the socket path, marks the store not-ready and returns false. */
  ownsSocket(): boolean {
    if (!this.listening) return false;
    if (this.sockPath !== undefined) {
      const cur = inode(this.sockPath);
      if (cur === null || cur !== this.sockIno) {
        this.listening = false;
        return false;
      }
    }
    return true;
  }

  /** True after env.sock was previously bound by this node and later taken
   * over or removed, so staging fails over immediately instead of waiting. */
  lostOwnership(): boolean {
    return this.sockPath !== undefined && !this.ownsSocket();
  }

  waitReady(signal?: AbortSignal, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.ownsSocket()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const wake = () => done();
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        if (err) reject(err);
        else resolve();
      };
      const t = setTimeout(() => done(new Error('env.sock did not start in time')), timeoutMs);
      const onAbort = () => done(new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wake);
    });
  }

  /** Pending waitReady callers (tests). */
  get waiterCount(): number {
    return this.waiters.length;
  }

  stage(data: TermEnvStageParams): TermEnvStaged {
    if (this.sockPath !== undefined && !this.ownsSocket()) throw new Fail('unavailable', 503, 'term-env socket taken over');
    const now = Date.now();
    for (const [tok, e] of this.entries) if (now >= e.expiresAt) this.drop(tok);
    if (this.entries.size >= this.maxEntries) throw new Fail('busy', 429, 'too many pending terminal launches');
    const token = randomBytes(24).toString('hex');
    const copy: TermEnvStageParams = {
      env: { ...data.env },
      ...(data.argv?.length ? { argv: [...data.argv] } : {}),
      ...(data.line !== undefined ? { line: data.line } : {}),
    };
    const timer = setTimeout(() => this.drop(token), this.ttlMs);
    timer.unref?.();
    this.entries.set(token, { data: copy, expiresAt: now + this.ttlMs, timer });
    return {
      token,
      launch: [...launchPrefix(), TERM_ENV_CMD, token, ...(copy.argv ?? [])],
    };
  }

  /** Consumes token at most once; null when unknown or expired. */
  take(token: string): TermEnvStageParams | null {
    const e = this.entries.get(token);
    if (!e) return null;
    this.entries.delete(token);
    clearTimeout(e.timer);
    if (Date.now() >= e.expiresAt) {
      wipeEnv(e.data.env);
      return null;
    }
    return e.data;
  }

  drop(token: string): void {
    const e = this.entries.get(token);
    if (!e) return;
    this.entries.delete(token);
    clearTimeout(e.timer);
    wipeEnv(e.data.env);
  }

  clear(): void {
    for (const tok of [...this.entries.keys()]) this.drop(tok);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Serves <run>/env.sock until signal ends. */
export function serveTermEnv(
  agent: Pick<Agent, 'dirs' | 'logger'>,
  store: TermEnvStore,
  o: { signal: AbortSignal; everyMs?: number; peerCred?: (c: Socket) => { pid: number; uid: number } },
): Promise<void> {
  if (!existsSync(agent.dirs.run)) mkdirSync(agent.dirs.run, { recursive: true, mode: 0o700 });
  const sockPath = posix.join(agent.dirs.run, TERM_ENV_SOCK);
  let active = 0;
  return serveSocket(
    'term-env',
    sockPath,
    (c: Socket) => {
      c.on('error', () => {});
      if (active >= MAX_CONNS) {
        c.destroy();
        return;
      }
      let cred: { pid: number; uid: number };
      try {
        cred = (o.peerCred ?? ((s: Socket) => peerCred(socketFd(s))))(c);
      } catch (e) {
        agent.logger(`term-env: refused a connection (${(e as Error).message})`);
        c.destroy();
        return;
      }
      if (cred.uid !== process.getuid!()) {
        agent.logger(`term-env: refused a connection from uid ${cred.uid}`);
        c.destroy();
        return;
      }
      active++;
      void (async () => {
        const timer = setTimeout(() => c.destroy(), TAKE_TIMEOUT_MS);
        try {
          const req = await readLine<{ token?: unknown }>(new Reader(c));
          const token = typeof req?.token === 'string' ? req.token : '';
          const taken = /^[0-9a-f]{48}$/.test(token) ? store.take(token) : null;
          if (!taken) {
            await writeLine(c, { ok: false } satisfies TermEnvReply);
            return;
          }
          try {
            await writeLine(c, {
              ok: true,
              env: taken.env,
              ...(taken.argv?.length ? { argv: taken.argv } : {}),
              ...(taken.line !== undefined ? { line: taken.line } : {}),
            } satisfies TermEnvReply);
          } finally {
            wipeEnv(taken.env);
          }
        } catch {
          // client disconnected or timed out
        } finally {
          clearTimeout(timer);
          active--;
          c.end();
        }
      })();
    },
    { signal: o.signal, logger: agent.logger, everyMs: o.everyMs, listening: () => store.markReady(sockPath) },
  ).finally(() => store.markNotReady());
}

/** Handles Op.TermEnv on a hub stream. */
export async function serveTermEnvOp(conn: Conn, h: Header, store: TermEnvStore, signal: AbortSignal): Promise<void> {
  let raw: unknown = h.params;
  if (h.params_length && h.params_length > 0) raw = await readBody(conn.reader, h.params_length);
  if (h.action === 'stage') {
    if (!validStageParams(raw)) {
      await writeLine(conn.stream, { ok: false, code: 'bad_params', error: 'invalid term.env stage params' } satisfies Reply);
      return;
    }
    if (store.lostOwnership()) {
      await writeLine(conn.stream, { ok: false, code: 'unavailable', error: 'term-env socket taken over' } satisfies Reply);
      return;
    }
    await store.waitReady(signal);
    const termenv = store.stage(raw);
    await writeLine(conn.stream, { ok: true, termenv } satisfies Reply);
    return;
  }
  if (h.action === 'drop') {
    const token = raw && typeof raw === 'object' ? (raw as { token?: unknown }).token : undefined;
    if (typeof token === 'string' && token) store.drop(token);
    await writeLine(conn.stream, { ok: true } satisfies Reply);
    return;
  }
  await writeLine(conn.stream, {
    ok: false,
    code: 'bad_params',
    error: `unknown term.env action ${JSON.stringify(h.action)}`,
  } satisfies Reply);
}

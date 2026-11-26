// The chat host's adapter of Claude Code (the kinds whose chat spec names
// the adapter claude), on Anthropic's Agent SDK, which it loads at run time
// from the machine's data directory (load.ts): each session is a query()
// of the user's own claude (pathToClaudeCodeExecutable, the host's command)
// with the SDK's arguments, started through the host's AgentProcesses
// (session.ts, sdk.ts). Sessions and imports read Claude Code's
// transcripts (history.ts); a session another Claude Code runs (a
// terminal's, by its record <claude dir>/sessions/<pid>.json) is neither
// resumed nor imported.
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { discard } from '#shared/lib/log.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';
import { Resolver } from '#machine/agents/sessions.ts';
import type {
  Adapter,
  ForkParams,
  ForkResult,
  HistoryParams,
  ModelsParams,
  Session,
  SessionsParams,
  Sink,
  StartParams,
} from '../adapter.ts';
import { EFFORTS, EFFORT_DEFAULT, MODEL_ID } from './config.ts';
import { badRequest } from './content.ts';
import { historyOf, sessionsOf } from './history.ts';
import type { SdkSource } from './load.ts';
import { CLAUDE_TIMING, ClaudeSession, probeModels, type ClaudeTiming } from './session.ts';

export { CLAUDE_TIMING, type ClaudeTiming } from './session.ts';

export interface ClaudeAdapterOptions {
  /** Where the Agent SDK comes from: the machine's data directory
   * (load.ts installedSdk); tests give the development dependency. */
  sdk: SdkSource;
  timing?: Partial<ClaudeTiming>;
  /** The most sessions a page of sessions lists (tests make pages short). */
  sessionsPage?: number;
}

/** The sessions of the agent's user, in the home and with the
 * CLAUDE_CONFIG_DIR of the agent's environment. */
const resolverOf = (env: Record<string, string>): Resolver => new Resolver({ home: env.HOME ?? '', getenv: (k) => env[k] });

/** Serializes temporary process.env.CLAUDE_CONFIG_DIR swaps when invoking
 * filesystem SDK helpers (forkSession) so concurrent calls never clobber one
 * another's config directory. */
let envLock: Promise<void> = Promise.resolve();

async function withClaudeEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = envLock;
  envLock = new Promise<void>((r) => (release = r));
  await prev;
  const hadConfig = 'CLAUDE_CONFIG_DIR' in process.env;
  const savedConfig = process.env.CLAUDE_CONFIG_DIR;
  const target = env.CLAUDE_CONFIG_DIR || (env.HOME ? posix.join(env.HOME, '.claude') : '');
  try {
    if (target !== '') process.env.CLAUDE_CONFIG_DIR = target;
    return await fn();
  } finally {
    if (hadConfig) process.env.CLAUDE_CONFIG_DIR = savedConfig;
    else delete process.env.CLAUDE_CONFIG_DIR;
    release();
  }
}

/** Claude Code's adapter. */
export function claudeAdapter(o: ClaudeAdapterOptions): Adapter {
  const t: ClaudeTiming = { ...CLAUDE_TIMING, ...o.timing };
  const page = o.sessionsPage ?? 50;
  /** The programs this adapter runs: their records of the sessions they run
   * are the host's own, not a terminal's. */
  const own = new Set<number>();
  /** Live sessions managed by this adapter, reused for supportedModels(). */
  const live = new Set<ClaudeSession>();

  /** The in_terminal error of a session another Claude Code than the
   * host's own runs: one whose record names it, of a process that runs and
   * started when the record says. */
  async function inTerminal(env: Record<string, string>, id: string, signal: AbortSignal): Promise<chat.ChatError | null> {
    if (!validSessionId(id)) return null;
    const pid = await resolverOf(env).claudeRunning(id, (pid) => own.has(pid), signal);
    if (pid === null) return null;
    return { code: Code.InTerminal, message: `claude: the session runs in another Claude Code (process ${pid})` };
  }

  return {
    async start(p: StartParams, sink: Sink, signal: AbortSignal): Promise<Session> {
      const id = p.resume !== '' ? p.resume : p.sessionId;
      const { mode, model, effort } = p.options;
      if (p.argv.length === 0 || !p.argv[0]!.startsWith('/')) throw badRequest('the program is not an absolute path');
      if (!p.cwd.startsWith('/')) throw badRequest('the directory is not an absolute path');
      if (!validSessionId(id)) throw badRequest('not a session id');
      if (mode && !(chat.MODES as readonly string[]).includes(mode)) throw badRequest('unknown mode');
      if (model && !MODEL_ID.test(model)) throw badRequest('not a model');
      if (effort && effort !== EFFORT_DEFAULT && !(EFFORTS as readonly string[]).includes(effort)) throw badRequest('unknown effort');
      if (p.resume !== '') {
        // Two programs do not write one session.
        const e = await inTerminal(p.env, p.resume, signal);
        if (e) throw new ChatProtoError(e);
      }
      // The SDK is loaded once a chat needs it, and the host goes on without
      // it (sdk_unavailable for the chat).
      const sdk = await o.sdk.load();
      const s = new ClaudeSession({ ...p, logger: p.logger ?? discard }, sink, id, t, own, sdk);
      await s.begin(signal);
      live.add(s);
      void s.done.then(() => live.delete(s));
      return s;
    },

    sessions(p: SessionsParams, signal: AbortSignal) {
      return sessionsOf(resolverOf(p.env), p.cwd, p.cursor, page, signal);
    },

    history(p: HistoryParams, emit, signal: AbortSignal) {
      return historyOf(resolverOf(p.env), p, emit, signal);
    },

    async inTerminal(p: HistoryParams, signal: AbortSignal) {
      return inTerminal(p.env, p.sessionId, signal);
    },

    async models(p: ModelsParams, signal: AbortSignal): Promise<chat.ModelOption[]> {
      if (p.argv.length === 0 || !p.argv[0]!.startsWith('/')) throw badRequest('the program is not an absolute path');
      if (!p.cwd.startsWith('/')) throw badRequest('the directory is not an absolute path');
      signal.throwIfAborted();
      for (const s of live) {
        if (!s.canQuery()) continue;
        try {
          return await s.supportedModels(signal);
        } catch (e) {
          if (signal.aborted) throw e;
        }
      }
      const sdk = await o.sdk.load();
      return probeModels(sdk, { ...p, logger: p.logger ?? discard }, t, own, signal);
    },

    async fork(p: ForkParams, signal: AbortSignal): Promise<ForkResult> {
      if (!p.cwd.startsWith('/')) throw badRequest('the directory is not an absolute path');
      if (!validSessionId(p.sessionId)) throw badRequest('not a session id');
      signal.throwIfAborted();
      const sdk = await o.sdk.load();
      if (typeof sdk.forkSession !== 'function')
        throw new ChatProtoError({ code: Code.Unsupported, message: 'claude: the SDK does not support forkSession' });
      try {
        const res = await withClaudeEnv(p.env, () =>
          sdk.forkSession(p.sessionId, {
            dir: p.cwd,
            ...(p.upToMessageId ? { upToMessageId: p.upToMessageId } : {}),
            ...(p.title ? { title: p.title } : {}),
          }),
        );
        if (!res?.sessionId || !validSessionId(res.sessionId))
          throw new ChatProtoError({ code: Code.Failed, message: 'claude: forkSession returned no session id' });
        return { sessionId: res.sessionId };
      } catch (e) {
        if (e instanceof ChatProtoError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        const low = msg.toLowerCase();
        if (low.includes('not found') || low.includes('no messages to fork'))
          throw new ChatProtoError({ code: Code.NotFound, message: 'claude: ' + msg });
        if (low.includes('invalid sessionid')) throw badRequest(msg);
        throw new ChatProtoError({ code: Code.Failed, message: 'claude: ' + msg });
      }
    },
  };
}

// The AI usage feature's machine side (docs/features/29-ai-usage.md): the
// machine reads the subscriptions its CLIs are signed in to and its logs'
// cost, and answers with numbers only. Actions:
//
//   - limits {providers, codexHomes, claudeKeychain, skip, skipLocal,
//     kimiRefresh}: the accounts with their windows, credits and balances
//     (machine/limits.ts), the providers asked in parallel within
//     limitsMs; an ended Kimi Code token renewed first with kimiRefresh
//     (machine/kimi.ts). Another hub's same request through the same node
//     within limitsShareMs gets the same answer: the hubs of a machine ask
//     the providers about once between them;
//   - cost {since, tzOffset, codexHomes, providers, prices, recentSince,
//     ifNoneMatch}: the logs' tokens and cost (machine/scan.ts), within
//     costMs; the user's prices only as usage.prices can hold them;
//   - setDeepseekKey {key}: writes (or with "" removes) the DeepSeek key
//     file; the key is never read back;
//   - session {kind, session, prices}: what one session of a coding agent
//     used (machine/session.ts), from the transcripts the locator finds
//     (the agents feature's, given by the host), within sessionMs.
//
// Credentials stay on the machine: no reply, log or error carries one, and
// errors name no path.
import { Fail } from '#shared/lib/fail.ts';
import { byId, validSessionId } from '#shared/agents/kinds.ts';
import { defineMachine, type MachineEnv } from '#machine/feature.ts';
import { DB_LIMITS, type DBLimits } from './machine/databases.ts';
import {
  DEFAULT_PROGRAMS,
  DEFAULT_URLS,
  Memo,
  USAGE_TIMING,
  type Account,
  type Programs,
  type UsageEnv,
  type UsageTiming,
  type Urls,
} from './machine/env.ts';
import { BadKey, limits, setDeepseekKey } from './machine/limits.ts';
import { validPrices } from './machine/pricing.ts';
import { CacheWorker } from './machine/cache-worker.ts';
import { CostScanner } from './machine/scan.ts';
import { Resolver } from '#machine/agents/sessions.ts';
import {
  CWD_START_SLACK_MS,
  SESSION_LIMITS,
  SESSION_PROVIDERS,
  SessionReader,
  locateClaudeByCwd,
  locateCodexByCwd,
  locateGrokSession,
  locateKimiSession,
  readAntigravitySessionUsage,
  readOpenCodeSessionUsage,
  sessionsLocator,
  type LocateSession,
  type SessionLimits,
} from './machine/session.ts';
import { usageProtocol } from './protocol.ts';

export type { LocateSession, Transcript } from './machine/session.ts';

export interface UsageMachineOptions {
  /** The providers' endpoints (tests point them at fake servers). */
  urls?: Partial<Urls>;
  timing?: Partial<UsageTiming>;
  /** The time, in ms since the epoch. */
  now?: () => number;
  platform?: NodeJS.Platform;
  /** The agent's user. */
  uid?: number;
  programs?: Partial<Programs>;
  procRoot?: string;
  /** The agent's environment (the agent's, cleaned, by default). */
  environ?: () => Record<string, string>;
  /** Finds a session's transcripts (tests give their own); the coding
   * agents' sessions of the agent's home by default (sessionsLocator). */
  locate?: LocateSession;
  dbLimits?: Partial<DBLimits>;
  sessionLimits?: Partial<SessionLimits>;
}

const badPrices = () => new Fail('bad_params', 400, 'usage: a price that is not one of usage.prices');

const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9_-]{4,128}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The provider whose prices a kind's sessions are priced with: every
 * coding agent whose logs or databases the spend reads. */
function sessionProvider(kind: string): string | undefined {
  const p = byId(kind)?.usageProvider;
  return p && SESSION_PROVIDERS.has(p) ? p : undefined;
}

function validUsageSessionId(kind: string, session: string): boolean {
  if (validSessionId(session)) return true;
  return kind === 'opencode' && OPENCODE_SESSION_ID.test(session);
}

function validSessionCwd(cwd: string): boolean {
  return cwd.startsWith('/') && Buffer.byteLength(cwd) <= 4096 && !cwd.includes('\0') && !LONE_SURROGATE.test(cwd);
}

/** The code of a session that could not be read; its message names no
 * path. */
function sessionError(err: unknown, signal: AbortSignal): Fail {
  if (err instanceof Fail) return err;
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Fail('not_found', 404, 'usage: no transcript of the session');
  if (signal.aborted) return new Fail('timeout', 504, "usage: the session's transcripts were not read in time");
  return new Fail('failed', 500, "usage: the session's transcripts could not be read");
}

export function usageMachine(o: UsageMachineOptions = {}) {
  return defineMachine(usageProtocol, (env: MachineEnv) => {
    const t: UsageTiming = { ...USAGE_TIMING, ...o.timing };
    const now = o.now ?? Date.now;
    const memo = new Memo();
    const cache = new CacheWorker(env.base, env.signal);
    const dbLimits: DBLimits = { ...DB_LIMITS, ...o.dbLimits };
    const scanner = new CostScanner(env.base, dbLimits, cache);
    const sessions = new SessionReader(scanner, { ...SESSION_LIMITS, ...o.sessionLimits });
    // The sessions' transcripts as the agents' sessions find them, in the
    // agent's home and environment (CLAUDE_CONFIG_DIR, CODEX_HOME).
    const resolver = new Resolver({ home: env.home, getenv: (k) => (o.environ?.() ?? env.environ())[k], now });
    const locate = o.locate ?? sessionsLocator(resolver);
    let shared: { client: string; params: string; at: number; accounts: Account[] } | null = null;
    const within = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    const usageEnv = (signal: AbortSignal): UsageEnv => ({
      home: env.home,
      base: env.base,
      env: o.environ?.() ?? env.environ(),
      platform: o.platform ?? process.platform,
      uid: o.uid ?? process.getuid?.() ?? -1,
      now,
      urls: { ...DEFAULT_URLS, ...o.urls },
      t,
      programs: { ...DEFAULT_PROGRAMS, ...o.programs },
      procRoot: o.procRoot ?? '/proc',
      memo,
      signal,
    });

    return {
      actions: {
        async limits(p, ctx) {
          const { force, ...rest } = p;
          const params = JSON.stringify(rest);
          if (
            !force &&
            ctx.client &&
            shared &&
            shared.client !== ctx.client &&
            shared.params === params &&
            now() - shared.at < t.limitsShareMs
          )
            return { accounts: shared.accounts };
          const signal = within(ctx.signal, t.limitsMs);
          const accounts = await limits(usageEnv(signal), p);
          if (ctx.client && !signal.aborted) shared = { client: ctx.client, params, at: now(), accounts };
          return { accounts };
        },

        async cost(p, ctx) {
          if (!validPrices(p.prices)) throw badPrices();
          const signal = within(ctx.signal, t.costMs);
          try {
            return await scanner.scan(usageEnv(signal), p);
          } catch (err) {
            // What the scan read so far is kept for the next.
            if (signal.aborted) throw new Fail('timeout', 504, 'usage: the scan did not end in time');
            env.logger(`usage: cost: ${(err as Error)?.stack ?? err}`);
            throw new Fail('failed', 500, 'usage: the logs could not be read');
          }
        },

        async setDeepseekKey(p) {
          try {
            await setDeepseekKey(env.base, p.key);
          } catch (err) {
            if (err instanceof BadKey) throw new Fail('bad_key', 400, 'not an API key');
            throw new Fail('failed', 500, 'usage: the key file could not be written');
          }
          return { set: p.key !== '' };
        },

        async session(p, ctx) {
          if (!validPrices(p.prices)) throw badPrices();
          // Only a known kind and a valid session id (or absolute cwd) reach
          // the search for a transcript or database.
          const provider = sessionProvider(p.kind);
          const hasSession = p.session !== '';
          const hasCwd = typeof p.cwd === 'string' && p.cwd !== '';
          const valid =
            !!provider &&
            ((hasSession && validUsageSessionId(p.kind, p.session) && (!hasCwd || validSessionCwd(p.cwd!))) ||
              (!hasSession && hasCwd && validSessionCwd(p.cwd!)));
          if (!valid) throw new Fail('bad_params', 400, 'usage: not a session of an agent whose sessions are priced');
          const signal = within(ctx.signal, t.sessionMs);
          const e = usageEnv(signal);
          try {
            let sinceMs: number | undefined;
            if (!hasSession && p.pid) {
              const start = await resolver.startOf(p.pid);
              if (start !== null) sinceMs = start - CWD_START_SLACK_MS;
            }
            if (provider === 'antigravity') {
              return await readAntigravitySessionUsage(e, sessions, {
                session: p.session,
                cwd: p.cwd ?? '',
                sinceMs,
                own: p.prices,
                dbLimits,
              });
            }
            if (provider === 'opencode') {
              return await readOpenCodeSessionUsage(e, sessions, {
                session: p.session,
                cwd: p.cwd ?? '',
                sinceMs,
                own: p.prices,
                dbLimits,
              });
            }
            let files;
            if (o.locate && hasSession) {
              files = await locate(p.kind, p.session, signal, p.codexHomes);
            } else if (provider === 'grok') {
              files = await locateGrokSession(e, p.session, p.cwd ?? '', sinceMs);
            } else if (provider === 'kimi') {
              files = await locateKimiSession(e, p.session, p.cwd ?? '', sinceMs);
            } else if (provider === 'codex' && !hasSession) {
              files = await locateCodexByCwd(e, resolver, p.cwd ?? '', sinceMs, p.codexHomes);
            } else if (provider === 'claude' && !hasSession) {
              files = await locateClaudeByCwd(e, resolver, p.cwd ?? '', sinceMs);
            } else {
              if (!hasSession) throw new Fail('not_found', 404, 'usage: no transcript of the session');
              files = await locate(p.kind, p.session, signal, p.codexHomes);
            }
            return await sessions.cost(e, provider, files, p.prices);
          } catch (err) {
            throw sessionError(err, signal);
          }
        },
      },

      /** The cost cache of a data directory no scan saved for the
       * retention (the feature off there) goes. */
      housekeep: (when) => scanner.housekeep(when.getTime()),
      close: () => {
        sessions.close();
        resolver.close();
        cache.close();
      },
    };
  });
}

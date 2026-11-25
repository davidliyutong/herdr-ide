// Helpers of the product's own that outlive the agent (the chat host) run
// as terminals of the instance's terminal core: the terminal core, not the
// agent, is their parent, so they have the lifetime, the owner (a user
// service or launchd job) and, on macOS, the privacy attribution of the
// user's terminals. They end with their program, or with the terminal core.
// No client shows them: the core keeps a terminal that carries HIDDEN_LABEL
// with its name's value (agentproto.hidden) from its clients.
import { connect } from 'node:net';
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { CHAT_HOST_NAME, HIDDEN_LABEL, chatHostFallbackName, hiddenValue } from '#shared/proto/agentproto/index.ts';
import { Conn, HCError, type Terminal } from '#shared/proto/hc/index.ts';
import { hiddenEnv } from './env.ts';

/** The size of a helper's terminal, which nobody looks at. */
const COLS = 80;
const ROWS = 24;
/** How long the terminal core has to answer a run or a kill. */
const TIMEOUT_MS = 30_000;
/** How long its socket has to take the connection. */
const DIAL_MS = 5000;
/** Bounds the fallback names tried while a user's terminal holds
 * CHAT_HOST_NAME. */
const MAX_FALLBACKS = 16;

/** No terminal core answers on the instance's socket: the agent starts none
 * for a helper. */
export const noTerminalCore = (why: string) => new Fail('no_terminal_core', 503, `the terminal core is not running: ${why}`);

/** A terminal of the name that is not the helper. */
const notHelper = () => new Fail('not_helper', 409, 'the terminal of the name is not the helper');

/** Connects to the terminal core on sock. */
export async function dialHC(sock: string, signal?: AbortSignal): Promise<Conn> {
  const timeout = AbortSignal.timeout(DIAL_MS);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const c = connect(sock);
  c.on('error', () => {});
  try {
    await new Promise<void>((res, rej) => {
      c.once('connect', res);
      c.once('error', rej);
      sig.addEventListener('abort', () => rej(new Error('timeout')), { once: true });
    });
    return (await Conn.dial(c, sig)).conn;
  } catch (e) {
    c.destroy();
    throw noTerminalCore((e as Error).message);
  }
}

async function liveTerminal(conn: Conn, name: string, signal: AbortSignal): Promise<Terminal | null> {
  try {
    const rec = await conn.call<Terminal>('terminal.get', { terminal: name }, { signal });
    return rec.state === 'live' ? rec : null;
  } catch (e) {
    if (e instanceof HCError && e.kind === 'not_found') return null;
    throw new Error(`terminal core: get ${name}: ${(e as Error).message}`);
  }
}

/** Whether rec is the helper name runs with argv (its program's path may
 * be an older build's). */
function isHelper(rec: Terminal | null, name: string, argv: string[]): boolean {
  if (!rec || rec.state !== 'live') return false;
  if (rec.name != null && rec.name !== name) return false;
  const a = rec.argv ?? [];
  return (
    (rec.labels ?? {})[HIDDEN_LABEL] === hiddenValue(name) &&
    a.length === argv.length &&
    argv.length > 0 &&
    a.slice(1).every((x, i) => x === argv[i + 1])
  );
}

const candidates = (name: string): string[] =>
  name === CHAT_HOST_NAME ? [name, ...Array.from({ length: MAX_FALLBACKS }, (_, i) => chatHostFallbackName(i + 1))] : [name];

export interface HiddenOptions {
  /** The terminal core's socket. */
  sock: string;
  home: string;
  /** The agent's environment (cleanEnv), of which the helper gets the
   * user's variables (hiddenEnv). */
  environ: Record<string, string>;
  logger: Logger;
  signal?: AbortSignal;
}

/** Runs argv as a terminal named name: without a parent, not notifying, in
 * the user's home, removed from the terminal core's records once its
 * program exits. A live terminal of our helper holding the name is success;
 * a user's terminal holding CHAT_HOST_NAME is left alone and a fallback
 * name taken instead. */
export async function runHidden(name: string, argv: string[], o: HiddenOptions): Promise<void> {
  const conn = await dialHC(o.sock, o.signal);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    const env = hiddenEnv(o.environ);
    for (const candidate of candidates(name)) {
      const params = {
        argv,
        cwd: o.home,
        env,
        name: candidate,
        labels: { [HIDDEN_LABEL]: hiddenValue(candidate) },
        size: { cols: COLS, rows: ROWS },
        no_parent: true,
        no_notify: true,
        rm: true,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await conn.call('terminal.run', params, { signal });
          o.logger(`started ${candidate} as a hidden terminal of the terminal core`);
          return;
        } catch (e) {
          if (!(e instanceof HCError) || e.kind !== 'name_taken')
            throw new Error(`terminal core: run ${candidate}: ${(e as Error).message}`);
        }
        const rec = await liveTerminal(conn, candidate, signal);
        if (!rec) continue; // it ended between the run and the get
        if (isHelper(rec, candidate, argv)) return;
        break; // a user's terminal: never touched; the next name
      }
    }
    if (name === CHAT_HOST_NAME) throw new Error(`terminal core: run ${name}: all fallback names are taken`);
    throw notHelper();
  } finally {
    conn.close();
  }
}

/** Ends a helper's terminal that holds its name and does not do its work:
 * the live terminal named name, when it carries the helper's label and
 * runs argv's program with argv's arguments, is killed, and killHidden
 * returns once the name is free, true; without kill, it reports whether
 * such a terminal holds the name. False when none has the name; Fail
 * not_helper when the one that has it is another, which is left alone. For
 * CHAT_HOST_NAME the fallback names are looked at too. */
export async function killHidden(name: string, argv: string[], kill: boolean, o: HiddenOptions): Promise<boolean> {
  const conn = await dialHC(o.sock, o.signal);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    try {
      return await killNamed(conn, name, argv, kill, signal);
    } catch (e) {
      if (!(e instanceof Fail && e.code === 'not_helper') || name !== CHAT_HOST_NAME) throw e;
    }
    for (let i = 1; i <= MAX_FALLBACKS; i++) {
      try {
        if (await killNamed(conn, chatHostFallbackName(i), argv, kill, signal)) return true;
      } catch (e) {
        if (!(e instanceof Fail && e.code === 'not_helper')) throw e;
      }
    }
    return false;
  } finally {
    conn.close();
  }
}

async function killNamed(conn: Conn, name: string, argv: string[], kill: boolean, signal: AbortSignal): Promise<boolean> {
  const rec = await liveTerminal(conn, name, signal);
  if (!rec) return false;
  if (!isHelper(rec, name, argv)) throw notHelper();
  if (!kill) return true;
  try {
    await conn.call('terminal.kill', { terminal: rec.address }, { signal });
  } catch (e) {
    throw new Error(`terminal core: kill ${rec.address}: ${(e as Error).message}`);
  }
  while (await liveTerminal(conn, name, signal)) {
    if (signal.aborted) throw new Error(`terminal core: ${name} did not end`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

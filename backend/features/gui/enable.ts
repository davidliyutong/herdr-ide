// Giving terminals opened without the display (before it existed, or
// outside the UI) the display's environment without restarting anything: a
// known shell waiting at its prompt gets Ctrl-C and an export command (its
// leading space keeps it out of history); a terminal running a program (an
// agent, an editor) is not typed into and is reported with the command to
// copy.
import type { GUIProc } from '#shared/proto/agentproto/index.ts';

/** The terminals of a machine's terminal core that Enable types into (the
 * terminals feature's). */
export interface Shells {
  /** Every terminal, for an Enable without a list. */
  all(): string[] | Promise<string[]>;
  /** The pid of the terminal's shell (0 when it has none) and whether it
   * waits at its prompt. */
  shell(id: string, signal?: AbortSignal): Promise<{ pid: number; idle: boolean }>;
  /** Types text into the terminal. */
  send(id: string, text: string, signal?: AbortSignal): Promise<void>;
}

/** What Enable did. */
export interface EnableResult {
  /** Shells that got the variables typed in. */
  enabled: number;
  /** Shells started with the display, or typed into before. */
  already: number;
  /** Terminals running a program. */
  busy: string[];
  /** Terminals typed into. */
  typed: string[];
  /** Terminals that could not be reached. */
  failed: string[];
  /** What was typed, for the busy terminals. */
  command: string;
}

/** Enable failed after it started: the result so far (nothing typed). */
export class EnableError extends Error {
  readonly result: EnableResult;

  constructor(result: EnableResult, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.result = result;
  }
}

/** The shell command that sets env: values single-quoted, names sorted;
 * the leading space keeps it out of shell history where that is enabled. */
export function exportCommand(env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  return ' export' + keys.map((k) => ` ${k}='${env[k].replaceAll("'", `'\\''`)}'`).join('');
}

/** The shells the export command is written for, by executable name;
 * anything else in a terminal (a program that replaced its shell with
 * exec, an agent) is never typed into. */
const SHELLS = new Set(['bash', 'zsh', 'fish', 'dash', 'sh', 'ksh', 'mksh', 'yash', 'ash']);

export type Decision = 'already' | 'busy' | 'type';

/** What Enable does with a terminal whose shell is p (undefined when the
 * agent could not see it): idle means it waits at its prompt, typed that
 * the hub typed the export into it before. */
export function decide(p: GUIProc | undefined, idle: boolean, typed: boolean): Decision {
  if (typed || p?.display) return 'already';
  if (!p || !idle || !SHELLS.has(p.comm)) return 'busy';
  return 'type';
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Discards a half-typed command line with Ctrl-C, then types cmd and
 * Enter; a failed interrupt types nothing more. */
export async function typeExport(send: (text: string) => Promise<void>, cmd: string, pauseMs: number, signal?: AbortSignal): Promise<void> {
  await send('\x03');
  await sleep(pauseMs, signal);
  await send(cmd + '\r');
}

export interface EnableDeps {
  /** The display's environment. */
  env: Record<string, string>;
  shells: Shells;
  /** Asks the machine's agent about the shells' processes. */
  procs(pids: string[]): Promise<GUIProc[]>;
  /** The terminals typed into, with the display they got: a shell's
   * environment as seen in /proc does not show it. */
  typed: Map<string, string>;
  pauseMs: number;
  signal: AbortSignal;
}

/** Types the display's environment into the shells of ids (all terminals
 * when empty) that wait at their prompt, checking each again right before.
 * One that cannot be reached is reported in failed; a failure to ask the
 * agent throws an EnableError with the result so far (nothing typed). */
export async function enableShells(ids: readonly string[], d: EnableDeps): Promise<EnableResult> {
  const { env, shells, signal } = d;
  const list = ids.length ? ids : await shells.all();
  const res: EnableResult = { enabled: 0, already: 0, busy: [], typed: [], failed: [], command: exportCommand(env) };
  const found: Array<{ id: string; pid: number; idle: boolean }> = [];
  for (const id of list) {
    let sh: { pid: number; idle: boolean };
    try {
      sh = await shells.shell(id, signal);
    } catch {
      res.failed.push(id);
      continue;
    }
    if (sh.pid === 0) res.busy.push(id);
    else found.push({ id, ...sh });
  }
  const procs = new Map<number, GUIProc>();
  if (found.length) {
    try {
      for (const p of await d.procs(found.map((s) => String(s.pid)))) procs.set(p.pid, p);
    } catch (e) {
      throw new EnableError(res, e);
    }
  }
  const display = env.DISPLAY;
  for (const sh of found) {
    switch (decide(procs.get(sh.pid), sh.idle, d.typed.get(sh.id) === display)) {
      case 'already':
        res.already++;
        continue;
      case 'busy':
        res.busy.push(sh.id);
        continue;
    }
    // Check again right before typing: the user may have started a
    // program meanwhile.
    let now: { pid: number; idle: boolean };
    try {
      now = await shells.shell(sh.id, signal);
    } catch {
      res.failed.push(sh.id);
      continue;
    }
    if (!now.idle || now.pid !== sh.pid) {
      res.busy.push(sh.id);
      continue;
    }
    try {
      await typeExport((text) => shells.send(sh.id, text, signal), res.command, d.pauseMs, signal);
    } catch {
      res.failed.push(sh.id);
      continue;
    }
    d.typed.set(sh.id, display);
    res.enabled++;
    res.typed.push(sh.id);
  }
  return res;
}

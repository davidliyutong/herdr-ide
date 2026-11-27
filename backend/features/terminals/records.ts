// The terminal core's terminal records as the clients get them: passed on
// with every field the core sent, without the terminals that are none of
// the clients' — the product's own helpers (hidden terminals, the chat
// host) and the terminals of other machines the terminal core has.
import { HIDDEN_LABEL, hidden } from '#shared/proto/agentproto/index.ts';
import type { CoreInfo } from '#shared/proto/hc/index.ts';

/** A terminal's record, with every field the core sent. */
export type Rec = Record<string, unknown>;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether addr, a terminal's address as the terminal core reports it, is
 * one of another machine ("box/t7"): the core's own terminals have
 * addresses without a machine ("t7"). */
export const otherMachine = (addr: string): boolean => addr.includes('/');

/** Whether a record is a hidden terminal's (agentproto.hidden): named as
 * the chat host and labeled as one, both; a label alone hides nothing,
 * since any program can set one. */
export function hiddenRecord(rec: unknown): boolean {
  if (!isObject(rec)) return false;
  const name = typeof rec.name === 'string' ? rec.name : '';
  const labels = isObject(rec.labels) ? rec.labels : {};
  const value = labels[HIDDEN_LABEL];
  return hidden(name, typeof value === 'string' ? value : '');
}

/** Strips the internal `term-env <token>` trampoline prefix from argv when
 * present, leaving any explicit target argv that followed it. */
export function stripTermEnvArgv(argv: unknown): string[] | undefined {
  if (!Array.isArray(argv)) return undefined;
  for (let i = 1; i + 1 < argv.length; i++) {
    if (argv[i] === 'term-env' && typeof argv[i + 1] === 'string' && /^[0-9a-f]{48}$/.test(argv[i + 1])) {
      return argv.slice(i + 2).filter((x): x is string => typeof x === 'string');
    }
  }
  return undefined;
}

/** Sanitizes a foreground process snapshot if sampled before `term-env`
 * execve'd its target: null drops a default-shell trampoline snapshot;
 * undefined means unchanged. */
export function cleanForeground(fg: unknown): Record<string, unknown> | null | undefined {
  if (!isObject(fg)) return undefined;
  const stripped = stripTermEnvArgv(fg.argv);
  if (stripped === undefined) return undefined;
  if (stripped.length === 0) return null;
  const prog = stripped[0];
  return { ...fg, name: prog.split('/').pop() || prog, argv: stripped };
}

/** Removes internal `term-env` trampoline details from a terminal record. */
export function cleanRecord(rec: Rec): Rec {
  const argv = stripTermEnvArgv(rec.argv);
  const fg = cleanForeground(rec.foreground);
  if (argv === undefined && fg === undefined) return rec;
  const out: Rec = { ...rec };
  if (argv !== undefined) out.argv = argv;
  if (fg === null) delete out.foreground;
  else if (fg !== undefined) out.foreground = fg;
  return out;
}

/** Sorts the core's terminals into those the clients are told of, by
 * address, and the addresses of the hidden ones. Other machines'
 * terminals are in neither. */
export function indexTerminals(list: readonly unknown[]): { terms: Map<string, Rec>; hidden: Set<string> } {
  const terms = new Map<string, Rec>();
  const hiddenSet = new Set<string>();
  for (const t of list) {
    const rec: Rec = isObject(t) ? t : {};
    const addr = typeof rec.address === 'string' ? rec.address : '';
    if (addr === '' || otherMachine(addr)) continue;
    if (hiddenRecord(rec)) hiddenSet.add(addr);
    else terms.set(addr, cleanRecord(rec));
  }
  return { terms, hidden: hiddenSet };
}

/** target, a terminal as a client names it ("t7", a name, or either after
 * a machine: "box/t7"), as the terminal core names one of its own: without
 * the core's own id or name before it. null for a target after any other
 * machine, and for one that is no address at all ("box/", "a/b/c"). */
export function localName(target: string, core: CoreInfo): string | null {
  const i = target.indexOf('/');
  if (i < 0) return target;
  const m = target.slice(0, i);
  const local = target.slice(i + 1);
  if (m === '' || local === '' || local.includes('/') || (m !== core.id && m !== core.name)) return null;
  return local;
}

/** The result of terminal.list with only the clients' terminals: without
 * the hidden ones (hiddenAddr, or their records) and other machines', and
 * without the machines the terminal core added; undefined for a result
 * that is no list of terminals. */
export function visibleList(result: unknown, hiddenAddr: (addr: string) => boolean): unknown {
  if (!isObject(result) || !('terminals' in result)) return undefined;
  const list = result.terminals;
  if (list !== null && !Array.isArray(list)) return undefined;
  const all = list ?? [];
  const kept: unknown[] = [];
  let sanitized = false;
  for (const rec of all) {
    if (rec !== null && !isObject(rec)) return undefined;
    const addr = typeof rec?.address === 'string' ? rec.address : '';
    if (!hiddenAddr(addr) && !hiddenRecord(rec) && !otherMachine(addr)) {
      const cleaned = rec ? cleanRecord(rec) : rec;
      if (cleaned !== rec) sanitized = true;
      kept.push(cleaned);
    }
  }
  const machines = result.machines;
  const dropMachines = 'machines' in result && machines !== null && (!Array.isArray(machines) || machines.length > 0);
  if (!dropMachines && !sanitized && kept.length === all.length) return result;
  const out: Record<string, unknown> = { ...result, terminals: kept };
  if (dropMachines) out.machines = [];
  return out;
}

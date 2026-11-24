// What a client may ask of a machine's terminal core: the methods it may
// call, the parameters that name terminals, and the checks of parameters
// the core reads before it passes a call on. Methods that reach beyond
// terminals and documents (files, commands, other machines, the core
// itself) are not offered.
import { isObject } from './records.ts';

/** Methods every client may call. */
export const READ_METHODS: ReadonlySet<string> = new Set(['terminal.list', 'terminal.get', 'terminal.read', 'doc.get', 'templates.list']);

/** Methods clients that may write call; refused in read-only mode. */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  'terminal.run',
  'terminal.kill',
  'terminal.rm',
  'terminal.keep',
  'terminal.label',
  'terminal.interrupt',
  'doc.set',
]);

/** Calls recorded in the audit log, as the method's name. */
export const AUDITED_METHODS: ReadonlySet<string> = new Set([
  'terminal.run',
  'terminal.kill',
  'terminal.rm',
  'terminal.interrupt',
  'terminal.keep',
]);

/** The parameters by which a call names a terminal: the one it acts on,
 * who calls, and a new terminal's parent. */
export const TARGET_PARAMS = ['terminal', 'caller', 'parent'] as const;

/** The parameter that would address a machine the terminal core itself
 * added: refused in every call. */
export const ROUTING_PARAM = 'on';

/** A call's parameters, as the client sent them. */
export type Params = Record<string, unknown>;

/** Whether v is an object of strings, as the terminal core reads labels
 * and environments: null, an array, a value of another type, or an object
 * with a value that is not a string (null included) is not. */
export function isStringMap(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** An environment as Go read it into map[string]string: absent and null
 * are no environment, anything but an object of strings is invalid
 * (undefined). */
export function envOf(v: unknown): Record<string, string> | null | undefined {
  if (v === undefined || v === null) return null;
  return isStringMap(v) ? v : undefined;
}

/** Folds a key as Go's strings.EqualFold compares it with "lines". */
const foldsToLines = (k: string): boolean => k.replace(/\u017f/g, 's').toLowerCase() === 'lines';

/** Removes from a read-only client's terminal.read the history lines it
 * asks for ("lines", in any letter case and of any JSON type), so that the
 * terminal core reads the screen only: to stitch history above the screen
 * of a program on the alternate screen the core scrolls the program (it
 * sends it mouse-wheel input, and other viewers see it redrawn), and a
 * read-only client only watches. */
export function readScreenOnly(params: Params | null): void {
  if (!params) return;
  for (const k of Object.keys(params)) if (foldsToLines(k)) delete params[k];
}

/** Sets env in the "env" object of params and returns the names it set:
 * with replace also those the caller gave a value, else only the others.
 * undefined when "env" is not an object of strings (params unchanged). */
export function addEnv(params: Params, env: Record<string, string>, replace: boolean): string[] | undefined {
  const given = envOf(params.env);
  if (given === undefined) return undefined;
  const out: Record<string, string> = { ...given };
  const names: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (k in out && !replace) continue;
    out[k] = v;
    names.push(k);
  }
  if (names.length === 0) return [];
  params.env = out;
  return names.sort();
}

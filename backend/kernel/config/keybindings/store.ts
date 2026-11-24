// The one keybinding system of every client (web UI, desktop app), modeled
// on VS Code's: commands with default keys per platform, registered here,
// and a hand-editable file of the user's rules ({key, command, when};
// command "-<id>" removes a binding) on the core host. The core serves the
// effective bindings of every platform and their conflicts (GET
// /api/keybindings); the clients only match keys. See
// docs/features/04-layout-and-keyboard.md.
import { byteOrder, indent, marshal } from '#shared/lib/gojson.ts';
import * as userfile from '#shared/host/userfile.ts';
import { PLATFORMS, validWhen, type Command, type When } from './commands.ts';
import { normalize } from './keys.ts';

/** A binding: a user's rule, or one in effect. */
export interface Rule {
  key: string;
  command: string;
  when?: When;
}

/** Something wrong in the user's file: an entry that is not a valid rule
 * ("invalid"), a command no version of the core has ("unknown"), or a file
 * that is not a JSON array ("parse", index -1). */
export interface Problem {
  index: number;
  code: string;
  detail?: string;
}

/** A key that runs more than one command in the same place, or a stroke
 * bound on its own that also starts chords (which then never run). */
export interface Conflict {
  key: string;
  commands: string[];
  prefix?: boolean;
}

/** The errors of setUser by the code the API reports them as (Go's
 * ErrInvalid and ErrFile). */
export const ErrorCode = {
  Invalid: 'invalid',
  File: 'file',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const errorText: Record<ErrorCode, string> = {
  invalid: 'invalid keybindings',
  file: 'the keybindings file has errors',
};

/** An error of setUser: its code is what the API reports, its message the
 * detail. */
export class KeybindingsError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? errorText[code] : `${errorText[code]}: ${detail}`);
    this.name = 'KeybindingsError';
    this.code = code;
  }
}

/** Whether e is a KeybindingsError (of code, when given). */
export function isKeybindingsError(e: unknown, code?: ErrorCode): e is KeybindingsError {
  return e instanceof KeybindingsError && (code === undefined || e.code === code);
}

/** Bounds the user's rules. */
export const MAX_RULES = 1000;
const maxBytes = 256 << 10;

const commandRE = /^-?[A-Za-z0-9_.:-]{1,128}$/;

// Go's bytes.TrimSpace: a file of only these is empty.
const blankRE = /^[\t\n\v\f\r \u0085\u00a0]*$/;

const ruleFields = ['key', 'command', 'when'] as const;

/** Reads one entry of the file, normalizing its key; throws an Error that
 * says why it is not a rule. As Go decodes it into a struct: names match
 * the fields in any case, other members are ignored, null is no value. */
function parseRule(raw: unknown): Rule {
  const r = { key: '', command: '', when: '' };
  if (raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a rule object');
    let bad = false;
    for (const [name, v] of Object.entries(raw)) {
      const field = ruleFields.find((f) => f === name.toLowerCase());
      if (field === undefined || v === null) continue;
      if (typeof v === 'string') r[field] = v;
      else bad = true;
    }
    if (bad) throw new Error('not a rule object');
  }
  if (!commandRE.test(r.command)) throw new Error(`invalid command ${JSON.stringify(r.command)}`);
  if (r.when !== '' && !validWhen(r.when)) throw new Error(`invalid when ${JSON.stringify(r.when)}`);
  // An empty key removes every binding of the command.
  const key = r.key === '' && r.command.startsWith('-') ? '' : normalize(r.key);
  const rule: Rule = { key, command: r.command };
  if (r.when !== '') rule.when = r.when as When;
  return rule;
}

/** The file: the array, one rule after another. */
function encode(user: readonly unknown[]): string {
  const b = indent(marshal(user), '', '  ');
  if (Buffer.byteLength(b) > maxBytes) throw new Error('too large');
  return b + '\n';
}

/** Whether two bindings can apply at the same time; the main UI's
 * (terminal) also apply in VS Code panes, for the keys VS Code leaves, and
 * wherever outside terminals (editor) does. */
function overlaps(a: string, b: string): boolean {
  if (a === b || a === 'always' || b === 'always') return true;
  const main = (w: string) => w === 'terminal' || w === 'editor' || w === 'vscode';
  return main(a) && main(b);
}

/** The keys that run several commands in the same place, and the strokes
 * bound alone that start chords too. */
export function conflicts(effective: readonly Rule[]): Conflict[] {
  const out: Conflict[] = [];
  const byKey = new Map<string, Rule[]>();
  for (const r of effective) {
    let list = byKey.get(r.key);
    if (!list) byKey.set(r.key, (list = []));
    list.push(r);
  }
  const keys = [...byKey.keys()].sort(byteOrder);
  const add = (key: string, prefix: boolean, rules: Rule[]) => {
    const ids: string[] = [];
    for (const r of rules) if (!ids.includes(r.command)) ids.push(r.command);
    if (ids.length > 1) out.push(prefix ? { key, commands: ids, prefix } : { key, commands: ids });
  };
  for (const k of keys) {
    const rules = byKey.get(k)!;
    const clash: Rule[] = [];
    rules.forEach((a, i) => {
      for (const b of rules.slice(i + 1)) if (a.command !== b.command && overlaps(a.when ?? '', b.when ?? '')) clash.push(a, b);
    });
    add(k, false, clash);
    if (k.includes(' ')) continue;
    // A single stroke that starts chords shadows them where both apply.
    const shadow: Rule[] = [];
    for (const a of rules) {
      for (const other of keys) {
        if (!other.startsWith(k + ' ')) continue;
        for (const b of byKey.get(other)!) if (overlaps(a.when ?? '', b.when ?? '')) shadow.push(a, b);
      }
    }
    add(k, true, shadow);
  }
  return out;
}

/** A command as the API lists it. */
export interface CommandJSON {
  id: string;
  section: string;
  when: When;
}

/** The user's rules and what follows from them on every platform: what the
 * API returns and pushes after each change. Objects' keys are in Go's
 * order (sorted). */
export interface State {
  user: unknown[];
  effective: Record<string, Rule[]>;
  conflicts: Record<string, Conflict[]>;
  problems: Problem[];
}

const sortedPlatforms = [...PLATFORMS].sort(byteOrder);

/** Holds the commands and the user's rules. */
export class Store {
  readonly #commands: readonly Command[];
  readonly #byID = new Map<string, Command>();

  #path: string;
  #sig: userfile.Sig | undefined;
  // The file's entries as written, kept whatever they hold.
  #user: unknown[] = [];
  #rules: Rule[] = []; // the entries that apply, in order
  #problems: Problem[] = [];
  #broken = false;
  readonly #subs: (() => void)[] = [];

  /** A store for the commands, saved in path ("" keeps rules in memory).
   * Invalid commands and default keys throw: they are programming errors. */
  constructor(path: string, commands: readonly Command[]) {
    this.#path = path;
    this.#commands = commands;
    for (const c of commands) {
      if (this.#byID.has(c.id) || !commandRE.test(c.id) || c.id.startsWith('-') || !validWhen(c.when)) {
        throw new Error('keybindings: invalid command ' + c.id);
      }
      for (const d of c.defaults) {
        let n = '';
        let err: unknown;
        try {
          n = normalize(d.key);
        } catch (e) {
          err = e;
        }
        if (n !== d.key) throw new Error(`keybindings: ${c.id}: default ${JSON.stringify(d.key)} is not canonical (${err ?? n})`);
      }
      this.#byID.set(c.id, c);
    }
  }

  /** Sets the file rules are saved in (before load). */
  setPath(path: string): void {
    this.#path = path;
  }

  /** The keybindings file. */
  path(): string {
    return this.#path;
  }

  /** Reads the file; a missing file has no rules. */
  load(): void {
    if (this.#path) this.#read();
  }

  #changedOnDisk(): boolean {
    const now = userfile.stat(this.#path);
    return this.#sig ? !userfile.sameSig(now, this.#sig) : now.exists;
  }

  /** Loads the file; throws when it cannot be read. A file that is not a
   * JSON array keeps the rules read before and is reported. */
  #read(): void {
    const { data, sig } = userfile.read(this.#path);
    this.#sig = sig;
    const text = data ? data.toString('utf8') : '';
    let user: unknown[] = [];
    if (!blankRE.test(text)) {
      let parsed: unknown;
      let detail: string | undefined;
      try {
        parsed = JSON.parse(text);
        if (parsed !== null && !Array.isArray(parsed)) detail = 'not a JSON array';
      } catch (e) {
        detail = (e as Error).message;
      }
      if (detail !== undefined) {
        this.#broken = true;
        this.#problems = [{ index: -1, code: 'parse', detail }];
        return;
      }
      user = (parsed as unknown[] | null) ?? [];
    }
    this.#broken = false;
    this.#set(user);
  }

  /** Makes user the current entries. */
  #set(user: unknown[]): void {
    const rules: Rule[] = [];
    const problems: Problem[] = [];
    user.forEach((raw, index) => {
      let r: Rule;
      try {
        r = parseRule(raw);
      } catch (e) {
        problems.push({ index, code: 'invalid', detail: (e as Error).message });
        return;
      }
      if (!this.#byID.has(r.command.replace(/^-/, ''))) {
        problems.push({ index, code: 'unknown', detail: r.command });
        return;
      }
      rules.push(r);
    });
    this.#user = user;
    this.#rules = rules;
    this.#problems = problems;
  }

  /** Reloads the file when it changes on disk, checking every interval
   * until signal aborts. */
  watch(signal: AbortSignal, everyMs: number): Promise<void> {
    return userfile.poll(signal, everyMs, () => this.reload());
  }

  /** Reads the file again if it changed since it was last read or written,
   * and notifies the subscribers. */
  reload(): void {
    if (!this.#path || !this.#changedOnDisk()) return;
    try {
      this.#read();
    } catch {
      return;
    }
    for (const fn of this.#subs.slice()) fn();
  }

  /** Validates and saves the user's rules (JSON values), replacing them.
   * Entries naming commands this version does not have are kept (another
   * version may); entries that are not valid rules are refused. Throws a
   * KeybindingsError, or the file's write error. */
  setUser(user: readonly unknown[]): void {
    if (user.length > MAX_RULES) throw new KeybindingsError('invalid', `more than ${MAX_RULES} rules`);
    user.forEach((raw, i) => {
      try {
        parseRule(raw);
      } catch (e) {
        throw new KeybindingsError('invalid', `rule ${i + 1}: ${(e as Error).message}`);
      }
    });
    let data: string;
    try {
      data = encode(user);
    } catch (e) {
      throw new KeybindingsError('invalid', (e as Error).message);
    }
    if (this.#path) {
      // A file that is not an array is not written over: it is being
      // edited by hand.
      if (this.#changedOnDisk()) {
        try {
          this.#read();
        } catch {
          // Written over below, as if it were missing.
        }
      }
      if (this.#broken) throw new KeybindingsError('file');
      this.#sig = userfile.write(this.#path, data);
      this.#broken = false;
    }
    // A copy of the entries, as written.
    this.#set(JSON.parse(data) as unknown[]);
    for (const fn of this.#subs.slice()) fn();
  }

  /** Registers fn to be called after the rules change. */
  onChange(fn: () => void): void {
    this.#subs.push(fn);
  }

  /** The default bindings on a platform, in command order. */
  defaults(platform: string): Rule[] {
    const out: Rule[] = [];
    for (const c of this.#commands) {
      for (const d of c.defaults) {
        if (d.platforms.length === 0 || d.platforms.includes(platform)) out.push({ key: d.key, command: c.id, when: c.when });
      }
    }
    return out;
  }

  /** The rules applied to the defaults on a platform. */
  #effective(platform: string): Rule[] {
    let out = this.defaults(platform);
    for (const r of this.#rules) {
      if (r.command.startsWith('-')) {
        const id = r.command.slice(1);
        out = out.filter((e) => !(e.command === id && (r.key === '' || e.key === r.key) && (!r.when || e.when === r.when)));
        continue;
      }
      const rule: Rule = { key: r.key, command: r.command, when: r.when || this.#byID.get(r.command)!.when };
      if (!out.some((e) => e.key === rule.key && e.command === rule.command && e.when === rule.when)) out.push(rule);
    }
    return out;
  }

  /** The user's rules, the effective bindings and conflicts per platform,
   * and the problems of the file. */
  state(): State {
    const st: State = { user: this.#user.slice(), effective: {}, conflicts: {}, problems: this.#problems.map((p) => ({ ...p })) };
    for (const p of sortedPlatforms) {
      const eff = this.#effective(p);
      st.effective[p] = eff;
      st.conflicts[p] = conflicts(eff);
    }
    return st;
  }

  /** The commands for the API. */
  commandList(): CommandJSON[] {
    return this.#commands.map((c) => ({ id: c.id, section: c.section, when: c.when }));
  }

  /** The default bindings of every platform. */
  allDefaults(): Record<string, Rule[]> {
    const out: Record<string, Rule[]> = {};
    for (const p of sortedPlatforms) out[p] = this.defaults(p);
    return out;
  }
}

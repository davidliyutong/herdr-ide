// The one settings system of the hub and of its clients (the web UI, also
// inside the desktop app), modeled on VS Code's: typed definitions
// (define.ts), a hand-editable JSONC file on the hub host, layered values
// and generic settings UIs rendered from the definitions.
//
// A value comes from, in order: the command line (which locks the setting,
// also for every machine), the machine's own value for settings whose scope
// allows one, the file's global value, the default.
//
// The file (settings[-<instance>].json) holds global values as top-level
// "key": value members and a machine's own values under "[machine:<id>]".
// Keys it does not know and values that do not validate stay in it and are
// reported as problems; such a value counts as unset. A file that is not
// JSON keeps the values read before and refuses changes until it is fixed.
import type { Node } from 'jsonc-parser';
import { getNodeValue, parseTree } from 'jsonc-parser';
import { ConfigFail, detailed, saveFailed } from '../fail.ts';
import { members, parseText, removeValue, setValue, UserFile } from '../jsonc.ts';
import {
  validate,
  type Defs,
  type Module,
  type Scope,
  type Section,
  type Setting,
  type SettingType,
  type SettingValue,
  type ValueOf,
} from './define.ts';

/** A setting with its key. */
export type Def = Setting & { readonly key: string };

/** Where a setting's current value comes from. */
export type Source = 'default' | 'global' | 'machine' | 'flag';

/** Something wrong in the settings file: a key no definition has
 * ("unknown"), a value that does not validate ("invalid"), a per-machine
 * value of a setting without them ("scope") or a file that is not a JSON
 * object ("parse", without a key). */
export interface Problem {
  key?: string;
  machine?: string;
  code: string;
  detail?: string;
}

/** A setting whose value changed, globally (machine "") or for one machine. */
export interface Change {
  key: string;
  machine: string;
}

/** A definition as the API lists it (web/src/settings.ts SettingDef). */
export interface DefJSON {
  key: string;
  type: SettingType;
  default: SettingValue;
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  item?: SettingType;
  length?: number;
  options?: string[];
  scope: Scope;
  section: string;
  group?: string;
  order: number;
  flag?: string;
}

/** A setting's state for the API: its global value and source, machines'
 * own values, and whether a flag fixes it. */
export interface Value {
  value: SettingValue;
  source: Source;
  machines?: Record<string, SettingValue>;
  locked?: boolean;
}

/** Every setting's value and the file's problems: what the API returns and
 * pushes after each change. */
export interface State {
  values: Record<string, Value>;
  problems: Problem[];
}

/** A setting's command-line flag, for the command line's parser: it takes
 * a value (--gui off, --gui=off) and locks the setting. */
export interface SettingFlag {
  /** Without dashes. */
  name: string;
  key: string;
  usage: string;
  /** The default as the flag takes it. */
  default: string;
}

export interface SettingsOptions {
  /** Every module of the hub: the kernel's, the features'. */
  modules?: readonly Module[];
  /** The command line's values by flag name (the values of others are
   * ignored): they set and lock their settings. */
  flags?: Readonly<Record<string, unknown>>;
  /** How often watch looks at the file. */
  pollMs?: number;
}

/** Keys whose value type T can be read as. */
type KeysOf<S extends Defs, T> = {
  [K in keyof S & string]: ValueOf<S[K]> extends T ? K : T extends ValueOf<S[K]> ? K : never;
}[keyof S & string];

// "[machine:<id>]" holds a machine's own values in the file.
const machineKey = (id: string) => `[machine:${id}]`;
const machineOf = (key: string): string | undefined => /^\[machine:(.+)\]$/s.exec(key)?.[1];

/** Bounds machine ids taken from requests. */
const validMachine = (id: string) => id !== '' && Buffer.byteLength(id) <= 256 && !/[\0\n\r[\]]/.test(id);

const clone = <T extends SettingValue>(v: T): T => (Array.isArray(v) ? (v.slice() as T) : v);
const same = (a: SettingValue, b: SettingValue) =>
  Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The values the file sets. */
interface Values {
  global: Map<string, SettingValue>;
  machines: Map<string, Map<string, SettingValue>>;
}

/** The flags of the modules' settings, in UI order. */
export function settingFlags(modules: readonly Module[]): SettingFlag[] {
  return definitions(modules)
    .defs.filter((d) => d.flag)
    .map((d) => ({ name: d.flag!, key: d.key, usage: d.usage ?? '', default: flagText(d.default) }));
}

/** The modules' sections and settings in UI order; invalid definitions
 * throw: they are programming errors. */
function definitions(modules: readonly Module[]): { sections: Section[]; defs: Def[] } {
  const sections: Section[] = [];
  for (const m of modules) {
    for (const s of m.sections ?? []) {
      if (sections.some((x) => x.id === s.id)) throw new Error(`settings: duplicate section ${s.id}`);
      sections.push({ id: s.id, order: s.order, ...(s.advanced ? { advanced: true } : {}), ...(s.plugin ? { plugin: s.plugin } : {}) });
    }
  }
  sections.sort((a, b) => a.order - b.order);
  const index = (id: string) => sections.findIndex((s) => s.id === id);
  const defs: Def[] = [];
  const keys = new Set<string>();
  for (const m of modules) {
    for (const [key, s] of Object.entries(m.settings ?? {})) {
      if (keys.has(key) || key === '' || key.startsWith('[')) throw new Error(`settings: invalid or duplicate key ${key}`);
      if (index(s.section) < 0) throw new Error(`settings: ${key} is in unknown section ${s.section}`);
      const r = validate(s, s.default);
      if (!r.ok) throw new Error(`settings: ${key}: default ${JSON.stringify(s.default)}: ${r.why}`);
      keys.add(key);
      defs.push({ ...s, key, default: r.value });
    }
  }
  defs.sort((a, b) => index(a.section) - index(b.section) || a.order - b.order);
  return { sections, defs };
}

/** A value the way its flag takes it. */
function flagText(v: SettingValue): string {
  return Array.isArray(v) ? v.join(',') : String(v);
}

const decimal = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** A flag's text as a value of the setting: true, on, yes or 1 (false,
 * off, no, 0) for a bool, a decimal number, items separated by commas. */
function fromFlag(d: Def, text: string): SettingValue {
  const refuse = (why: string) => detailed('invalid', 400, `invalid value: --${d.flag}: ${why}`);
  let v: unknown = text;
  switch (d.type) {
    case 'bool': {
      const t = text.toLowerCase();
      if (['true', 'on', 'yes', '1'].includes(t)) v = true;
      else if (['false', 'off', 'no', '0'].includes(t)) v = false;
      else throw refuse(`${d.key} must be true or false (on or off)`);
      break;
    }
    case 'number':
      if (!decimal.test(text)) throw refuse(`${d.key} must be a number`);
      v = Number(text);
      break;
    case 'list':
      v = text === '' ? [] : text.split(',');
      break;
  }
  const r = validate(d, v);
  if (!r.ok) throw refuse(`${d.key}: ${r.why}`);
  return r.value;
}

/** Holds the definitions and the current values. S types the keys of a
 * store made of known modules (of). */
export class Settings<S extends Defs = Defs> {
  readonly #file: UserFile;
  readonly #sections: readonly Section[];
  readonly #defs: readonly Def[];
  readonly #defsByName: readonly Def[];
  readonly #byKey: ReadonlyMap<string, Def>;
  #defsJSON?: DefJSON[];
  readonly #flags = new Map<string, SettingValue>();
  readonly #subs = new Set<(changes: Change[]) => void>();
  readonly #pollMs: number;
  // The file's text as last read or written: changes are edits of it.
  #text = '';
  // Set while the file is not a JSON object: values stay as they were and
  // nothing is written over it.
  #broken = false;
  #values: Values = { global: new Map(), machines: new Map() };
  #problems: Problem[] = [];

  /** A store of the modules' settings saved in path ("" keeps them in
   * memory). Invalid definitions throw, and so does an invalid flag's
   * value (a ConfigFail, invalid). */
  constructor(path = '', o: SettingsOptions = {}) {
    this.#file = new UserFile(path);
    this.#pollMs = o.pollMs ?? 2000;
    const { sections, defs } = definitions(o.modules ?? []);
    this.#sections = sections;
    this.#defs = defs;
    this.#defsByName = [...defs].sort((a, b) => byName(a.key, b.key));
    this.#byKey = new Map(defs.map((d) => [d.key, d]));
    for (const d of defs) {
      const text = d.flag ? o.flags?.[d.flag] : undefined;
      if (typeof text === 'string') this.#flags.set(d.key, fromFlag(d, text));
    }
  }

  /** The settings file ("" in memory). */
  get path(): string {
    return this.#file.path;
  }

  /** The same store, typed by a module registered in it: of(m).get(key)
   * has the type of the key's setting. */
  of<T extends Defs>(m: Module<T>): Settings<T> {
    for (const key of Object.keys(m.settings ?? {})) if (!this.#byKey.has(key)) throw new Error(`settings: ${key} is not registered`);
    return this as unknown as Settings<T>;
  }

  /** The sections in UI order. */
  sections(): Section[] {
    return this.#sections.map((s) => ({ ...s }));
  }

  /** The definitions in UI order. */
  defs(): readonly Def[] {
    return this.#defs;
  }

  /** A setting's definition. */
  lookup(key: string): Def | undefined {
    return this.#byKey.get(key);
  }

  /** The definitions for the API, in UI order. */
  definitions(): DefJSON[] {
    this.#defsJSON ??= this.#defs.map((d) => ({
      key: d.key,
      type: d.type,
      default: clone(d.default),
      ...(d.enum?.length ? { enum: [...d.enum] } : {}),
      ...(d.min !== undefined ? { min: d.min } : {}),
      ...(d.max !== undefined ? { max: d.max } : {}),
      ...(d.integer ? { integer: true } : {}),
      ...(d.step ? { step: d.step } : {}),
      ...(d.item ? { item: d.item } : {}),
      ...(d.length ? { length: d.length } : {}),
      ...(d.options?.length ? { options: [...d.options] } : {}),
      scope: d.scope,
      section: d.section,
      ...(d.group ? { group: d.group } : {}),
      order: d.order,
      ...(d.flag ? { flag: d.flag } : {}),
    }));
    return structuredClone(this.#defsJSON);
  }

  /** Reads the file (a missing one is empty); throws when it cannot be
   * read. A file that is not JSON is reported as a problem. */
  load(): void {
    if (this.path) this.#read();
  }

  /** Reads the file again if someone changed it since it was last read or
   * written; subscribers learn what changed. */
  reload(): void {
    if (!this.#file.changed()) return;
    const before = this.#effective();
    const problems = JSON.stringify(this.#problems);
    try {
      this.#read();
    } catch {
      return;
    }
    const changes = diff(before, this.#effective());
    if (changes.length > 0 || JSON.stringify(this.#problems) !== problems) this.#notify(changes);
  }

  /** Reloads the file when it is edited by hand, looking every pollMs (or
   * everyMs) until signal aborts. */
  watch(signal: AbortSignal, everyMs = this.#pollMs): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const t = setInterval(() => this.reload(), everyMs);
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** A setting's value for a machine ("" or absent: the global value).
   * An unknown key throws: settings are registered before they are read. */
  get<K extends keyof S & string>(key: K, machine = ''): ValueOf<S[K]> {
    return clone(this.#valueFor(this.#def(key), machine)[0]) as ValueOf<S[K]>;
  }

  /** A bool setting's value (false if it is not a bool). */
  bool(key: KeysOf<S, boolean>, machine = ''): boolean {
    return this.#valueFor(this.#def(key), machine)[0] === true;
  }

  /** A string, enum or color setting's value ("" if it is none). */
  string(key: KeysOf<S, string>, machine = ''): string {
    const v = this.#valueFor(this.#def(key), machine)[0];
    return typeof v === 'string' ? v : '';
  }

  /** A number setting's value (0 if it is not a number). */
  number(key: KeysOf<S, number>, machine = ''): number {
    const v = this.#valueFor(this.#def(key), machine)[0];
    return typeof v === 'number' ? v : 0;
  }

  /** Validates and saves a value, globally (machine "") or as a machine's
   * own; throws a Fail: unknown, scope, invalid, locked, file, save. */
  set(key: string, machine: string, value: unknown): void {
    const d = this.#known(key);
    if (machine && (d.scope === 'app' || !validMachine(machine))) throw detailed('scope', 400, `setting has no per-machine values: ${key}`);
    const r = validate(d, value);
    if (!r.ok) throw detailed('invalid', 400, `invalid value: ${key}: ${r.why}`);
    this.#change(d, machine, r.value);
  }

  /** Removes a value: the global one (machine "") falls back to the
   * default, a machine's own to the global value. Throws as set. */
  reset(key: string, machine: string): void {
    const d = this.#known(key);
    if (machine && !validMachine(machine)) throw detailed('scope', 400, `setting has no per-machine values: ${key}`);
    this.#change(d, machine, undefined);
  }

  /** Calls fn after values change (through set and reset, or an edit of
   * the file); changes are empty when only the problems did. Returns what
   * unsubscribes it. */
  onChange(fn: (changes: Change[]) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** The current values (keys sorted) and the file's problems. */
  state(): State {
    const values: Record<string, Value> = {};
    const machines = [...this.#values.machines.keys()].sort(byName);
    for (const d of this.#defsByName) {
      const [value, source] = this.#valueFor(d, '');
      const e: Value = { value: clone(value), source };
      if (d.scope !== 'app') {
        for (const m of machines) {
          const v = this.#values.machines.get(m)!.get(d.key);
          if (v !== undefined) (e.machines ??= {})[m] = clone(v);
        }
      }
      if (source === 'flag') e.locked = true;
      values[d.key] = e;
    }
    return { values, problems: this.#problems.map((p) => ({ ...p })) };
  }

  #def(key: string): Def {
    const d = this.#byKey.get(key);
    if (!d) throw new Error(`settings: unknown setting ${key}`);
    return d;
  }

  #known(key: string): Def {
    const d = this.#byKey.get(key);
    if (!d) throw new ConfigFail('unknown', 404, `unknown setting: ${key}`);
    return d;
  }

  #valueFor(d: Def, machine: string): [SettingValue, Source] {
    const flag = this.#flags.get(d.key);
    if (flag !== undefined) return [flag, 'flag'];
    if (machine && d.scope !== 'app') {
      const v = this.#values.machines.get(machine)?.get(d.key);
      if (v !== undefined) return [v, 'machine'];
    }
    const v = this.#values.global.get(d.key);
    return v !== undefined ? [v, 'global'] : [d.default, 'default'];
  }

  /** Reads the file into the values; throws when it cannot be read. */
  #read(): void {
    const text = this.#file.read();
    const parsed = parseText(text);
    const top = parsed.error === undefined && parsed.tree !== undefined ? members(parsed.tree) : undefined;
    if (parsed.error !== undefined || (parsed.tree !== undefined && !top)) {
      this.#broken = true;
      this.#problems = [{ code: 'parse', detail: parsed.error ?? 'not a JSON object' }];
      return;
    }
    this.#broken = false;
    this.#apply(text, top ?? new Map());
  }

  /** Makes text, whose members are top, the file's content. */
  #apply(text: string, top: Map<string, Node>): void {
    const values: Values = { global: new Map(), machines: new Map() };
    const problems: Problem[] = [];
    const value = (d: Def, node: Node): { ok: true; value: SettingValue } | { ok: false; why: string } => {
      const r = validate(d, getNodeValue(node));
      return r.ok ? r : { ok: false, why: `invalid value: ${d.key}: ${r.why}` };
    };
    for (const k of [...top.keys()].sort(byName)) {
      const node = top.get(k)!;
      const id = machineOf(k);
      if (id === undefined) {
        const d = this.#byKey.get(k);
        if (!d) {
          problems.push({ key: k, code: 'unknown' });
          continue;
        }
        const r = value(d, node);
        if (r.ok) values.global.set(k, r.value);
        else problems.push({ key: k, code: 'invalid', detail: r.why });
        continue;
      }
      if (node.type === 'null') continue;
      const own = members(node);
      if (!own) {
        problems.push({ key: k, code: 'invalid', detail: 'must be an object of settings' });
        continue;
      }
      for (const key of [...own.keys()].sort(byName)) {
        const d = this.#byKey.get(key);
        if (!d) {
          problems.push({ key, machine: id, code: 'unknown' });
        } else if (d.scope === 'app') {
          problems.push({ key, machine: id, code: 'scope' });
        } else {
          const r = value(d, own.get(key)!);
          if (!r.ok) {
            problems.push({ key, machine: id, code: 'invalid', detail: r.why });
            continue;
          }
          let vals = values.machines.get(id);
          if (!vals) values.machines.set(id, (vals = new Map()));
          vals.set(key, r.value);
        }
      }
    }
    this.#text = text;
    this.#values = values;
    this.#problems = problems;
  }

  /** Saves value (undefined removes it) and notifies the subscribers. */
  #change(d: Def, machine: string, value: SettingValue | undefined): void {
    if (this.#flags.has(d.key)) throw new ConfigFail('locked', 409, `setting is fixed by a command-line flag: --${d.flag}`);
    const before = this.#effective();
    // Edits made by hand since the last read are kept.
    if (this.#file.changed()) {
      try {
        this.#read();
      } catch (e) {
        throw saveFailed(e);
      }
    }
    if (this.#broken) throw new ConfigFail('file', 409, 'the settings file has errors');
    const text = machine
      ? this.#machineEdit(d.key, machine, value)
      : value === undefined
        ? removeValue(this.#text, [d.key])
        : setValue(this.#text, [d.key], value, globalSlot(d.key));
    if (text !== this.#text) {
      try {
        this.#file.write(text);
      } catch (e) {
        throw saveFailed(e);
      }
    }
    this.#apply(text, members(parseTree(text)) ?? new Map());
    const changes = diff(before, this.#effective());
    if (!changes.some((c) => c.key === d.key && c.machine === machine)) changes.push({ key: d.key, machine });
    this.#notify(changes);
  }

  /** The text with machine's own value of key set (undefined removes it;
   * the machine's entry goes with its last value). */
  #machineEdit(key: string, machine: string, value: SettingValue | undefined): string {
    const mk = machineKey(machine);
    const entry = members(parseTree(this.#text))?.get(mk);
    if (entry && entry.type !== 'object' && entry.type !== 'null') throw new ConfigFail('file', 409, 'the settings file has errors');
    const own = members(entry) ?? new Map<string, Node>();
    const left = [...own.keys()].filter((k) => k !== key).length + (value === undefined ? 0 : 1);
    if (left === 0) return removeValue(this.#text, [mk]);
    if (value === undefined) return removeValue(this.#text, [mk, key]);
    if (!own.size) return setValue(this.#text, [mk], { [key]: value }, machineSlot(mk));
    return setValue(this.#text, [mk, key], value, sortedSlot(key));
  }

  /** Every value the file sets, by machine ("" for global ones) and key. */
  #effective(): Map<string, { change: Change; value: SettingValue }> {
    const out = new Map<string, { change: Change; value: SettingValue }>();
    for (const [key, value] of this.#values.global) out.set(`\n${key}`, { change: { key, machine: '' }, value });
    for (const [machine, vals] of this.#values.machines) {
      for (const [key, value] of vals) out.set(`${machine}\n${key}`, { change: { key, machine }, value });
    }
    return out;
  }

  #notify(changes: Change[]): void {
    for (const fn of [...this.#subs]) fn(changes);
  }
}

/** What differs between two sets of values, by key and machine. */
function diff(a: Map<string, { change: Change; value: SettingValue }>, b: Map<string, { change: Change; value: SettingValue }>): Change[] {
  const out: Change[] = [];
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !same(v.value, w.value)) out.push(v.change);
  }
  for (const [k, v] of b) if (!a.has(k)) out.push(v.change);
  return out.sort((x, y) => byName(x.key, y.key) || byName(x.machine, y.machine));
}

// Where a new member goes, so that a file the UIs write reads as the Go
// hub wrote it: global values sorted, then each machine's entry, sorted.
const sortedSlot = (key: string) => (names: string[]) => slot(names, (n) => n > key);
const globalSlot = (key: string) => (names: string[]) => slot(names, (n) => machineOf(n) !== undefined || n > key);
const machineSlot = (mk: string) => (names: string[]) => slot(names, (n) => machineOf(n) !== undefined && n > mk);
const slot = (names: string[], after: (name: string) => boolean) => {
  const i = names.findIndex(after);
  return i < 0 ? names.length : i;
};

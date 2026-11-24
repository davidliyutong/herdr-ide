// The one settings system of the core and of its clients (the web UI, also
// inside the desktop app), modeled on VS Code's: a registry of typed
// definitions, a hand-editable JSON file on the core host, layered values
// and generic settings UIs rendered from the definitions.
//
// Packages define the settings they use (Module) and the core registers them
// all (internal/registry). Labels and descriptions are not here: the UIs
// translate settings.<key>, settings.<key>.desc and settings.<key>.<option>.
//
// A value comes from, in order: the command line (which locks the setting,
// also for every machine), the machine's own value for settings whose scope
// allows one, the file's global value, the default.
//
// The file (settings[-<instance>].json) holds global values as top-level
// "key": value pairs and a machine's own values under "[machine:<id>]".
// Keys it does not know and values that do not validate are kept when it is
// rewritten and reported as problems; such a value counts as unset.
import { byteOrder, compact, indent, marshal, members } from '#shared/lib/gojson.ts';
import * as userfile from '#shared/host/userfile.ts';

/** The type of a setting's value. */
export const Type = {
  Bool: 'bool',
  Number: 'number',
  String: 'string',
  Enum: 'enum',
  /** "#rrggbb" */
  Color: 'color',
  /** of Item values */
  List: 'list',
} as const;
export type Type = (typeof Type)[keyof typeof Type];

/** Which machines may have their own value of a setting. */
export const Scope = {
  /** One value for everything. */
  App: 'app',
  /** Any machine may differ. */
  Machine: 'machine',
  /** Machines other than the core's host may differ. */
  RemoteMachine: 'remote-machine',
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

/** Where a setting's current value comes from. */
export const Source = {
  Default: 'default',
  Global: 'global',
  Machine: 'machine',
  Flag: 'flag',
} as const;
export type Source = (typeof Source)[keyof typeof Source];

/** The errors of set and reset by the code the API reports them as (Go's
 * ErrUnknown, ErrLocked, ErrInvalid, ErrScope and ErrFile). */
export const ErrorCode = {
  Unknown: 'unknown',
  Locked: 'locked',
  Invalid: 'invalid',
  Scope: 'scope',
  File: 'file',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const errorText: Record<ErrorCode, string> = {
  unknown: 'unknown setting',
  locked: 'setting is fixed by a command-line flag',
  invalid: 'invalid value',
  scope: 'setting has no per-machine values',
  file: 'the settings file has errors',
};

/** An error of set, reset or a flag: its code is what the API reports,
 * its message the detail ("invalid value: a.size: must be between…"). */
export class SettingsError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail?: string) {
    super(detail === undefined ? errorText[code] : `${errorText[code]}: ${detail}`);
    this.name = 'SettingsError';
    this.code = code;
  }
}

/** Whether e is a SettingsError (of code, when given). */
export function isSettingsError(e: unknown, code?: ErrorCode): e is SettingsError {
  return e instanceof SettingsError && (code === undefined || e.code === code);
}

/** A setting's value: a bool, number, string or list of strings, by its type. */
export type SettingValue = boolean | number | string | string[];

/** A group of settings in the UIs; sections are shown by order, the
 * advanced ones after the others under a heading of their own. A plugin's
 * section names its plugin (internal/plugin's id): the UIs list it under
 * the plugins and say when the plugin is off. */
export interface Section {
  id: string;
  order: number;
  advanced?: boolean;
  plugin?: string;
}

/** Defines a setting. */
export interface Def {
  /** Dotted, e.g. "terminal.fontSize". */
  key: string;
  type: Type;
  /** A bool, number, string or list of strings, by type. */
  default: SettingValue;
  /** The values of an enum setting. */
  enum?: string[];
  /** Bounds of a number setting (absent: unbounded); integer refuses
   * fractions; step is what the UIs' stepper adds (0 or absent: 1). */
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  /** The type of a list's items (string or color); length the number of
   * items a list must have (0 or absent: any up to 256). options are the
   * values the UIs offer for a list of strings; others can be added. */
  item?: Type;
  length?: number;
  options?: string[];
  /** Absent: app. */
  scope?: Scope;
  /** section and order place the setting in the UIs; group names a heading
   * within the section (settings of a group are next to each other). */
  section: string;
  group?: string;
  order?: number;
  /** A command-line flag that sets and locks the setting, with usage as
   * its help text. */
  flag?: string;
  usage?: string;
  /** Checks a value beyond its type, throwing an Error to refuse it;
   * absent accepts any. */
  validate?: (v: SettingValue) => void;
}

/** min and max of a Def, to spread into it. */
export function range(min: number, max: number): { min: number; max: number } {
  return { min, max };
}

/** What a package registers: its sections and settings. */
export interface Module {
  sections?: Section[];
  defs?: Def[];
}

/** Something wrong in the settings file: a key no definition has
 * ("unknown"), a value that does not validate ("invalid"), a per-machine
 * value of a setting without them ("scope") or a file that is not JSON
 * ("parse", without a key). */
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

const colorRE = /^#[0-9a-fA-F]{6}$/;
// Go's unicode.IsControl: C0, DEL and C1.
const controlRE = /[\u0000-\u001f\u007f-\u009f]/;

const maxString = 4096;

/** Checks v (as decoded from JSON) against the definition and returns it
 * in its canonical form; throws a SettingsError (invalid) otherwise. */
export function normalize(d: Def, v: unknown): SettingValue {
  let out: SettingValue;
  try {
    out = check(d, v);
    d.validate?.(out);
  } catch (e) {
    throw new SettingsError('invalid', `${d.key}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

function check(d: Def, v: unknown): SettingValue {
  switch (d.type) {
    case 'bool':
      if (typeof v !== 'boolean') throw new Error('must be true or false');
      return v;
    case 'number':
      if (typeof v !== 'number') throw new Error('must be a number');
      if (!Number.isFinite(v)) throw new Error('must be a finite number');
      if (d.integer && v !== Math.trunc(v)) throw new Error('must be a whole number');
      if ((d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max)) {
        throw new Error(`must be between ${fmtNum(d.min)} and ${fmtNum(d.max)}`);
      }
      return v;
    case 'string':
    case 'enum':
    case 'color':
      if (typeof v !== 'string') throw new Error('must be a string');
      return checkString(d.type, d.enum, v);
    case 'list': {
      if (!Array.isArray(v)) throw new Error('must be a list');
      for (const it of v) if (typeof it !== 'string') throw new Error('items must be strings');
      const items = v as string[];
      if (d.length && items.length !== d.length) throw new Error(`must have ${d.length} items`);
      if (items.length > 256) throw new Error('too many items');
      return items.map((s, i) => {
        try {
          return checkString(d.item, undefined, s);
        } catch (e) {
          throw new Error(`item ${i + 1}: ${(e as Error).message}`);
        }
      });
    }
  }
  throw new Error(`unknown type ${d.type}`);
}

function checkString(t: Type | undefined, enumValues: string[] | undefined, s: string): string {
  // No control character: C0 (line breaks, ESC, NUL…), DEL and C1: a
  // string is shown in the UIs and written into the settings file.
  if (controlRE.test(s) || Buffer.byteLength(s) > maxString) throw new Error('contains control characters or is too long');
  switch (t) {
    case 'enum':
      if (!enumValues?.includes(s)) throw new Error(`must be one of ${(enumValues ?? []).join(', ')}`);
      break;
    case 'color':
      if (!colorRE.test(s)) throw new Error('must be a color #rrggbb');
      s = s.toLowerCase();
      break;
  }
  return s;
}

/** A number as Go's strconv.FormatFloat(n, 'f', -1, 64) writes it: the
 * shortest digits that read back as n, never with an exponent. */
export function formatFloat(n: number): string {
  const s = String(n);
  const e = s.indexOf('e');
  if (e < 0) return s;
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.slice(neg ? 1 : 0, e).split('.');
  const digits = int + frac;
  const point = int.length + Number(s.slice(e + 1));
  let out: string;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  return (neg ? '-' : '') + out;
}

function fmtNum(n: number | undefined): string {
  return n === undefined ? 'any' : formatFloat(n);
}

// Go's strconv.ParseFloat: decimal numbers, infinities and NaN (which
// normalize then refuses).
const floatRE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^[+-]?(inf|infinity|nan)$/i;

/** Turns a flag's text into a value of the setting. */
function parseFlag(d: Def, s: string): SettingValue {
  switch (d.type) {
    case 'bool':
      switch (s.toLowerCase()) {
        case 'true':
        case 'on':
        case 'yes':
        case '1':
          return normalize(d, true);
        case 'false':
        case 'off':
        case 'no':
        case '0':
          return normalize(d, false);
      }
      throw new SettingsError('invalid', `${d.key} must be true or false (on or off)`);
    case 'number': {
      if (!floatRE.test(s)) throw new SettingsError('invalid', `${d.key} must be a number`);
      const lower = s.toLowerCase().replace(/^\+/, '');
      const n = /inf/.test(lower) ? (lower.startsWith('-') ? -Infinity : Infinity) : Number(lower);
      return normalize(d, n);
    }
    case 'list':
      return normalize(d, s === '' ? [] : s.split(','));
  }
  return normalize(d, s);
}

/** A value the way its flag takes it. */
function formatFlag(v: SettingValue): string {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return formatFloat(v);
  if (Array.isArray(v)) return v.join(',');
  return v;
}

// machinePrefix and machineSuffix enclose a machine's id in the file:
// "[machine:<id>]".
const machinePrefix = '[machine:';
const machineSuffix = ']';

function machineKey(id: string): string {
  return machinePrefix + id + machineSuffix;
}

function machineOf(key: string): string | undefined {
  if (key.startsWith(machinePrefix) && key.endsWith(machineSuffix) && key.length > machinePrefix.length + machineSuffix.length) {
    return key.slice(machinePrefix.length, key.length - machineSuffix.length);
  }
  return undefined;
}

/** Bounds machine ids taken from requests. */
function validMachine(id: string): boolean {
  return id !== '' && Buffer.byteLength(id) <= 256 && !/[\u0000\n\r[\]]/.test(id);
}

// Go's bytes.TrimSpace: a file of only these is empty.
const blankRE = /^[\t\n\v\f\r \u0085\u00a0]*$/;

function clone(v: SettingValue): SettingValue {
  return Array.isArray(v) ? v.slice() : v;
}

function equal(a: SettingValue, b: SettingValue): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

function sameProblems(a: Problem[], b: Problem[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && p.machine === b[i].machine && p.code === b[i].code && p.detail === b[i].detail)
  );
}

function problem(code: string, key?: string, machine?: string, detail?: string): Problem {
  const p: Problem = {} as Problem;
  if (key) p.key = key;
  if (machine) p.machine = machine;
  p.code = code;
  if (detail) p.detail = detail;
  return p;
}

/** A setting's command-line flag: set gives its text, sets the setting
 * and locks it (a SettingsError, invalid, when it does not take it). */
export interface SettingFlag {
  /** The flag's name, without dashes. */
  name: string;
  usage: string;
  /** The setting's default as the flag takes it. */
  defaultText: string;
  set(text: string): void;
}

/** A definition as the API lists it. */
export interface DefJSON {
  key: string;
  type: Type;
  default: SettingValue;
  enum?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  item?: Type;
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

// effective's entries, by JSON.stringify([key, machine]).
type Effective = Map<string, { change: Change; value: SettingValue }>;

function diff(a: Effective, b: Effective): Change[] {
  const out: Change[] = [];
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !equal(v.value, w.value)) out.push(v.change);
  }
  for (const [k, v] of b) if (!a.has(k)) out.push(v.change);
  return out.sort((x, y) => byteOrder(x.key, y.key) || byteOrder(x.machine, y.machine));
}

/** Writes the file: global values first, then each machine's, keys
 * sorted, two-space indentation. */
function encode(raw: Map<string, string>): string {
  const keys = [...raw.keys()].sort(byteOrder);
  keys.sort((a, b) => Number(machineOf(a) !== undefined) - Number(machineOf(b) !== undefined));
  let out = '{';
  keys.forEach((k, i) => {
    if (i > 0) out += ',';
    out += `\n  ${marshal(k)}: ${indent(raw.get(k)!, '  ', '  ')}`;
  });
  if (keys.length > 0) out += '\n';
  return out + '}\n';
}

/** A machine's own values as json.Marshal writes a map: keys sorted. */
function encodeObject(own: Map<string, string>): string {
  const keys = [...own.keys()].sort(byteOrder);
  return '{' + keys.map((k) => marshal(k) + ':' + compact(own.get(k)!)).join(',') + '}';
}

/** Holds the definitions and the current values. */
export class Store {
  readonly #sections: Section[] = [];
  readonly #defs: Def[] = [];
  readonly #byKey = new Map<string, number>();

  #path: string;
  #sig: userfile.Sig | undefined;
  // The file's entries as last read or written (values as written): those
  // this version does not know or cannot use are kept from here.
  #raw = new Map<string, string>();
  #global = new Map<string, SettingValue>(); // valid global values
  #machines = new Map<string, Map<string, SettingValue>>(); // machine id → valid own values
  #problems: Problem[] = [];
  // Set while the file is not JSON: values stay as they were and nothing is
  // written over it.
  #broken = false;
  readonly #flags = new Map<string, SettingValue>();
  readonly #subs: ((changes: Change[]) => void)[] = [];

  /** A store for the modules' settings, saved in path ("" keeps values in
   * memory). Invalid definitions throw: they are programming errors. */
  constructor(path: string, ...modules: Module[]) {
    this.#path = path;
    const sectionIDs = new Set<string>();
    for (const m of modules) {
      for (const sec of m.sections ?? []) {
        if (sectionIDs.has(sec.id)) throw new Error('settings: duplicate section ' + sec.id);
        sectionIDs.add(sec.id);
        const s: Section = { id: sec.id, order: sec.order };
        if (sec.advanced) s.advanced = true;
        if (sec.plugin) s.plugin = sec.plugin;
        this.#sections.push(s);
      }
    }
    this.#sections.sort((a, b) => a.order - b.order);
    for (const m of modules) {
      for (const d of m.defs ?? []) {
        if (this.#byKey.has(d.key) || d.key === '' || d.key.startsWith('[')) throw new Error('settings: invalid or duplicate key ' + d.key);
        if (!sectionIDs.has(d.section)) throw new Error('settings: ' + d.key + ' is in unknown section ' + d.section);
        const def: Def = { ...d, scope: d.scope || Scope.App };
        def.default = normalize(def, d.default);
        this.#byKey.set(d.key, this.#defs.length);
        this.#defs.push(def);
      }
    }
    const index = (id: string) => this.#sections.findIndex((s) => s.id === id);
    this.#defs.sort((a, b) => (a.section !== b.section ? index(a.section) - index(b.section) : (a.order ?? 0) - (b.order ?? 0)));
    this.#defs.forEach((d, i) => this.#byKey.set(d.key, i));
  }

  /** Sets the file values are saved in (before load). */
  setPath(path: string): void {
    this.#path = path;
  }

  /** The settings file. */
  path(): string {
    return this.#path;
  }

  /** The definitions in UI order. */
  defs(): readonly Def[] {
    return this.#defs;
  }

  /** The sections in UI order. */
  sections(): readonly Section[] {
    return this.#sections;
  }

  /** A setting's definition. */
  lookup(key: string): Def | undefined {
    const i = this.#byKey.get(key);
    return i === undefined ? undefined : this.#defs[i];
  }

  /** Reads the settings file (a missing file is empty). A file that is not
   * JSON is reported as a problem and the defaults apply. */
  load(): void {
    if (this.#path) this.#read();
  }

  /** Whether the file changed since it was last read or written. */
  #changedOnDisk(): boolean {
    const now = userfile.stat(this.#path);
    return this.#sig ? !userfile.sameSig(now, this.#sig) : now.exists;
  }

  /** Loads the file into raw and the values; throws when it cannot be read. */
  #read(): void {
    const { data, sig } = userfile.read(this.#path);
    this.#sig = sig;
    const text = data ? data.toString('utf8') : '';
    let raw = new Map<string, string>();
    if (!blankRE.test(text)) {
      let detail = 'not a JSON object';
      let m: Map<string, string> | undefined;
      try {
        JSON.parse(text);
        m = members(text);
      } catch (e) {
        detail = (e as Error).message;
      }
      if (!m) {
        this.#broken = true;
        this.#problems = [problem('parse', undefined, undefined, detail)];
        return;
      }
      raw = m;
    }
    this.#broken = false;
    this.#raw = raw;
    this.#parse();
  }

  /** Derives the values and problems from raw. */
  #parse(): void {
    const global = new Map<string, SettingValue>();
    const machines = new Map<string, Map<string, SettingValue>>();
    const problems: Problem[] = [];
    for (const k of [...this.#raw.keys()].sort(byteOrder)) {
      const id = machineOf(k);
      if (id !== undefined) {
        const text = this.#raw.get(k)!;
        const own = text === 'null' ? new Map<string, string>() : members(text);
        if (!own) {
          problems.push(problem('invalid', k, undefined, 'must be an object of settings'));
          continue;
        }
        for (const key of [...own.keys()].sort(byteOrder)) {
          const d = this.lookup(key);
          if (!d) {
            problems.push(problem('unknown', key, id));
          } else if (d.scope === Scope.App) {
            problems.push(problem('scope', key, id));
          } else {
            try {
              const v = normalize(d, JSON.parse(own.get(key)!));
              let vals = machines.get(id);
              if (!vals) machines.set(id, (vals = new Map()));
              vals.set(key, v);
            } catch (e) {
              problems.push(problem('invalid', key, id, (e as Error).message));
            }
          }
        }
        continue;
      }
      const d = this.lookup(k);
      if (!d) {
        problems.push(problem('unknown', k));
        continue;
      }
      try {
        global.set(k, normalize(d, JSON.parse(this.#raw.get(k)!)));
      } catch (e) {
        problems.push(problem('invalid', k, undefined, (e as Error).message));
      }
    }
    this.#global = global;
    this.#machines = machines;
    this.#problems = problems;
  }

  /** Saves raw as the file and makes it current. */
  #write(raw: Map<string, string>): void {
    if (this.#path) {
      if (this.#broken) throw new SettingsError('file');
      this.#sig = userfile.write(this.#path, encode(raw));
    }
    this.#raw = raw;
    this.#parse();
  }

  /** Reloads the file when it changes on disk (edited by hand), checking
   * every interval until signal aborts; subscribers learn what changed. */
  watch(signal: AbortSignal, everyMs: number): Promise<void> {
    return userfile.poll(signal, everyMs, () => this.reload());
  }

  /** Reads the file again if it changed since it was last read or written. */
  reload(): void {
    if (!this.#path || !this.#changedOnDisk()) return;
    const before = this.#effective();
    const problems = this.#problems.slice();
    try {
      this.#read();
    } catch {
      return;
    }
    const changes = diff(before, this.#effective());
    if (changes.length > 0 || !sameProblems(problems, this.#problems)) {
      for (const fn of this.#subs.slice()) fn(changes);
    }
  }

  /** Every value the file sets: machine "" for global ones. */
  #effective(): Effective {
    const out: Effective = new Map();
    for (const [key, value] of this.#global) out.set(JSON.stringify([key, '']), { change: { key, machine: '' }, value });
    for (const [machine, vals] of this.#machines) {
      for (const [key, value] of vals) out.set(JSON.stringify([key, machine]), { change: { key, machine }, value });
    }
    return out;
  }

  /** The settings' command-line flags, for the command line's parser. */
  flags(): SettingFlag[] {
    return this.#defs
      .filter((d) => d.flag)
      .map((d) => ({
        name: d.flag!,
        usage: d.usage ?? '',
        defaultText: formatFlag(d.default),
        set: (text: string) => {
          this.#flags.set(d.key, parseFlag(d, text));
        },
      }));
  }

  /** A setting's value for a machine ("" for the global value) and its source. */
  #valueFor(d: Def, machine: string): [SettingValue, Source] {
    const flag = this.#flags.get(d.key);
    if (flag !== undefined) return [flag, Source.Flag];
    if (machine && d.scope !== Scope.App) {
      const v = this.#machines.get(machine)?.get(d.key);
      if (v !== undefined) return [v, Source.Machine];
    }
    const v = this.#global.get(d.key);
    if (v !== undefined) return [v, Source.Global];
    return [d.default, Source.Default];
  }

  /** A setting's global value (undefined for unknown keys). */
  get(key: string): SettingValue | undefined {
    return this.getFor(key, '');
  }

  /** A setting's value for a machine ("" for the global value). */
  getFor(key: string, machine: string): SettingValue | undefined {
    const d = this.lookup(key);
    if (!d) return undefined;
    return clone(this.#valueFor(d, machine)[0]);
  }

  /** A string, enum or color setting's value for a machine. */
  string(key: string, machine = ''): string {
    const v = this.getFor(key, machine);
    return typeof v === 'string' ? v : '';
  }

  /** A bool setting's value for a machine. */
  bool(key: string, machine = ''): boolean {
    return this.getFor(key, machine) === true;
  }

  /** Validates and saves a value, globally (machine "") or as a machine's
   * own value; throws a SettingsError, or the file's write error. */
  set(key: string, machine: string, value: unknown): void {
    const d = this.lookup(key);
    if (!d) throw new SettingsError('unknown', key);
    if (machine && (d.scope === Scope.App || !validMachine(machine))) throw new SettingsError('scope', key);
    this.#change(d, machine, marshal(normalize(d, value)));
  }

  /** Removes a value: the global one (machine "") falls back to the
   * default, a machine's own one to the global value. */
  reset(key: string, machine: string): void {
    const d = this.lookup(key);
    if (!d) throw new SettingsError('unknown', key);
    if (machine && !validMachine(machine)) throw new SettingsError('scope', key);
    this.#change(d, machine, undefined);
  }

  /** Saves value (undefined removes it) and notifies the subscribers. */
  #change(d: Def, machine: string, value: string | undefined): void {
    if (this.#flags.has(d.key)) throw new SettingsError('locked', `--${d.flag}`);
    const before = this.#effective();
    // Edits made by hand since the last read are kept.
    if (this.#path && this.#changedOnDisk()) this.#read();
    const raw = new Map(this.#raw);
    if (!machine) {
      if (value === undefined) raw.delete(d.key);
      else raw.set(d.key, value);
    } else {
      const mk = machineKey(machine);
      const prev = raw.get(mk);
      let own = new Map<string, string>();
      if (prev !== undefined && prev !== 'null') {
        const m = members(prev);
        if (!m) throw new SettingsError('file');
        own = m;
      }
      if (value === undefined) own.delete(d.key);
      else own.set(d.key, value);
      if (own.size === 0) raw.delete(mk);
      else raw.set(mk, encodeObject(own));
    }
    this.#write(raw);
    const changes = diff(before, this.#effective());
    if (!changes.some((c) => c.key === d.key && c.machine === machine)) changes.push({ key: d.key, machine });
    for (const fn of this.#subs.slice()) fn(changes);
  }

  /** Registers fn to be called after values change (by the API or an edit
   * of the file); changes can be empty when only the problems did. */
  onChange(fn: (changes: Change[]) => void): void {
    this.#subs.push(fn);
  }

  /** The definitions for the API, in UI order. */
  definitions(): DefJSON[] {
    return this.#defs.map((d) => {
      const out = { key: d.key, type: d.type, default: clone(d.default) } as DefJSON;
      if (d.enum?.length) out.enum = d.enum;
      if (d.min !== undefined) out.min = d.min;
      if (d.max !== undefined) out.max = d.max;
      if (d.integer) out.integer = true;
      if (d.step) out.step = d.step;
      if (d.item) out.item = d.item;
      if (d.length) out.length = d.length;
      if (d.options?.length) out.options = d.options;
      out.scope = d.scope ?? Scope.App;
      out.section = d.section;
      if (d.group) out.group = d.group;
      out.order = d.order ?? 0;
      if (d.flag) out.flag = d.flag;
      return out;
    });
  }

  /** The current values and problems; objects' keys sorted, as Go writes
   * its maps. */
  state(): State {
    const values: Record<string, Value> = {};
    const machineIDs = [...this.#machines.keys()].sort(byteOrder);
    for (const d of [...this.#defs].sort((a, b) => byteOrder(a.key, b.key))) {
      const [v, source] = this.#valueFor(d, '');
      const e: Value = { value: clone(v), source };
      if (d.scope !== Scope.App) {
        for (const m of machineIDs) {
          const mv = this.#machines.get(m)!.get(d.key);
          if (mv !== undefined) (e.machines ??= Object.create(null) as Record<string, SettingValue>)[m] = clone(mv);
        }
      }
      if (source === Source.Flag) e.locked = true;
      values[d.key] = e;
    }
    return { values, problems: this.#problems.map((p) => ({ ...p })) };
  }
}

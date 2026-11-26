// How a setting is defined: a zod schema that validates a value as it
// comes from JSON (a request, the file) and gives its canonical form, with
// what the UIs need to render it and where it goes. The helpers (bool,
// int, number, text, enumOf, color, stringList, colorList) build both; a
// module (defineModule) holds a feature's settings by key, so a store of
// it types each key's value.
//
// Labels and descriptions are not here: the UIs translate settings.<key>,
// settings.<key>.desc and settings.<key>.<option>.
import { z } from 'zod';

/** The type of a setting's value, as the API lists it. */
export type SettingType = 'bool' | 'number' | 'string' | 'enum' | 'color' | 'list';

/** Which machines may have their own value: none (app), any, or those
 * other than the hub's host. */
export type Scope = 'app' | 'machine' | 'remote-machine';

export type SettingValue = boolean | number | string | string[];

/** Where a setting goes and what may set it besides the UIs. */
export interface Placement {
  /** The section it is shown in; order places it there, group names a
   * heading within the section. */
  section: string;
  order?: number;
  group?: string;
  /** Absent: app. */
  scope?: Scope;
  /** A command-line flag that sets and locks the setting (its name without
   * dashes), with usage as its help. */
  flag?: string;
  usage?: string;
}

export interface Setting<T extends SettingValue = SettingValue> {
  readonly type: SettingType;
  readonly default: T;
  /** Checks a value as decoded from JSON and gives its canonical form (a
   * color in lower case); its first issue's message says why not. */
  readonly schema: z.ZodType<T>;
  readonly scope: Scope;
  readonly section: string;
  readonly order: number;
  readonly group?: string;
  readonly flag?: string;
  readonly usage?: string;
  /** The values of an enum. */
  readonly enum?: readonly string[];
  /** A number's bounds (absent: unbounded); integer refuses fractions;
   * step is what the UIs' stepper adds (absent: 1). */
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly step?: number;
  /** A list's items; length the number it must have (absent: up to
   * MAX_ITEMS); options the strings the UIs offer, others can be added. */
  readonly item?: 'string' | 'color';
  readonly length?: number;
  readonly options?: readonly string[];
}

/** A setting's value type. */
export type ValueOf<D> = D extends Setting<infer T> ? T : never;

/** Settings by key ("terminal.fontSize"). */
export type Defs = { readonly [key: string]: Setting };

/** A group of settings in the UIs; sections are shown by order, the
 * advanced ones after the others under a heading of their own. A feature's
 * section names its feature (plugin): the UIs list it under the plugins
 * and say when it is off. */
export interface Section {
  id: string;
  order: number;
  advanced?: boolean;
  plugin?: string;
}

/** What a feature (or the kernel) registers: its sections and settings. */
export interface Module<S extends Defs = Defs> {
  readonly sections?: readonly Section[];
  readonly settings?: S;
}

export const defineModule = <const S extends Defs>(m: {
  sections?: readonly Section[];
  settings: S;
}): Module<S> & { readonly settings: S } => m;

/** The most bytes of a string, and items of a list. */
export const MAX_STRING = 4096;
export const MAX_ITEMS = 256;

/** A check beyond the type: why value is refused, or undefined. */
export type Check<T> = (value: T) => string | undefined;

type Options<T> = Placement & { default: T; check?: Check<T> };

// Every control character: C0 (line breaks, ESC, NUL…), DEL and C1. A
// string is shown in the UIs and written into the settings file.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const plainText = z
  .string({ error: 'must be a string' })
  .refine((s) => !CONTROL.test(s) && Buffer.byteLength(s) <= MAX_STRING, 'contains control characters or is too long');

const colorText = plainText.regex(/^#[0-9a-fA-F]{6}$/, 'must be a color #rrggbb').overwrite((s) => s.toLowerCase());

function setting<T extends SettingValue>(
  type: SettingType,
  schema: z.ZodType<T>,
  o: Options<T>,
  extra: Partial<Setting<T>> = {},
): Setting<T> {
  const check = o.check;
  return {
    type,
    default: o.default,
    schema: check
      ? schema.superRefine(
          (v, ctx) => {
            const why = check(v);
            if (why !== undefined) ctx.addIssue(why);
          },
          { when: (p) => p.issues.length === 0 },
        )
      : schema,
    scope: o.scope ?? 'app',
    section: o.section,
    order: o.order ?? 0,
    ...(o.group ? { group: o.group } : {}),
    ...(o.flag ? { flag: o.flag, usage: o.usage ?? '' } : {}),
    ...extra,
  };
}

export function bool(o: Options<boolean>): Setting<boolean> {
  return setting('bool', z.boolean({ error: 'must be true or false' }), o);
}

type NumberOptions = Options<number> & { min?: number; max?: number; step?: number };

/** A number; integer refuses fractions. */
export function number(o: NumberOptions & { integer?: boolean }): Setting<number> {
  let schema = z.number({ error: (iss) => (typeof iss.input === 'number' ? 'must be a finite number' : 'must be a number') });
  if (o.integer) schema = schema.int({ error: 'must be a whole number' });
  const { min, max } = o;
  if (min !== undefined || max !== undefined) {
    schema = schema.refine(
      (n) => (min === undefined || n >= min) && (max === undefined || n <= max),
      `must be between ${min ?? 'any'} and ${max ?? 'any'}`,
    );
  }
  return setting('number', schema, o, {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(o.integer ? { integer: true } : {}),
    ...(o.step ? { step: o.step } : {}),
  });
}

/** A whole number. */
export const int = (o: NumberOptions): Setting<number> => number({ ...o, integer: true });

/** A string without control characters, of at most MAX_STRING bytes. */
export function text(o: Options<string>): Setting<string> {
  return setting('string', plainText, o);
}

/** One of values. */
export function enumOf<const V extends readonly [string, ...string[]]>(values: V, o: Options<V[number]>): Setting<V[number]> {
  const schema = z.enum(values, {
    error: (iss) => (typeof iss.input === 'string' ? `must be one of ${values.join(', ')}` : 'must be a string'),
  });
  return setting('enum', schema as unknown as z.ZodType<V[number]>, o, { enum: values });
}

/** "#rrggbb", kept in lower case. */
export function color(o: Options<string>): Setting<string> {
  return setting('color', colorText, o);
}

type ListOptions = Options<string[]> & { length?: number };

function list(item: 'string' | 'color', o: ListOptions, options?: readonly string[]): Setting<string[]> {
  const { length } = o;
  const schema = z
    .array(z.unknown(), { error: 'must be a list' })
    .refine((a) => a.every((x) => typeof x === 'string'), 'items must be strings')
    .refine((a) => !length || a.length === length, `must have ${length} items`)
    .refine((a) => a.length <= MAX_ITEMS, 'too many items')
    .pipe(z.array(item === 'color' ? colorText : plainText));
  return setting('list', schema, o, { item, ...(length ? { length } : {}), ...(options?.length ? { options } : {}) });
}

/** A list of strings; options are those the UIs offer. */
export const stringList = (o: ListOptions & { options?: readonly string[] }): Setting<string[]> => list('string', o, o.options);

/** A list of colors. */
export const colorList = (o: ListOptions): Setting<string[]> => list('color', o);

/** value in the setting's canonical form, or why it is not one of its
 * values: the first issue, an item's with its position ("item 2: must be a
 * color #rrggbb"). */
export function validate(s: Setting, value: unknown): { ok: true; value: SettingValue } | { ok: false; why: string } {
  const r = s.schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0]!;
  return { ok: false, why: issue.path.length > 0 ? `item ${Number(issue.path[0]) + 1}: ${issue.message}` : issue.message };
}

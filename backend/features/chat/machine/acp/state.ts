// What a chat states of its ACP agent's session: its configuration options
// (and the session modes of the protocol's older way, as an option of the
// chat's own), its slash commands, its usage; each read from the agent's
// JSON leniently, as Go's decoding of the same members does (a member of
// another type than the protocol's leaves out what holds it), and bounded.
import * as chat from '#shared/proto/chatproto/index.ts';

// Bounds of what a chat keeps of its agent's state.
export const MAX_CONFIG_OPTIONS = 64;
export const MAX_CONFIG_VALUES = 1000;
export const MAX_COMMANDS = 1000;
/** The most characters of a name and of a description kept. */
export const MAX_NAME = 200;
export const MAX_TEXT = 2000;

/** The configuration option a chat makes of an agent's session modes
 * (session/set_mode) when the agent has no option of category mode: the
 * first id unless the agent has an option of that id. */
export const LEGACY_MODE_ID = 'mode';
export const LEGACY_MODE_ID_ALT = '_mode';

/** Client-enforced permission mode option for ACP agents (such as Grok) that
 * advertise neither a mode configOption nor legacy session modes. Enforced in
 * the adapter's session/request_permission handler via allow_once only, so the
 * agent's own configuration files are never modified. */
export function clientModeOption(id: string, currentValue: string = chat.Mode.Default): chat.ConfigOption {
  return {
    id,
    name: 'Mode',
    category: chat.Category.Mode,
    type: chat.CONFIG_SELECT,
    currentValue,
    options: [
      { value: chat.Mode.Default, name: 'Default' },
      { value: chat.Mode.AcceptEdits, name: 'Accept Edits' },
      { value: chat.Mode.Full, name: 'Full Access', full: true },
    ],
  };
}

/** s cut to n characters (code points). */
export function clip(s: string, n: number): string {
  let i = 0;
  let count = 0;
  while (i < s.length) {
    if (count === n) return s.slice(0, i);
    const c = s.codePointAt(i)!;
    i += c > 0xffff ? 2 : 1;
    count++;
  }
  return s;
}

export type Obj = Record<string, unknown>;

/** Whether v is a JSON object. */
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a member holds a value: there and not null. */
export const present = (v: unknown): boolean => v !== undefined && v !== null;

/** A string member as Go decodes one into a string: "" for none (or
 * null), undefined for a value of another type, which fails the decoding of
 * what holds it. */
export function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : undefined;
}

/** An integer member as Go decodes one into an int64: undefined for none,
 * NaN for a value of another type (a fraction, a string). */
export function int(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : NaN;
}

/** Whether every one of keys of o is a string or none. */
function strings(o: Obj, ...keys: string[]): boolean {
  return keys.every((k) => str(o[k]) !== undefined);
}

/** An array member as Go decodes one into a slice: [] for none, undefined
 * for a value of another type. */
function arr(v: unknown): unknown[] | undefined {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : undefined;
}

/** An agent's configuration options as a chat states them: the options of
 * type select, their grouped values one after the other; null for what is
 * no array of them. */
export function configOptions(raw: unknown): chat.ConfigOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: chat.ConfigOption[] = [];
  for (const w of raw) {
    if (!isObj(w) || !strings(w, 'id', 'name', 'description', 'category', 'type')) continue;
    const values = arr(w.options);
    const id = str(w.id)!;
    // Boolean options need a capability this client does not state; a
    // current value of null is Go's "", none at all no option.
    const current = w.currentValue === null ? '' : w.currentValue;
    if (values === undefined || id === '' || w.type !== chat.CONFIG_SELECT || typeof current !== 'string') continue;
    const description = clip(str(w.description)!, MAX_TEXT);
    const category = clip(str(w.category)!, MAX_NAME);
    // The members in the order Go writes them.
    const o: chat.ConfigOption = {
      id: clip(id, MAX_NAME),
      name: clip(str(w.name)!, MAX_NAME),
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      type: chat.CONFIG_SELECT,
      currentValue: current,
      options: [],
    };
    addValues(o, values, 0);
    out.push(o);
    if (out.length === MAX_CONFIG_OPTIONS) break;
  }
  return out;
}

/** Adds an option's values, and those of its groups (one level). */
function addValues(o: chat.ConfigOption, raw: unknown[], depth: number): void {
  for (const v of raw) {
    if (o.options!.length === MAX_CONFIG_VALUES) return;
    if (!isObj(v) || !strings(v, 'name', 'description', 'group') || (present(v.value) && typeof v.value !== 'string')) continue;
    const group = arr(v.options);
    if (group === undefined) continue;
    if (typeof v.value === 'string') {
      const cv: chat.ConfigValue = { value: v.value, name: clip(str(v.name)!, MAX_NAME) };
      const description = clip(str(v.description)!, MAX_TEXT);
      if (description) cv.description = description;
      o.options!.push(cv);
    } else if (present(v.options) && depth === 0) {
      addValues(o, group, depth + 1);
    }
  }
}

/** The configuration option a chat makes of an agent's session modes,
 * under id; null for what are no modes. */
export function modesOption(raw: unknown, id: string): chat.ConfigOption | null {
  if (!isObj(raw) || str(raw.currentModeId) === undefined) return null;
  const modes = arr(raw.availableModes);
  if (modes === undefined || modes.length === 0) return null;
  if (!modes.every((m) => m === null || (isObj(m) && strings(m, 'id', 'name', 'description')))) return null;
  const o: chat.ConfigOption = {
    id,
    name: 'Mode',
    category: chat.Category.Mode,
    type: chat.CONFIG_SELECT,
    currentValue: str(raw.currentModeId)!,
    options: [],
  };
  for (const m of modes) {
    if (!isObj(m)) continue;
    const value = str(m.id)!;
    if (value !== '' && o.options!.length < MAX_CONFIG_VALUES) {
      const cv: chat.ConfigValue = { value, name: clip(str(m.name)!, MAX_NAME) };
      const description = clip(str(m.description)!, MAX_TEXT);
      if (description) cv.description = description;
      o.options!.push(cv);
    }
  }
  return o;
}

/** The first option of a category; undefined for none. */
export const optionOf = (opts: readonly chat.ConfigOption[], category: string): chat.ConfigOption | undefined =>
  opts.find((o) => o.category === category);

/** The option of an id; undefined for none. */
export const optionByID = (opts: readonly chat.ConfigOption[], id: string): chat.ConfigOption | undefined => opts.find((o) => o.id === id);

/** Whether value is one of the option's. */
export const hasValue = (o: chat.ConfigOption, value: string): boolean => (o.options ?? []).some((v) => v.value === value);

/** A copy of opts that shares nothing with it. */
export const cloneConfig = (opts: readonly chat.ConfigOption[]): chat.ConfigOption[] =>
  opts.map((o) => ({ ...o, options: (o.options ?? []).map((v) => ({ ...v })) }));

/** For each of the host's permission modes, the ids an agent's mode of that
 * meaning has, as the agents name them. A mode the agent has none of is
 * left at the agent's default. For Mode.Full, explicit full-access values
 * (such as Kimi Code's "yolo") take precedence over "auto", while agents whose
 * autonomous full-access mode is named "auto" (such as Antigravity's
 * "Run autonomously") map cleanly to it (still gated by allowFullAccess via
 * markFull). */
export const MODE_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  [chat.Mode.Default]: ['default', 'ask'],
  [chat.Mode.AcceptEdits]: ['acceptEdits', 'accept_edits', 'accept-edits'],
  [chat.Mode.Plan]: ['plan'],
  [chat.Mode.Full]: ['yolo', 'bypassPermissions', 'full', 'full-access', 'full_access', 'auto'],
};

/** Whether an agent's mode is known not to give it full access. */
export const safeMode = (v: string): boolean =>
  [chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Plan].some((m) => MODE_CANDIDATES[m]!.includes(v));

/** Marks the values of the mode options that may give the agent full
 * access, which the host refuses unless its settings allow full access:
 * every value but those known to ask (deny by default: an agent's own mode
 * of another meaning, Kimi Code's "auto", counts as full access). */
export function markFull(opts: chat.ConfigOption[]): void {
  for (const o of opts) {
    if (o.category !== chat.Category.Mode) continue;
    for (const v of o.options ?? []) {
      if (safeMode(v.value)) delete v.full;
      else v.full = true;
    }
  }
}

/** The value of the mode option that a chat's mode stands for: the agent's
 * own value when it is one, else the agent's value of the host's mode of
 * that name; "" when the agent has none. */
export function modeValue(o: chat.ConfigOption, mode: string): string {
  if (hasValue(o, mode)) return mode;
  for (const c of MODE_CANDIDATES[mode] ?? []) if (hasValue(o, c)) return c;
  return '';
}

/** An available_commands_update's commands; null for one without them. */
export function slashCommands(raw: unknown): chat.SlashCommand[] | null {
  if (!isObj(raw) || !Array.isArray(raw.availableCommands)) return null;
  const out: chat.SlashCommand[] = [];
  for (const c of raw.availableCommands) {
    if (!isObj(c) || !strings(c, 'name', 'description')) continue;
    if (present(c.input) && (!isObj(c.input) || str(c.input.hint) === undefined)) continue;
    const name = str(c.name)!;
    if (name.trim() === '') continue;
    const sc: chat.SlashCommand = { name: clip(name, MAX_NAME) };
    const description = clip(str(c.description)!, MAX_TEXT);
    if (description) sc.description = description;
    const hint = isObj(c.input) ? clip(str(c.input.hint)!, MAX_NAME) : '';
    if (hint) sc.argumentHint = hint;
    out.push(sc);
    if (out.length === MAX_COMMANDS) break;
  }
  return out;
}

/** Whether two lists of commands are the same. */
export const sameCommands = (a: readonly chat.SlashCommand[], b: readonly chat.SlashCommand[]): boolean =>
  a.length === b.length &&
  a.every(
    (c, i) =>
      c.name === b[i]!.name && (c.description ?? '') === (b[i]!.description ?? '') && (c.argumentHint ?? '') === (b[i]!.argumentHint ?? ''),
  );

/** A usage_update's numbers; null for a malformed one. */
export function usageUpdate(raw: unknown): { used: number; size: number; cost?: chat.Cost } | null {
  if (!isObj(raw)) return null;
  const used = int(raw.used);
  const size = int(raw.size);
  if (used === undefined || Number.isNaN(used) || Number.isNaN(size)) return null;
  let cost: chat.Cost | undefined;
  if (present(raw.cost)) {
    const c = raw.cost;
    if (!isObj(c) || (present(c.amount) && typeof c.amount !== 'number') || str(c.currency) === undefined) return null;
    if (str(c.currency)) cost = { amount: (c.amount as number | undefined) ?? 0, currency: c.currency as string };
  }
  return { used, size: size ?? 0, ...(cost ? { cost } : {}) };
}

/** Sets u's context window: used of size tokens (size 0 when unknown),
 * the percentage from them. */
export function withContext(u: chat.Usage, used: number, size: number): void {
  u.used = used;
  u.size = size;
  delete u.percentage;
  if (size > 0) u.percentage = (used * 100) / size;
}

/** A copy of u to change; a new one for none. */
export function cloneUsage(u: chat.Usage | undefined): chat.Usage {
  if (!u) return { used: 0, size: 0 };
  const c: chat.Usage = { ...u };
  if (u.cost) c.cost = { ...u.cost };
  if (u.limits) c.limits = u.limits.map((l) => ({ ...l }));
  return c;
}

/** What a tick of Grok's costUsdTicks is worth: 10^10 ticks make a US
 * dollar, as Grok's own documentation states. */
export const USD_PER_TICK = 1e-10;

/** What a session/prompt answer's _meta tells of the turn, as Grok sends
 * it: the tokens of its last model call, which are the context in use, its
 * model and its cost; null for none. */
export function turnMeta(raw: unknown): { totalTokens: number; modelId: string; costUsdTicks: number } | null {
  if (!isObj(raw)) return null;
  const total = int(raw.totalTokens);
  const model = str(raw.modelId);
  if (Number.isNaN(total) || model === undefined) return null;
  let ticks: number | undefined = 0;
  if (present(raw.usage)) {
    if (!isObj(raw.usage)) return null;
    ticks = int(raw.usage.costUsdTicks);
    if (Number.isNaN(ticks)) return null;
  }
  return { totalTokens: total ?? 0, modelId: model, costUsdTicks: ticks ?? 0 };
}

/** The context windows of the models of a session's model state, by
 * model id, as Grok gives them (_meta.totalContextTokens). */
export function contextSizes(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isObj(raw) || !Array.isArray(raw.availableModels)) return out;
  for (const a of raw.availableModels) {
    if (!isObj(a) || typeof a.modelId !== 'string' || !isObj(a._meta)) continue;
    const n = int(a._meta.totalContextTokens);
    if (a.modelId !== '' && n !== undefined && n > 0 && out.size < MAX_CONFIG_VALUES) out.set(a.modelId, n);
  }
  return out;
}

/** Extracts available models for Op.Models from a session/new response's
 * configOptions (category "model") with fallback to legacy
 * models.availableModels, enriching effort metadata where available. */
export function modelOptions(rawConfig: unknown, rawModels: unknown, images: boolean): chat.ModelOption[] {
  const effortsByModel = new Map<string, { efforts: string[]; defaultEffort?: string }>();
  const legacy: chat.ModelOption[] = [];
  if (isObj(rawModels) && Array.isArray(rawModels.availableModels)) {
    for (const m of rawModels.availableModels) {
      if (!isObj(m) || typeof m.modelId !== 'string' || m.modelId === '') continue;
      if (legacy.length >= MAX_CONFIG_VALUES) break;
      const name = typeof m.name === 'string' && m.name ? clip(m.name, MAX_NAME) : clip(m.modelId, MAX_NAME);
      const description = typeof m.description === 'string' && m.description ? clip(m.description, MAX_TEXT) : undefined;
      let efforts: string[] | undefined;
      let defaultEffort: string | undefined;
      if (isObj(m._meta) && Array.isArray(m._meta.reasoningEfforts)) {
        const vals: string[] = [];
        for (const e of m._meta.reasoningEfforts) {
          if (!isObj(e)) continue;
          const v = typeof e.value === 'string' && e.value ? e.value : typeof e.id === 'string' ? e.id : '';
          if (!v) continue;
          vals.push(v);
          if (e.default === true && !defaultEffort) defaultEffort = v;
        }
        if (vals.length > 0) {
          efforts = vals;
          if (!defaultEffort && typeof m._meta.reasoningEffort === 'string' && vals.includes(m._meta.reasoningEffort)) {
            defaultEffort = m._meta.reasoningEffort;
          }
          effortsByModel.set(m.modelId, { efforts, ...(defaultEffort ? { defaultEffort } : {}) });
        }
      }
      legacy.push({
        value: m.modelId,
        name,
        ...(description ? { description } : {}),
        ...(efforts ? { efforts } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
        ...(images ? { images: true } : {}),
      });
    }
  }
  const cfg = configOptions(rawConfig);
  const modelOpt = cfg ? optionOf(cfg, chat.Category.Model) : undefined;
  if (modelOpt?.options?.length) {
    return modelOpt.options.map((v) => {
      const eff = effortsByModel.get(v.value);
      return {
        value: v.value,
        name: v.name || v.value,
        ...(v.description ? { description: v.description } : {}),
        ...(eff?.efforts ? { efforts: eff.efforts } : {}),
        ...(eff?.defaultEffort ? { defaultEffort: eff.defaultEffort } : {}),
        ...(images ? { images: true } : {}),
      };
    });
  }
  return legacy;
}

// What a chat of Claude Code states of its configuration: the mode, the
// model and the effort as configuration options, what they make the
// chat's capabilities, and the bounds of what initialize lists.
import * as chat from '#shared/proto/chatproto/index.ts';

/** The ids of the configuration options of a chat of Claude Code. */
export const OPTION_MODE = 'mode';
export const OPTION_MODEL = 'model';
export const OPTION_EFFORT = 'effort';
/** The effort option's value that leaves the effort to the model's
 * default. */
export const EFFORT_DEFAULT = 'default';

/** The effort levels Claude Code knows. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** What a model given at the start may be: a model's name or alias as
 * Claude Code takes them (claude-opus-5-5, claude-opus-5-5[1m], opus). */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;

// Bounds of what a chat states: the slash commands, the models, the
// questions of an AskUserQuestion and the options of one, the bytes of each
// of their strings; the rate limit windows.
export const MAX_COMMANDS = 1000;
export const MAX_MODELS = 256;
export const MAX_QUESTIONS = 16;
export const MAX_OPTIONS = 64;
export const MAX_TEXT = 4 << 10;
export const MAX_LIMITS = 16;

/** s cut to at most n bytes of UTF-8, at a character's start. */
export function cut(s: string, n: number): string {
  if (s.length <= n / 3) return s;
  const b = Buffer.from(s, 'utf8');
  if (b.length <= n) return s;
  let i = n;
  while (i > 0 && (b[i]! & 0xc0) === 0x80) i--;
  return b.subarray(0, i).toString('utf8');
}

/** A model initialize lists, the members read. */
export interface Model {
  value: string;
  resolved: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  levels: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The models of initialize's answer, at most MAX_MODELS. */
export function modelsOf(v: unknown): Model[] {
  if (!Array.isArray(v)) return [];
  const out: Model[] = [];
  for (const m of v.slice(0, MAX_MODELS)) {
    if (typeof m !== 'object' || m === null) continue;
    const o = m as Record<string, unknown>;
    out.push({
      value: str(o.value),
      resolved: str(o.resolvedModel),
      displayName: str(o.displayName),
      description: str(o.description),
      supportsEffort: o.supportsEffort === true,
      levels: Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter((l): l is string => typeof l === 'string') : [],
    });
  }
  return out;
}

/** The slash commands of initialize or commands_changed, as the chat
 * states them. */
export function slashCommands(v: unknown): chat.SlashCommand[] {
  if (!Array.isArray(v)) return [];
  const out: chat.SlashCommand[] = [];
  for (const c of v.slice(0, MAX_COMMANDS)) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (str(o.name) === '') continue;
    const sc: chat.SlashCommand = { name: cut(str(o.name), MAX_TEXT) };
    const d = cut(str(o.description), MAX_TEXT);
    const h = cut(str(o.argumentHint), MAX_TEXT);
    if (d) sc.description = d;
    if (h) sc.argumentHint = h;
    out.push(sc);
  }
  return out;
}

/** Claude Code's permission mode of a chat's mode. */
export function claudeMode(mode: string): 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' {
  switch (mode) {
    case chat.Mode.AcceptEdits:
      return 'acceptEdits';
    case chat.Mode.Plan:
      return 'plan';
    case chat.Mode.Full:
      return 'bypassPermissions';
  }
  return 'default';
}

/** The chat's mode of Claude Code's permission mode; "" for one it has none
 * of (dontAsk, auto). */
export function chatMode(mode: unknown): string {
  switch (mode) {
    case 'default':
      return chat.Mode.Default;
    case 'acceptEdits':
      return chat.Mode.AcceptEdits;
    case 'plan':
      return chat.Mode.Plan;
    case 'bypassPermissions':
      return chat.Mode.Full;
  }
  return '';
}

/** The first of s that is not empty. */
export const firstOf = (...s: string[]): string => s.find((x) => x !== '') ?? '';

/** The models, the chat's model, effort and mode. */
export class Config {
  models: Model[] = [];
  /** The model option's value; "" while it is the program's default and not
   * known. */
  model = '';
  effort: string;
  mode: string;

  constructor(effort: string, mode: string) {
    this.effort = effort;
    this.mode = mode;
  }

  /** The model of the list whose value is v, else the one v resolves to (a
   * full id given for an alias). */
  find(v: string): Model | undefined {
    return this.models.find((m) => m.value === v) ?? this.models.find((m) => m.resolved === v);
  }

  /** The value of the list's model that is id, or resolves to it ("default"
   * first); "" for none. */
  valueOf(id: string): string {
    if (this.models.some((m) => m.value === id)) return id;
    let found = '';
    for (const m of this.models) if (m.resolved === id && (found === '' || m.value === 'default')) found = m.value;
    return found;
  }

  /** The efforts of the chat's model, "default" first; none for a model
   * without. */
  levels(): string[] {
    let m = this.models.find((x) => x.value === this.model);
    // The model is the program's default, not known yet: the levels of the
    // list's default.
    if (!m && this.model === '') m = this.models.findLast((x) => x.value === 'default');
    if (!m || !m.supportsEffort || m.levels.length === 0) return [];
    return [EFFORT_DEFAULT, ...m.levels];
  }

  /** The configuration options and capabilities the chat states. */
  state(): { config: chat.ConfigOption[]; capabilities: chat.Capabilities } {
    const config: chat.ConfigOption[] = [
      {
        id: OPTION_MODE,
        name: 'Mode',
        category: chat.Category.Mode,
        type: chat.CONFIG_SELECT,
        currentValue: this.mode,
        options: [
          { value: chat.Mode.Default, name: 'Ask' },
          { value: chat.Mode.AcceptEdits, name: 'Accept edits' },
          { value: chat.Mode.Plan, name: 'Plan' },
          { value: chat.Mode.Full, name: 'Full access', full: true },
        ],
      },
    ];
    if (this.models.length > 0)
      config.push({
        id: OPTION_MODEL,
        name: 'Model',
        category: chat.Category.Model,
        type: chat.CONFIG_SELECT,
        currentValue: this.model,
        options: this.models.map((m) => {
          const v: chat.ConfigValue = { value: m.value, name: cut(firstOf(m.displayName, m.value), MAX_TEXT) };
          const d = cut(m.description, MAX_TEXT);
          if (d) v.description = d;
          return v;
        }),
      });
    const levels = this.levels();
    if (levels.length > 0)
      config.push({
        id: OPTION_EFFORT,
        name: 'Effort',
        category: chat.Category.ThoughtLevel,
        type: chat.CONFIG_SELECT,
        currentValue: this.effort,
        options: levels.map((l) => ({ value: l, name: l })),
      });
    return {
      config,
      capabilities: {
        images: true,
        compact: true,
        queue: true,
        plan: true,
        questions: true,
        effort: levels.length > 0,
        model: this.models.length > 0,
        cancelQueued: true,
      },
    };
  }
}

// The one keybinding system of every client (web UI, desktop app), modeled
// on VS Code's: commands with default keys per platform (commands.ts), and
// a hand-editable JSONC file of the user's rules ({key, command, when};
// command "-<id>" removes a binding) on the hub host. The hub serves the
// effective bindings of every platform and their conflicts (GET
// /api/keybindings); the clients only match keys. See
// docs/features/04-layout-and-keyboard.md.
import { getNodeValue } from 'jsonc-parser';
import { z } from 'zod';
import { ConfigFail, detailed, saveFailed } from '../fail.ts';
import { insertValue, parseText, removeValue, UserFile } from '../jsonc.ts';
import { COMMANDS, PLATFORMS, WHENS, type Command, type Platform, type When } from './commands.ts';
import { normalize } from './keys.ts';

/** A binding: a user's rule, or one in effect. */
export interface Rule {
  key: string;
  command: string;
  when?: When;
}

/** Something wrong in the user's file: an entry that is not a valid rule
 * ("invalid"), a command no version of the hub has ("unknown"), or a file
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

/** A command as the API lists it. */
export interface CommandJSON {
  id: string;
  section: string;
  when: When;
}

/** The user's rules and what follows from them on every platform: what the
 * API returns and pushes after each change. */
export interface State {
  /** The file's entries as written, unknown and invalid ones included. */
  user: unknown[];
  effective: Record<Platform, Rule[]>;
  conflicts: Record<Platform, Conflict[]>;
  problems: Problem[];
}

export interface KeybindingsOptions {
  commands?: readonly Command[];
  /** How often watch looks at the file. */
  pollMs?: number;
}

/** Bounds the user's rules. */
export const MAX_RULES = 1000;
const MAX_BYTES = 256 << 10;

const commandId = /^-?[A-Za-z0-9_.:-]{1,128}$/;

/** The platforms as the API's objects list them (sorted). */
const SORTED_PLATFORMS = [...PLATFORMS].sort();

// An entry of the file: its members, null as none; others are kept but
// mean nothing.
const entry = z
  .object(
    {
      key: z.string().nullish(),
      command: z.string().nullish(),
      when: z.string().nullish(),
    },
    { error: 'not a rule object' },
  )
  .nullable();

/** Reads one entry of the file, its key normalized; throws an Error that
 * says why it is not a rule. */
function parseRule(raw: unknown): Rule {
  const r = entry.safeParse(raw);
  if (!r.success) throw new Error('not a rule object');
  const key = r.data?.key ?? '';
  const command = r.data?.command ?? '';
  const when = r.data?.when ?? '';
  if (!commandId.test(command)) throw new Error(`invalid command ${JSON.stringify(command)}`);
  if (when && !(WHENS as readonly string[]).includes(when)) throw new Error(`invalid when ${JSON.stringify(when)}`);
  // An empty key with "-<id>" removes every binding of the command.
  const rule: Rule = { key: !key && command.startsWith('-') ? '' : normalize(key), command };
  if (when) rule.when = when as When;
  return rule;
}

/** Whether two bindings can apply at the same time; the main UI's
 * (terminal) also apply in VS Code panes, for the keys VS Code leaves, and
 * wherever outside terminals (editor) does. */
function overlaps(a: When | undefined, b: When | undefined): boolean {
  if (a === b || a === 'always' || b === 'always') return true;
  const main = (w: When | undefined) => w === 'terminal' || w === 'editor' || w === 'vscode';
  return main(a) && main(b);
}

/** The keys that run several commands in the same place, and the strokes
 * bound alone that start chords too. */
export function conflicts(effective: readonly Rule[]): Conflict[] {
  const byKey = new Map<string, Rule[]>();
  for (const r of effective) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const keys = [...byKey.keys()].sort();
  const out: Conflict[] = [];
  const add = (key: string, prefix: boolean, rules: Rule[]) => {
    const commands = [...new Set(rules.map((r) => r.command))];
    if (commands.length > 1) out.push(prefix ? { key, commands, prefix } : { key, commands });
  };
  for (const k of keys) {
    const rules = byKey.get(k)!;
    add(
      k,
      false,
      rules.flatMap((a, i) => rules.slice(i + 1).flatMap((b) => (a.command !== b.command && overlaps(a.when, b.when) ? [a, b] : []))),
    );
    if (k.includes(' ')) continue;
    // A single stroke that starts chords shadows them where both apply.
    const chords = keys.filter((other) => other.startsWith(k + ' ')).flatMap((other) => byKey.get(other)!);
    add(
      k,
      true,
      rules.flatMap((a) => chords.flatMap((b) => (overlaps(a.when, b.when) ? [a, b] : []))),
    );
  }
  return out;
}

/** Holds the commands and the user's rules. */
export class Keybindings {
  readonly #commands: readonly Command[];
  readonly #byId: ReadonlyMap<string, Command>;
  readonly #file: UserFile;
  readonly #pollMs: number;
  readonly #subs = new Set<() => void>();
  // The file's text and entries as last read or written.
  #text = '';
  #user: unknown[] = [];
  #rules: Rule[] = []; // the entries that apply, in order
  #problems: Problem[] = [];
  // Set while the file is not a JSON array: the rules stay as they were and
  // nothing is written over it.
  #broken = false;
  // Cached derived views for GET /api/keybindings (read by both the desktop
  // shell and the UI at startup); cleared whenever the user's rules change.
  #allDefaults?: Record<Platform, Rule[]>;
  #cachedState?: State;

  /** A store of the commands' bindings with the user's rules saved in
   * path ("" keeps them in memory). Invalid commands and default keys
   * throw: they are programming errors. */
  constructor(path = '', o: KeybindingsOptions = {}) {
    this.#commands = o.commands ?? COMMANDS;
    this.#file = new UserFile(path);
    this.#pollMs = o.pollMs ?? 2000;
    const byId = new Map<string, Command>();
    for (const c of this.#commands) {
      if (byId.has(c.id) || !commandId.test(c.id) || c.id.startsWith('-') || !WHENS.includes(c.when)) {
        throw new Error(`keybindings: invalid command ${c.id}`);
      }
      for (const d of c.defaults) {
        let canonical: string;
        try {
          canonical = normalize(d.key);
        } catch (e) {
          throw new Error(`keybindings: ${c.id}: default ${JSON.stringify(d.key)}: ${(e as Error).message}`);
        }
        if (canonical !== d.key) throw new Error(`keybindings: ${c.id}: default ${JSON.stringify(d.key)} is not canonical (${canonical})`);
      }
      byId.set(c.id, c);
    }
    this.#byId = byId;
  }

  /** The keybindings file ("" in memory). */
  get path(): string {
    return this.#file.path;
  }

  /** Reads the file (a missing one has no rules); throws when it cannot be
   * read. */
  load(): void {
    if (this.path) this.#read();
  }

  /** Reads the file again if someone changed it since it was last read or
   * written, and notifies the subscribers. */
  reload(): void {
    if (!this.#file.changed()) return;
    try {
      this.#read();
    } catch {
      return;
    }
    this.#notify();
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

  /** Validates and saves the user's rules (JSON values), replacing them.
   * Entries naming commands this version does not have are kept (another
   * version may); entries that are not rules are refused. Throws a Fail:
   * invalid, file, save. */
  setUser(user: readonly unknown[]): void {
    if (user.length > MAX_RULES) throw detailed('invalid', 400, `invalid keybindings: more than ${MAX_RULES} rules`);
    user.forEach((raw, i) => {
      try {
        parseRule(raw);
      } catch (e) {
        throw detailed('invalid', 400, `invalid keybindings: rule ${i + 1}: ${(e as Error).message}`);
      }
    });
    // A copy as JSON has it (the file's entries are JSON values).
    const next = JSON.parse(JSON.stringify(user)) as unknown[];
    if (this.#file.changed()) {
      try {
        this.#read();
      } catch {
        // written over below, as if it were missing
        this.#broken = false;
        this.#text = '';
        this.#user = [];
      }
    }
    // A file that is not an array is not written over: it is being edited
    // by hand.
    if (this.#broken) throw new ConfigFail('file', 409, 'the keybindings file has errors');
    const text = editArray(this.#text, this.#user, next);
    if (Buffer.byteLength(text) > MAX_BYTES) throw detailed('invalid', 400, 'invalid keybindings: too large');
    try {
      this.#file.write(text);
    } catch (e) {
      throw saveFailed(e);
    }
    this.#set(text, next);
    this.#notify();
  }

  /** Calls fn after the rules change; returns what unsubscribes it. */
  onChange(fn: () => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** The commands for the API. */
  commands(): CommandJSON[] {
    return this.#commands.map((c) => ({ id: c.id, section: c.section, when: c.when }));
  }

  /** The default bindings on a platform, in command order. */
  defaults(platform: Platform): Rule[] {
    return this.#commands.flatMap((c) =>
      c.defaults
        .filter((d) => d.platforms.length === 0 || d.platforms.includes(platform))
        .map((d) => ({ key: d.key, command: c.id, when: c.when })),
    );
  }

  /** The default bindings of every platform. */
  allDefaults(): Record<Platform, Rule[]> {
    this.#allDefaults ??= Object.fromEntries(SORTED_PLATFORMS.map((p) => [p, this.defaults(p)])) as Record<Platform, Rule[]>;
    return structuredClone(this.#allDefaults);
  }

  /** The user's rules, the effective bindings and conflicts per platform,
   * and the problems of the file. */
  state(): State {
    if (!this.#cachedState) {
      const effective = Object.fromEntries(SORTED_PLATFORMS.map((p) => [p, this.#effective(p)])) as Record<Platform, Rule[]>;
      this.#cachedState = {
        user: structuredClone(this.#user),
        effective,
        conflicts: Object.fromEntries(SORTED_PLATFORMS.map((p) => [p, conflicts(effective[p])])) as Record<Platform, Conflict[]>,
        problems: this.#problems.map((p) => ({ ...p })),
      };
    }
    return structuredClone(this.#cachedState);
  }

  /** The rules applied to the defaults on a platform. */
  #effective(platform: Platform): Rule[] {
    let out = this.defaults(platform);
    for (const r of this.#rules) {
      if (r.command.startsWith('-')) {
        const id = r.command.slice(1);
        out = out.filter((e) => !(e.command === id && (!r.key || e.key === r.key) && (!r.when || e.when === r.when)));
        continue;
      }
      const rule: Rule = { key: r.key, command: r.command, when: r.when ?? this.#byId.get(r.command)!.when };
      if (!out.some((e) => e.key === rule.key && e.command === rule.command && e.when === rule.when)) out.push(rule);
    }
    return out;
  }

  /** Loads the file; throws when it cannot be read. A file that is not a
   * JSON array keeps the rules read before and is reported. */
  #read(): void {
    const text = this.#file.read();
    const parsed = parseText(text);
    const root = parsed.error === undefined ? parsed.tree : undefined;
    const detail = parsed.error ?? (root && root.type !== 'array' && root.type !== 'null' ? 'not a JSON array' : undefined);
    if (detail !== undefined) {
      this.#broken = true;
      this.#problems = [{ index: -1, code: 'parse', detail }];
      this.#cachedState = undefined;
      return;
    }
    this.#broken = false;
    this.#set(text, root?.type === 'array' ? (root.children ?? []).map((n) => getNodeValue(n) as unknown) : []);
  }

  /** Makes text, whose entries are user, the file's content. */
  #set(text: string, user: unknown[]): void {
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
      if (!this.#byId.has(r.command.replace(/^-/, ''))) problems.push({ index, code: 'unknown', detail: r.command });
      else rules.push(r);
    });
    this.#text = text;
    this.#user = user;
    this.#rules = rules;
    this.#problems = problems;
    this.#cachedState = undefined;
  }

  #notify(): void {
    for (const fn of [...this.#subs]) fn();
  }
}

/** Past this many entries changed, the array is written anew. */
const MAX_EDITS = 64;

/** text, whose array holds before, made to hold after: the entries that
 * stay (the longest common subsequence) keep their text and comments, the
 * others are removed or inserted. A text without an array gets a new one. */
function editArray(text: string, before: readonly unknown[], after: readonly unknown[]): string {
  const root = parseText(text);
  const fresh = JSON.stringify(after, null, 2) + '\n';
  if (root.error !== undefined || root.tree?.type !== 'array') return fresh;
  const a = before.map((v) => JSON.stringify(v));
  const b = after.map((v) => JSON.stringify(v));
  // lcs[i][j]: the longest common subsequence of a[i:] and b[j:].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  if (a.length + b.length - 2 * lcs[0]![0]! > MAX_EDITS) return fresh;
  let i = 0;
  let j = 0;
  let at = 0; // the position in the text's array
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      at++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      text = insertValue(text, [], at, after[j]);
      j++;
      at++;
    } else {
      text = removeValue(text, [at]);
      i++;
    }
  }
  return text;
}

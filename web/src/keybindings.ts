// The keybindings (internal/keybindings): commands, their default keys and
// the user's rules from GET /api/keybindings, kept current by the core's
// "keybindings" pushes on /ws. The core works out the bindings in effect on
// each platform; the page takes its platform's (keymap.ts matches keys
// against them). Until the core answers, the defaults of
// design/generated/registry.json apply.

import { create } from 'zustand';
import registry from '../../design/generated/registry.json';
import { desktopShell } from './shell';
import { hasMessage, t } from './i18n';

export type When = 'terminal' | 'editor' | 'vscode' | 'dialog' | 'always';

export interface Binding {
  key: string;
  command: string;
  when: When;
}

export interface Command {
  id: string;
  section: string;
  when: When;
}

export interface Conflict {
  key: string;
  commands: string[];
  prefix?: boolean;
}

export interface KeyProblem {
  index: number;
  code: string;
  detail?: string;
}

/** A rule of the user's file, as written there. */
export type UserRule = { key?: string; command?: string; when?: string } & Record<string, unknown>;

export type Platform = 'mac' | 'windows' | 'linux' | 'mac-browser' | 'windows-browser' | 'linux-browser';

export { isMac, isWindows, osPlatform, type OS } from './keys';
import { osPlatform, type OS } from './keys';

/** The platform whose bindings apply: the desktop app or a browser, on
 * macOS, Windows or Linux. Browsers keep Cmd+T and the like for themselves. */
export function platform(os: OS | boolean = osPlatform, app = !!desktopShell): Platform {
  const kind: OS = typeof os === 'boolean' ? (os ? 'mac' : 'linux') : os;
  return app ? kind : `${kind}-browser`;
}

interface KeyStore {
  loaded: boolean;
  sections: { id: string; order: number }[];
  commands: Command[];
  defaults: Binding[];
  user: UserRule[];
  effective: Binding[];
  conflicts: Conflict[];
  problems: KeyProblem[];
  readOnly: boolean;
  file: string;
}

const builtin = registry.keybindings as Record<Platform, Binding[]>;

export const useKeys = create<KeyStore>(() => ({
  loaded: false,
  sections: [],
  commands: registry.commands as Command[],
  defaults: builtin[platform()],
  user: [],
  effective: builtin[platform()],
  conflicts: [],
  problems: [],
  readOnly: false,
  file: '',
}));

/** Applies a "keybindings" push (or a change's reply). */
export function applyKeybindings(m: { user?: unknown; effective?: unknown; conflicts?: unknown; problems?: unknown }) {
  const p = platform();
  const effective = (m.effective as Record<string, Binding[]> | undefined)?.[p];
  if (!Array.isArray(effective)) return;
  useKeys.setState({
    user: Array.isArray(m.user) ? (m.user as UserRule[]) : [],
    effective,
    conflicts: (m.conflicts as Record<string, Conflict[]> | undefined)?.[p] ?? [],
    problems: Array.isArray(m.problems) ? (m.problems as KeyProblem[]) : [],
  });
}

export async function loadKeybindings(): Promise<boolean> {
  try {
    const r = await fetch('/api/keybindings');
    if (!r.ok) return false;
    const j = await r.json();
    useKeys.setState({
      loaded: true,
      sections: j.sections ?? [],
      commands: j.commands ?? [],
      defaults: j.defaults?.[platform()] ?? [],
      readOnly: !!j.read_only,
      file: j.file ?? '',
    });
    applyKeybindings(j);
    return true;
  } catch {
    return false;
  }
}

/** Replaces the user's rules; resolves to an error message, or undefined. */
export async function saveUserRules(rules: UserRule[]): Promise<string | undefined> {
  try {
    const r = await fetch('/api/keybindings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules),
    });
    const j = await r.json();
    if (!r.ok) {
      const code = `settings.error.${j.error}`;
      return (hasMessage(code) ? t(code) : String(j.error)) + (j.detail ? `: ${j.detail}` : '');
    }
    applyKeybindings(j);
    return undefined;
  } catch {
    return t('settings.error.network');
  }
}

/** The rules that give a command the keys in `keys`: rules of other commands
 * are kept, the command's own are replaced, and defaults it no longer has
 * are removed with "-<command>" rules. */
export function rulesFor(user: UserRule[], defaults: Binding[], command: string, keys: string[]): UserRule[] {
  const others = user.filter((r) => r.command !== command && r.command !== `-${command}`);
  const own = defaults.filter((d) => d.command === command).map((d) => d.key);
  const out = [...others];
  for (const k of own) if (!keys.includes(k)) out.push({ key: k, command: `-${command}` });
  for (const k of keys) if (!own.includes(k)) out.push({ key: k, command });
  return out;
}

/** The rules without any of the command's: its defaults again. */
export function resetRules(user: UserRule[], command: string): UserRule[] {
  return user.filter((r) => r.command !== command && r.command !== `-${command}`);
}

/** The keys in effect for a command, in order. */
export function keysOf(effective: Binding[], command: string): string[] {
  return effective.filter((b) => b.command === command).map((b) => b.key);
}

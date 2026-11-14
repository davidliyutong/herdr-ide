// Direct shortcuts of the desktop app: the keybindings (internal/keybindings)
// in effect on this platform that are a single stroke with Cmd, Ctrl or Alt
// (Cmd+T…). The shell reads them from /api/keybindings, intercepts matching
// keys before the page sees them (so a pane never receives them, whichever
// frame has focus) and asks the page to run the command. Chords (ctrl+b c)
// and plain keys stay with the page, which matches them itself. Keys are
// named by web/src/keys.ts, after the character the keyboard layout gives
// them.

import registry from '../../design/generated/registry.json';
import { acceleratorKey, parseKeys, strokeOf } from '../../web/src/keys';

/** The keybindings' platforms of the desktop app. */
export type Platform = 'mac' | 'pc';

export function platformOf(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : 'pc';
}

export interface Binding {
  key: string;
  command: string;
  when: string;
}

/** Whether a binding is one the shell takes: one stroke with cmd, ctrl or alt. */
export function isDirect(b: Binding): boolean {
  try {
    const seq = parseKeys(b.key);
    return seq.length === 1 && (seq[0].cmd || seq[0].ctrl || seq[0].alt);
  } catch {
    return false;
  }
}

/** The direct shortcuts among bindings. */
export function directShortcuts(bindings: Binding[]): Binding[] {
  return bindings.filter(isDirect);
}

/** The default bindings of the platform (design/generated/registry.json),
 * used until the core's are read, so a key never falls through to closing
 * the window while they load. */
export function defaultBindings(platform: Platform): Binding[] {
  return registry.keybindings[platform] as Binding[];
}

/** The bindings in effect on the platform in a /api/keybindings reply;
 * undefined for a reply without them. */
export function bindingsFromReply(reply: unknown, platform: Platform): Binding[] | undefined {
  const list = (reply as { effective?: Record<string, unknown> } | null)?.effective?.[platform];
  if (!Array.isArray(list)) return;
  return list.filter(
    (b): b is Binding =>
      typeof b?.key === 'string' && typeof b?.command === 'string' && typeof b?.when === 'string' && /^[A-Za-z0-9_.:-]+$/.test(b.command),
  );
}

/** The fields of Electron's before-input-event Input used for matching. */
export interface KeyInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** The stroke of a key-down, e.g. "cmd+shift+t", by the character the
 * layout gives the key (so AZERTY's Cmd+Z is not cmd+w). */
export function inputStroke(input: KeyInput): string | undefined {
  if (input.type !== 'keyDown') return;
  return strokeOf({
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
  });
}

/** The direct shortcut a key-down runs where focus is: in a VS Code frame
 * only bindings for VS Code or everywhere, elsewhere those for the main UI or
 * everywhere (dialog bindings belong to the page). */
export function shortcutFor(bindings: Binding[], input: KeyInput, inCode = false): Binding | undefined {
  const stroke = inputStroke(input);
  if (!stroke) return;
  return bindings.find((b) => b.key === stroke && isDirect(b) && (b.when === 'always' || b.when === (inCode ? 'vscode' : 'terminal')));
}

/** Whether a key-down is a direct shortcut of the main UI, whatever has
 * focus: one the shell leaves to VS Code when VS Code has it. */
export function shortcutOutsideCode(bindings: Binding[], input: KeyInput): boolean {
  const stroke = inputStroke(input);
  return !!stroke && bindings.some((b) => b.key === stroke && isDirect(b) && b.when === 'terminal');
}

/** Electron accelerator for a menu's key label, e.g. "Super+Shift+T";
 * undefined for chords. */
export function toAccelerator(key: string | undefined): string | undefined {
  if (!key) return;
  try {
    const seq = parseKeys(key);
    if (seq.length !== 1) return;
    const s = seq[0];
    const mods = [s.cmd && 'Super', s.ctrl && 'Control', s.alt && 'Alt', s.shift && 'Shift'].filter(Boolean);
    return [...mods, acceleratorKey(s.key)].join('+');
  } catch {
    return;
  }
}

/** The menu accelerator of a command: its first direct shortcut. */
export function acceleratorFor(bindings: Binding[], command: string): string | undefined {
  return toAccelerator(bindings.find((b) => b.command === command && isDirect(b))?.key);
}

/** The stroke of a key-down while the settings record a key, e.g.
 * "cmd+shift+t"; undefined for keys without cmd, ctrl or alt (those reach
 * the page: Escape cancels, Enter keeps) and for lone modifiers. */
export function recordedSpec(input: KeyInput): string | undefined {
  if (!(input.meta || input.control || input.alt)) return;
  return inputStroke(input);
}

/** Whether url is a VS Code (code-server) frame of the core, /m/<machine>/code/…. */
export function isCodeFrame(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin && !u.username && !u.password && /^\/m\/[^/]+\/code\//.test(u.pathname);
  } catch {
    return false;
  }
}

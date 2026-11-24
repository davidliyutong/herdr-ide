// The settings of the user interface: the web UI (also inside the desktop
// app) reads them from the core (/api/settings), so every client of a core
// looks and behaves the same and the values survive browsers, profiles and
// reinstalls. See docs/features/13-settings-and-appearance.md.
import * as agentkinds from '#shared/agents/kinds.ts';
import { bool, color, colorList, defineModule, enumOf, int, number, stringList, text, type Setting } from '../settings/index.ts';
import { TOKEN_COLORS, TOKEN_THEMES } from './tokens.ts';

/** Read by the core: whether the new terminals of an ssh machine get the
 * variables of its ssh session (SSH_CONNECTION, SSH_CLIENT). */
export const SSH_ENV = 'terminal.sshEnv';

/** The most terminals a page keeps attached while they are not shown: each
 * holds a stream and an emulator with its scrollback. */
export const MAX_KEPT_TERMINALS = 64;

/** The most lines a terminal keeps above its screen. */
export const MAX_SCROLLBACK = 100_000;

/** Bound the desktop app's zoom, in percent. */
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 300;

/** Bound the time, in seconds, a closed pane, tab or workspace can be
 * brought back. */
export const MIN_UNDO_CLOSE = 3;
export const MAX_UNDO_CLOSE = 120;

/** The ids of the coding agents the terminals recognize (the kinds of
 * shared/agents, which are the detector manifests'), sorted, offered by
 * the list of silent agents. */
export const AGENTS: readonly string[] = agentkinds
  .all()
  .map((k) => k.id)
  .sort();

/** The terminal color schemes the UIs offer; "default" is the design
 * tokens' colors of the theme in use (web/src/terminal/schemes.ts has the
 * colors of the others). */
export const SCHEMES = [
  'default',
  'dracula',
  'gruvbox-dark',
  'gruvbox-light',
  'nord',
  'one-dark',
  'one-light',
  'solarized-dark',
  'solarized-light',
  'tomorrow',
  'tomorrow-night',
] as const;

const [firstTheme, ...otherThemes] = TOKEN_THEMES;

/** The colors of a theme that replace its scheme's, defaulting to the
 * design tokens (the default scheme). */
function themeColors(theme: 'dark' | 'light', base: number): Record<string, Setting> {
  const c = TOKEN_COLORS[theme];
  const p = `terminal.colors.${theme}.`;
  return {
    [p + 'foreground']: color({ default: c.foreground, section: 'colors', order: base + 1 }),
    [p + 'background']: color({ default: c.background, section: 'colors', order: base + 2 }),
    [p + 'cursor']: color({ default: c.cursor, section: 'colors', order: base + 3 }),
    [p + 'selection']: color({ default: c.selection, section: 'colors', order: base + 4 }),
    [p + 'palette']: colorList({ default: [...c.palette], length: 16, section: 'colors', order: base + 5 }),
  };
}

/** The user interfaces' sections and settings. */
export const UI = defineModule({
  sections: [
    { id: 'appearance', order: 10 },
    { id: 'layout', order: 20 },
    { id: 'terminal', order: 30 },
    { id: 'colors', order: 40 },
    { id: 'notifications', order: 50 },
    { id: 'performance', order: 90, advanced: true },
  ],
  settings: {
    // The terminals a page keeps attached while another tab, workspace or
    // machine is shown (the web UI's keptPanes.ts); 0 keeps none.
    'performance.keptTerminals': int({ default: 12, min: 0, max: MAX_KEPT_TERMINALS, step: 1, section: 'performance', order: 10 }),

    'appearance.theme': enumOf(['system', 'light', 'dark'], { default: 'system', section: 'appearance', order: 10 }),
    // The accent of the chrome (spec/tokens.json themes); the neutrals are
    // the same in every one.
    'appearance.colorTheme': enumOf([firstTheme!, ...otherThemes], { default: firstTheme!, section: 'appearance', order: 15 }),
    'appearance.language': enumOf(['auto', 'en', 'zh-CN'], { default: 'auto', section: 'appearance', order: 20 }),
    'appearance.uiFontSize': int({ default: 13, min: 11, max: 20, section: 'appearance', order: 30 }),
    // The desktop app's windows, terminals included, in percent: its shell
    // applies it; browsers zoom pages themselves.
    'window.zoom': int({ default: 100, min: MIN_ZOOM, max: MAX_ZOOM, step: 10, section: 'appearance', order: 35 }),

    // How long a close of a pane, tab or workspace can be undone, in
    // seconds (the web UI's Undo Close).
    'layout.undoClose': int({ default: 5, min: MIN_UNDO_CLOSE, max: MAX_UNDO_CLOSE, step: 1, section: 'layout', order: 10 }),

    'terminal.fontFamily': text({ default: '', section: 'terminal', group: 'text', order: 10 }),
    'terminal.fontSize': number({ default: 13, min: 6, max: 40, step: 1, section: 'terminal', group: 'text', order: 20 }),
    'terminal.fontWeight': enumOf(['regular', 'medium'], { default: 'regular', section: 'terminal', group: 'text', order: 30 }),
    'terminal.lineHeight': number({ default: 1.05, min: 0.8, max: 2, step: 0.05, section: 'terminal', group: 'text', order: 40 }),
    // A thin bar by default, as text fields and editors show it; programs
    // may ask for another shape (DECSCUSR).
    'terminal.cursorStyle': enumOf(['block', 'bar', 'underline'], { default: 'bar', section: 'terminal', group: 'cursor', order: 50 }),
    // The bar's and the underline's thickness, in CSS pixels.
    'terminal.cursorWidth': number({ default: 1, min: 0.5, max: 4, step: 0.5, section: 'terminal', group: 'cursor', order: 55 }),
    'terminal.cursorBlink': bool({ default: true, section: 'terminal', group: 'cursor', order: 60 }),
    'terminal.scrollback': int({
      default: 10000,
      min: 0,
      max: MAX_SCROLLBACK,
      step: 1000,
      section: 'terminal',
      group: 'behavior',
      order: 70,
    }),
    'terminal.bell': enumOf(['none', 'sound', 'visual'], { default: 'visual', section: 'terminal', group: 'behavior', order: 80 }),
    'terminal.optionIsMeta': bool({ default: false, section: 'terminal', group: 'behavior', order: 90 }),
    // LaTeX formulas in panes shown rendered under the pointer.
    'terminal.mathHover': bool({ default: true, section: 'terminal', group: 'behavior', order: 100 }),
    [SSH_ENV]: bool({ default: true, scope: 'remote-machine', section: 'terminal', group: 'behavior', order: 105 }),
    'terminal.copyOnSelect': bool({ default: false, section: 'terminal', group: 'clipboard', order: 110 }),
    // What a program's clipboard write (OSC 52) does.
    'terminal.programClipboard': enumOf(['auto', 'ask', 'off'], { default: 'auto', section: 'terminal', group: 'clipboard', order: 120 }),

    // Terminal colors: a scheme per theme, then the user's own colors,
    // which replace the scheme's.
    'terminal.colorScheme.dark': enumOf(SCHEMES, { default: 'default', section: 'colors', order: 10 }),
    'terminal.colorScheme.light': enumOf(SCHEMES, { default: 'default', section: 'colors', order: 20 }),
    'terminal.boldIsBright': bool({ default: false, section: 'colors', order: 30 }),
    ...themeColors('dark', 100),
    ...themeColors('light', 200),

    // Sounds, the system's notifications and the badge, each on by
    // default, with droid silent (sounds only).
    'notifications.sound': bool({ default: true, section: 'notifications', order: 10 }),
    'notifications.system': bool({ default: true, section: 'notifications', order: 20 }),
    'notifications.badge': bool({ default: true, section: 'notifications', order: 30 }),
    'notifications.mutedAgents': stringList({ default: ['droid'], options: AGENTS, section: 'notifications', order: 40 }),
  },
});

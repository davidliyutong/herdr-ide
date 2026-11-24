// The settings of the user interface: the web UI (also inside the desktop
// app) reads them from the core (/api/settings), so every client of a core
// looks and behaves the same and the values survive browsers, profiles and
// reinstalls. See docs/features/13-settings-and-appearance.md.
import * as agentkinds from '#shared/agents/kinds.ts';
import { range, Scope, Type, type Def, type Module } from '#kernel/config/settings/index.ts';
import { TOKEN_COLORS, TOKEN_THEMES } from './tokens.ts';

// Setting keys the core itself does not read are named here for tests and
// the clients' documentation; the clients use the same strings.
export const LANGUAGE = 'appearance.language';
export const THEME = 'appearance.theme';
export const COLOR_THEME = 'appearance.colorTheme';
export const UI_FONT_SIZE = 'appearance.uiFontSize';
export const ZOOM = 'window.zoom';
export const FONT_FAMILY = 'terminal.fontFamily';
export const FONT_SIZE = 'terminal.fontSize';
export const SCROLLBACK = 'terminal.scrollback';
export const UNDO_CLOSE = 'layout.undoClose';
/** How many terminals a page keeps attached, hidden, besides the ones it
 * shows. */
export const KEPT_TERMINALS = 'performance.keptTerminals';
export const MUTED_AGENTS = 'notifications.mutedAgents';
export const SCHEME_PREFIX = 'terminal.colorScheme.';
export const COLORS_PREFIX = 'terminal.colors.';

/** Read by the core: whether the new terminals of an ssh machine get the
 * variables of its ssh session (internal/server/sshenv.go). */
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
 * agentkinds, which are the detector manifests'), sorted, offered by the
 * list of silent agents. */
export const AGENTS: readonly string[] = agentkinds
  .all()
  .map((k) => k.id)
  .sort();

/** The terminal color schemes the UIs offer; "default" is the design
 * tokens' colors of the theme in use (web/src/terminal/schemes.ts has the
 * colors of the others). */
export const SCHEMES: readonly string[] = [
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
];

function defs(): Def[] {
  const out: Def[] = [
    // Performance: the terminals a page keeps attached while another tab,
    // workspace or machine is shown (the web UI's keptPanes.ts); 0 keeps none.
    {
      key: KEPT_TERMINALS,
      type: Type.Number,
      default: 12,
      ...range(0, MAX_KEPT_TERMINALS),
      integer: true,
      step: 1,
      section: 'performance',
      order: 10,
    },

    // Appearance.
    { key: THEME, type: Type.Enum, default: 'system', enum: ['system', 'light', 'dark'], section: 'appearance', order: 10 },
    // The accent of the chrome (spec/tokens.json themes); the neutrals are
    // the same in every one.
    { key: COLOR_THEME, type: Type.Enum, default: TOKEN_THEMES[0], enum: [...TOKEN_THEMES], section: 'appearance', order: 15 },
    { key: LANGUAGE, type: Type.Enum, default: 'auto', enum: ['auto', 'en', 'zh-CN'], section: 'appearance', order: 20 },
    { key: UI_FONT_SIZE, type: Type.Number, default: 13, ...range(11, 20), integer: true, section: 'appearance', order: 30 },
    // The desktop app's windows, terminals included, in percent: its shell
    // applies it; browsers zoom pages themselves.
    { key: ZOOM, type: Type.Number, default: 100, ...range(MIN_ZOOM, MAX_ZOOM), integer: true, step: 10, section: 'appearance', order: 35 },

    // Panes, tabs and workspaces: how long a close can be undone, in
    // seconds (the web UI's Undo Close).
    {
      key: UNDO_CLOSE,
      type: Type.Number,
      default: 5,
      ...range(MIN_UNDO_CLOSE, MAX_UNDO_CLOSE),
      integer: true,
      step: 1,
      section: 'layout',
      order: 10,
    },

    // Terminal.
    { key: FONT_FAMILY, type: Type.String, default: '', section: 'terminal', group: 'text', order: 10 },
    { key: FONT_SIZE, type: Type.Number, default: 13, ...range(6, 40), step: 1, section: 'terminal', group: 'text', order: 20 },
    {
      key: 'terminal.fontWeight',
      type: Type.Enum,
      default: 'regular',
      enum: ['regular', 'medium'],
      section: 'terminal',
      group: 'text',
      order: 30,
    },
    {
      key: 'terminal.lineHeight',
      type: Type.Number,
      default: 1.05,
      ...range(0.8, 2),
      step: 0.05,
      section: 'terminal',
      group: 'text',
      order: 40,
    },
    // A thin bar by default, as text fields and editors show it; programs
    // may ask for another shape (DECSCUSR).
    {
      key: 'terminal.cursorStyle',
      type: Type.Enum,
      default: 'bar',
      enum: ['block', 'bar', 'underline'],
      section: 'terminal',
      group: 'cursor',
      order: 50,
    },
    // The bar's and the underline's thickness, in CSS pixels.
    {
      key: 'terminal.cursorWidth',
      type: Type.Number,
      default: 1,
      ...range(0.5, 4),
      step: 0.5,
      section: 'terminal',
      group: 'cursor',
      order: 55,
    },
    { key: 'terminal.cursorBlink', type: Type.Bool, default: true, section: 'terminal', group: 'cursor', order: 60 },
    {
      key: SCROLLBACK,
      type: Type.Number,
      default: 10000,
      ...range(0, MAX_SCROLLBACK),
      integer: true,
      step: 1000,
      section: 'terminal',
      group: 'behavior',
      order: 70,
    },
    {
      key: 'terminal.bell',
      type: Type.Enum,
      default: 'visual',
      enum: ['none', 'sound', 'visual'],
      section: 'terminal',
      group: 'behavior',
      order: 80,
    },
    { key: 'terminal.optionIsMeta', type: Type.Bool, default: false, section: 'terminal', group: 'behavior', order: 90 },
    // LaTeX formulas in panes shown rendered under the pointer.
    { key: 'terminal.mathHover', type: Type.Bool, default: true, section: 'terminal', group: 'behavior', order: 100 },
    // SSH_CONNECTION and SSH_CLIENT in the terminals of ssh machines.
    { key: SSH_ENV, type: Type.Bool, default: true, scope: Scope.RemoteMachine, section: 'terminal', group: 'behavior', order: 105 },
    { key: 'terminal.copyOnSelect', type: Type.Bool, default: false, section: 'terminal', group: 'clipboard', order: 110 },
    // What a program's clipboard write (OSC 52) does.
    {
      key: 'terminal.programClipboard',
      type: Type.Enum,
      default: 'auto',
      enum: ['auto', 'ask', 'off'],
      section: 'terminal',
      group: 'clipboard',
      order: 120,
    },

    // Terminal colors: a scheme per theme, then the user's own colors,
    // which replace the scheme's.
    { key: SCHEME_PREFIX + 'dark', type: Type.Enum, default: 'default', enum: [...SCHEMES], section: 'colors', order: 10 },
    { key: SCHEME_PREFIX + 'light', type: Type.Enum, default: 'default', enum: [...SCHEMES], section: 'colors', order: 20 },
    { key: 'terminal.boldIsBright', type: Type.Bool, default: false, section: 'colors', order: 30 },

    // Notifications: sounds, the system's notifications and the badge, each
    // on by default, with droid silent (sounds only).
    { key: 'notifications.sound', type: Type.Bool, default: true, section: 'notifications', order: 10 },
    { key: 'notifications.system', type: Type.Bool, default: true, section: 'notifications', order: 20 },
    { key: 'notifications.badge', type: Type.Bool, default: true, section: 'notifications', order: 30 },
    {
      key: MUTED_AGENTS,
      type: Type.List,
      item: Type.String,
      options: [...AGENTS],
      default: ['droid'],
      section: 'notifications',
      order: 40,
    },
  ];
  // The colors of each theme that replace its scheme's, defaulting to the
  // design tokens (the default scheme).
  (['dark', 'light'] as const).forEach((theme, i) => {
    const c = TOKEN_COLORS[theme];
    const p = COLORS_PREFIX + theme + '.';
    const base = 100 * (i + 1);
    out.push(
      { key: p + 'foreground', type: Type.Color, default: c.foreground, section: 'colors', order: base + 1 },
      { key: p + 'background', type: Type.Color, default: c.background, section: 'colors', order: base + 2 },
      { key: p + 'cursor', type: Type.Color, default: c.cursor, section: 'colors', order: base + 3 },
      { key: p + 'selection', type: Type.Color, default: c.selection, section: 'colors', order: base + 4 },
      { key: p + 'palette', type: Type.List, item: Type.Color, length: 16, default: [...c.palette], section: 'colors', order: base + 5 },
    );
  });
  return out;
}

/** The user interfaces' sections and settings. */
export const MODULE: Module = {
  sections: [
    { id: 'appearance', order: 10 },
    { id: 'layout', order: 20 },
    { id: 'terminal', order: 30 },
    { id: 'colors', order: 40 },
    { id: 'notifications', order: 50 },
    { id: 'performance', order: 90, advanced: true },
  ],
  defs: defs(),
};

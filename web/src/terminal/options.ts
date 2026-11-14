// Options shared by every terminal: pane terminals (TermController) and the
// terminals of the ssh and remote-herdr dialogs.

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { Appearance } from '../appearance';
import type { TermColors } from '../prefs';
import { termFontFamily } from './fonts';

/** The ANSI colors' names in xterm.js's theme, in palette order. */
export const ansiNames = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/** A theme's terminal colors (the terminal.colors.* settings, whose
 * defaults are the design tokens) as xterm.js takes them. */
export function xtermTheme(c: TermColors): ITheme {
  const theme: ITheme = {
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor,
    cursorAccent: c.background,
    selectionBackground: c.selection,
  };
  ansiNames.forEach((name, i) => {
    theme[name] = c.palette[i];
  });
  return theme;
}

/** Options every terminal shares (panes and the dialogs' terminals). */
export function termOptions(a: Pick<Appearance, 'colors' | 'fontSize' | 'fontWeight' | 'fontFamily' | 'lineHeight'>): ITerminalOptions {
  return {
    fontFamily: termFontFamily(a.fontWeight, a.fontFamily),
    fontSize: a.fontSize,
    fontWeight: a.fontWeight,
    fontWeightBold: 700,
    lineHeight: a.lineHeight,
    theme: xtermTheme(a.colors),
  };
}

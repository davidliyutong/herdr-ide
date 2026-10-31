// Options shared by every terminal: pane terminals (TermController) and the
// terminals of the ssh and remote-herdr dialogs.

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { Appearance, ThemeKind } from '../appearance';
import { termFontFamily } from './fonts';

// GitHub Dark Default (as in Ghostty's theme of that name), on the UI's --bg.
const dark: ITheme = {
  background: '#0e1116',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#0e1116',
  selectionBackground: '#3b4a6b',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

const light: ITheme = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d4fe',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#9a6700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

/** Terminal colors per UI theme; backgrounds match --bg in styles.css. */
export const themes: Record<ThemeKind, ITheme> = { dark, light };

/** Options every terminal shares (panes and the dialogs' terminals). The
 *  bundled font's natural line height is 1.32 em; 5% more separates rows a
 *  little more, as Ghostty does with adjust-cell-height. */
export function termOptions(a: Pick<Appearance, 'theme' | 'fontSize' | 'fontWeight'>): ITerminalOptions {
  return {
    fontFamily: termFontFamily(a.fontWeight),
    fontSize: a.fontSize,
    fontWeight: a.fontWeight,
    fontWeightBold: 700,
    lineHeight: 1.05,
    theme: themes[a.theme],
  };
}

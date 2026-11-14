import { describe, expect, it } from 'vitest';
import type { ITheme } from '@xterm/xterm';
import tokens from '../../../design/tokens.json';
import { themes } from '../terminal/options';

// The 16 ANSI colors in the order of the tokens' palettes.
const ansi: Array<keyof ITheme> = [
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
];

describe('design tokens', () => {
  // The macOS application takes its terminal colors from the tokens, the
  // web UI from terminal/options.ts: they are the same colors.
  for (const kind of ['dark', 'light'] as const) {
    it(`has the ${kind} terminal palette of the web UI`, () => {
      const token = tokens.terminal[kind];
      const theme = themes[kind];
      expect(ansi.map((k) => theme[k])).toEqual(token.palette);
      expect(theme.background).toBe(token.background);
      expect(theme.foreground).toBe(token.foreground);
      expect(theme.cursor).toBe(token.cursor);
      expect(theme.cursorAccent).toBe(token.background);
      expect(theme.selectionBackground).toBe(token.selection);
    });
  }

  it('gives the page and its terminals one background per theme', () => {
    expect(tokens.terminal.dark.background).toBe(tokens.color.background.dark);
    expect(tokens.terminal.light.background).toBe(tokens.color.background.light);
  });
});

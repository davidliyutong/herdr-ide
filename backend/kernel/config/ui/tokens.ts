// The design tokens the settings take their defaults from, read from
// spec/tokens.json when the core is built (scripts/tokens generates the
// web UI's CSS from the same file and validates it: 16 opaque palette
// colors per theme, themes with unique ids).
import tokens from '../../../../spec/tokens.json' with { type: 'json' };

/** A color of the tokens: "#rrggbb", or {hex, alpha}. */
type TokenColor = string | { hex: string; alpha?: number };

interface TokenTerminal {
  background: TokenColor;
  foreground: TokenColor;
  cursor: TokenColor;
  selection: TokenColor;
  palette: TokenColor[];
}

/** A theme's terminal colors: the 16 ANSI colors are black to white, then
 * their bright variants. */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  palette: string[];
}

const hex = (c: TokenColor) => (typeof c === 'string' ? c : c.hex);

function colors(t: TokenTerminal): TerminalColors {
  return {
    background: hex(t.background),
    foreground: hex(t.foreground),
    cursor: hex(t.cursor),
    selection: hex(t.selection),
    palette: t.palette.map(hex),
  };
}

const terminal = tokens.terminal as { dark: TokenTerminal; light: TokenTerminal };

/** The terminal's default colors in the dark and the light theme. */
export const TOKEN_COLORS: Readonly<Record<'dark' | 'light', TerminalColors>> = {
  dark: colors(terminal.dark),
  light: colors(terminal.light),
};

/** The color themes, the default first. */
export const TOKEN_THEMES: readonly string[] = (tokens.themes as { id: string }[]).map((t) => t.id);

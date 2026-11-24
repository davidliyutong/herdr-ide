import { describe, expect, it } from 'vitest';
import tokens from '../../../spec/tokens.json';
import { builtinDefaults } from '../settings';
import { accentAttribute, colorThemes, DEFAULT_COLOR_THEME } from '../themes';
import { sizePx } from '../lib/sizes';

describe('design tokens', () => {
  // The terminal colors' settings default to the tokens' (scripts/tokens
  // writes the core's defaults).
  for (const kind of ['dark', 'light'] as const) {
    it(`are the ${kind} terminal colors' defaults`, () => {
      const token = tokens.terminal[kind];
      const p = `terminal.colors.${kind}.`;
      expect(builtinDefaults[p + 'palette']).toEqual(token.palette);
      expect(builtinDefaults[p + 'background']).toBe(token.background);
      expect(builtinDefaults[p + 'foreground']).toBe(token.foreground);
      expect(builtinDefaults[p + 'cursor']).toBe(token.cursor);
      expect(builtinDefaults[p + 'selection']).toBe(token.selection);
    });
  }

  it('gives the page and its terminals one background per theme', () => {
    expect(tokens.terminal.dark.background).toBe(tokens.color.background.dark);
    expect(tokens.terminal.light.background).toBe(tokens.color.background.light);
  });

  // The color theme setting defaults to the tokens' first theme (the core
  // offers them all: backend/kernel/config/ui).
  it('defaults to the first color theme', () => {
    expect(builtinDefaults['appearance.colorTheme']).toBe(DEFAULT_COLOR_THEME);
  });

  it('selects a theme other than the default by data-accent', () => {
    expect(accentAttribute(DEFAULT_COLOR_THEME)).toBeUndefined();
    expect(accentAttribute('vscode')).toBe('vscode');
    // A theme a newer core knows shows the default.
    expect(accentAttribute('no-such-theme')).toBeUndefined();
    expect(accentAttribute(undefined)).toBeUndefined();
  });

  // The accent marks focus and selection and carries text: 3:1 against the
  // background at least, and its own text 4.5:1 on it.
  for (const th of colorThemes) {
    for (const kind of ['dark', 'light'] as const) {
      it(`gives the ${th.id} theme a legible accent (${kind})`, () => {
        expect(contrast(th.accent[kind], tokens.color.background[kind])).toBeGreaterThanOrEqual(3);
        expect(contrast(th.onAccent[kind], th.accent[kind])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('scales sizes with the UI font size', () => {
    expect(sizePx('row', tokens.font.root)).toBe(tokens.size.row);
    expect(sizePx('row', 2 * tokens.font.root)).toBe(2 * tokens.size.row);
  });
});

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

import { describe, expect, it } from 'vitest';
import tokens from '../../../design/tokens.json';
import { builtinDefaults } from '../settings';

describe('design tokens', () => {
  // The terminal colors' settings default to the tokens' (scripts/tokens
  // writes the core's defaults), which the macOS application shares.
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
});

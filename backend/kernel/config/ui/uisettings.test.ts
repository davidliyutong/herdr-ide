import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '#kernel/config/settings/index.ts';
import { TOKEN_COLORS, TOKEN_THEMES } from './tokens.ts';
import { AGENTS, COLOR_THEME, MAX_UNDO_CLOSE, MIN_UNDO_CLOSE, MODULE, SCHEMES, UNDO_CLOSE } from './index.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';

const root = REPO_ROOT;

const sorted = (l: readonly string[]) => l.every((s, i) => i === 0 || l[i - 1] <= s);

describe('uisettings', () => {
  // Every color scheme and agent has a label in the UIs by its id; the
  // schemes' colors are tested by the web UI (schemes.test.ts).
  test('options', () => {
    expect(sorted(AGENTS)).toBe(true);
    expect(sorted(SCHEMES.slice(1))).toBe(true);
    expect(SCHEMES[0]).toBe('default');
  });

  // The color theme setting offers the design tokens' themes, the first by
  // default.
  test('color themes', () => {
    const d = MODULE.defs!.find((d) => d.key === COLOR_THEME)!;
    expect(d.enum).toEqual([...TOKEN_THEMES]);
    expect(d.default).toBe(TOKEN_THEMES[0]);
  });

  test('undo close bounds', () => {
    const d = MODULE.defs!.find((d) => d.key === UNDO_CLOSE)!;
    expect(d).toMatchObject({ default: 5, min: MIN_UNDO_CLOSE, max: MAX_UNDO_CLOSE, integer: true });
  });

  // The tokens read from spec/tokens.json are the values scripts/tokens
  // wrote into the Go program (internal/uisettings/tokens.go).
  test('tokens as tokens.go has them', () => {
    const go = readFileSync(join(root, 'internal/uisettings/tokens.go'), 'utf8');
    for (const theme of ['dark', 'light'] as const) {
      const m = new RegExp(
        `"${theme}": \\{\\s*Background: "(#[0-9a-f]{6})", Foreground: "(#[0-9a-f]{6})", Cursor: "(#[0-9a-f]{6})", Selection: "(#[0-9a-f]{6})",\\s*Palette: \\[\\]string\\{([^}]*)\\}`,
      ).exec(go);
      expect(m, theme).not.toBeNull();
      const palette = [...m![5].matchAll(/"(#[0-9a-f]{6})"/g)].map((p) => p[1]);
      expect(TOKEN_COLORS[theme]).toEqual({ background: m![1], foreground: m![2], cursor: m![3], selection: m![4], palette });
      expect(palette.length).toBe(16);
    }
    const themes = /var tokenThemes = \[\]string\{([^}]*)\}/.exec(go);
    expect(themes).not.toBeNull();
    expect([...TOKEN_THEMES]).toEqual([...themes![1].matchAll(/"([^"]+)"/g)].map((t) => t[1]));
  });

  // The settings' defaults are those scripts/registry wrote for the
  // clients (spec/generated/registry.json), and the agents those of the
  // registry's kinds.
  test('registry', () => {
    const registry = JSON.parse(readFileSync(join(root, 'spec/generated/registry.json'), 'utf8')) as {
      settings: Record<string, unknown>;
      agents: { id: string }[];
    };
    const store = new Store('', MODULE);
    expect(store.defs().length).toBe(MODULE.defs!.length);
    for (const d of store.defs()) expect(d.default, d.key).toEqual(registry.settings[d.key] as never);
    expect([...AGENTS]).toEqual(registry.agents.map((a) => a.id).sort());
    expect(store.lookup('notifications.mutedAgents')!.options).toEqual([...AGENTS]);
  });
});

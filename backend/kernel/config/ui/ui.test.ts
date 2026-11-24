import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { Settings } from '../settings/index.ts';
import { AGENTS, MAX_UNDO_CLOSE, MIN_UNDO_CLOSE, SCHEMES, TOKEN_COLORS, TOKEN_THEMES, UI } from './index.ts';

const sorted = (l: readonly string[]) => l.every((s, i) => i === 0 || l[i - 1]! <= s);

describe('ui settings', () => {
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
    const d = UI.settings['appearance.colorTheme'];
    expect(d.enum).toEqual([...TOKEN_THEMES]);
    expect(d.default).toBe(TOKEN_THEMES[0]!);
  });

  test('undo close bounds', () => {
    const d = new Settings('', { modules: [UI] }).definitions().find((d) => d.key === 'layout.undoClose');
    expect(d).toMatchObject({ default: 5, min: MIN_UNDO_CLOSE, max: MAX_UNDO_CLOSE, integer: true, step: 1 });
  });

  // The store types the values of a module's keys.
  test('typed values', () => {
    const s = new Settings('', { modules: [UI] }).of(UI);
    const size: number = s.get('terminal.fontSize');
    const theme: 'system' | 'light' | 'dark' = s.get('appearance.theme');
    const muted: string[] = s.get('notifications.mutedAgents');
    expect([size, theme, muted]).toEqual([13, 'system', ['droid']]);
    expect(s.bool('terminal.sshEnv', 'm')).toBe(true);
  });

  // The tokens read from spec/tokens.json are the values scripts/tokens
  // wrote into the Go program (internal/uisettings/tokens.go).
  test('tokens as tokens.go has them', () => {
    const go = readFileSync(join(REPO_ROOT, 'internal/uisettings/tokens.go'), 'utf8');
    for (const theme of ['dark', 'light'] as const) {
      const m = new RegExp(
        `"${theme}": \\{\\s*Background: "(#[0-9a-f]{6})", Foreground: "(#[0-9a-f]{6})", Cursor: "(#[0-9a-f]{6})", Selection: "(#[0-9a-f]{6})",\\s*Palette: \\[\\]string\\{([^}]*)\\}`,
      ).exec(go);
      expect(m, theme).not.toBeNull();
      const palette = [...m![5]!.matchAll(/"(#[0-9a-f]{6})"/g)].map((p) => p[1]);
      expect(TOKEN_COLORS[theme]).toEqual({
        background: m![1]!,
        foreground: m![2]!,
        cursor: m![3]!,
        selection: m![4]!,
        palette: palette as string[],
      });
      expect(palette.length).toBe(16);
    }
    const themes = /var tokenThemes = \[\]string\{([^}]*)\}/.exec(go);
    expect(themes).not.toBeNull();
    expect([...TOKEN_THEMES]).toEqual([...themes![1]!.matchAll(/"([^"]+)"/g)].map((t) => t[1]!));
  });

  // The agents offered are the registry's kinds.
  test('agents', () => {
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/generated/registry.json'), 'utf8')) as { agents: { id: string }[] };
    expect([...AGENTS]).toEqual(registry.agents.map((a) => a.id).sort());
    expect(UI.settings['notifications.mutedAgents'].options).toEqual([...AGENTS]);
  });
});

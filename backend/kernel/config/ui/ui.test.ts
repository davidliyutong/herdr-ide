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
  // wrote into the web UI's CSS (web/src/tokens.css): the terminal's colors
  // of the dark (:root) and the light theme, and the color themes, the
  // default first (the only one without a selector of its own).
  test('tokens as tokens.css has them', () => {
    const css = readFileSync(join(REPO_ROOT, 'web/src/tokens.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {\n`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('\n}\n', start));
    };
    for (const [theme, selector] of [
      ['dark', ':root'],
      ['light', ":root[data-theme='light']"],
    ] as const) {
      const b = block(selector);
      const v = (name: string) => new RegExp(`--ds-terminal-${name}: (#[0-9a-f]{6});`).exec(b)?.[1];
      expect(TOKEN_COLORS[theme]).toEqual({
        background: v('background')!,
        foreground: v('foreground')!,
        cursor: v('cursor')!,
        selection: v('selection')!,
        palette: Array.from({ length: 16 }, (_, i) => v(`ansi-${i}`)!),
      });
    }
    const accents = [...css.matchAll(/^:root\[data-accent='([^']+)'\] \{$/gm)].map((m) => m[1]!);
    expect(TOKEN_THEMES.slice(1)).toEqual(accents);
    expect(accents).not.toContain(TOKEN_THEMES[0]);
  });

  // The agents offered are the registry's kinds.
  test('agents', () => {
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/generated/registry.json'), 'utf8')) as { agents: { id: string }[] };
    expect([...AGENTS]).toEqual(registry.agents.map((a) => a.id).sort());
    expect(UI.settings['notifications.mutedAgents'].options).toEqual([...AGENTS]);
  });
});

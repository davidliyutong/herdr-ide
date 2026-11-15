// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}) } }));

import registry from '../../../design/generated/registry.json';
import { resolveTheme } from '../appearance';
import { dropZone } from '../paneDrag';
import { matchesSearch, problemText, valueLabel } from '../components/SettingsDialog';
import { hasMessage } from '../i18n';
import { applySettings, builtinDefaults, legacyImports, setSetting, useSettings, type SettingState } from '../settings';
import { getPrefs, usePrefs } from '../prefs';

describe('resolveTheme', () => {
  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('dropZone', () => {
  const r = { left: 100, top: 100, width: 200, height: 100 };
  it('swaps in the middle and moves to the nearest edge elsewhere', () => {
    expect(dropZone(r, 200, 150)).toBe('center');
    expect(dropZone(r, 105, 150)).toBe('left');
    expect(dropZone(r, 295, 150)).toBe('right');
    expect(dropZone(r, 200, 102)).toBe('top');
    expect(dropZone(r, 200, 198)).toBe('bottom');
    // Near a corner, the closer edge (relative to the pane's size) wins.
    expect(dropZone(r, 110, 190)).toBe('left');
  });
});

describe('translations', () => {
  // design/generated/registry.json lists the keys of every setting, option,
  // section and command the core registers.
  it('has every label the core’s registry needs', () => {
    expect(registry.i18n.length).toBeGreaterThan(80);
    for (const k of registry.i18n) expect(hasMessage(k), k).toBe(true);
  });
});

const values = (over: Record<string, unknown> = {}): Record<string, SettingState> => {
  const out: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) out[k] = { value: v, source: 'default' };
  for (const [k, v] of Object.entries(over)) out[k] = { value: v as never, source: 'global' };
  return out;
};

describe('settings store', () => {
  afterEach(() => {
    applySettings({ values: values(), problems: [] });
    vi.unstubAllGlobals();
  });

  it('starts from the built-in defaults', () => {
    const p = getPrefs();
    expect(p.theme).toBe('system');
    expect(p.termFontSize).toBe(13);
    expect(p.termLineHeight).toBe(1.05);
    expect(p.colors.dark.palette).toHaveLength(16);
    expect(p.colors.dark.background).toBe('#0a0a0a');
  });

  it('follows the core’s pushes', () => {
    applySettings({
      values: values({ 'terminal.fontSize': 15, 'terminal.colors.dark.foreground': '#ff0000' }),
      problems: [{ key: 'x', code: 'unknown' }],
    });
    expect(getPrefs().termFontSize).toBe(15);
    expect(getPrefs().colors.dark.foreground).toBe('#ff0000');
    expect(useSettings.getState().problems).toHaveLength(1);
    // Not a settings message: nothing changes.
    applySettings({});
    expect(getPrefs().termFontSize).toBe(15);
  });

  it('shows a change at once and keeps the core’s answer', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ values: values({ [body.key]: 16 }), problems: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const done = setSetting('terminal.fontSize', 18);
    expect(getPrefs().termFontSize).toBe(18);
    expect(await done).toBeUndefined();
    expect(getPrefs().termFontSize).toBe(16);
    expect(fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }));
    usePrefs.getState().setPref('optionIsMeta', true);
    expect(fetch.mock.calls[1][1]?.body).toBe('{"key":"terminal.optionIsMeta","value":true}');
  });

  it('reports the core’s error codes and shows the value before', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'locked' }), { status: 409 }));
    expect(await setSetting('terminal.fontSize', 18)).toBe('Fixed by a command-line flag');
    expect(getPrefs().termFontSize).toBe(13);
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await setSetting('terminal.fontSize', 18)).toBe('Could not reach the server');
  });
});

describe('browser settings of earlier versions', () => {
  it('moves values the core does not have yet', () => {
    const stored: Record<string, string> = {
      theme: 'light',
      termFontSize: '30.5',
      optionIsMeta: 'true',
      locale: '',
      dockPosition: 'left',
      uiFontSize: '99',
    };
    const got = legacyImports((k) => stored[k] ?? null, values({ 'terminal.optionIsMeta': false }));
    expect(got).toEqual([
      { name: 'locale', key: 'appearance.language', value: undefined },
      { name: 'theme', key: 'appearance.theme', value: 'light' },
      { name: 'uiFontSize', key: 'appearance.uiFontSize', value: 20 },
      { name: 'termFontSize', key: 'terminal.fontSize', value: 30.5 },
      // The VS Code panel's place, a setting no more: dropped.
      { name: 'dockPosition', key: '', value: undefined },
      // Set on the core already: the core's value stays.
      { name: 'optionIsMeta', key: 'terminal.optionIsMeta', value: undefined },
    ]);
    expect(legacyImports(() => null, values())).toEqual([]);
  });
});

describe('settings dialog', () => {
  it('finds settings', () => {
    expect(matchesSearch({ key: 'terminal.fontSize' }, 'font size')).toBe(true);
    expect(matchesSearch({ key: 'terminal.fontSize' }, 'FONTSIZE')).toBe(true);
    expect(matchesSearch({ key: 'terminal.cursorStyle', enum: ['block', 'bar', 'underline'] }, 'underline')).toBe(true);
    expect(matchesSearch({ key: 'terminal.fontSize' }, 'cursor')).toBe(false);
    expect(matchesSearch({ key: 'terminal.fontSize' }, '  ')).toBe(true);
  });
  it('labels values and problems', () => {
    expect(valueLabel({ key: 'gui.enabled', type: 'bool' }, false)).toBe('Off');
    expect(valueLabel({ key: 'gui.gpu', type: 'enum' }, 'all')).toBe('All programs');
    expect(valueLabel({ key: 'terminal.fontSize', type: 'number' }, 13)).toBe('13');
    expect(problemText({ key: 'gui.enabled', machine: 'm1', code: 'invalid', detail: 'must be true or false' })).toBe(
      'gui.enabled (m1) · invalid value · must be true or false',
    );
    expect(problemText({ code: 'parse' })).toContain('JSON');
  });
});

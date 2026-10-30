import { describe, expect, it } from 'vitest';
import { parsePref, prefDefs } from '../prefs';
import { resolveTheme } from '../appearance';
import { dropZone } from '../paneDrag';
import { serverSection } from '../components/SettingsDialog';
import { hasMessage } from '../i18n';
import { keyLabel } from '../keymap';

describe('parsePref', () => {
  it('falls back to the default for missing or invalid values', () => {
    expect(parsePref('theme', null)).toBe('system');
    expect(parsePref('theme', 'purple')).toBe('system');
    expect(parsePref('theme', 'light')).toBe('light');
    expect(parsePref('locale', '')).toBe('auto');
    expect(parsePref('optionIsMeta', 'true')).toBe(true);
    expect(parsePref('optionIsMeta', 'yes')).toBe(false);
  });
  it('clamps numbers to their range', () => {
    expect(parsePref('termFontSize', '100')).toBe(24);
    expect(parsePref('termFontSize', '3')).toBe(9);
    expect(parsePref('uiFontSize', '14.6')).toBe(15);
    expect(parsePref('uiFontSize', 'big')).toBe(13);
  });
  it('has a translated label for every setting and option', () => {
    for (const [key, d] of Object.entries(prefDefs)) {
      expect(hasMessage(`settings.${key}`), key).toBe(true);
      if (d.kind === 'enum' && key !== 'locale')
        for (const o of d.options) expect(hasMessage(`settings.${key}.${o}`), `${key}.${o}`).toBe(true);
    }
  });
});

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

describe('server settings', () => {
  it('groups code-server settings and translates them', () => {
    expect(serverSection('code-server-install')).toBe('codeServer');
    expect(serverSection('something-else')).toBe('server');
    for (const k of ['code-server-install', 'code-server-path']) expect(hasMessage(`settings.${k}`), k).toBe(true);
    for (const o of ['push', 'download', 'existing']) expect(hasMessage(`settings.code-server-install.${o}`), o).toBe(true);
  });
});

describe('keyLabel', () => {
  it('shows key names as the keys themselves', () => {
    expect(keyLabel('prefix+comma', 'ctrl+b')).toBe('ctrl+b ,');
    expect(keyLabel('prefix+minus', 'ctrl+b')).toBe('ctrl+b -');
    expect(keyLabel('prefix+shift+g', 'ctrl+a')).toBe('ctrl+a shift+g');
    expect(keyLabel('prefix+plus', 'ctrl+b')).toBe('ctrl+b +');
  });
});

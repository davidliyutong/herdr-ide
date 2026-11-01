import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShortcut, shortcutFor, shortcutsFromSettings, toAccelerator } from './shortcuts';

const key = (code: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}, type = 'keyDown') => ({
  type,
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
});

test('specs need a known key and cmd, ctrl or alt', () => {
  assert.deepEqual(parseShortcut('cmd+shift+t'), { cmd: true, ctrl: false, alt: false, shift: true, key: 't' });
  for (const spec of [undefined, '', 'none', 't', 'shift+t', 'cmd+', 'meta+t', 'cmd+cmd+t', 'cmd+f25', 'cmd+tt', 'Cmd+T'])
    assert.equal(parseShortcut(spec), undefined, String(spec));
});

test('inputs match exact modifiers on the physical key', () => {
  const s = { new_tab: 'cmd+t', close_tab: 'ctrl+w' };
  assert.equal(shortcutFor(s, key('KeyT', { meta: true })), 'new_tab');
  assert.equal(shortcutFor(s, key('KeyW', { control: true })), 'close_tab');
  assert.equal(shortcutFor(s, key('KeyT', { meta: true, shift: true })), undefined);
  assert.equal(shortcutFor(s, key('KeyT', { meta: true }, 'keyUp')), undefined);
  assert.equal(shortcutFor(s, key('KeyW', { meta: true })), undefined);
  assert.equal(shortcutFor({ new_tab: 'none' }, key('KeyT', { meta: true })), undefined);
  assert.equal(shortcutFor({ new_tab: 'alt+bracketleft' }, key('BracketLeft', { alt: true })), 'new_tab');
  assert.equal(shortcutFor({ new_tab: 'ctrl+f5' }, key('F5', { control: true })), 'new_tab');
});

test('menu accelerators', () => {
  assert.equal(toAccelerator('cmd+t'), 'Super+T');
  assert.equal(toAccelerator('ctrl+shift+w'), 'Control+Shift+W');
  assert.equal(toAccelerator('alt+comma'), 'Alt+,');
  assert.equal(toAccelerator('none'), undefined);
});

test('shortcuts come from the settings reply; invalid values are dropped', () => {
  const reply = {
    settings: [
      { key: 'desktop-new-tab-key', value: 'cmd+t' },
      { key: 'desktop-close-tab-key', value: 'w' },
      { key: 'gui', value: 'on' },
    ],
  };
  assert.deepEqual(shortcutsFromSettings(reply), { new_tab: 'cmd+t' });
  assert.deepEqual(shortcutsFromSettings(null), {});
  assert.deepEqual(shortcutsFromSettings({ settings: 'x' }), {});
});

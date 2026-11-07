import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultShortcuts,
  isCodeFrame,
  overCode,
  parseShortcut,
  recordedSpec,
  shortcutFor,
  shortcutsFromSettings,
  toAccelerator,
} from './shortcuts';

type Mods = Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }>;

// A key on a US layout: its character is the code's letter or digit.
const key = (code: string, mods: Mods = {}, type = 'keyDown') => ({
  type,
  key: /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : code,
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

// A key whose character on the current layout is char.
const typed = (char: string, code: string, mods: Mods = {}) => ({ ...key(code, mods), key: char });

test('keys match by their character on the current layout', () => {
  const s = { new_tab: 'cmd+t', close_tab: 'cmd+w' };
  // AZERTY: Z sits where QWERTY has W. Cmd+Z is undo, not close tab.
  assert.equal(shortcutFor(s, typed('z', 'KeyW', { meta: true })), undefined);
  assert.equal(shortcutFor(s, typed('w', 'KeyZ', { meta: true })), 'close_tab');
  // Dvorak: the key at KeyW types a comma.
  assert.equal(shortcutFor(s, typed(',', 'KeyW', { meta: true })), undefined);
  assert.equal(shortcutFor(s, typed('w', 'Comma', { meta: true })), 'close_tab');
  // Shift changes the character's case only.
  assert.equal(shortcutFor({ new_tab: 'cmd+shift+t' }, typed('T', 'KeyT', { meta: true, shift: true })), 'new_tab');
  assert.equal(shortcutFor({ new_tab: 'cmd+shift+1' }, typed('!', 'Digit1', { meta: true, shift: true })), 'new_tab');
  // Non-Latin layouts and Option characters fall back to the physical key.
  assert.equal(shortcutFor(s, typed('ц', 'KeyW', { meta: true })), 'close_tab');
  assert.equal(shortcutFor({ new_tab: 'alt+t' }, typed('†', 'KeyT', { alt: true })), 'new_tab');
  assert.equal(shortcutFor({ new_tab: 'cmd+comma' }, typed(',', 'KeyM', { meta: true })), 'new_tab');
});

test('default shortcuts per platform', () => {
  assert.deepEqual(defaultShortcuts('darwin'), {
    new_tab: 'cmd+t',
    close_tab: 'cmd+w',
    open_settings: 'cmd+comma',
    new_workspace: 'cmd+n',
    toggle_code: 'cmd+j',
  });
  assert.deepEqual(defaultShortcuts('linux'), {
    new_tab: 'ctrl+shift+t',
    close_tab: 'ctrl+shift+w',
    open_settings: 'ctrl+comma',
    new_workspace: 'ctrl+shift+n',
    toggle_code: 'ctrl+shift+j',
  });
  // Only showing or hiding VS Code works while VS Code has focus.
  assert.deepEqual([...overCode], ['toggle_code']);
  // Cmd+, by the character the layout types.
  assert.equal(shortcutFor(defaultShortcuts('darwin'), typed(',', 'Comma', { meta: true })), 'open_settings');
  assert.equal(toAccelerator('cmd+comma'), 'Super+,');
});

test('recorded keys', () => {
  assert.equal(recordedSpec(typed('w', 'KeyZ', { meta: true })), 'cmd+w');
  assert.equal(recordedSpec(key('KeyT', { control: true, shift: true })), 'ctrl+shift+t');
  assert.equal(recordedSpec(key('F4', { alt: true })), 'alt+f4');
  // Keys that type text, lone modifiers and key-ups reach the page.
  assert.equal(recordedSpec(key('KeyT', { shift: true })), undefined);
  assert.equal(recordedSpec(key('Escape')), undefined);
  assert.equal(recordedSpec(typed('Meta', 'MetaLeft', { meta: true })), undefined);
  assert.equal(recordedSpec(key('KeyT', { meta: true }, 'keyUp')), undefined);
});

test('VS Code frames', () => {
  const origin = 'http://127.0.0.1:7781';
  assert.equal(isCodeFrame(`${origin}/m/local/code/?folder=/src`, origin), true);
  assert.equal(isCodeFrame(`${origin}/m/gpu%20box/code/static/out/vs/workbench/webview.html`, origin), true);
  assert.equal(isCodeFrame(`${origin}/m/local/files/a.pdf`, origin), false);
  assert.equal(isCodeFrame(`${origin}/`, origin), false);
  assert.equal(isCodeFrame('http://127.0.0.1:9999/m/local/code/', origin), false);
  assert.equal(isCodeFrame('about:blank', origin), false);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceleratorFor,
  bindingsFromReply,
  defaultBindings,
  directShortcuts,
  isCodeFrame,
  platformOf,
  recordedSpec,
  shortcutFor,
  shortcutOutsideCode,
  toAccelerator,
  type Binding,
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

// A key whose character on the current layout is char.
const typed = (char: string, code: string, mods: Mods = {}) => ({ ...key(code, mods), key: char });

const b = (key: string, command: string, when = 'terminal'): Binding => ({ key, command, when });

test('only single strokes with cmd, ctrl or alt are direct shortcuts', () => {
  const list = [
    b('cmd+t', 'tab.new'),
    b('ctrl+b c', 'tab.new'),
    b('f5', 'code.open'),
    b('alt+x', 'x'),
    b('ctrl+shift+w', 'tab.close'),
    b('bad key', 'x'),
  ];
  assert.deepEqual(
    directShortcuts(list).map((x) => x.key),
    ['cmd+t', 'alt+x', 'ctrl+shift+w'],
  );
});

test('inputs match exact modifiers', () => {
  const s = [b('cmd+t', 'tab.new'), b('ctrl+w', 'tab.close'), b('alt+bracketleft', 'x'), b('ctrl+f5', 'y')];
  assert.equal(shortcutFor(s, key('KeyT', { meta: true }))?.command, 'tab.new');
  assert.equal(shortcutFor(s, key('KeyW', { control: true }))?.command, 'tab.close');
  assert.equal(shortcutFor(s, key('KeyT', { meta: true, shift: true })), undefined);
  assert.equal(shortcutFor(s, key('KeyT', { meta: true }, 'keyUp')), undefined);
  assert.equal(shortcutFor(s, key('KeyW', { meta: true })), undefined);
  assert.equal(shortcutFor(s, key('BracketLeft', { alt: true }))?.command, 'x');
  assert.equal(shortcutFor(s, key('F5', { control: true }))?.command, 'y');
  // A chord's first stroke is the page's.
  assert.equal(shortcutFor([b('ctrl+b c', 'tab.new')], key('KeyB', { control: true })), undefined);
});

test('keys match by their character on the current layout', () => {
  const s = [b('cmd+t', 'tab.new'), b('cmd+w', 'pane.close')];
  // AZERTY: Z sits where QWERTY has W. Cmd+Z is undo, not close.
  assert.equal(shortcutFor(s, typed('z', 'KeyW', { meta: true })), undefined);
  assert.equal(shortcutFor(s, typed('w', 'KeyZ', { meta: true }))?.command, 'pane.close');
  // Dvorak: the key at KeyW types a comma.
  assert.equal(shortcutFor(s, typed(',', 'KeyW', { meta: true })), undefined);
  // Shift changes the character's case only.
  assert.equal(shortcutFor([b('cmd+shift+t', 'x')], typed('T', 'KeyT', { meta: true, shift: true }))?.command, 'x');
  assert.equal(shortcutFor([b('cmd+shift+1', 'x')], typed('!', 'Digit1', { meta: true, shift: true }))?.command, 'x');
  // Non-Latin layouts and Option characters fall back to the physical key.
  assert.equal(shortcutFor(s, typed('ц', 'KeyW', { meta: true }))?.command, 'pane.close');
  assert.equal(shortcutFor([b('alt+t', 'x')], typed('†', 'KeyT', { alt: true }))?.command, 'x');
});

test('VS Code keeps its keys except bindings for everywhere', () => {
  const s = defaultBindings('mac');
  assert.equal(shortcutFor(s, key('KeyJ', { meta: true }), true)?.command, 'view.toggleCode');
  assert.equal(shortcutFor(s, key('KeyW', { meta: true }), true), undefined);
  assert.equal(shortcutOutsideCode(s, key('KeyW', { meta: true })), true);
  assert.equal(shortcutFor([b('cmd+k', 'x', 'vscode')], key('KeyK', { meta: true }), true)?.command, 'x');
  assert.equal(shortcutFor([b('cmd+k', 'x', 'vscode')], key('KeyK', { meta: true })), undefined);
  assert.equal(shortcutFor([b('cmd+k', 'x', 'dialog')], key('KeyK', { meta: true })), undefined);
});

test('default shortcuts per platform', () => {
  assert.equal(platformOf('darwin'), 'mac');
  assert.equal(platformOf('linux'), 'pc');
  const mac = defaultBindings('mac');
  const pc = defaultBindings('pc');
  const direct = (list: Binding[], command: string) => directShortcuts(list).find((x) => x.command === command)?.key;
  assert.equal(direct(mac, 'tab.new'), 'cmd+t');
  assert.equal(direct(mac, 'pane.close'), 'cmd+w');
  assert.equal(direct(mac, 'app.settings'), 'cmd+comma');
  assert.equal(direct(mac, 'workspace.new'), 'cmd+n');
  assert.equal(direct(mac, 'view.toggleCode'), 'cmd+j');
  assert.equal(direct(pc, 'tab.new'), 'ctrl+shift+t');
  assert.equal(direct(pc, 'tab.close'), 'ctrl+shift+w');
  assert.equal(direct(pc, 'app.settings'), 'ctrl+comma');
  assert.equal(direct(pc, 'workspace.new'), 'ctrl+shift+n');
  assert.equal(direct(pc, 'view.toggleCode'), 'ctrl+shift+j');
  // Cmd+, by the character the layout types.
  assert.equal(shortcutFor(mac, typed(',', 'Comma', { meta: true }))?.command, 'app.settings');
  assert.equal(acceleratorFor(mac, 'app.settings'), 'Super+,');
  assert.equal(acceleratorFor(mac, 'tab.close'), undefined);
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
  assert.equal(toAccelerator('ctrl+b c'), undefined);
  assert.equal(toAccelerator('none'), undefined);
  assert.equal(toAccelerator(undefined), undefined);
});

test('bindings come from the keybindings reply; malformed entries are dropped', () => {
  const reply = {
    effective: {
      mac: [b('cmd+t', 'tab.new'), { key: 1, command: 'x', when: 'terminal' }, b('cmd+x', 'bad command')],
      pc: [b('ctrl+shift+t', 'tab.new')],
    },
  };
  assert.deepEqual(bindingsFromReply(reply, 'mac'), [b('cmd+t', 'tab.new')]);
  assert.deepEqual(bindingsFromReply(reply, 'pc'), [b('ctrl+shift+t', 'tab.new')]);
  assert.equal(bindingsFromReply(null, 'mac'), undefined);
  assert.equal(bindingsFromReply({ effective: 'x' }, 'mac'), undefined);
});

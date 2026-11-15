import test from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItemConstructorOptions } from 'electron';
import registry from '../../design/generated/registry.json';
import { translate } from '../../web/src/i18n';
import { en, type MessageKey } from '../../web/src/i18n/en';
import { zhCN } from '../../web/src/i18n/zh-CN';
import { accelerator, menus, menuTemplate, type Binding } from './menu';

const mac = registry.keybindings.mac as Binding[];

test('every item runs a registered command or a standard role, titled in both languages', () => {
  const commands = new Set(registry.commands.map((c) => c.id));
  for (const { title, items } of menus) {
    if (title !== 'app') assert.ok(en[`desktop.menu.${title}`] && zhCN[`desktop.menu.${title}`], title);
    for (const it of items) {
      if (it === '-') continue;
      if ('command' in it) assert.ok(commands.has(it.command), it.command);
      assert.ok(en[`desktop.menu.${it.title}` as MessageKey] && zhCN[`desktop.menu.${it.title}` as MessageKey], it.title);
    }
  }
});

test('accelerators: one stroke, shifted punctuation as its character', () => {
  assert.deepEqual(accelerator('cmd+t'), { accelerator: 'Super+T', cmd: true });
  assert.deepEqual(accelerator('cmd+shift+d'), { accelerator: 'Super+Shift+D', cmd: true });
  assert.deepEqual(accelerator('cmd+comma'), { accelerator: 'Super+,', cmd: true });
  assert.deepEqual(accelerator('cmd+shift+bracketright'), { accelerator: 'Super+}', cmd: true });
  assert.deepEqual(accelerator('cmd+shift+equal'), { accelerator: 'Super+Plus', cmd: true });
  assert.deepEqual(accelerator('cmd+shift+1'), { accelerator: 'Super+!', cmd: true });
  assert.deepEqual(accelerator('ctrl+alt+left'), { accelerator: 'Control+Alt+Left', cmd: false });
  assert.deepEqual(accelerator('ctrl+shift+tab'), { accelerator: 'Control+Shift+Tab', cmd: false });
  assert.deepEqual(accelerator('cmd+slash'), { accelerator: 'Super+/', cmd: true });
  assert.deepEqual(accelerator('ctrl+shift+slash'), { accelerator: 'Control+?', cmd: false });
  for (const key of ['ctrl+k c', 'ctrl+b shift+slash', 't', 'cmd+nope', '']) assert.equal(accelerator(key), undefined, key);
});

type Built = MenuItemConstructorOptions & { submenu: MenuItemConstructorOptions[] };

/** The built menu for bindings, in English, with the commands its items ran. */
function build(bindings: Binding[]) {
  const ran: string[] = [];
  const template = menuTemplate(
    bindings,
    'App',
    (key, vars) => translate('en', key, vars),
    (command) => () => ran.push(command),
  ) as Built[];
  const items = template.flatMap((m) => m.submenu);
  const byCommand = (id: string) => items.find((it) => it.id === id)!;
  return { template, items, byCommand, ran };
}

test('items show the first single-stroke key of their command and run it', () => {
  const { template, byCommand, ran, items } = build(mac);
  assert.deepEqual(
    template.map((m) => m.label),
    ['App', 'Shell', 'Edit', 'View', 'Window'],
  );
  assert.equal(items.find((it) => it.role === 'quit')?.label, 'Quit App');
  const newTerminal = byCommand('tab.new');
  assert.equal(newTerminal.label, 'New Terminal');
  assert.equal(newTerminal.accelerator, 'Super+T');
  assert.equal(newTerminal.registerAccelerator, true);
  assert.equal(byCommand('pane.close').accelerator, 'Super+W');
  assert.equal(byCommand('tab.next').accelerator, 'Super+}');
  assert.equal(byCommand('view.toggleCode').accelerator, 'Super+J');
  assert.equal(byCommand('app.commandPalette').accelerator, 'Super+Shift+P');
  assert.equal(byCommand('app.keyboardShortcuts').accelerator, 'Super+/');
  // Commands without a default key are items without one.
  for (const id of ['pane.zoom', 'workspace.switch', 'workspace.rename', 'tab.rename', 'pane.focusLeft']) {
    assert.equal(byCommand(id).accelerator, undefined, id);
    assert.ok(byCommand(id).label, id);
  }
  (newTerminal.click as () => void)();
  assert.deepEqual(ran, ['tab.new']);
});

test('on other systems the menu shows the Ctrl+Shift keys and leaves them to the page', () => {
  const { byCommand } = build(registry.keybindings.pc as Binding[]);
  assert.equal(byCommand('app.commandPalette').accelerator, 'Control+Shift+P');
  assert.equal(byCommand('app.commandPalette').registerAccelerator, false);
  assert.equal(byCommand('tab.new').accelerator, 'Control+Shift+T');
  assert.equal(byCommand('pane.splitRight').accelerator, undefined);
});

/** The bindings the core works out after the user's rules: a rule adds its
 * key; "-command" removes that key of the command. */
function withRules(defaults: Binding[], rules: { key: string; command: string }[]): Binding[] {
  let out = [...defaults];
  for (const r of rules) {
    if (r.command.startsWith('-')) out = out.filter((b) => !(b.key === r.key && b.command === r.command.slice(1)));
    else out.push({ key: r.key, command: r.command, when: 'terminal' });
  }
  return out;
}

test("a rebinding moves the item's key; an unbinding removes it; chords stay with the page", () => {
  const { byCommand } = build(
    withRules(mac, [
      { key: 'cmd+t', command: '-tab.new' },
      { key: 'cmd+shift+t', command: 'tab.new' },
      { key: 'cmd+w', command: '-pane.close' },
      { key: 'ctrl+k z', command: 'pane.zoom' },
      { key: 'ctrl+alt+z', command: 'pane.zoom' },
    ]),
  );
  assert.equal(byCommand('tab.new').accelerator, 'Super+Shift+T');
  // Unbound: the item stays, without a key.
  assert.equal(byCommand('pane.close').accelerator, undefined);
  assert.equal(byCommand('pane.close').label, 'Close Terminal');
  // A chord is never an accelerator; a key without Cmd is shown, not taken.
  assert.equal(byCommand('pane.zoom').accelerator, 'Control+Alt+Z');
  assert.equal(byCommand('pane.zoom').registerAccelerator, false);
});

test('titles follow the language', () => {
  const template = menuTemplate(
    mac,
    'App',
    (key, vars) => translate('zh-CN', key, vars),
    () => () => {},
  ) as Built[];
  assert.deepEqual(
    template.map((m) => m.label),
    ['App', '终端', '编辑', '显示', '窗口'],
  );
  assert.equal(template[0].submenu.find((it) => it.role === 'about')?.label, '关于 App');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { MenuItemConstructorOptions } from 'electron';
import registry from '../../design/generated/registry.json';
import { translate } from '../../web/src/i18n';
import { en, type MessageKey } from '../../web/src/i18n/en';
import { zhCN } from '../../web/src/i18n/zh-CN';
import { accelerator, menuCommands, menus, menusFor, menuTemplate, parseDisabled, type Binding } from './menu';
import type { Platform } from './platform';

const mac = registry.keybindings.mac as Binding[];

test('every item runs a registered command, named as the command, or a standard role, titled in both languages', () => {
  const commands = new Set(registry.commands.map((c) => c.id));
  for (const { title, items } of menus) {
    if (title !== 'app') assert.ok(en[`desktop.menu.${title}`] && zhCN[`desktop.menu.${title}`], title);
    for (const it of items) {
      if (it === '-') continue;
      if ('command' in it) {
        assert.ok(commands.has(it.command), it.command);
        const key = `command.${it.command}` as MessageKey;
        assert.ok(en[key] && zhCN[key], key);
      } else assert.ok(en[`desktop.menu.${it.title}` as MessageKey] && zhCN[`desktop.menu.${it.title}` as MessageKey], it.title);
    }
  }
});

test("the page's disabled commands are disabled items; anything else is refused", () => {
  const template = menuTemplate(
    mac,
    'App',
    (key, vars) => translate('en', key, vars),
    () => () => {},
    'darwin',
    new Set(['tab.close']),
  ) as Built[];
  const items = template.flatMap((m) => m.submenu);
  assert.equal(items.find((it) => it.id === 'tab.close')?.enabled, false);
  assert.equal(items.find((it) => it.id === 'tab.new')?.enabled, true);
  // Commands without an item (the tab numbers, VS Code's) are left out.
  assert.deepEqual(parseDisabled(['tab.close', 'pane.zoom', 'tab.select1', 'code.diff']), new Set(['tab.close', 'pane.zoom']));
  for (const bad of [['tab.close', 'rm -rf'], 'tab.close', [1], null, Array(201).fill('tab.close')])
    assert.equal(parseDisabled(bad), undefined);
  // Every command of the menu can be named; the Window menu is macOS's.
  assert.ok(menuCommands().includes('app.addMachine'));
  assert.equal(template.find((m) => m.label === 'Window')?.role, 'windowMenu');
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

/** The built menu of a platform for bindings, in English, with the commands
 * its items ran. */
function build(bindings: Binding[], platform: Platform = 'darwin') {
  const ran: string[] = [];
  const template = menuTemplate(
    bindings,
    'App',
    (key, vars) => translate('en', key, vars),
    (command) => () => ran.push(command),
    platform,
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
  assert.equal(newTerminal.label, 'New Tab');
  assert.equal(newTerminal.accelerator, 'Super+T');
  assert.equal(newTerminal.registerAccelerator, true);
  assert.equal(byCommand('pane.close').accelerator, 'Super+W');
  assert.equal(byCommand('tab.next').accelerator, 'Super+}');
  assert.equal(byCommand('code.open').accelerator, 'Super+J');
  assert.equal(byCommand('app.commandPalette').accelerator, 'Super+Shift+P');
  assert.equal(byCommand('app.keyboardShortcuts').accelerator, 'Super+/');
  assert.equal(byCommand('tab.close').accelerator, 'Super+Shift+W');
  assert.equal(byCommand('pane.focusLeft').accelerator, 'Super+Alt+Left');
  assert.equal(byCommand('pane.zoom').accelerator, 'Super+Shift+Enter');
  assert.equal(byCommand('pane.back').accelerator, 'Super+[');
  assert.equal(byCommand('pane.back').registerAccelerator, false);
  assert.equal(byCommand('pane.forward').accelerator, 'Super+]');
  assert.equal(byCommand('pane.forward').registerAccelerator, false);
  assert.equal(byCommand('pane.splitRight').accelerator, 'Super+D');
  assert.equal(byCommand('pane.splitRight').registerAccelerator, false);
  assert.equal(byCommand('find.open').accelerator, 'Super+F');
  assert.equal(byCommand('find.open').registerAccelerator, false);
  assert.equal(byCommand('app.keyboardShortcuts').registerAccelerator, false);
  assert.equal(byCommand('pane.leave').accelerator, 'Control+B');
  assert.equal(byCommand('pane.leave').registerAccelerator, false);
  // Cmd+Z is Edit's Undo in text fields and VS Code: the item only shows it,
  // and the page takes it in a terminal.
  assert.equal(byCommand('pane.undoClose').accelerator, 'Super+Z');
  assert.equal(byCommand('pane.undoClose').registerAccelerator, false);
  // The window's zoom, shown with the key it is known by (⌘+).
  assert.equal(byCommand('view.zoomIn').label, 'Zoom In');
  assert.equal(byCommand('view.zoomIn').accelerator, 'Super+Plus');
  assert.equal(byCommand('view.zoomOut').accelerator, 'Super+-');
  assert.equal(byCommand('view.zoomReset').accelerator, 'Super+0');
  assert.deepEqual(
    items
      .filter((it) => it.role && ['minimize', 'zoom', 'front', 'togglefullscreen', 'hideOthers', 'unhide'].includes(it.role))
      .map((it) => it.label),
    ['Hide Others', 'Show All', 'Toggle Full Screen', 'Minimize', 'Zoom', 'Bring All to Front'],
  );
  // Commands without a default key are items without one.
  for (const id of ['workspace.edit', 'tab.rename', 'workspace.close', 'app.addMachine']) {
    assert.equal(byCommand(id).accelerator, undefined, id);
    assert.ok(byCommand(id).label, id);
  }
  (newTerminal.click as () => void)();
  assert.deepEqual(ran, ['tab.new']);
});

test('on Windows and Linux, File and Help menus; platform-native keys are shown and every one is left to the page', () => {
  for (const [p, regKey, splitRight] of [
    ['win32', 'windows', 'Alt+Plus'],
    ['linux', 'linux', 'Control+Shift+D'],
  ] as const) {
    const { template, byCommand, items } = build(registry.keybindings[regKey] as Binding[], p);
    assert.deepEqual(
      template.map((m) => m.label),
      ['File', 'Shell', 'Edit', 'View', 'Window', 'Help'],
    );
    assert.deepEqual(
      template[0].submenu.map((it) => it.label ?? '-'),
      ['Settings…', 'Keyboard Shortcuts', '-', p === 'win32' ? 'Exit' : 'Quit App'],
    );
    assert.equal(template.at(-1)!.submenu[0].role, 'about');
    assert.equal(
      items.find((it) => it.role === 'hide'),
      undefined,
    );
    assert.equal(byCommand('app.commandPalette').accelerator, 'Control+Shift+P');
    assert.equal(byCommand('tab.new').accelerator, 'Control+Shift+T');
    assert.equal(byCommand('pane.splitRight').accelerator, splitRight);
    assert.equal(byCommand('pane.back').accelerator, 'Alt+Left');
    assert.equal(byCommand('pane.leave').accelerator, 'Control+B');
    // Ctrl+C, Ctrl+M, Ctrl+Q… are programs' keys in terminals: no item takes one.
    for (const it of items) if (it.role || it.accelerator) assert.equal(it.registerAccelerator, false, String(it.label));
  }
  // The same commands everywhere.
  const commands = (p: Platform) =>
    menusFor(p)
      .flatMap((m) => m.items)
      .flatMap((it) => (it !== '-' && 'command' in it ? [it.command] : []))
      .sort();
  assert.deepEqual(commands('win32'), commands('darwin'));
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
      { key: 'cmd+shift+enter', command: '-pane.zoom' },
      { key: 'ctrl+k z', command: 'pane.zoom' },
      { key: 'ctrl+alt+z', command: 'pane.zoom' },
    ]),
  );
  assert.equal(byCommand('tab.new').accelerator, 'Super+Shift+T');
  // Unbound: the item stays, without a key.
  assert.equal(byCommand('pane.close').accelerator, undefined);
  assert.equal(byCommand('pane.close').label, 'Close Pane');
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
    'darwin',
  ) as Built[];
  assert.deepEqual(
    template.map((m) => m.label),
    ['App', '终端', '编辑', '视图', '窗口'],
  );
  assert.equal(template[0].submenu.find((it) => it.role === 'about')?.label, '关于 App');
  // Items of commands are named as the commands are everywhere else.
  assert.equal(template[1].submenu.find((it) => it.id === 'tab.new')?.label, '新建标签页');
});

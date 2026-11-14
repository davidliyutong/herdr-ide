import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MenuItemConstructorOptions } from 'electron';
import registry from '../../design/generated/registry.json';
import { translate } from '../../web/src/i18n';
import { en, type MessageKey } from '../../web/src/i18n/en';
import { zhCN } from '../../web/src/i18n/zh-CN';
import { accelerator, menus, menuTemplate, type Binding } from './menu';

// The tests run from desktop/ (pnpm -C desktop test).
const repo = '..';
const mac = registry.keybindings.mac as Binding[];

/** The menu the macOS application builds (makeMenu in its main.swift): each
 * menu's title key and its items, "-" for separators. */
function nativeMenus(): { title: string; items: string[] }[] {
  const swift = readFileSync(`${repo}/macos/Sources/App/main.swift`, 'utf8');
  const body = swift.slice(swift.indexOf('private func makeMenu()'));
  const out: { title: string; items: string[] }[] = [];
  const line =
    /submenu\((?:Brand\.appName|tr\("menu\.(\w+)"\))\)|command\(menu, "menu\.(\w+)", "([\w.]+)"\)|add\(menu, "menu\.(\w+)"|menu\.addItem\(\.separator\(\)\)|^\s*return main$/gm;
  for (const m of body.matchAll(line)) {
    if (m[0].trim() === 'return main') break;
    if (m[0].startsWith('submenu')) out.push({ title: m[1] ?? 'app', items: [] });
    else if (m[2]) out.at(-1)!.items.push(`${m[2]} ${m[3]}`);
    else if (m[4]) out.at(-1)!.items.push(m[4]);
    else out.at(-1)!.items.push('-');
  }
  return out;
}

/** Items without separators at either end or in a row. */
function tidy(items: string[]): string[] {
  return items.filter((it, i, all) => it !== '-' || (i > 0 && i < all.length - 1 && all[i + 1] !== '-'));
}

// Edit's Undo, Redo and Cut are the shell's own (Chromium's text fields need
// them); Files… and Add Machine… open the macOS application's own windows
// and dialogs (the page has its sidebar's).
const shellOnly = new Set(['undo', 'redo', 'cut']);
const nativeOnly = new Set(['files', 'addMachine']);

test("the menu is the macOS application's: same menus, commands, order", () => {
  const native = nativeMenus();
  assert.ok(native.length >= 5, 'main.swift parsed');
  const shell = menus.map(({ title, items }) => ({
    title,
    items: tidy(
      items
        .filter((it) => it === '-' || !shellOnly.has(it.title))
        .map((it) => (it === '-' ? '-' : 'command' in it ? `${it.title} ${it.command}` : it.title)),
    ),
  }));
  const expected = native.map(({ title, items }) => ({ title, items: tidy(items.filter((it) => !nativeOnly.has(it))) }));
  assert.deepEqual(shell, expected);
});

/** The macOS application's strings of a language, %@ written {app}. */
function nativeStrings(lproj: string): Map<string, string> {
  const text = readFileSync(`${repo}/macos/Sources/App/Resources/${lproj}.lproj/Localizable.strings`, 'utf8');
  return new Map([...text.matchAll(/^"([^"]+)" = "(.*)";$/gm)].map((m) => [m[1], m[2].replaceAll('%@', '{app}')]));
}

test("titles are the macOS application's, in English and Chinese", () => {
  const titles = menus
    .flatMap(({ title, items }) => [title, ...items.map((it) => (it === '-' ? '' : it.title))])
    .filter((t) => t && t !== 'app');
  for (const [dict, lproj] of [
    [en, 'en'],
    [zhCN, 'zh-Hans'],
  ] as const) {
    const native = nativeStrings(lproj);
    for (const title of titles) {
      const own = dict[`desktop.menu.${title}` as MessageKey];
      assert.ok(own, `desktop.menu.${title} (${lproj})`);
      if (!shellOnly.has(title)) assert.equal(own, native.get(`menu.${title}`), `menu.${title} (${lproj})`);
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
  for (const key of ['ctrl+b c', 'ctrl+b shift+slash', 't', 'cmd+nope', '']) assert.equal(accelerator(key), undefined, key);
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
  // cmd+t, not the chord ctrl+b c listed first.
  assert.equal(newTerminal.accelerator, 'Super+T');
  assert.equal(newTerminal.registerAccelerator, true);
  assert.equal(byCommand('pane.close').accelerator, 'Super+W');
  assert.equal(byCommand('tab.next').accelerator, 'Super+}');
  assert.equal(byCommand('view.toggleCode').accelerator, 'Super+J');
  // Commands with chords only show none: the page matches chords.
  assert.equal(byCommand('pane.zoom').accelerator, undefined);
  assert.equal(byCommand('workspace.switch').accelerator, undefined);
  (newTerminal.click as () => void)();
  assert.deepEqual(ran, ['tab.new']);
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
  // Unbound: the item stays, without a key; its chord ctrl+b x is the page's.
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

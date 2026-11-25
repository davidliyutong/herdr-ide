// The registry's contents for a core of features (registry.ts); the
// composed core's, against the files in the repository, are tested with
// its composition (hosts/bun/registry.test.ts).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRegistry, coreModules, fillReference, registryInput, translationKeys, updateRegistry } from './registry.ts';
import { bool, defineModule, enumOf, Settings } from './settings/index.ts';
import { UI } from './ui/index.ts';

/** A feature with a section of its own, a setting with a flag and an enum. */
const extra = {
  id: 'extra',
  settings: defineModule({
    sections: [{ id: 'extra', order: 80, plugin: 'extra' }],
    settings: {
      'extra.on': bool({ default: true, section: 'extra', order: 10, flag: 'extra-on', usage: 'turns it on' }),
      'extra.mode': enumOf(['a', 'b'], { default: 'a', section: 'extra', order: 20 }),
    },
  }),
};
const input = registryInput([{ id: 'machines', toggle: false }, extra]);

describe('core modules', () => {
  // The user interface's module, the switches of the features that have
  // one in the features' order, then the features' own modules in that
  // order; a feature that is always on has no switch.
  test("the features' modules and switches, in their order", () => {
    const files = defineModule({
      sections: [{ id: 'files', order: 66, plugin: 'files' }],
      settings: { 'files.showHidden': bool({ default: true, section: 'files', order: 10 }) },
    });
    const modules = coreModules([
      { id: 'machines', toggle: false },
      { id: 'vscode', defaultOff: true, browserRisk: true },
      { id: 'files', settings: files },
      extra,
    ]);
    expect(modules[0]).toBe(UI);
    expect(modules.slice(2)).toEqual([files, extra.settings]);
    const s = new Settings('', { modules });
    expect(s.lookup('plugins.machines.enabled')).toBeUndefined();
    expect(s.lookup('plugins.vscode.enabled')).toMatchObject({ default: false, order: 10 });
    expect(s.lookup('plugins.vscode.browser')).toMatchObject({ default: false, order: 15 });
    expect(s.lookup('plugins.files.enabled')).toMatchObject({ default: true, order: 20 });
    expect(s.lookup('plugins.extra.enabled')).toMatchObject({ default: true, order: 30 });
    expect(s.lookup('files.showHidden')?.default).toBe(true);
  });
});

describe('registry', () => {
  test('translation keys', () => {
    const keys = translationKeys(input);
    for (const k of [
      'settings.terminal.fontSize',
      'settings.terminal.cursorStyle.bar',
      'settings.section.colors',
      'settings.section.extra',
      'settings.extra.mode.b',
      'settings.plugins.extra.enabled',
      'command.tab.new',
      'command.section.pane',
    ]) {
      expect(keys).toContain(k);
    }
    expect(keys).toEqual([...keys].sort());
  });

  // The tables are written between their markers, list every setting and
  // command, and a document without the markers is refused.
  test('reference tables', () => {
    const doc = [
      'intro',
      '<!-- make tokens: settings -->',
      'STALE-TABLE',
      '<!-- end of make tokens: settings -->',
      'middle',
      '<!-- make tokens: commands -->',
      '<!-- end of make tokens: commands -->',
      'end',
      '',
    ].join('\n');
    const out = fillReference(doc, input);
    for (const want of [
      'intro\n<!-- make tokens: settings -->\n\n| Setting |',
      '| `terminal.fontSize` |',
      '| `extra.on` |',
      '`--extra-on`',
      '| `tab.new` | `terminal` | `cmd+t` | – | `ctrl+shift+t` | – | `ctrl+shift+t` | – |',
      '<!-- end of make tokens: settings -->\nmiddle\n',
      '\nend\n',
    ]) {
      expect(out).toContain(want);
    }
    expect(out).not.toContain('STALE-TABLE');
    expect(fillReference(out, input)).toBe(out);
    expect(() => fillReference('no markers', input)).toThrow();
  });

  test('update and check', () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-test-'));
    const doc =
      '<!-- make tokens: settings -->\n<!-- end of make tokens: settings -->\n<!-- make tokens: commands -->\n<!-- end of make tokens: commands -->\n';
    try {
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs/reference.md'), doc);
      const both = ['spec/generated/registry.json', 'docs/reference.md'];
      expect(updateRegistry(root, input, true)).toEqual(both);
      expect(readFileSync(join(root, 'docs/reference.md'), 'utf8')).toBe(doc);
      expect(updateRegistry(root, input)).toEqual(both);
      expect(updateRegistry(root, input, true)).toEqual([]);
      expect(readFileSync(join(root, 'spec/generated/registry.json'), 'utf8')).toBe(buildRegistry(input));
      expect(readFileSync(join(root, 'docs/reference.md'), 'utf8')).toBe(fillReference(doc, input));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

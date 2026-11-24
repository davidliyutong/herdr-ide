import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { buildRegistry, coreModules, fillReference, translationKeys, updateRegistry } from './registry.ts';
import { bool, Settings } from './settings/index.ts';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('registry', () => {
  // The registry the clients read is the core's, byte for byte.
  test('spec/generated/registry.json', () => {
    expect(buildRegistry()).toBe(read('spec/generated/registry.json'));
  });

  // The reference's tables are current.
  test('docs/reference.md', () => {
    const doc = read('docs/reference.md');
    expect(fillReference(doc)).toBe(doc);
  });

  test('translation keys', () => {
    const keys = translationKeys();
    for (const k of [
      'settings.terminal.fontSize',
      'settings.terminal.cursorStyle.bar',
      'settings.section.colors',
      'settings.group.usageRefresh',
      'command.tab.new',
      'command.section.pane',
      'settings.gui.gpu.vglrun',
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
      '<!-- scripts/registry: settings -->',
      'STALE-TABLE',
      '<!-- end of scripts/registry: settings -->',
      'middle',
      '<!-- scripts/registry: commands -->',
      '<!-- end of scripts/registry: commands -->',
      'end',
      '',
    ].join('\n');
    const out = fillReference(doc);
    for (const want of [
      'intro\n<!-- scripts/registry: settings -->\n\n| Setting |',
      '| `terminal.fontSize` |',
      '| `gui.enabled` |',
      '`--gui`',
      '| `tab.new` | `terminal` | `cmd+t` | – | `ctrl+shift+t` | – | `ctrl+shift+t` | – |',
      '<!-- end of scripts/registry: settings -->\nmiddle\n',
      '\nend\n',
    ]) {
      expect(out).toContain(want);
    }
    expect(out).not.toContain('STALE-TABLE');
    expect(fillReference(out)).toBe(out);
    expect(() => fillReference('no markers')).toThrow();
  });

  test('update and check', () => {
    const root = mkdtempSync(join(tmpdir(), 'registry-test-'));
    try {
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs/reference.md'), read('docs/reference.md'));
      expect(updateRegistry(root, true)).toEqual(['spec/generated/registry.json']);
      expect(updateRegistry(root)).toEqual(['spec/generated/registry.json']);
      expect(updateRegistry(root, true)).toEqual([]);
      expect(readFileSync(join(root, 'spec/generated/registry.json'), 'utf8')).toBe(read('spec/generated/registry.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A feature's section names a feature of the core (one with a switch),
  // so the UIs can list it under the plugins and say when it is off.
  test('plugin sections', () => {
    const s = new Settings('', { modules: coreModules() });
    const switches = new Set(
      s
        .defs()
        .filter((d) => d.section === 'plugins')
        .map((d) => d.key.split('.')[1]),
    );
    const owned = s.sections().filter((sec) => sec.plugin);
    expect(owned.length).toBeGreaterThan(5);
    for (const sec of owned) expect(switches.has(sec.plugin!), sec.id).toBe(true);
    expect(owned.find((sec) => sec.id === 'usage')?.plugin).toBe('usage');
  });
});

describe('core modules', () => {
  // A ported feature's module replaces the staged one in its place; its
  // switch keeps its order; a feature that is always on has none.
  test('features', () => {
    const files = {
      sections: [{ id: 'files', order: 66, plugin: 'files' }],
      settings: { 'files.showHidden': bool({ default: true, section: 'files' }) },
    };
    const modules = coreModules([
      { id: 'machines', toggle: false },
      { id: 'files', settings: files },
      { id: 'extra', defaultOff: true },
    ]);
    const s = new Settings('', { modules });
    expect(s.lookup('files.exclude')).toBeUndefined();
    expect(s.lookup('files.showHidden')?.default).toBe(true);
    expect(s.lookup('plugins.machines.enabled')).toBeUndefined();
    expect(s.lookup('plugins.files.enabled')?.order).toBe(30);
    expect(s.lookup('plugins.extra.enabled')).toMatchObject({ default: false, order: 120 });
    expect(modules.indexOf(files)).toBe(coreModules().findIndex((m) => m.sections?.[0]?.id === 'files'));
  });
});

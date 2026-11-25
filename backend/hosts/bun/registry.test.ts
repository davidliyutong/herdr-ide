// The registry of the core serve composes (kernel/config/registry.ts):
// what the clients read before a core and the reference's tables are its,
// byte for byte, and its settings follow the features' order.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { buildRegistry, fillReference, registryInput, translationKeys } from '#kernel/config/registry.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { describedFeatures } from '#hosts/common/compose.ts';

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const input = registryInput(describedFeatures());

describe("the composed core's registry", () => {
  test('spec/generated/registry.json', () => {
    expect(buildRegistry(input)).toBe(read('spec/generated/registry.json'));
  });

  test("docs/reference.md's tables", () => {
    const doc = read('docs/reference.md');
    expect(fillReference(doc, input)).toBe(doc);
  });

  test('translation keys', () => {
    const keys = translationKeys(input);
    for (const k of [
      'settings.group.usageRefresh',
      'settings.gui.gpu.vglrun',
      'settings.section.codeServer',
      'settings.plugins.vscode.browser',
    ])
      expect(keys).toContain(k);
  });

  // The switches in the order the UIs list them: the features' order.
  test("the features' switches, in their order", () => {
    const s = new Settings('', { modules: input.modules });
    const switches = s
      .defs()
      .filter((d) => d.section === 'plugins')
      .map((d) => d.key);
    expect(switches).toEqual([
      'plugins.vscode.enabled',
      'plugins.vscode.browser',
      ...['browser', 'files', 'search', 'git', 'monitor', 'usage', 'vault', 'agents', 'chat', 'history'].map(
        (id) => `plugins.${id}.enabled`,
      ),
    ]);
  });

  // A feature's section names a feature of the core (one with a switch),
  // so the UIs can list it under the plugins and say when it is off.
  test('plugin sections', () => {
    const s = new Settings('', { modules: input.modules });
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

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../harness/fixtures';
import { git, gitConfig, repo } from '../harness/git';
import { cdInTerminal, newTerminalTab, showPanel, terminalOfPane } from '../harness/ui';

test('the Git panel finds a submodule and a nested repository and switches to them', async ({ app, instance, term }) => {
  gitConfig(instance);
  const lib = join(instance.home, 'lib-origin');
  repo(instance, lib, { 'lib.txt': 'lib\n' });
  const main = join(instance.work, 'app');
  repo(instance, main, { 'README.md': '# app\n' });
  git(instance, main, 'submodule', 'add', '-q', lib, 'vendor/lib');
  git(instance, main, 'commit', '-q', '-m', 'add lib');
  repo(instance, join(main, 'tools', 'nested'), { 'tool.txt': 'tool\n' });
  // A change in each.
  writeFileSync(join(main, 'README.md'), '# app\nchanged\n');
  writeFileSync(join(main, 'vendor', 'lib', 'lib.txt'), 'lib changed\n');
  writeFileSync(join(main, 'tools', 'nested', 'tool.txt'), 'tool changed\n');

  await newTerminalTab(app);
  await cdInTerminal(app, term, await terminalOfPane(term, 1), main);
  const panel = await showPanel(app, 'Source Control');
  const repoPick = panel.getByRole('button', { name: 'Repository' });
  const changes = panel.getByRole('tree', { name: 'Changes' });
  const row = (path: string) => changes.locator(`[role="treeitem"][title="${path}"]`);
  await expect(row('README.md')).toBeVisible();
  await expect(repoPick).toHaveText('app');
  const sub = row('vendor/lib');
  const nested = row('tools/nested/');
  await expect(sub).toBeVisible();
  await expect(nested).toBeVisible();

  // Enter on the submodule's row opens it: its own changes.
  await changes.focus();
  for (let i = 0; i < 5 && (await sub.getAttribute('aria-selected')) !== 'true'; i++) await app.keyboard.press('ArrowDown');
  await expect(sub).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Enter');
  await expect(repoPick).toHaveText('lib');
  await expect(row('lib.txt')).toBeVisible();

  // Back to the superproject through the picker, then the nested
  // repository by its row's button.
  await repoPick.click();
  await app.getByRole('option', { name: /^app/ }).click();
  await expect(repoPick).toHaveText('app');
  await nested.hover();
  await nested.getByRole('button', { name: 'Open Repository' }).click();
  await expect(repoPick).toHaveText('nested');
  await expect(row('tool.txt')).toBeVisible();
});

import { expect } from '@playwright/test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../harness/fixtures';
import { paths } from '../harness/paths';
import { cdInTerminal, terminalOfPane } from '../harness/ui';
import { wants } from './manifest';
import { capture, newTerminal, prepare, seedWorkspace } from './support';

test.use({
  instanceOptions: {
    settings: { 'plugins.vscode.browser': true },
    codeServerSeed: process.env.E2E_CODE_SERVER_SEED,
  },
});

(wants('vscode') ? test : test.skip)('VS Code pane screenshot', async ({ app, instance, term }) => {
  test.setTimeout(300_000);
  await prepare(app, instance);
  await seedWorkspace(instance);
  const hosts = join(instance.home, `.${paths.slug}-${instance.name}`, 'hosts');
  const host = readdirSync(hosts)[0];
  const user = join(hosts, host, 'cs-data', 'User');
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, 'settings.json'), JSON.stringify({ 'workbench.colorTheme': 'Default Dark Modern' }, null, 2));
  await newTerminal(app);
  const addr = await terminalOfPane(term, 1);
  await cdInTerminal(app, term, addr, instance.work);
  await app.getByRole('button', { name: 'Open in VS Code' }).first().click();
  const code = app.frameLocator('.code-frame');
  await expect(code.locator('.monaco-workbench')).toBeVisible({ timeout: 180_000 });
  await code.getByText('train.py', { exact: true }).first().click();
  await expect(code.locator('.view-lines').filter({ hasText: 'log_interval' }).first()).toBeVisible({ timeout: 60_000 });
  await capture(app, instance, 'vscode', async () => {
    await expect(code.locator('.monaco-workbench')).toBeVisible({ timeout: 180_000 });
    await code.getByText('train.py', { exact: true }).first().click();
    await expect(code.locator('.view-lines').filter({ hasText: 'learning_rate' }).first()).toBeVisible({ timeout: 60_000 });
  });
});

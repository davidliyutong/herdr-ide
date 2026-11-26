import { expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../harness/fixtures';
import { newTerminalTab } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { HEIGHT, imagePath, wants, WIDTH } from './manifest';
import { restoreEditor, seedWorkspace, showPanel } from './support';

test.use({ desktopOptions: { settings: { 'appearance.theme': 'dark', 'appearance.language': 'en' } } });

(wants('desktop') ? test : test.skip)('desktop app screenshot', async ({ desktop }) => {
  test.setTimeout(180_000);
  await desktop.localReady();
  await desktop.api('PUT', '/api/m/local/label', { label: 'workstation' });
  await seedWorkspace(desktop.home);
  await desktop.win.setViewportSize({ width: WIDTH, height: HEIGHT });
  await newTerminalTab(desktop.win);
  await desktop.win.keyboard.type(
    `cd '${desktop.home.work}' && printf 'nanoGPT run 042\\nDesktop hub: in process\\n' && touch .desktop-ready`,
  );
  await desktop.win.keyboard.press('Enter');
  await waitFor(() => existsSync(join(desktop.home.work, '.desktop-ready')), { what: 'the desktop terminal' });
  const tree = await showPanel(desktop.win, 'files');
  await expect(tree.getByRole('treeitem', { name: 'train.py', exact: true })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'train.py', exact: true }).click();
  await expect(desktop.win.locator('.files-editor .monaco-editor')).toContainText('log_interval');
  await desktop.win.evaluate(() => document.fonts.ready);
  await desktop.win.screenshot({ path: imagePath('desktop', 'en'), animations: 'disabled', caret: 'hide' });

  await desktop.api('PUT', '/api/settings', { key: 'appearance.language', value: 'zh-CN' });
  await desktop.win.reload();
  await expect(desktop.win.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await restoreEditor(desktop.win, 'train.py');
  await expect(desktop.win.locator('.files-editor .monaco-editor')).toContainText('learning_rate');
  await desktop.win.evaluate(() => document.fonts.ready);
  await desktop.win.screenshot({ path: imagePath('desktop', 'zh-CN'), animations: 'disabled', caret: 'hide' });
});

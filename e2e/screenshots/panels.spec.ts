import { expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../harness/fixtures';
import { terminalOfPane } from '../harness/ui';
import { DEMO_NOW } from './demo';
import { capture, installMonitorData, installUsageData, newTerminal, prepare, showPanel } from './support';
import { wants } from './manifest';

const PASSPHRASE = 'documentation-only-passphrase';

test.beforeEach(async ({ app, instance }) => {
  await prepare(app, instance);
});

async function openInPane(page: Page, id: string) {
  const panel = await showPanel(page, id);
  await panel.locator('.panel-head button.icon').first().click();
  await expect(page.locator(`.pane .${id === 'usage' ? 'usage-panel' : id === 'monitor' ? 'monitor-tm' : 'missing'}`)).toBeVisible();
}

async function openSettings(page: Page) {
  const dialog = page.locator('.modal.settings');
  if (await dialog.isVisible()) return dialog;
  await page.locator('.sidebar-head button').last().click();
  await expect(dialog).toBeVisible();
  return dialog;
}

(wants('usage') ? test : test.skip)('AI usage screenshot', async ({ app, instance }) => {
  await installUsageData(app, instance);
  await openInPane(app, 'usage');
  await expect(app.locator('.usage-panel')).toContainText('Claude');
  await expect(app.locator('.usage-panel')).toContainText('$');
  await capture(app, instance, 'usage', async () => {
    await app.clock.setFixedTime(DEMO_NOW);
    await expect(app.locator('.usage-panel')).toBeVisible();
    await expect(app.locator('.usage-panel')).toContainText('Claude Max');
  });
});

(wants('vault') ? test : test.skip)('variable vault screenshot', async ({ app, instance }) => {
  const panel = await showPanel(app, 'vault');
  await panel.locator('input[type=password]').nth(0).fill(PASSPHRASE);
  await panel.locator('input[type=password]').nth(1).fill(PASSPHRASE);
  await panel.locator('.vault-gate button.primary').click();
  await expect(panel.locator('.vault-session')).toBeVisible();
  for (const [name, value, description] of [
    ['HF_TOKEN', 'demo-only-not-a-token', 'Model registry on gpu-server'],
    ['DATABASE_URL', 'postgres://demo.invalid/nanogpt', 'Training metrics database'],
    ['API_BASE_URL', 'https://api.example.com', 'Shared evaluation endpoint'],
  ]) {
    await panel.locator('.vault-toolbar button.primary').click();
    const dialog = app.getByRole('dialog', { name: 'New Variable' });
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Value', { exact: true }).fill(value);
    await dialog.getByLabel('Description').fill(description);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(panel.locator('.vault-list')).toContainText('HF_TOKEN');
  await panel.locator('.panel-head button.icon').first().click();
  await expect(app.locator('.pane .vault')).toBeVisible();
  await capture(app, instance, 'vault', async () => {
    const shown = app.locator('.pane .vault');
    const gate = shown.locator('.vault-gate');
    if (await gate.isVisible()) {
      await gate.locator('input[type=password]').fill(PASSPHRASE);
      await gate.locator('button.primary').click();
    }
    await expect(shown.locator('.vault-list')).toContainText('DATABASE_URL');
    await expect(shown.locator('.vault-list')).not.toContainText('demo-only-not-a-token');
  });
});

(wants('monitor') ? test : test.skip)('system monitor screenshot', async ({ app, instance }) => {
  await instance.api('PUT', '/api/m/local/label', { label: 'gpu-server' });
  await installMonitorData(app);
  await openInPane(app, 'monitor');
  await expect(app.locator('.monitor-tm')).toContainText('python');
  await capture(app, instance, 'monitor', async () => {
    await app.locator('.monitor-proc-row[data-pid="2400"]').click();
    await expect(app.locator('.monitor-tm-detail')).toContainText('train.py');
    const status = app.locator('.monitor-status-item');
    if ((await status.getAttribute('aria-expanded')) !== 'true') await status.click();
    await expect(app.locator('.monitor-popover')).toContainText('NVIDIA RTX 6000');
    await expect(app.locator('.monitor-popover')).toContainText('/datasets');
  });
});

(wants('settings') ? test : test.skip)('settings screenshot', async ({ app, instance }) => {
  await openSettings(app);
  await expect(app.locator('.theme-picker')).toBeVisible();
  await capture(app, instance, 'settings', async () => {
    await openSettings(app);
    await expect(app.locator('.theme-picker')).toBeVisible();
    await expect(app.locator('.settings-nav')).toContainText(/Keyboard Shortcuts|键盘快捷键/);
  });
});

(wants('security') ? test : test.skip)('browser security screenshot', async ({ app, instance }) => {
  const risk = async () => {
    if (await app.locator('.risk-dialog').isVisible()) return;
    const dialog = await openSettings(app);
    await dialog
      .locator('.settings-nav button')
      .filter({ hasText: /^(?:Plugins|插件)$/ })
      .click();
    const row = dialog.locator('.plugin-row[data-plugin="vscode"]');
    await row.locator('input[type=checkbox]').click();
    await expect(app.locator('.risk-dialog')).toBeVisible();
    await app.locator('.risk-dialog input[type=checkbox]').check();
    await expect(app.locator('[data-answer="accept"]')).toBeEnabled();
  };
  await risk();
  await capture(app, instance, 'security', risk);
});

(wants('formula') ? test : test.skip)('terminal formula screenshot', async ({ app, instance, term }) => {
  const file = join(instance.work, 'formula.txt');
  writeFileSync(file, 'Learning rate schedule: $\\eta_t = \\frac{\\eta_0}{1 + \\gamma t}$\n');
  await newTerminal(app);
  const addr = await terminalOfPane(term, 1);
  await app.keyboard.type(`cat '${file}'`);
  await app.keyboard.press('Enter');
  await term.waitScreen(addr, /Learning rate schedule/);
  const hover = async () => {
    await term.waitScreen(addr, /Learning rate schedule/);
    const host = app.locator('.pane:has(> .pane-header.focused) .term-host');
    const box = await host.boundingBox();
    if (!box) throw new Error('terminal has no bounds');
    await expect(host.locator('canvas').first()).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await app.mouse.move(box.x + 300 + (i % 2), box.y + 26);
      await app.waitForTimeout(500);
      if (await app.locator('.math-popover').isVisible()) return;
    }
    await expect(app.locator('.math-popover')).toBeVisible();
  };
  await hover();
  await capture(app, instance, 'formula', hover, false);
});

import { expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Instance } from '../harness/instance';
import { ALIAS } from '../harness/sshd';
import type { TermClient } from '../harness/term';
import { terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { costReport, DEMO_NOW, metrics, processes, sourceFiles, usageSnapshot } from './demo';
import { HEIGHT, imagePath, type Locale, type SceneName, WIDTH } from './manifest';

export async function seedWorkspace(home: { work: string }) {
  for (const [name, text] of Object.entries(sourceFiles)) {
    const path = join(home.work, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

export async function prepare(page: Page, instance: Instance) {
  await instance.api('PUT', '/api/m/local/label', { label: 'workstation' });
  await instance.api('PUT', '/api/settings', { key: 'appearance.theme', value: 'dark' });
  await instance.api('PUT', '/api/settings', { key: 'appearance.language', value: 'en' });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
}

export async function showPanel(page: Page, id: string): Promise<Locator> {
  const button = page.locator(`.panel-rail button[data-panel="${id}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  const panel = page.locator(`aside.panel[data-panel="${id}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

export async function restoreEditor(page: Page, fileName: string) {
  await page.getByRole('tab').first().click();
  await showPanel(page, 'files');
  await page.getByRole('tab', { name: new RegExp(fileName) }).click();
}

export async function newTerminal(page: Page) {
  await page.locator('button.new-tab').first().click();
  await expect(page.locator('.pane:has(> .pane-header.focused) textarea.term-input')).toBeFocused();
}

export async function terminal(page: Page, term: TermClient, count = 1): Promise<string> {
  await newTerminal(page);
  return terminalOfPane(term, count);
}

export async function newChat(page: Page): Promise<Locator> {
  await page.locator('button.new-tab-kinds').first().click();
  await page.getByRole('menuitem', { name: /Kimi Code (?:Chat|对话)/ }).click();
  const pane = page.locator('.pane:has(> .pane-header.focused) .chat-pane');
  await expect(pane.locator('.chat-state')).toHaveText(/^(?:Ready|就绪)$/);
  return pane;
}

export async function sendChat(pane: Locator, text: string) {
  const box = pane.locator('textarea').last();
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

export async function addRemote(page: Page, instance: Instance): Promise<string> {
  await instance.api('POST', '/api/machines', { target: ALIAS, label: 'gpu-server' });
  const id = await waitFor(
    async () => {
      const machine = (await instance.machines()).find((m) => m.id !== 'local');
      return machine?.status === 'ready' ? machine.id : null;
    },
    { what: 'gpu-server to connect', timeout: 60_000 },
  );
  await expect(page.locator('.machine-label', { hasText: 'gpu-server' })).toBeVisible();
  return id;
}

export async function showMachine(page: Page, label: string) {
  const machine = page.locator('.machine').filter({ has: page.locator('.machine-label', { hasText: label }) });
  await machine.getByRole('treeitem', { name: /^(?:Show its terminals|显示终端)$/ }).click();
  await expect(machine.locator('.ws-item.selected')).toBeVisible({ timeout: 30_000 });
}

export async function allowLoopbackForwards(page: Page, instance: Instance) {
  const hub = new URL(instance.baseURL);
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (loopback && url.port !== hub.port) {
      await route.fulfill({ response: await route.fetch() });
    } else await route.continue();
  });
}

export async function installMonitorData(page: Page) {
  await page.route(/\/api\/m\/[^/]+\/p\/monitor\/(metrics|processes)$/, async (route) => {
    const metricsPath = route.request().url().endsWith('/metrics');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metricsPath ? metrics : processes) });
  });
}

export async function installUsageData(page: Page, instance: Instance) {
  await instance.api('PUT', '/api/settings', { key: 'usage.refresh', value: 'manual' });
  await page.clock.setFixedTime(DEMO_NOW);
  await page.route(/\/api\/p\/usage(?:\/cost)?(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/p/usage') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(usageSnapshot) });
    } else if (path === '/api/p/usage/cost') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(costReport) });
    } else await route.continue();
  });
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

export async function capture(
  page: Page,
  instance: Instance,
  name: SceneName,
  again?: (locale: Locale) => Promise<void>,
  parkMouse = true,
) {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await again?.('en');
  if (parkMouse) await page.mouse.move(1, 1);
  await settle(page);
  await page.screenshot({ path: imagePath(name, 'en'), animations: 'disabled', caret: 'hide' });

  await instance.api('PUT', '/api/settings', { key: 'appearance.language', value: 'zh-CN' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.statusbar')).toBeVisible();
  await again?.('zh-CN');
  if (parkMouse) await page.mouse.move(1, 1);
  await settle(page);
  await page.screenshot({ path: imagePath(name, 'zh-CN'), animations: 'disabled', caret: 'hide' });
}

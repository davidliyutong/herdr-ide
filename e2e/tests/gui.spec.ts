// Program windows of an SSH machine shown by two cores of one instance
// (feature 14, 39): the machine's node serves both, one controls the
// windows and the other views them until it takes control. The machine is
// a container with Xvfb (harness/sshd.ts); the program is e2e/xclient,
// which prints the clicks it gets. Skipped without Docker.

import { test, expect } from '../harness/fixtures';
import type { Instance } from '../harness/instance';
import { ALIAS } from '../harness/sshd';
import { TermClient } from '../harness/term';
import { waitFor } from '../harness/wait';
import type { Browser, Page } from '@playwright/test';

interface GuiState {
  m: string;
  phase: string;
  view_only?: boolean;
  windows: { id: number; title: string }[];
}

/** The SSH machine of the core, once ready. */
async function remote(inst: Instance): Promise<string> {
  const m = await waitFor(
    async () => {
      const x = (await inst.machines()).find((x) => x.id !== 'local');
      return x?.status === 'ready' ? x : null;
    },
    { what: 'the SSH machine to connect', timeout: 60_000 },
  );
  return m.id;
}

/** The machine's display state in the core, once ok says so. */
function display(inst: Instance, m: string, ok: (s: GuiState) => boolean, what: string): Promise<GuiState> {
  return waitFor(
    async () => {
      const s = (await inst.api<GuiState[]>('GET', '/api/gui')).find((x) => x.m === m);
      return s && ok(s) ? s : null;
    },
    { what, timeout: 60_000 },
  );
}

/** A page of the program window in a browser context of its own, which
 * reaches the core and nothing else. */
async function windowPage(browser: Browser, inst: Instance, m: string, id: number): Promise<Page> {
  const context = await browser.newContext();
  const origin = new URL(inst.baseURL).origin;
  await context.route(
    (url) => !url.href.startsWith(origin + '/') && /^https?:/.test(url.protocol),
    (route) => route.abort(),
  );
  const page = await context.newPage();
  await page.goto(`${inst.baseURL}/m/${encodeURIComponent(m)}/gui/${id}`);
  await expect(page.locator('.gui-stage canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.gui-overlay')).toHaveCount(0, { timeout: 30_000 });
  return page;
}

/** Clicks the middle of the program window. */
async function click(page: Page) {
  const box = await page.locator('.gui-host').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test('two cores show a program window: one controls it, the other views it until it takes control', async ({ browser, instance, sshd }) => {
  void sshd;
  await instance.api('POST', '/api/machines', { target: ALIAS, label: '' });
  const m = await remote(instance);
  await display(instance, m, (s) => s.phase === 'ready', 'the display to be ready');
  const second = await instance.second(true);
  const term = new TermClient(instance.baseURL, m);
  const pages: Page[] = [];
  try {
    expect(await remote(second)).toBe(m);
    // The program, in a terminal of the machine: it gets the display.
    const rec = await term.call<{ address: string }>('terminal.run', { argv: ['e2e-xclient'] });
    await term.waitScreen(rec.address, /mapped/, 30_000);
    const win = (await display(instance, m, (s) => s.windows.some((w) => w.title === 'e2e window'), 'the window')).windows.find(
      (w) => w.title === 'e2e window',
    )!;
    await display(second, m, (s) => s.windows.some((w) => w.id === win.id) && !!s.view_only, 'the second core to view the window');
    const clicks = async () => ((await term.screen(rec.address)).match(/^button 1 /gm) ?? []).length;

    // The first core controls: its page takes input; the second's views.
    const a = await windowPage(browser, instance, m, win.id);
    const b = await windowPage(browser, second, m, win.id);
    pages.push(a, b);
    const banner = (p: Page) => p.locator('.gui-banner', { hasText: 'View only' });
    await expect(banner(b)).toBeVisible();
    await expect(banner(a)).toHaveCount(0);
    await click(a);
    await waitFor(async () => (await clicks()) === 1, { what: 'the controller’s click to reach the program' });
    await click(b);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await clicks()).toBe(1);

    // The second takes control: the first views.
    await b.getByRole('button', { name: 'Take Control' }).click();
    await expect(banner(b)).toHaveCount(0);
    await expect(banner(a)).toBeVisible();
    await click(b);
    await waitFor(async () => (await clicks()) === 2, { what: 'the new controller’s click to reach the program' });
    await click(a);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await clicks()).toBe(2);

    // The controller's core gone, the first core controls again.
    await second.stopCore(false);
    await expect(banner(a)).toHaveCount(0, { timeout: 30_000 });
    await click(a);
    await waitFor(async () => (await clicks()) === 3, { what: 'the click after the controller left' });
  } finally {
    for (const p of pages) await p.context().close();
    term.close();
    await second.stop();
  }
});

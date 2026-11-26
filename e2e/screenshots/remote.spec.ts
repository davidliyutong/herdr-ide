import { expect, type Page } from '@playwright/test';
import { test } from '../harness/fixtures';
import { TermClient } from '../harness/term';
import { run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { browserPage } from './demo';
import { dockerImage, HEIGHT, imagePath, wants, WIDTH, type Locale } from './manifest';
import { addRemote, allowLoopbackForwards, capture, newTerminal, prepare, showMachine } from './support';

test.beforeEach(async ({ app, instance }) => {
  await prepare(app, instance);
});

(wants('browser') ? test : test.skip)('browser pane screenshot', async ({ app, instance, sshd }) => {
  const remote = await addRemote(app, instance);
  void remote;
  await allowLoopbackForwards(app, instance);
  await showMachine(app, 'gpu-server');
  await sshd.user(
    `mkdir -p demo-site\ncat > demo-site/index.html <<'EOF'\n${browserPage}\nEOF\ncd demo-site && e2e-http >/tmp/e2e-http.log 2>&1 &\nsleep 0.2\nwget -qO- http://127.0.0.1:3000/ | grep 'training run 042'`,
  );
  await app.locator('button.new-tab-kinds').first().click();
  await app.getByRole('menuitem', { name: /^(?:Browser|浏览器)$/ }).click();
  await app.locator('.browser-address').fill('localhost:3000');
  await app.locator('.browser-address').press('Enter');
  await expect(app.locator('.browser-layer iframe.browser-frame')).toBeVisible({ timeout: 30_000 });
  await expect(app.locator('.browser-cover')).toHaveCount(0);
  await capture(app, instance, 'browser', async () => {
    await expect(app.locator('.browser-chip')).toContainText('gpu-server');
    await expect(app.locator('.browser-layer iframe.browser-frame')).toBeVisible({ timeout: 30_000 });
    await expect(app.locator('.browser-layer iframe.browser-frame')).toHaveAttribute('src', /127\.0\.0\.1|localhost/);
    const ports = app.locator('.browser-bar button').filter({ has: app.locator('svg.lucide-network') });
    if ((await ports.getAttribute('aria-expanded')) !== 'true') await ports.click();
    await expect(app.locator('.browser-popover')).toContainText('3000');
    await expect(app.locator('.browser-popover')).toContainText('gpu-server');
  });
});

interface GuiState {
  m: string;
  phase: string;
  windows: { id: number; title: string }[];
}

async function composite(app: Page, gui: Page, name: 'windows', locale: Locale) {
  await app.setViewportSize({ width: WIDTH, height: HEIGHT });
  await expect(app.locator('.term-host')).toBeVisible();
  const shot = await gui.locator('.gui-stage').screenshot({ animations: 'disabled' });
  await app.evaluate((data) => {
    document.getElementById('screenshot-program-window')?.remove();
    const frame = document.createElement('div');
    frame.id = 'screenshot-program-window';
    frame.style.cssText =
      'position:fixed;z-index:10000;left:50%;top:52%;transform:translate(-50%,-50%);width:min(1120px,82vw);background:#151d28;border:1px solid #4a5b70;border-radius:14px;overflow:hidden;box-shadow:0 28px 90px #000a;pointer-events:none';
    const bar = document.createElement('div');
    bar.style.cssText =
      'height:44px;display:flex;align-items:center;gap:9px;padding:0 16px;color:#dce7f5;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#202b39';
    for (const color of ['#ff6259', '#febc2e', '#28c840']) {
      const dot = document.createElement('span');
      dot.style.cssText = `width:13px;height:13px;border-radius:50%;background:${color}`;
      bar.append(dot);
    }
    const title = document.createElement('span');
    title.textContent = 'waves.py · gpu-server';
    title.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);font-weight:600';
    bar.append(title);
    const image = document.createElement('img');
    image.src = 'data:image/png;base64,' + data;
    image.style.cssText = 'display:block;width:100%;height:auto;background:#f7f9fc';
    frame.append(bar, image);
    document.body.append(frame);
  }, shot.toString('base64'));
  await app.evaluate(() => document.fonts.ready);
  await app.waitForTimeout(250);
  await app.screenshot({ path: imagePath(name, locale), animations: 'disabled', caret: 'hide' });
  await app.locator('#screenshot-program-window').evaluate((el) => el.remove());
}

test.describe('remote program windows', () => {
  test.use({ sshdOptions: { image: dockerImage } });

  (wants('windows') ? test : test.skip)('remote program window screenshot', async ({ app, instance, browser, sshd }) => {
    test.setTimeout(300_000);
    const remote = await addRemote(app, instance);
    await showMachine(app, 'gpu-server');
    const term = new TermClient(instance.baseURL, remote);
    let gui: Page | undefined;
    try {
      await newTerminal(app);
      await terminalOfPane(term, 1);
      await app.keyboard.type('python3 waves.py');
      await app.keyboard.press('Enter');
      const win = await waitFor(
        async () => {
          const state = (await instance.api<GuiState[]>('GET', '/api/gui')).find((s) => s.m === remote);
          return state?.windows.find((w) => w.title.includes('waves.py')) ?? null;
        },
        { what: 'the matplotlib window', timeout: 90_000 },
      );
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
      const origin = new URL(instance.baseURL).origin;
      await context.route(
        (url) => !url.href.startsWith(origin + '/') && /^https?:/.test(url.protocol),
        (route) => route.abort(),
      );
      gui = await context.newPage();
      await gui.goto(`${instance.baseURL}/m/${encodeURIComponent(remote)}/gui/${win.id}`);
      await expect(gui.locator('.gui-stage canvas').first()).toBeVisible({ timeout: 30_000 });
      await expect(gui.locator('.gui-overlay')).toHaveCount(0, { timeout: 30_000 });
      await composite(app, gui, 'windows', 'en');
      await instance.api('PUT', '/api/settings', { key: 'appearance.language', value: 'zh-CN' });
      await app.reload();
      await expect(app.locator('html')).toHaveAttribute('lang', 'zh-CN');
      await composite(app, gui, 'windows', 'zh-CN');
    } finally {
      await gui?.context().close();
      term.close();
    }
  });
});

(wants('terminal-history') ? test : test.skip)('terminal history screenshot', async ({ app, instance, term }) => {
  await instance.api('PUT', '/api/settings', { key: 'history.capture', value: true });
  await instance.api('PUT', '/api/settings', { key: 'history.interval', value: 10 });
  await newTerminal(app);
  const left = await terminalOfPane(term, 1);
  await run(app, term, left, 'printf "nanoGPT run 042\\nstep=400 loss=2.1470\\ncheckpoint saved\\n"', /checkpoint saved/);
  await app.getByRole('button', { name: 'Split Right' }).first().click();
  const right = await terminalOfPane(term, 2);
  await run(app, term, right, 'printf "GPU 0  87%%  42°C  31.0 GiB\\nGPU 1  36%%  38°C  12.0 GiB\\n"', /12.0 GiB/);
  await waitFor(
    async () => {
      const history = await instance.api<{ terminals: { terminal: string; at: number }[] }>('GET', '/api/m/local/p/history');
      return [left, right].every((addr) => history.terminals.some((h) => h.terminal === addr && h.at > 0));
    },
    { what: 'both terminal snapshots', timeout: 45_000 },
  );
  await instance.api('POST', '/api/m/local/hc/stop');
  await waitFor(async () => !(await instance.api<{ running: boolean }>('GET', '/api/m/local/hc')).running, {
    what: 'the terminal core to stop',
  });
  await instance.api('POST', '/api/m/local/hc/start');
  await waitFor(
    async () => {
      const live = await term.live();
      return [left, right].every((addr) => live.some((t) => t.address === addr && typeof t.pid === 'number'));
    },
    { what: 'both restored shells', timeout: 30_000 },
  );
  await expect(app.locator('.pane-header')).toHaveCount(2);
  await app.reload();
  await expect(app.locator('.statusbar .conn.on')).toBeVisible();
  await expect(app.locator('.term-host canvas').first()).toBeVisible();
  await capture(app, instance, 'terminal-history', async () => {
    await expect(app.locator('.pane-header')).toHaveCount(2);
    await expect(app.locator('.term-host')).toHaveCount(2);
    const history = await instance.api<{ terminals: unknown[] }>('GET', '/api/m/local/p/history');
    expect(history.terminals.length).toBeGreaterThan(0);
    for (const index of [0, 1]) {
      const pane = app.locator('.term-host').nth(index);
      await expect(pane.locator('.term-scrollbar-thumb')).toBeVisible();
      await pane.hover();
      await app.mouse.wheel(0, -10000);
    }
  });
});

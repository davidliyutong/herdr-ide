// The desktop app with its core in its utility process (harness/desktop.ts):
// the UI loads from the app's origin with nothing of the core listening on
// TCP, the local machine gets ready, a terminal runs a command, a file
// downloads, an ssh login runs in a terminal of the core's host
// (node-pty), the core comes back after a crash with the window kept, and
// a VS Code window loads when a code-server release is at hand
// (E2E_CODE_SERVER_SEED: a directory with
// code-server-<version>-<os>-<arch>.tar.gz). Skips without the desktop
// app built (pnpm -C desktop install && pnpm -C desktop build) or a
// display.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_PARTITION, ORIGIN, tcpListeners } from '../harness/desktop';
import { expect, test } from '../harness/fixtures';
import { unported } from '../harness/paths';
import { newTerminalTab } from '../harness/ui';
import { waitFor } from '../harness/wait';

// VS Code's machine side is not the TypeScript machine side's yet.
const seed = unported('vscode') ? undefined : process.env.E2E_CODE_SERVER_SEED;

// VS Code (off by default) is on when it can be installed.
test.use({ desktopOptions: { settings: seed ? { 'plugins.vscode.enabled': true } : {}, codeServerSeed: seed } });

test('the desktop app runs its core in process, without a listener', async ({ desktop }) => {
  test.setTimeout(seed ? 300_000 : 180_000);
  const { win, home } = desktop;
  expect(
    await win.evaluate(() => ({
      origin: location.origin,
      secure: isSecureContext,
      shell: 'desktopShell' in window,
      channels: 'desktopChannels' in window,
    })),
  ).toEqual({ origin: ORIGIN, secure: true, shell: true, channels: true });

  // Nothing of the core listens on TCP; nor any of the app's processes
  // but the main one, where only the debugging ports Playwright drives it
  // through are (loopback).
  const core = await desktop.corePid();
  expect(tcpListeners(core)).toEqual([]);
  for (const p of await desktop.processes()) {
    const lines = tcpListeners(p.pid);
    test.info().annotations.push({
      type: 'process',
      description: `${p.type} ${p.name} ${p.pid}: ${lines.length ? lines.join('; ') : 'no TCP listener'}`,
    });
    if (p.type === 'Browser') for (const l of lines) expect(l).toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
    else expect(lines, `${p.type} ${p.name}`).toEqual([]);
  }

  await desktop.localReady();
  // The requests of the app's windows are the desktop client's.
  expect((await desktop.api<{ client: string }>('GET', '/api/config')).client).toBe('desktop');

  // A page of another origin in the app's session (a data: URL, whose
  // origin is opaque, as a sandboxed frame's is; a site's in a VS Code
  // window is another): the core sees who asked and refuses it, a write as
  // a read, though a handler's answers are readable to any page.
  const secret = join(home.work, 'secret.txt');
  writeFileSync(secret, 'not for other origins\n');
  const planted = join(home.work, 'planted.txt');
  const foreign = await desktop.app.evaluate(
    async ({ BrowserWindow }, [write, read, partition]) => {
      const w = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true } });
      try {
        await w.loadURL('data:text/html,<!doctype html><title>other</title>');
        return (await w.webContents.executeJavaScript(`(async () => {
          const out = {};
          try { const r = await fetch(${JSON.stringify(write)}, { method: 'POST', mode: 'no-cors', body: 'planted' }); out.write = r.type + ' ' + r.status; } catch (e) { out.write = 'error'; }
          try { const r = await fetch(${JSON.stringify(read)}); out.read = r.status + ' ' + (await r.text()); } catch (e) { out.read = 'error'; }
          return out;
        })()`)) as { write: string; read: string };
      } finally {
        w.destroy();
      }
    },
    [
      `${ORIGIN}/api/m/local/write?${new URLSearchParams({ path: planted, force: '1' })}`,
      `${ORIGIN}/api/m/local/file?${new URLSearchParams({ path: secret })}`,
      APP_PARTITION,
    ] as const,
  );
  expect(foreign.read).toMatch(/^403 .*origin_not_allowed/);
  expect(foreign.read).not.toContain('not for other origins');
  expect(existsSync(planted), `the write: ${foreign.write}`).toBe(false);
  // The window's own reads still are.
  expect(await win.evaluate((u) => fetch(u).then((r) => r.text()), `/api/m/local/file?${new URLSearchParams({ path: secret })}`)).toBe(
    'not for other origins\n',
  );

  // A terminal runs a command.
  await newTerminalTab(win);
  const out = join(home.dir, 'out.txt');
  await win.keyboard.type(`echo desktop-$((6*7)) > '${out}'`);
  await win.keyboard.press('Enter');
  await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').trim() === 'desktop-42', { what: 'the command to run' });

  // An ssh login runs in a terminal of the core's host (node-pty in the
  // utility process): one to a port that refuses shows ssh's answer.
  const added = await desktop.api<{ id: string }>('POST', '/api/machines', { target: 'ssh://nobody@127.0.0.1:9', label: 'refusing' });
  expect(await desktop.channelText(`/api/m/${encodeURIComponent(added.id)}/auth?cols=80&rows=24`)).toMatch(/refused/i);

  // A file downloads (saved where the test says, not through a dialog).
  const saved = join(home.dir, 'saved');
  mkdirSync(saved);
  await desktop.saveDownloadsTo(saved);
  const file = join(home.work, 'report.txt');
  writeFileSync(file, 'downloaded through the core\n'.repeat(1000));
  await win.evaluate(
    (url) => {
      const a = document.createElement('a');
      a.href = url;
      document.body.append(a);
      a.click();
      a.remove();
    },
    `/api/m/local/file?${new URLSearchParams({ path: file, download: '1' })}`,
  );
  await waitFor(
    () => existsSync(join(saved, 'report.txt')) && readFileSync(join(saved, 'report.txt'), 'utf8') === readFileSync(file, 'utf8'),
    { what: 'the download' },
  );

  // The core crashes: it comes back, the window stays and reconnects.
  process.kill(core, 'SIGKILL');
  const again = await desktop.corePid(core);
  expect(tcpListeners(again)).toEqual([]);
  await waitFor(async () => (await desktop.localStatus()) === 'ready', { what: 'the local machine again', timeout: 60_000 });
  // The page's terminal channel came back: the same terminal runs another.
  const after = join(home.dir, 'after.txt');
  await win.locator('.pane:has(> .pane-header.focused) .term-host').click();
  await waitFor(
    async () => {
      await win.keyboard.type(`echo back-$((6*7)) > '${after}'`);
      await win.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 500));
      return existsSync(after) && readFileSync(after, 'utf8').trim() === 'back-42';
    },
    { what: 'the terminal after the restart', timeout: 30_000 },
  );

  if (!seed) {
    test.info().annotations.push({ type: 'skipped', description: 'VS Code: no code-server release at hand (E2E_CODE_SERVER_SEED)' });
    return;
  }
  // A VS Code window: its WebSockets are channels through the shim of its
  // frames; the explorer lists the folder over code-server's.
  const opened = desktop.app.waitForEvent('window');
  await win.evaluate((folder) => void window.open(`/m/local/code/?folder=${encodeURIComponent(folder)}`), home.work);
  const code = await opened;
  try {
    await expect(code.locator('.monaco-workbench')).toBeVisible({ timeout: 120_000 });
  } catch (e) {
    const status = await desktop.api('GET', '/api/m/local/code/status').catch((x: Error) => x.message);
    const text = await code.evaluate(() => `${location.href}\n${document.body?.innerText ?? ''}`).catch((x: Error) => x.message);
    throw new Error(`${(e as Error).message}\nstatus: ${JSON.stringify(status)}\nwindow: ${text.slice(0, 2000)}`);
  }
  await expect(code.locator('.explorer-folders-view .monaco-list-row', { hasText: 'report.txt' })).toBeVisible({ timeout: 60_000 });
  expect(await code.evaluate(() => typeof (window as { desktopShell?: unknown }).desktopShell)).toBe('undefined');
});

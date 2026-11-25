// The desktop app (desktop/, unpackaged Electron) with its core in its
// utility process, isolated: its own instance (<PREFIX>DESKTOP_DEV), a
// profile of its own (--user-data-dir), a temporary home for the core's
// files, Chromium's mock keychain, the payloads scripts/e2e.sh built. The
// UI loads from the app's origin with nothing of the core listening on
// TCP, the local machine gets ready, a terminal runs a command, a file
// downloads, an ssh login runs in a terminal of the core's host (node-pty),
// the core comes back after a crash with the window kept, and
// a VS Code window loads when a code-server release is at hand
// (E2E_CODE_SERVER_SEED: a directory with code-server-<version>-<os>-<arch>.tar.gz).
// Skips without the desktop app built (pnpm -C desktop install && pnpm -C
// desktop build) or a display.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { HOME_PREFIX, MARKER, controlDir, stopNodes, stopTerminalCore } from '../harness/instance';
import { paths, repoRoot } from '../harness/paths';
import { newTerminalTab } from '../harness/ui';
import { waitFor } from '../harness/wait';

const desktopDir = join(repoRoot, 'desktop');
const ORIGIN = `https://${paths.slug}.localhost`;
const PREFIX = paths.slug.toUpperCase().replaceAll('-', '_') + '_';
const DEAD_PROXY = 'http://127.0.0.1:9';

function electronBinary(): string | undefined {
  try {
    const bin = createRequire(join(desktopDir, 'package.json'))('electron') as unknown;
    return typeof bin === 'string' && existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const binary = electronBinary();
const built = ['main.cjs', 'preload.cjs', 'frames.cjs', 'core.mjs'].every((f) => existsSync(join(desktopDir, 'dist', f)));
const seed = process.env.E2E_CODE_SERVER_SEED;

test.skip(!binary || !built, 'the desktop app is not built: pnpm -C desktop install && pnpm -C desktop build');
test.skip(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'Electron needs a display');

/** The PIDs and kinds of the app's processes. */
async function processes(app: ElectronApplication): Promise<Array<{ pid: number; type: string; name: string }>> {
  type Metric = { pid: number; type: string; serviceName?: string; name?: string };
  return app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m: Metric) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '' })),
  );
}

/** The core's utility process. */
async function corePid(app: ElectronApplication): Promise<number> {
  return waitFor(async () => (await processes(app)).find((p) => p.type === 'Utility' && / core$/.test(p.name))?.pid, {
    what: "the core's utility process",
  });
}

/** What a process listens on over TCP (lsof), one line each. */
function listening(pid: number): string[] {
  const r = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .slice(1)
    .filter((l) => l.trim());
}

async function api<T>(page: Page, method: string, path: string): Promise<T> {
  return page.evaluate(
    async ([m, p]) => {
      const r = await fetch(p, { method: m });
      const text = await r.text();
      if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${text}`);
      return (text ? JSON.parse(text) : undefined) as T;
    },
    [method, path] as const,
  );
}

const localStatus = async (page: Page) =>
  (await api<Array<{ id: string; status: string }>>(page, 'GET', '/api/machines')).find((m) => m.id === 'local')?.status;

test('the desktop app runs its core in process, without a listener', async () => {
  test.setTimeout(seed ? 300_000 : 180_000);
  const name = 'e2e-' + randomBytes(4).toString('hex');
  const home = realpathSync(mkdtempSync(HOME_PREFIX));
  const work = join(home, 'work');
  const saved = join(home, 'saved');
  for (const d of [work, saved, join(home, 'tmp')]) mkdirSync(d, { recursive: true });
  // Swept by the next run's global setup if this one is killed.
  writeFileSync(join(home, MARKER), JSON.stringify({ name, pid: process.pid }));
  writeFileSync(join(home, '.bashrc'), `PS1='$ '\n`);
  writeFileSync(join(home, '.bash_profile'), `PS1='$ '\n`);
  // The instance's settings: the AI usage feature leaves the keychain shut;
  // the UI speaks English whatever the system's language; VS Code (off by
  // default) is on for the desktop app when it can be installed.
  const config = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config');
  mkdirSync(join(config, paths.slug), { recursive: true });
  writeFileSync(
    join(config, paths.slug, `settings-${name}.json`),
    JSON.stringify({ 'usage.claudeKeychain': false, 'appearance.language': 'en', ...(seed && { 'plugins.vscode.enabled': true }) }),
  );
  const user = process.env.USER || process.env.LOGNAME || 'e2e';
  const env: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: '/bin/bash',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: join(home, 'tmp'),
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    [`${PREFIX}DESKTOP_DEV`]: name,
    [`${PREFIX}DESKTOP_NO_OPEN`]: '1',
    [`${PREFIX}DESKTOP_PAYLOAD`]: join(paths.agents, '..', 'payload'),
    [`${PREFIX}AGENT_DIR`]: join(paths.agents, '..', 'payload', 'agents'),
    ...(seed && { [`${PREFIX}SEED_DIR`]: seed }),
    ...(process.env.DISPLAY && { DISPLAY: process.env.DISPLAY }),
    ...(process.env.WAYLAND_DISPLAY && { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }),
  };
  let app: ElectronApplication | undefined;
  const log: string[] = [];
  try {
    app = await electron.launch({
      executablePath: binary,
      // The mock keychain: Chromium's own secrets never reach the user's.
      args: [desktopDir, `--user-data-dir=${join(home, 'profile')}`, '--use-mock-keychain', '--lang=en-US'],
      cwd: home,
      env,
      timeout: 60_000,
    });
    app.process().stderr?.on('data', (d: Buffer) => log.push(d.toString()));
    const win = await app.firstWindow();
    await win.waitForURL(`${ORIGIN}/`);
    await expect(win.getByRole('tablist', { name: 'Tabs' })).toBeVisible({ timeout: 30_000 });
    expect(
      await win.evaluate(() => ({
        origin: location.origin,
        secure: isSecureContext,
        shell: 'desktopShell' in window,
        channels: 'desktopChannels' in window,
      })),
    ).toEqual({ origin: ORIGIN, secure: true, shell: true, channels: true });

    // Nothing of the core listens on TCP; nor any of the app's processes
    // but the main one, where only the debugging ports Playwright drives
    // it through are (loopback).
    const core = await corePid(app);
    expect(listening(core)).toEqual([]);
    for (const p of await processes(app)) {
      const lines = listening(p.pid);
      test.info().annotations.push({
        type: 'process',
        description: `${p.type} ${p.name} ${p.pid}: ${lines.length ? lines.join('; ') : 'no TCP listener'}`,
      });
      if (p.type === 'Browser') for (const l of lines) expect(l).toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
      else expect(lines, `${p.type} ${p.name}`).toEqual([]);
    }

    await waitFor(async () => (await localStatus(win)) === 'ready', { what: 'the local machine', timeout: 60_000 });
    // The requests of the app's windows are the desktop client's.
    expect((await api<{ client: string }>(win, 'GET', '/api/config')).client).toBe('desktop');

    // A terminal runs a command.
    await api(win, 'POST', '/api/m/local/hc/start');
    await waitFor(async () => (await api<{ running: boolean }>(win, 'GET', '/api/m/local/hc')).running, {
      what: 'the terminal core',
      timeout: 30_000,
    });
    await newTerminalTab(win);
    const out = join(home, 'out.txt');
    await win.keyboard.type(`echo desktop-$((6*7)) > '${out}'`);
    await win.keyboard.press('Enter');
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').trim() === 'desktop-42', { what: 'the command to run' });

    // An ssh login runs in a terminal of the core's host (node-pty in the
    // utility process): one to a port that refuses shows ssh's answer.
    const added = await win.evaluate(async () => {
      const r = await fetch('/api/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'ssh://nobody@127.0.0.1:9', label: 'refusing' }),
      });
      return (await r.json()) as { id: string };
    });
    const login = await win.evaluate(
      (path) =>
        new Promise<string>((resolve) => {
          const shell = (window as unknown as { desktopChannels: { open(p: string, protocols: string[]): string } }).desktopChannels;
          const id = shell.open(path, []);
          addEventListener('message', (ev: MessageEvent) => {
            if ((ev.data as Record<string, unknown> | null)?.desktopChannelPort !== id) return;
            const port = ev.ports[0];
            let text = '';
            const done = () => {
              port.close();
              resolve(text);
            };
            port.onmessage = (e) => {
              const d = e.data as unknown;
              if (typeof d === 'string') text += d;
              else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) text += new TextDecoder().decode(d as ArrayBuffer);
              else if ((d as { t?: string } | null)?.t === 'close') done();
            };
            setTimeout(done, 15_000);
          });
        }),
      `/api/m/${encodeURIComponent(added.id)}/auth?cols=80&rows=24`,
    );
    expect(login).toMatch(/refused/i);

    // A file downloads (saved where the test says, not through a dialog).
    const file = join(work, 'report.txt');
    writeFileSync(file, 'downloaded through the core\n'.repeat(1000));
    await app.evaluate(
      ({ session }, [dir, partition]) => {
        type Item = { setSavePath(path: string): void; getFilename(): string };
        session.fromPartition(partition).on('will-download', (_e: unknown, item: Item) => item.setSavePath(`${dir}/${item.getFilename()}`));
      },
      [saved, 'persist:app'] as const,
    );
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
      {
        what: 'the download',
      },
    );

    // The core crashes: it comes back, the window stays and reconnects.
    process.kill(core, 'SIGKILL');
    const again = await waitFor(
      async () => {
        const pid = await corePid(app!);
        return pid !== core ? pid : undefined;
      },
      { what: 'the core to start again', timeout: 30_000 },
    );
    expect(listening(again)).toEqual([]);
    await waitFor(async () => (await localStatus(win).catch(() => undefined)) === 'ready', {
      what: 'the local machine again',
      timeout: 60_000,
    });
    // The page's terminal channel came back: the same terminal runs another.
    const after = join(home, 'after.txt');
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

    if (seed) {
      // A VS Code window: its WebSockets are channels through the shim of
      // its frames; the explorer lists the folder over code-server's.
      const opened = app.waitForEvent('window');
      await win.evaluate((folder) => void window.open(`/m/local/code/?folder=${encodeURIComponent(folder)}`), work);
      const code = await opened;
      try {
        await expect(code.locator('.monaco-workbench')).toBeVisible({ timeout: 120_000 });
      } catch (e) {
        const status = await api(win, 'GET', '/api/m/local/code/status').catch((x: Error) => x.message);
        const text = await code.evaluate(() => `${location.href}\n${document.body?.innerText ?? ''}`).catch((x: Error) => x.message);
        throw new Error(`${(e as Error).message}\nstatus: ${JSON.stringify(status)}\nwindow: ${text.slice(0, 2000)}`);
      }
      await expect(code.locator('.explorer-folders-view .monaco-list-row', { hasText: 'report.txt' })).toBeVisible({ timeout: 60_000 });
      expect(await code.evaluate(() => typeof (window as { desktopShell?: unknown }).desktopShell)).toBe('undefined');
    } else {
      test.info().annotations.push({ type: 'skipped', description: 'VS Code: no code-server release at hand (E2E_CODE_SERVER_SEED)' });
    }
  } catch (e) {
    throw new Error(`${(e as Error).message}\napp log:\n${log.join('').slice(-6000)}`);
  } finally {
    // Quitting stops the core; the instance's node and terminal core
    // outlive it and are stopped as the instance's own.
    await app?.close().catch(() => {});
    stopNodes(home, name);
    stopTerminalCore(home, name);
    rmSync(home, { recursive: true, force: true });
    rmSync(controlDir(name), { recursive: true, force: true });
  }
});

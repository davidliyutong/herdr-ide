// The desktop app (desktop/, unpackaged Electron) on an isolated instance:
// a home of its own (home.ts) as its HOME and the core's instance
// (<PREFIX>DESKTOP_DEV), its own Chromium profile (--user-data-dir) with the
// mock keychain, so neither the user's app, its profile and instance nor
// their keychain is read or touched; the payloads scripts/e2e.sh built.
// Its core runs in the app's utility process, without a listener: the
// test reaches it through the app's window (api(), channelText()), as the
// UI does.
//
// close() quits the app, which stops the core; the instance's node and
// terminal core outlive it and are stopped with the home.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TestHome } from './home';
import { paths, repoRoot } from './paths';
import { waitFor } from './wait';

export const desktopDir = join(repoRoot, 'desktop');
/** The origin of the app's windows. */
export const ORIGIN = `https://${paths.slug}.localhost`;
/** The prefix of the desktop app's environment variables. */
const PREFIX = paths.slug.toUpperCase().replaceAll('-', '_') + '_';
/** The session of the app's windows (desktop/src/main.ts). */
export const APP_PARTITION = 'persist:app';

function electronBinary(): string | undefined {
  try {
    const bin = createRequire(join(desktopDir, 'package.json'))('electron') as unknown;
    return typeof bin === 'string' && existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/** Why the desktop app cannot run here, or undefined when it can. */
export function desktopUnavailable(): string | undefined {
  if (!electronBinary() || !['main.cjs', 'preload.cjs', 'frames.cjs', 'core.mjs'].every((f) => existsSync(join(desktopDir, 'dist', f))))
    return 'the desktop app is not built: pnpm -C desktop install && pnpm -C desktop build';
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'Electron needs a display';
  return undefined;
}

export interface DesktopOptions {
  /** The instance's settings besides BASE_SETTINGS and English. */
  settings?: Record<string, unknown>;
  /** A directory with code-server-<version>-<os>-<arch>.tar.gz, which the
   * core installs from instead of downloading. */
  codeServerSeed?: string;
  /** More of the app's environment (a proxy's settings). */
  env?: Record<string, string>;
}

/** One of the app's processes (app.getAppMetrics). */
export interface AppProcess {
  pid: number;
  /** Browser (the main process), Utility, Tab, GPU… */
  type: string;
  name: string;
}

export class Desktop {
  private closed?: Promise<void>;

  private constructor(
    readonly home: TestHome,
    readonly app: ElectronApplication,
    /** The app's first window, its UI loaded. */
    readonly win: Page,
    private readonly log: string[],
  ) {}

  /** Launches the app on a new instance and waits for its UI. */
  static async launch(o: DesktopOptions = {}): Promise<Desktop> {
    const why = desktopUnavailable();
    if (why) throw new Error(why);
    const home = new TestHome({ 'appearance.language': 'en', ...o.settings });
    let app: ElectronApplication | undefined;
    const log: string[] = [];
    try {
      app = await electron.launch({
        executablePath: electronBinary(),
        // The mock keychain: Chromium's own secrets never reach the user's.
        args: [desktopDir, `--user-data-dir=${join(home.dir, 'profile')}`, '--use-mock-keychain', '--lang=en-US'],
        cwd: home.dir,
        env: home.env({
          [`${PREFIX}DESKTOP_DEV`]: home.name,
          [`${PREFIX}DESKTOP_NO_OPEN`]: '1',
          [`${PREFIX}DESKTOP_PAYLOAD`]: paths.payload,
          [`${PREFIX}AGENT_DIR`]: paths.agents,
          [`${PREFIX}SEED_DIR`]: o.codeServerSeed,
          DISPLAY: process.env.DISPLAY,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
          ...o.env,
        }),
        timeout: 60_000,
      });
      app.process().stderr?.on('data', (d: Buffer) => log.push(d.toString()));
      const win = await app.firstWindow();
      await win.waitForURL(`${ORIGIN}/`);
      await win.getByRole('tablist', { name: 'Tabs' }).waitFor({ timeout: 30_000 });
      return new Desktop(home, app, win, log);
    } catch (e) {
      await app?.close().catch(() => {});
      await home.remove().catch(() => {});
      throw new Error(`${(e as Error).message}\napp log:\n${tail(log)}`);
    }
  }

  /** The last of what the app wrote to stderr (its core's log too). */
  logs(): string {
    return tail(this.log);
  }

  /** A request of the app's window to the core, its JSON answer; throws on
   * an error status. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.win.evaluate(
      async ([m, p, b]) => {
        const r = await fetch(p, {
          method: m,
          headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
          body: b === undefined ? undefined : JSON.stringify(b),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${text}`);
        return (text ? JSON.parse(text) : undefined) as T;
      },
      [method, path, body] as const,
    );
  }

  /** The local machine's status, undefined while the core cannot answer. */
  async localStatus(): Promise<string | undefined> {
    const list = await this.api<Array<{ id: string; status: string }>>('GET', '/api/machines').catch(() => undefined);
    return list?.find((m) => m.id === 'local')?.status;
  }

  /** Waits until the local machine is ready and its terminal core runs. */
  async localReady(): Promise<void> {
    await waitFor(async () => (await this.localStatus()) === 'ready', { what: 'the local machine', timeout: 60_000 });
    await this.api('POST', '/api/m/local/hc/start');
    await waitFor(async () => (await this.api<{ running: boolean }>('GET', '/api/m/local/hc')).running, {
      what: 'the terminal core',
      timeout: 30_000,
    });
  }

  /** What a channel of the window to path (desktopChannels, as the UI
   * opens its WebSockets) brings until it closes or timeoutMs pass, as
   * text. */
  channelText(path: string, timeoutMs = 15_000): Promise<string> {
    return this.win.evaluate(
      ([p, ms]) =>
        new Promise<string>((resolve) => {
          const channels = (window as unknown as { desktopChannels: { open(p: string, protocols: string[]): string } }).desktopChannels;
          const id = channels.open(p, []);
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
            setTimeout(done, ms);
          });
        }),
      [path, timeoutMs] as const,
    );
  }

  /** Saves what the app's windows download into dir, without a dialog. */
  async saveDownloadsTo(dir: string): Promise<void> {
    await this.app.evaluate(
      ({ session }, [d, partition]) => {
        type Item = { setSavePath(path: string): void; getFilename(): string };
        session.fromPartition(partition).on('will-download', (_e: unknown, item: Item) => item.setSavePath(`${d}/${item.getFilename()}`));
      },
      [dir, APP_PARTITION] as const,
    );
  }

  /** The app's processes. */
  processes(): Promise<AppProcess[]> {
    type Metric = { pid: number; type: string; serviceName?: string; name?: string };
    return this.app.evaluate(({ app: a }) =>
      a.getAppMetrics().map((m: Metric) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '' })),
    );
  }

  /** The core's utility process; waits for one other than not (the one
   * that crashed). */
  corePid(not?: number): Promise<number> {
    return waitFor(
      async () => {
        const pid = (await this.processes()).find((p) => p.type === 'Utility' && / core$/.test(p.name))?.pid;
        return pid !== not ? pid : undefined;
      },
      { what: "the core's utility process", timeout: 30_000 },
    );
  }

  /** Quits the app (which stops its core), stops the instance's node and
   * terminal core and removes the home; once. */
  close(): Promise<void> {
    this.closed ??= (async () => {
      await this.app.close().catch(() => {});
      await this.home.remove();
    })();
    return this.closed;
  }
}

const tail = (log: string[]) => log.join('').slice(-6000);

/** What a process listens on over TCP (lsof), one line each. */
export function tcpListeners(pid: number): string[] {
  const r = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' });
  return r.stdout
    .split('\n')
    .slice(1)
    .filter((l) => l.trim());
}

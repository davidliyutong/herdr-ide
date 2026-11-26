// The desktop app (desktop/, unpackaged Electron) on an isolated instance:
// a home of its own (home.ts) as its HOME and the hub's instance
// (<PREFIX>DESKTOP_DEV), its own Chromium profile (--user-data-dir) with the
// mock keychain, so neither the user's app, its profile and instance nor
// their keychain is read or touched; the payloads scripts/e2e.sh built.
// Its hub runs in the app's utility process, without a listener: the
// test reaches it through the app's window (api(), channelText()), as the
// UI does.
//
// close() quits the app, which stops the hub; the instance's node and
// terminal core outlive it and are stopped with the home.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
  if (!electronBinary() || !['main.cjs', 'preload.cjs', 'frames.cjs', 'hub.mjs'].every((f) => existsSync(join(desktopDir, 'dist', f))))
    return 'the desktop app is not built: pnpm -C desktop install && pnpm -C desktop build';
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'Electron needs a display';
  return undefined;
}

export interface DesktopOptions {
  /** The instance's settings besides BASE_SETTINGS and English. */
  settings?: Record<string, unknown>;
  /** A directory with code-server-<version>-<os>-<arch>.tar.gz, which the
   * hub installs from instead of downloading. */
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

/** Whether Electron needs --no-sandbox on Linux (containers or Ubuntu 24.04
 * AppArmor userns restriction without a setuid chrome-sandbox). */
function needsNoSandbox(bin: string | undefined): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.E2E_ELECTRON_NO_SANDBOX === '1') return true;
  if (existsSync('/.dockerenv')) return true;
  try {
    const restricted = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
    if (!restricted) return false;
    const sandbox = bin ? join(dirname(bin), 'chrome-sandbox') : '';
    const st = sandbox && existsSync(sandbox) ? statSync(sandbox) : undefined;
    return !(st && st.uid === 0 && (st.mode & 0o4000) !== 0);
  } catch {
    return false;
  }
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
      const bin = electronBinary();
      const args = [desktopDir, `--user-data-dir=${join(home.dir, 'profile')}`, '--use-mock-keychain', '--lang=en-US'];
      if (needsNoSandbox(bin)) args.push('--no-sandbox');
      app = await electron.launch({
        executablePath: bin,
        // The mock keychain: Chromium's own secrets never reach the user's.
        args,
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

  /** The last of what the app wrote to stderr (its hub's log too). */
  logs(): string {
    return tail(this.log);
  }

  /** A request of the app's window to the hub, its JSON answer; throws on
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

  /** The local machine's status, undefined while the hub cannot answer. */
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

  /** The hub's utility process; waits for one other than not (the one
   * that crashed). */
  hubPid(not?: number): Promise<number> {
    return waitFor(
      async () => {
        const pid = (await this.processes()).find((p) => p.type === 'Utility' && / hub$/.test(p.name))?.pid;
        return pid !== not ? pid : undefined;
      },
      { what: "the hub's utility process", timeout: 30_000 },
    );
  }

  /** Quits the app (which stops its hub), stops the instance's node and
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

/** What a process listens on over TCP (lsof, falling back on Linux to ss
 * and /proc/net/tcp when lsof is not installed), one line each. */
export function tcpListeners(pid: number): string[] {
  const r = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' });
  if (!r.error && typeof r.stdout === 'string') {
    return r.stdout
      .split('\n')
      .slice(1)
      .filter((l) => l.trim());
  }
  if (process.platform !== 'linux') {
    throw new Error(`lsof failed: ${r.error?.message ?? `exit ${r.status}`}`);
  }
  const ss = spawnSync('ss', ['-H', '-ltnp'], { encoding: 'utf8' });
  if (!ss.error && typeof ss.stdout === 'string') {
    const tag = `pid=${pid},`;
    return ss.stdout
      .split('\n')
      .filter((l) => l.includes(tag))
      .map((l) => {
        const local = l.trim().split(/\s+/)[3] ?? l.trim();
        return `${local} (LISTEN)`;
      });
  }
  return procTcpListeners(pid);
}

/** Parses /proc/<pid>/fd and /proc/net/tcp{,6} for listening TCP sockets. */
function procTcpListeners(pid: number): string[] {
  const inodes = new Set<string>();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) inodes.add(m[1]);
      } catch {
        // fd closed meanwhile
      }
    }
  } catch {
    return [];
  }
  if (!inodes.size) return [];
  const out: string[] = [];
  for (const [file, v6] of [
    ['/proc/net/tcp', false],
    ['/proc/net/tcp6', true],
  ] as const) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A' || !inodes.has(f[9])) continue;
      const [hexIp, hexPort] = f[1].split(':');
      const port = parseInt(hexPort, 16);
      const host = v6
        ? hexIp === '00000000000000000000000001000000'
          ? '[::1]'
          : `[${hexIp}]`
        : [6, 4, 2, 0].map((i) => parseInt(hexIp.slice(i, i + 2), 16)).join('.');
      out.push(`${host}:${port} (LISTEN)`);
    }
  }
  return out;
}

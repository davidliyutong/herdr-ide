import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';
import type { MessageKey } from '../../web/src/i18n/en';

export const ENV_PREFIX = APP_SLUG.toUpperCase().replaceAll('-', '_') + '_';

// A failure the launcher explains in the UI language; detail is technical
// (an exit code, a port) and shown as is.
export class DesktopError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly detail = '',
  ) {
    super(detail ? `${key} (${detail})` : key);
  }
}

export function corePort(port: string): number {
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new DesktopError('desktop.badPort', port);
  return Number(port);
}

export function coreArgs(dev: boolean, port: number): string[] {
  return [
    'serve',
    '--parent-stdio',
    '--listen',
    `127.0.0.1:${port}`,
    '--instance',
    dev ? 'dev' : 'desktop',
    ...(dev ? ['--local-only', '--local-session', `${APP_SLUG}-dev`, '--remote-session', `${APP_SLUG}-dev`] : []),
  ];
}

export function coreEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  // Finder does not load shell rc files. Include common installations without
  // executing the user's login shell or interpolating shell commands.
  const paths = [env.PATH || '', join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { ...env, PATH: paths.filter(Boolean).join(delimiter) };
}

export class CoreProcess {
  private child?: ChildProcessWithoutNullStreams;
  private stopped?: Promise<void>;
  private stopping = false;
  private stderr = '';

  get diagnostics(): string {
    return this.stderr;
  }

  // port is the one passed in --listen; 0 accepts the port the core chose.
  async start(binary: string, args: string[], port: number, env: NodeJS.ProcessEnv, cwd: string, onExit: () => void): Promise<string> {
    const child = spawn(binary, args, { env, cwd, stdio: 'pipe', shell: false });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-16_384);
      process.stderr.write(data);
    });
    return new Promise((resolve, reject) => {
      let ready = false;
      let buffer = '';
      const timer = setTimeout(() => reject(new DesktopError('desktop.coreTimeout')), 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      // Permanent: an 'error' without a listener (e.g. a failed kill during
      // stop) would crash the Electron main process.
      child.on('error', (error) => {
        if (ready) console.error(error);
        else fail(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (!ready) reject(new DesktopError('desktop.coreExited', String(code ?? signal)));
        else if (!this.stopping) onExit();
      });
      child.stdout.on('data', (data: Buffer) => {
        if (ready) return;
        buffer += data.toString();
        if (buffer.length > 4096) {
          fail(new DesktopError('desktop.coreBadReady'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let url: URL;
        let event: unknown;
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          event = message.event;
          url = new URL(message.url);
        } catch {
          fail(new DesktopError('desktop.coreBadReady'));
          return;
        }
        if (
          event !== 'ready' ||
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash ||
          (port !== 0 && Number(url.port || '80') !== port)
        ) {
          fail(new DesktopError('desktop.coreBadReady', url.origin));
          return;
        }
        ready = true;
        clearTimeout(timer);
        resolve(url.origin);
      });
    });
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
    this.stopped = new Promise((resolve) => {
      // The core allows 3 s for HTTP and 15 s for agents. Force only this
      // owned child if it cannot finish; never signal herdr's session server.
      const force = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin.end();
      child.kill('SIGTERM');
    });
    return this.stopped;
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';
import type { MessageKey } from '../../web/src/i18n/en';
import type { Platform } from './platform';

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

/** The instance of a run: `desktop`, or in development `dev` or the one
 * <prefix>DESKTOP_DEV names (`1` is `dev`), so that a smoke test can run
 * beside a development instance in use; never `desktop` itself. */
export function coreInstance(dev: boolean, devValue: string | undefined): string {
  if (!dev) return 'desktop';
  if (!devValue || devValue === '1') return 'dev';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(devValue) || devValue === 'desktop') throw new DesktopError('desktop.badInstance', devValue);
  return devValue;
}

/** The instance of the machines' nodes (their data directory and terminal
 * core) a core of instance uses: the app's is the default one, which it
 * shares with every core of the default instance, as a server's UI;
 * a development instance keeps its own. */
export function nodeInstance(instance: string): string {
  return instance === 'desktop' ? '' : instance;
}

export function coreArgs(instance: string, port: number): string[] {
  return [
    'serve',
    '--parent-stdio',
    '--listen',
    `127.0.0.1:${port}`,
    '--instance',
    instance,
    `--node-instance=${nodeInstance(instance)}`,
    ...(instance === 'desktop' ? [] : ['--local-only']),
  ];
}

// The desktop app's token of a launch tells the core which requests are
// its windows' (backend/hosts/bun/parent.ts): VS Code has a switch for the
// desktop app and one for browsers, and the core applies the requesting
// client's. The token goes to the core on stdin, the first line of
// --parent-stdio (never in its environment, which terminals, agents and
// code-server inherit), and to the app's own session as a cookie for the
// core's origin, which every request of its windows then carries.

/** The cookie's name; the core's DesktopCookie. */
export const DESKTOP_COOKIE = `${APP_SLUG}-desktop`;

/** A new token: 32 random bytes as hex, for one launch. */
export function desktopToken(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('hex');
}

/** A new key for the system's prompts (verify.ts): 32 random bytes as hex,
 * for one launch. Unlike the token it is sent to the core only in the
 * hello and kept in the main process: never in a cookie, an environment
 * variable, an argument or a log. */
export function verifyKey(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString('hex');
}

/** The launcher's hello, the first line the core reads on stdin. */
export function coreHello(token: string, verifyKey = ''): string {
  return (
    JSON.stringify({
      ...(token && { desktop_token: token }),
      ...(verifyKey && { verify_key: verifyKey }),
    }) + '\n'
  );
}

/** What Electron's cookies.set gets for the token: the core's origin only
 * (host-only: no domain; the whole site: path /), HttpOnly so that no
 * script of the page or of VS Code reads it, SameSite=Strict, and a
 * session cookie (no expiry), gone when the app quits. */
export function desktopCookie(origin: string, token: string) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin)
    throw new DesktopError('desktop.coreBadReady', origin);
  return {
    url: `${origin}/`,
    name: DESKTOP_COOKIE,
    value: token,
    path: '/',
    secure: false,
    httpOnly: true,
    sameSite: 'strict' as const,
  };
}

export function coreEnv(env: NodeJS.ProcessEnv, home: string, platform: Platform): NodeJS.ProcessEnv {
  // Windows keeps its Path as it is (its name differs in case, which a copy
  // of the environment would duplicate).
  if (platform === 'win32') return env;
  // Finder and desktop launchers do not load shell rc files. Include common
  // installations without executing the user's login shell or interpolating
  // shell commands.
  const paths = [
    env.PATH || '',
    posix.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return { ...env, PATH: paths.filter(Boolean).join(posix.delimiter) };
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
  // token and verifyKey are the desktop app's of this launch, sent in the
  // hello.
  async start(
    binary: string,
    args: string[],
    port: number,
    env: NodeJS.ProcessEnv,
    cwd: string,
    onExit: () => void,
    token = '',
    verifyKey = '',
  ): Promise<string> {
    // windowsHide: the core is a console program, which would get a window.
    const child = spawn(binary, args, { env, cwd, stdio: 'pipe', shell: false, windowsHide: true });
    this.child = child;
    child.stdin.on('error', () => {});
    // The core reads the hello before it serves; stdin stays open (its
    // end stops the core).
    child.stdin.write(coreHello(token, verifyKey));
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

  /** Stops the core by closing its stdin (--parent-stdio), which works on
   * every platform: Windows has no signal a process can clean up after
   * (Node's kill terminates it there). The core allows 3 s for HTTP and 15 s
   * for agents; only this owned child is killed if it has not ended within
   * deadline ms, never the terminal cores. */
  stop(deadline = 20_000): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
    this.stopped = new Promise((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), deadline);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.stdin.end();
    });
    return this.stopped;
  }
}

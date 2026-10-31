import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';

export const ENV_PREFIX = APP_SLUG.toUpperCase().replaceAll('-', '_') + '_';

export function coreArgs(dev: boolean, port: string): string[] {
  if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error('Invalid desktop port');
  return [
    'serve',
    '--parent-stdio',
    '--listen',
    `127.0.0.1:${Number(port)}`,
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

  async start(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onExit: () => void): Promise<string> {
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
      const timer = setTimeout(() => reject(new Error('Core startup timed out')), 30_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`Core exited (${code ?? signal})`));
        else if (!this.stopping) onExit();
      });
      child.stdout.on('data', (data: Buffer) => {
        if (ready) return;
        buffer += data.toString();
        if (buffer.length > 4096) {
          fail(new Error('Invalid core ready message'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          const url = new URL(message.url);
          const requested = args[args.indexOf('--listen') + 1].split(':')[1];
          if (
            message.event !== 'ready' ||
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            (requested !== '0' && (url.port || '80') !== requested)
          )
            throw new Error('Invalid core URL');
          ready = true;
          clearTimeout(timer);
          resolve(url.origin);
        } catch (error) {
          fail(error as Error);
        }
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

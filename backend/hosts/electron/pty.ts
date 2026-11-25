// Terminals on the hub's host through node-pty (kernel/pty.ts): the
// desktop app's hub runs an interactive ssh login in one. node-pty is
// Node-API, so the same binary loads in Node and in Electron's utility
// process without a rebuild for Electron. It is loaded when a login first
// needs it: a hub whose node-pty does not load runs without ssh logins.
import { createRequire } from 'node:module';
import type * as NodePty from 'node-pty';
import type { Pty, SpawnPty } from '#kernel/pty.ts';

let loaded: typeof NodePty | undefined;

export const nodePty: SpawnPty = (argv, size) => {
  loaded ??= createRequire(import.meta.url)('node-pty') as typeof NodePty;
  const [file, ...args] = argv;
  const term = loaded.spawn(file, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME,
    env: process.env as Record<string, string>,
    // Output as bytes, not decoded text.
    encoding: null,
  });
  let done = false;
  const exited = new Promise<number>((resolve) =>
    term.onExit(({ exitCode }) => {
      done = true;
      resolve(exitCode);
    }),
  );
  const pty: Pty = {
    write: (d) => term.write(typeof d === 'string' ? d : Buffer.from(d.buffer, d.byteOffset, d.byteLength)),
    resize: (cols, rows) => {
      if (!done) term.resize(cols, rows);
    },
    kill() {
      if (done) return;
      term.kill('SIGHUP');
      setTimeout(() => done || term.kill('SIGKILL'), 2000).unref();
    },
    onData: (fn) => void term.onData((d) => fn(typeof d === 'string' ? Buffer.from(d) : d)),
    exited,
  };
  return pty;
};

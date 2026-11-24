// Terminals on the core's host through Bun.Terminal (kernel/pty.ts).
import type { Pty, SpawnPty } from '#kernel/pty.ts';

export const bunPty: SpawnPty = (argv, size) => {
  const listeners: Array<(d: Uint8Array) => void> = [];
  const terminal = new Bun.Terminal({
    cols: size.cols,
    rows: size.rows,
    data: (_t, d) => {
      for (const l of listeners) l(d);
    },
  });
  const proc = Bun.spawn([...argv], { terminal });
  const exited = proc.exited.then((code) => {
    // Output still in the terminal is read until its end of file.
    setTimeout(() => terminal.close(), 2000).unref();
    return code;
  });
  const pty: Pty = {
    write: (d) => void terminal.write(d),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill() {
      proc.kill('SIGHUP');
      setTimeout(() => proc.killed || proc.kill('SIGKILL'), 2000).unref();
    },
    onData: (fn) => void listeners.push(fn),
    exited,
  };
  return pty;
};

// A terminal on the hub's own host (an interactive ssh login): the host
// provides it, Bun.Terminal on the command line, node-pty in the desktop
// app.

export interface Pty {
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  /** Ends the program (SIGHUP, then SIGKILL). */
  kill(): void;
  onData(fn: (data: Uint8Array) => void): void;
  /** Resolves with the exit code once the program exited. */
  readonly exited: Promise<number>;
}

export type SpawnPty = (argv: readonly string[], size: { cols: number; rows: number }) => Pty;

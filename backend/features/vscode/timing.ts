// The durations of VS Code's side of the core, which tests shorten.

export interface Timing {
  /** A machine's code-server is released after this long without a VS Code
   * connection or request (--code-server-idle); 0 or less: never. */
  idleMs: number;
  /** How often idle code-servers are looked for. */
  idleCheckMs: number;
  /** Bounds a code-server request of its own (status, marker). */
  requestMs: number;
  /** Bounds starting code-server (the agent waits for it up to 90 s). */
  startMs: number;
  /** Bounds the answer to an upload once it is sent: unpacking a release,
   * installing an extension (which the agent bounds at 5 min). */
  installMs: number;
  /** Bounds a machine's own download of the release (the agent's limit is
   * 20 min). */
  machineDownloadMs: number;
  /** Bounds a download on the core's host. */
  downloadMs: number;
  /** Bounds stopping or releasing code-server. */
  stopMs: number;
  /** Bounds reaching code-server's socket through the agent. */
  dialMs: number;
  /** Bounds the wait for the head of a proxied response. */
  responseHeadMs: number;
  /** A pooled connection to code-server unused this long is closed, before
   * code-server closes it (Node's keep-alive timeout, 5 s). */
  freeSocketMs: number;
  /** Bounds the WebSocket handshake with code-server, and the browser's
   * upgrade after it. */
  handshakeMs: number;
  /** Bounds a bridge command, preparing code-server included. */
  bridgeCommandMs: number;
  /** How long a command waits for its window. */
  bridgeWindowMs: number;
  /** After this, a command takes a window that contains its folder. */
  bridgeGraceMs: number;
  /** How often a command looks again without news of windows. */
  bridgePollMs: number;
  /** How long a window may take to acknowledge a command. */
  bridgeAckMs: number;
  /** Bounds a write to a window. */
  bridgeWriteMs: number;
}

export const DEFAULT_TIMING: Timing = {
  idleMs: 20 * 60_000,
  idleCheckMs: 60_000,
  requestMs: 60_000,
  startMs: 120_000,
  installMs: 10 * 60_000,
  machineDownloadMs: 21 * 60_000,
  downloadMs: 30 * 60_000,
  stopMs: 30_000,
  dialMs: 30_000,
  responseHeadMs: 2 * 60_000,
  freeSocketMs: 4000,
  handshakeMs: 30_000,
  bridgeCommandMs: 2 * 60_000,
  bridgeWindowMs: 60_000,
  bridgeGraceMs: 4000,
  bridgePollMs: 1000,
  bridgeAckMs: 30_000,
  bridgeWriteMs: 10_000,
};

export { parseDuration } from '#shared/lib/gotime.ts';

// The durations and bounds of program windows, which tests shorten.

export interface Timing {
  /** The wait before preparing a display again after a failure; it
   * doubles with each failure in a row up to retryMaxMs. */
  retryMinMs: number;
  retryMaxMs: number;
  /** How long an attachment must last for its end not to count as a
   * failure in the backoff. */
  stableAttachMs: number;
  /** Bounds preparing a display: its status, install and start. */
  prepareMs: number;
  /** Bounds asking a machine to keep its display, and installing the GPU
   * selection library. */
  keepMs: number;
  /** Bounds putting the video encoder on a machine. */
  videoMs: number;
  /** Bounds enabling the display in open terminals. */
  enableMs: number;
  /** Lets a shell handle Ctrl-C before the export command follows: the
   * terminal discards input that arrives with the interrupt. */
  interruptPauseMs: number;
  /** Lets a browser window that is reloading come back before its program
   * window is closed. */
  closeGraceMs: number;
  /** How often one viewer may have a window sent in full, or a key frame
   * asked for. */
  refreshEveryMs: number;
  /** A viewer skips frames while the oldest frame it has not shown was
   * shown by another viewer and sent this long ago (the agent goes at the
   * pace of the fastest viewer). */
  viewerLagMs: number;
  /** A browser window whose connection takes nothing this long is
   * disconnected. */
  viewerWriteMs: number;
  /** How long an attach stream the core ended may take to end on the
   * agent's side too before it is reset. */
  detachMs: number;
}

export const DEFAULT_TIMING: Timing = {
  retryMinMs: 5000,
  retryMaxMs: 5 * 60_000,
  stableAttachMs: 60_000,
  prepareMs: 10 * 60_000,
  keepMs: 60_000,
  videoMs: 5 * 60_000,
  enableMs: 60_000,
  interruptPauseMs: 200,
  closeGraceMs: 2000,
  refreshEveryMs: 500,
  viewerLagMs: 250,
  viewerWriteMs: 20_000,
  detachMs: 5000,
};

export interface Limits {
  /** Commands waiting to be written to a machine's agent; more are
   * dropped while the agent does not keep up. */
  agentCommands: number;
  /** Messages waiting for a browser window's connection; a frame that
   * does not fit is skipped (the window is sent in full later). */
  viewerMessages: number;
  /** A viewer with this many frames, or bytes, not shown skips frames. */
  viewerMaxFrames: number;
  viewerMaxBytes: number;
  /** Bytes a browser window's channel may hold unsent before the core
   * keeps its messages in its own queue. */
  viewerBuffered: number;
  /** The largest message a browser window may send. */
  viewerMessageBytes: number;
  /** The largest body of POST /api/m/{id}/gui/enable. */
  enableBodyBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  agentCommands: 256,
  viewerMessages: 64,
  viewerMaxFrames: 64,
  viewerMaxBytes: 16 << 20,
  viewerBuffered: 1 << 20,
  viewerMessageBytes: 64 << 10,
  enableBodyBytes: 64 << 10,
};

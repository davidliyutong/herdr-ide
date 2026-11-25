// The durations and bounds of the chat feature, which tests shorten.

export interface Timing {
  /** How long a chat host has to send its Hello once the machine opened
   * the stream (the open itself covers the machine starting the host). */
  helloMs: number;
  /** How long one line may take to be written to a chat host. */
  writeMs: number;
  /** Bounds a request to a chat host, and a configure. */
  shortMs: number;
  /** Bounds listing an agent's sessions, which may run the agent. */
  sessionsMs: number;
  /** Bounds getting Anthropic's Agent SDK to a machine before a Claude
   * Code chat starts: the machine's download, else the core's and its
   * upload. */
  sdkMs: number;
  /** Bounds a handoff, from the open to the command's answer. */
  handoffMs: number;
  /** Bounds a subscription's attach until the host's answer. */
  attachMs: number;
  /** Bounds what GET /api/p/chat/hosts asks each machine's chat host. */
  overviewMs: number;
  /** How long the core keeps watching a host whose chats run no agent and
   * that nothing of the core used. */
  lingerMs: number;
  /** How often the watches are looked at. */
  tickMs: number;
  /** The first wait after a watch failed; it doubles up to 5 minutes. */
  retryMs: number;
  /** The wait after a watch's stream ended. */
  againMs: number;
  /** How long after a refused command's audit record a page's refusals of
   * the same operation are only counted, into the next record. */
  refusalGapMs: number;
  /** How long a page may go without taking any of what waits for it
   * before it is disconnected. */
  pageWriteMs: number;
}

export const DEFAULT_TIMING: Timing = {
  helloMs: 10_000,
  writeMs: 30_000,
  shortMs: 45_000,
  sessionsMs: 120_000,
  sdkMs: 10 * 60_000,
  handoffMs: 60_000,
  attachMs: 45_000,
  overviewMs: 5000,
  lingerMs: 120_000,
  tickMs: 5000,
  retryMs: 5000,
  againMs: 1000,
  refusalGapMs: 10_000,
  pageWriteMs: 30_000,
};

export interface Limits {
  /** The most connections the core has open to one machine's chat host,
   * the pages' subscriptions and every request's together; the last
   * reservedConns of them only for the watch and the configures. */
  maxHostConns: number;
  reservedConns: number;
  /** Bound what waits to be sent to a page. The events of its
   * subscriptions share half of them: a subscription over its share is not
   * read from the chat host until the page took enough of them (the host
   * drops a connection that falls behind, and the page attaches again).
   * The core's own messages take the rest: a page that falls that far
   * behind is disconnected. One message of any size is taken when nothing
   * waits. */
  backlogMessages: number;
  backlogBytes: number;
  /** Bytes the page's channel may hold unsent before the core keeps the
   * page's messages in its own backlog. */
  pageBuffered: number;
  /** How many commands of a subscription may wait to be written to its
   * host connection, and how many may wait for their answer. */
  subCommands: number;
  maxPending: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxHostConns: 128,
  reservedConns: 8,
  backlogMessages: 8192,
  backlogBytes: 32 << 20,
  pageBuffered: 1 << 20,
  subCommands: 16,
  maxPending: 64,
};

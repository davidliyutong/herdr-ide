// herdr-core's API types (protocol generation 1).

/** A JSON-RPC error from the core. kind is stable ("not_found", "conflict",
 * "unavailable", "needs_framed"…); message and hint are the core's English
 * text and are not shown to users. */
export class HCError extends Error {
  readonly code: number;
  readonly rpcMessage: string;
  readonly kind: string;
  readonly hint: string;

  constructor(code: number, rpcMessage: string, kind: string, hint: string) {
    super(kind ? `hc: ${kind}: ${rpcMessage}` : `hc: ${rpcMessage} (${code})`);
    this.code = code;
    this.rpcMessage = rpcMessage;
    this.kind = kind;
    this.hint = hint;
  }
}

/** The core's answer to the handshake. */
export interface Hello {
  generation: number;
  version: string;
  framed: boolean;
  core: CoreInfo;
  methods: string[] | null;
  features: string[] | null;
}

export const hasFeature = (h: Hello, feature: string): boolean => (h.features ?? []).includes(feature);

/** Identifies a core: id stays until its state is wiped. */
export interface CoreInfo {
  id: string;
  name: string;
}

/** What a program reported about itself through OSC 7501; the core never
 * infers it from the screen. */
export interface Status {
  state: string;
  kind?: string | null;
  app?: string;
  title?: string;
  msg?: string;
  progress?: number | null;
}

/** The program running in a terminal now. */
export interface Foreground {
  pid: number;
  name: string;
  argv: string[] | null;
  cwd: string;
}

/** The core's record of a terminal, live or finished. Records keep the
 * fields this package does not know, so they can be passed on as sent. */
export interface Terminal {
  address: string;
  name?: string | null;
  state: string;
  argv: string[] | null;
  cwd: string;
  cols: number;
  rows: number;
  created_ms: number;
  finished_ms?: number | null;
  pid?: number | null;
  parent?: string | null;
  labels: Record<string, string> | null;
  title?: string;
  keep?: boolean;
  reason?: string | null;
  exit_code?: number | null;
  signal?: number | null;
  status?: Status | null;
  status_ms?: number | null;
  records?: Record<string, Status>;
  reported?: boolean;
  turn?: number;
  foreground?: Foreground | null;
  screen: string;
  [field: string]: unknown;
}

/** What a viewer tells the core about itself: colors as the core's color
 * strings and the cell size in pixels. */
export interface Display {
  fg?: string;
  bg?: string;
  cursor?: string;
  cell?: number[];
}

export interface AttachParams {
  terminal: string;
  cols: number;
  rows: number;
  /** Lines above the screen in the first paint. */
  history?: number;
  /** A viewer that never types or resizes. */
  observe?: boolean;
  /** The terminal's grid as resize messages in the stream (observers). */
  resize_notifications?: boolean;
  /** Continues a stream lost with its connection. */
  resumed?: boolean;
  display?: Display;
}

export interface Attached {
  channel: number;
  terminal: Terminal;
  automatic_input?: boolean;
  resize_notifications?: boolean;
}

/** Filters of an event subscription; empty subscribes to everything,
 * documents included. */
export interface SubscribeParams {
  terminal?: string;
  children_of?: string;
  labels?: Record<string, string>;
}

/** The terminals now and the sequence number the events follow. */
export interface Subscribed {
  channel: number | null;
  seq: number;
  terminals: Terminal[] | null;
}

/** One message of an event subscription. */
export interface Notification {
  /** "event", "heartbeat" or "missed". */
  method: string;
  /** Rises by one per event and restarts with the core process. */
  seq: number;
  /** For an event: its type ("created", "status", "doc"…), the terminal it
   * is about (none for documents), the added machine it comes from. */
  type: string;
  terminal: string;
  machine: string;
  data: unknown;
  /** The fresh snapshot of a "missed": events not above its seq are dropped. */
  terminals: Terminal[] | null;
}

/** Why the core closed a stream: for a terminal, how its program ended
 * (reason "exited", "killed", "server_stop"…). */
export interface Exit {
  reason: string;
  exit_code: number | null;
  signal: number | null;
}

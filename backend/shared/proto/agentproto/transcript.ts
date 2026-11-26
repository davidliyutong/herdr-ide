// A coding agent's session transcript as a machine reads it, parsed into
// events shaped as the Agent Client Protocol's (ACP v1) session/update
// notifications: members named as ACP's, and those every event has as an
// event log's (t, at). A transcript is named by its agent's kind and
// session id, never by a path.
import { SLUG } from '#shared/lib/brand.ts';

export const Transcript = {
  /** An ACP session update, in update. */
  Update: 'update',
  /** A prompt of the user, its ACP content blocks in content. */
  User: 'user',
  /** A turn started, ended or failed (state, stopReason). */
  Turn: 'turn',
  /** Something that is no session update (method, params). */
  Notice: 'notice',
} as const;

export const Turn = { Start: 'start', End: 'end', Error: 'error' } as const;

/** The notices of a transcript and of a chat, by name (noticeMethod). */
export const Notice = {
  Compacted: 'compacted',
  Command: 'command',
  Error: 'error',
  Skipped: 'skipped',
  // the chats' own
  Compacting: 'compacting',
  HandedOff: 'handed_off',
  Restarted: 'restarted',
  Imported: 'imported',
  UntrustedFolder: 'untrusted_folder',
  FullAccessOff: 'full_access_off',
} as const;

/** The method of a notice: an ACP extension method, "_<slug>/<name>". */
export const noticeMethod = (name: string): string => `_${SLUG}/${name}`;

export const TranscriptLimits = {
  /** The most text of one event. */
  maxTextBytes: 256 << 10,
  /** The most of a tool call's output an event keeps (its start and end). */
  maxToolOutput: 32 << 10,
  /** The most events one line of a transcript makes. */
  maxLineEvents: 1 << 8,
} as const;

/** One event of a transcript, made from its line alone. */
export interface TranscriptEvent {
  t: string;
  /** RFC 3339 (formatRFC3339); absent when unknown. */
  at?: string;
  update?: unknown;
  content?: unknown[];
  state?: string;
  stopReason?: string;
  method?: string;
  params?: unknown;
}

/** The codes of a transcript's readers. */
export const TranscriptCode = {
  NotFound: 'not_found',
  Compressed: 'compressed',
  TooLarge: 'too_large',
  BadRequest: 'bad_request',
} as const;

export interface ResolveReply {
  ok: boolean;
  code?: string;
}

export const RESOLVE_OTHER_CWD = 'other_cwd';

/** What a session of a coding agent used, at API prices. */
export interface SessionUsage {
  model?: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
  requests: number;
  cost: number;
  priced: boolean;
  contextUsed?: number;
  contextSize?: number;
}

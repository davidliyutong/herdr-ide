// A search's parameters once checked, and the limits both engines keep.
import type { SearchParams } from '../protocol.ts';

/** The matches a search returns unless it asks for fewer. */
export const DEFAULT_RESULTS = 2000;
/** The walker skips larger files; ripgrep's limit is RG_MAX_FILE_SIZE. */
export const MAX_FILE_SIZE = 1 << 20;
/** Bounds the files the walker reads. */
export const MAX_FILES = 100_000;

export interface Query extends SearchParams {
  /** The directory searched, absolute and clean. */
  dir: string;
  includes: string[];
  excludes: string[];
  /** The most matches. */
  limit: number;
}

/** How a search ends early: when signal aborts (the core gave up on it or
 * it ran out of time); timedOut tells which. */
export interface Stop {
  signal: AbortSignal;
  timedOut(): boolean;
}

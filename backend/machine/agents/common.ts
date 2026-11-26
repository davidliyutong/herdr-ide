// What the modules of the coding agents' sessions share (sessions.ts,
// claude.ts, codex.ts): the types of their answers, their bounds and
// timing, and a search's matches.
import type { BigIntStats } from 'node:fs';
import { posix } from 'node:path';
import { byId } from '#shared/agents/kinds.ts';
import type { FileId, Files } from './files.ts';

/** The foreground program of a terminal, as the terminal core reports it. */
export interface Proc {
  pid: number;
  argv: readonly string[];
  cwd: string;
}

/** A session and how it was found (agentproto's SessionFrom). */
export interface Found {
  id: string;
  source: string;
}

export const NO_SESSION: Found = Object.freeze({ id: '', source: '' });

/** What a transcript says of itself: the directory the session ran in and
 * when it started (ms); empty when it does not say. */
export interface Info {
  cwd: string;
  started: number | null;
}

/** Why a session has no transcript to read. */
export class SessionError extends Error {
  readonly code: 'bad_id' | 'unknown_kind' | 'not_found' | 'compressed';
  constructor(code: SessionError['code']) {
    super(`sessions: ${code.replace('_', ' ')}`);
    this.code = code;
  }
}

/** The transcript formats with sessions (Kind.transcript). */
export const Format = { Claude: 'claude', Codex: 'codex' } as const;
export type Format = (typeof Format)[keyof typeof Format];

/** The format of a kind with sessions; null for any other kind. */
export function formatOf(kind: string): Format | null {
  const t = byId(kind)?.transcript;
  return t === Format.Claude || t === Format.Codex ? t : null;
}

/** Bounds of what one call reads. */
export const LIMITS = {
  /** Claude Code's <pid>.json. */
  record: 64 << 10,
  /** What is read of a Codex rollout's first line (session_meta, tens of
   * KiB with the model's instructions). */
  metaLine: 1 << 20,
  /** What is read of a Claude transcript to find its first conversation
   * line, in bytes and lines; lines longer than headLine are passed over. */
  head: 4 << 20,
  headLines: 256,
  headLine: 256 << 10,
  /** Entries read of one directory. */
  entries: 4096,
  /** Entries read of a Claude projects directory. */
  projects: 10000,
  /** Entries read of a Codex session root (archived_sessions holds every
   * archived rollout in one directory). */
  archived: 1 << 16,
  /** Rollouts whose first line one resolve reads. */
  metaReads: 256,
  /** Other processes' records read for a guess. */
  claims: 256,
  /** Transcripts a guess reads to confirm the directory. */
  confirm: 8,
  /** Subagent transcripts listed. */
  subagents: 256,
  /** Directories a search of Codex's dated directories reads. */
  walkDirs: 5000,
  /** Entries of each cache a Resolver keeps. */
  remembered: 1024,
  /** Misses a Resolver remembers. */
  misses: 1024,
  /** A terminal's program and its descendants looked at (a wrapper
   * script, a launcher and the agent), in generations and processes. */
  depth: 3,
  candidates: 32,
} as const;

export const TIMING = {
  /** A session made this long before its process started (clock
   * granularity, the time a launcher takes) still counts as made after. */
  startSlackMs: 2000,
  /** Claude Code's record of a process is believed when its startedAt is
   * this close to the process's start (a pid reused by another process is
   * not). */
  recordSlackMs: 60_000,
  /** How long locate remembers that a session has no transcript: the
   * search that reads every dated directory of Codex's is not made again
   * meanwhile. */
  missTtlMs: 3000,
  /** How long a remembered miss is answered without looking at all; after
   * it the places a new transcript appears in are looked at again (Codex:
   * the dated directories of now and of the id's time; Claude Code, which
   * has no others: every project directory). */
  missRecheckMs: 1000,
} as const;

/** A transcript found and the session root it lies in, both resolved
 * through links, and the file found there. */
export interface Location {
  file: string;
  root: string;
  id: FileId;
}

/** The matches of a search: the most recently modified wins. */
export class Search {
  best: Location | null = null;
  private mod = -1n;
  compressed = false;

  /** Takes p, a match under root (resolved), when it resolves through
   * links to a regular file of the user's own with one name still inside
   * root. */
  async consider(files: Files, root: string, p: string): Promise<boolean> {
    if (!(await files.lstat(p))) return false;
    const real = await files.realpath(p);
    if (!real || !real.startsWith(root + '/')) return false;
    const st = await files.lstatOwn(real);
    if (!st) return false;
    if (!this.best || st.mtimeNs > this.mod) {
      this.best = { file: real, root, id: { dev: st.dev, ino: st.ino } };
      this.mod = st.mtimeNs;
    }
    return true;
  }
}

/** When a file was last written, in ms (with its fraction). */
export const mtimeOf = (st: BigIntStats): number => Number(st.mtimeNs / 1000n) / 1000;

/** The pid of a record's name, <pid>.json with the pid as Go writes a
 * number; null for any other name. */
export function recordPid(name: string): number | null {
  const m = /^([1-9]\d{0,9})\.json$/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return pid <= 0x7fffffff ? pid : null;
}

/** p cleaned as Go's path.Clean does. */
export function clean(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** Whether two directories are the same path once cleaned. */
export const samePath = (a: string, b: string): boolean => a !== '' && b !== '' && clean(a) === clean(b);

/** The non-empty strings of s, without duplicates, in order. */
export const uniq = (...s: string[]): string[] => [...new Set(s.filter((x) => x !== ''))];

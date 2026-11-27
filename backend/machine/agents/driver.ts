// Table-driven driver contract for coding agents' on-disk session detection
// and transcript location (sessions.ts). Adding a new agent format (such as
// Pi-Agent, Gemini CLI, or future Native CLI + Native UI agents) is one driver
// entry here instead of editing five switch statements across Resolver.
import type { FileHandle } from 'node:fs/promises';
import { agyInfo, agyStamp, resolveAgy, searchAgy } from './agy.ts';
import { claudeInfoOf, claudeStamp, claudeSubagents, resolveClaude, searchClaude } from './claude.ts';
import { codexStamp, codexSubagents, decodeSessionMeta, resolveCodex, searchCodex } from './codex.ts';
import { Format, LIMITS, type Found, type Info, type Location, type Proc, type Search } from './common.ts';
import { readMetadata, type FileId } from './files.ts';
import type { Resolver } from './sessions.ts';

export interface SessionSearchOptions {
  now: number;
  /** True for a full scan; false during a remembered miss to scan only
   * newly written locations (e.g. Codex dated dirs). */
  full: boolean;
  extraHomes?: readonly string[];
}

/** One coding agent transcript format's session discovery & metadata driver. */
export interface SessionDriver {
  readonly format: Format;
  resolve(r: Resolver, kind: string, p: Proc, signal: AbortSignal): Promise<Found | null>;
  stamp(r: Resolver, p: Proc, last: Found, out: string[]): Promise<void>;
  search(r: Resolver, s: Search, id: string, o: SessionSearchOptions): Promise<void>;
  describe(
    r: Resolver,
    id: string,
    openFile: () => Promise<{ fh: FileHandle; loc: Location }>,
    locate: () => Promise<Location>,
  ): Promise<Info>;
  subagents?(r: Resolver, loc: Location, id: string): Promise<Array<{ path: string; id: FileId }>>;
  /** When true, a miss remembered within missTtlMs preserves its initial `at`
   * timestamp across rechecks (Codex incremental dated-dir search). */
  readonly incrementalMissSearch?: boolean;
  /** Optional cache-key suffix when extraHomes affect search results. */
  cacheKeyExtra?(extraHomes?: readonly string[]): string;
}

const claudeDriver: SessionDriver = {
  format: Format.Claude,
  resolve: (r, kind, p, signal) => resolveClaude(r, kind, p, signal),
  stamp: (r, p, last, out) => claudeStamp(r, p, last, out),
  search: (r, s, id) => searchClaude(r, s, id),
  describe: async (_r, _id, openFile) => {
    const { fh } = await openFile();
    try {
      return await claudeInfoOf(fh);
    } finally {
      await fh.close().catch(() => {});
    }
  },
  subagents: (r, loc) => claudeSubagents(r, loc),
};

const codexDriver: SessionDriver = {
  format: Format.Codex,
  incrementalMissSearch: true,
  cacheKeyExtra: (extraHomes) => (extraHomes?.length ? `|${extraHomes.join('\0')}` : ''),
  resolve: (r, kind, p, signal) => resolveCodex(r, kind, p, signal),
  stamp: (r, p, last, out) => codexStamp(r, p, last, out),
  search: (r, s, id, o) => searchCodex(r, s, id, o.now, o.full, o.extraHomes),
  describe: async (_r, _id, openFile) => {
    const { fh } = await openFile();
    try {
      const m = await readMetadata(fh, LIMITS.metaLine, decodeSessionMeta);
      return m ? { cwd: m.cwd, started: m.started } : { cwd: '', started: null };
    } finally {
      await fh.close().catch(() => {});
    }
  },
  subagents: (r, loc, id) => codexSubagents(r, loc, id),
};

const agyDriver: SessionDriver = {
  format: Format.Agy,
  resolve: (r, kind, p, signal) => resolveAgy(r, kind, p, signal),
  stamp: (r, p, last, out) => agyStamp(r, p, last, out),
  search: (r, s, id) => searchAgy(r, s, id),
  describe: async (r, id, _openFile, locate) => {
    const loc = await locate();
    return agyInfo(r, id, loc.file);
  },
};

export const SESSION_DRIVERS: ReadonlyMap<Format, SessionDriver> = new Map<Format, SessionDriver>([
  [Format.Claude, claudeDriver],
  [Format.Codex, codexDriver],
  [Format.Agy, agyDriver],
]);

export const driverOf = (format: Format | null): SessionDriver | undefined => (format ? SESSION_DRIVERS.get(format) : undefined);

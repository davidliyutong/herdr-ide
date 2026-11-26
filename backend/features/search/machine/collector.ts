// The matches a search gathers, up to its limit.
import { excerpt, type Span } from './excerpt.ts';

/** A line with matches: line and col 1-based (col in UTF-16 code units),
 * the preview and the matches in it. */
export interface Match {
  [member: string]: unknown;
  line: number;
  col: number;
  preview: string;
  ranges: Span[] | null;
}

/** A file with matches, its path relative to the directory searched. */
export interface FileMatches {
  [member: string]: unknown;
  path: string;
  matches: Match[];
}

/** A search's result (the protocol's searchResult). */
export interface Result {
  [member: string]: unknown;
  engine: string;
  dir: string;
  files: FileMatches[];
  matchCount: number;
  truncated?: boolean;
  reason?: string;
}

export class Collector {
  readonly res: Result;
  readonly limit: number;
  private readonly byFile = new Map<string, FileMatches>();

  constructor(engine: string, limit: number) {
    this.res = { engine, dir: '', files: [], matchCount: 0 };
    this.limit = limit;
  }

  /** Whether the limit is reached. */
  get full(): boolean {
    return this.res.matchCount >= this.limit;
  }

  /** Records a line of file with the matches spans (byte offsets in
   * line); false once the limit is reached (the line's matches past it are
   * dropped). */
  add(file: string, lineNo: number, line: Uint8Array, spans: Span[]): boolean {
    if (spans.length === 0) return !this.full;
    const left = this.limit - this.res.matchCount;
    if (spans.length > left) spans = spans.slice(0, left);
    if (spans.length === 0) return false;
    const { preview, col, ranges } = excerpt(line, spans);
    let f = this.byFile.get(file);
    if (!f) {
      f = { path: file, matches: [] };
      this.byFile.set(file, f);
      this.res.files.push(f);
    }
    f.matches.push({ line: lineNo, col, preview, ranges });
    this.res.matchCount += spans.length;
    return !this.full;
  }

  /** Marks the result truncated for reason (the first reason stays). */
  stop(reason: string): void {
    if (!this.res.truncated) {
      this.res.truncated = true;
      this.res.reason = reason;
    }
  }

  /** Marks the result truncated when the limit was reached or the search
   * ran out of time. */
  finish(timedOut: boolean): void {
    if (this.full) this.stop('max_results');
    if (timedOut) this.stop('timeout');
  }
}

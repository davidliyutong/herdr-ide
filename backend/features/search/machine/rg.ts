// ripgrep: a search runs it when the machine has it (on PATH, else the
// copy a code-server installed by the agent ships), without a shell, with
// an argument vector of the agent's own (the query after "--", globs as
// --glob=<value>), no configuration file (--no-config, RIPGREP_CONFIG_PATH
// dropped) and so no preprocessor, in a session of its own whose process
// group is killed when the search ends: at its time limit, when the hub
// gives up on it, or once enough matches were read.
import { spawn } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { Fail } from '#shared/lib/fail.ts';
import { Collector, type Result } from './collector.ts';
import type { Span } from './excerpt.ts';
import { rgGlobs } from './glob.ts';
import type { Query, Stop } from './query.ts';
import { decode } from './utf8.ts';

/** ripgrep skips larger files. */
const RG_MAX_FILE_SIZE = '4M';
/** Bounds a line of ripgrep's output; a longer one (a match in a file of
 * one huge line) is skipped. */
export const MAX_RG_LINE = 16 << 20;
/** Bounds what is kept of ripgrep's errors. */
const MAX_STDERR = 64 << 10;
/** How long ripgrep's output may stay open once it exited (a descendant
 * holding it). */
const WAIT_DELAY_MS = 2000;

/** The file at dir/name when it is a regular file one may run. */
function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** name on PATH, as a shell would find it; "" when it is not there. */
export function lookPath(name: string, path = process.env.PATH ?? ''): string {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = posix.join(dir, name);
    if (executable(p)) return p;
  }
  return '';
}

/** The machine's platform among the binaries of @vscode/ripgrep-universal
 * (darwin-arm64, linux-x64…). */
export const rgPlatform = (): string => `${process.platform}-${process.arch}`;

/** The ripgrep of the newest code-server installed in home's data
 * directory (code-server ships VS Code's @vscode/ripgrep); "" for none. */
export function bundledRg(home: string): string {
  if (!home) return '';
  const root = posix.join(home, DATA_DIR_NAME, 'code-server');
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return '';
  }
  const found: string[] = [];
  for (const v of versions) {
    const modules = posix.join(root, v, 'lib', 'vscode', 'node_modules', '@vscode');
    found.push(posix.join(modules, 'ripgrep-universal', 'bin', rgPlatform(), 'rg'), posix.join(modules, 'ripgrep', 'bin', 'rg'));
  }
  found.sort().reverse();
  return found.find(executable) ?? '';
}

/** ripgrep's arguments for q: JSON output, no configuration file, hidden
 * files searched (the skipped folders are excluded by globs), links not
 * followed, the query after "--", the directory as ".". */
export function rgArgs(q: Pick<Query, 'query' | 'regex' | 'caseSensitive' | 'wholeWord' | 'includes' | 'excludes'>): string[] {
  const args = ['--json', '--no-config', '--hidden', '--max-filesize', RG_MAX_FILE_SIZE];
  args.push(q.caseSensitive ? '--case-sensitive' : '--ignore-case');
  if (!q.regex) args.push('--fixed-strings');
  if (q.wholeWord) args.push('--word-regexp');
  args.push(...rgGlobs(q.includes, q.excludes));
  return [...args, '--', q.query, '.'];
}

/** ripgrep's environment: the agent's, without a configuration file. */
export function rgEnviron(env: Record<string, string>): Record<string, string> {
  const { RIPGREP_CONFIG_PATH: _, ...rest } = env;
  return rest;
}

/** ripgrep's text: UTF-8 as text, other bytes base64-encoded. */
interface RgText {
  text?: string;
  bytes?: string;
}

const bytesOf = (t: RgText | undefined): Buffer =>
  typeof t?.text === 'string' ? Buffer.from(t.text, 'utf8') : Buffer.from(t?.bytes ?? '', 'base64');

interface RgMessage {
  type?: string;
  data?: {
    path?: RgText;
    lines?: RgText;
    line_number?: number;
    submatches?: Array<{ start?: number; end?: number }>;
  };
}

/** Adds a match message of ripgrep's to c. */
function addRg(c: Collector, m: RgMessage): void {
  const d = m.data ?? {};
  const p = bytesOf(d.path);
  let path = decode(p);
  if (path.startsWith('./')) path = path.slice(2);
  let text = bytesOf(d.lines);
  if (text.at(-1) === 0x0a) text = text.subarray(0, -1);
  if (text.at(-1) === 0x0d) text = text.subarray(0, -1);
  const spans: Span[] = [];
  for (const s of d.submatches ?? []) {
    const start = s.start ?? 0;
    const end = s.end ?? 0;
    if (start < 0 || end <= start || end > text.length + 2) continue;
    spans.push([Math.min(start, text.length), Math.min(end, text.length)]);
  }
  c.add(path, d.line_number ?? 0, text, spans);
}

/** Reads ripgrep's --json output line by line into c until it ends or c
 * is full: a line longer than maxLine is skipped. seen is whether ripgrep
 * searched anything (a begin, match or summary message). */
export class RgParser {
  seen = false;
  private parts: Buffer[] = [];
  private size = 0;
  private over = false;
  private readonly c: Collector;
  private readonly maxLine: number;

  constructor(c: Collector, maxLine = MAX_RG_LINE) {
    this.c = c;
    this.maxLine = maxLine;
  }

  /** Takes a chunk of the output; false once c is full. */
  push(chunk: Buffer): boolean {
    let at = 0;
    while (at < chunk.length && !this.c.full) {
      const nl = chunk.indexOf(0x0a, at);
      const piece = chunk.subarray(at, nl < 0 ? chunk.length : nl);
      at = nl < 0 ? chunk.length : nl + 1;
      if (!this.over) {
        if (this.size + piece.length > this.maxLine) {
          this.over = true;
          this.parts = [];
          this.size = 0;
        } else {
          this.parts.push(piece);
          this.size += piece.length;
        }
      }
      if (nl < 0) break;
      this.line();
    }
    return !this.c.full;
  }

  /** The output ended. */
  end(): void {
    if (!this.c.full) this.line();
  }

  private line(): void {
    const over = this.over;
    const b = Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.over = false;
    if (over || b.length === 0) return;
    let m: RgMessage;
    try {
      m = JSON.parse(b.toString('utf8'));
    } catch {
      return;
    }
    switch (m?.type) {
      case 'begin':
      case 'summary':
      case 'end':
        this.seen = true;
        break;
      case 'match':
        this.seen = true;
        addRg(this.c, m);
    }
  }
}

/** Searches with ripgrep at bin. */
export async function runRg(bin: string, q: Query, env: Record<string, string>, stop: Stop): Promise<Result> {
  const c = new Collector('rg', q.limit);
  const parser = new RgParser(c);
  // A session of its own: a process group to kill.
  const p = spawn(bin, rgArgs(q), { cwd: q.dir, env: rgEnviron(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let killed = false;
  const kill = () => {
    if (killed || p.pid === undefined) return;
    killed = true;
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      // ended
    }
  };
  const started = new Promise<void>((res, rej) => {
    p.once('spawn', res);
    p.once('error', rej);
  });
  try {
    await started;
  } catch (e) {
    throw new Fail('failed', 400, `ripgrep did not start: ${(e as Error).message}`);
  }
  stop.signal.addEventListener('abort', kill, { once: true });
  p.stderr.setEncoding('utf8').on('data', (s: string) => {
    if (stderr.length < MAX_STDERR) stderr += s.slice(0, MAX_STDERR - stderr.length);
  });
  p.stdout.on('data', (b: Buffer) => {
    if (!parser.push(b)) kill();
  });
  const exit = await new Promise<number | null>((resolve) => {
    let code: number | null = null;
    p.once('close', () => resolve(code));
    p.once('exit', (c) => {
      code = c;
      setTimeout(() => {
        p.stdout.destroy();
        p.stderr.destroy();
        resolve(code);
      }, WAIT_DELAY_MS).unref();
    });
    if (stop.signal.aborted) kill();
  });
  stop.signal.removeEventListener('abort', kill);
  parser.end();
  c.finish(stop.timedOut());
  if (stop.signal.aborted && !stop.timedOut()) throw new Fail('cancelled', 400, 'the search was given up');
  if (exit === 2 && !c.res.truncated && !parser.seen) {
    // Nothing searched: the query or a glob was refused.
    let msg = stderr.trim();
    if (msg.length > 2000) msg = msg.slice(0, 2000) + '…';
    throw new Fail(msg.includes('regex') ? 'bad_regex' : msg.includes('glob') ? 'bad_glob' : 'failed', 400, msg);
  }
  return c.res;
}

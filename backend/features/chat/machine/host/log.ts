// The host's log file in the instance's data directory, one for each host
// of a shared home (hostFile: chat-host-<host>.log): what the host logs,
// beside its standard error, which only its hidden terminal shows. It is
// started again once it reaches LOG_MAX bytes, the one before kept
// (chat-host.old-<host>.log); the files of other hosts nobody wrote for 30
// days go when a host opens its own. Lines are written in order by the
// runtime's pool, never on the host's thread; while the file does not take
// them, at most LOG_BACKLOG bytes of them wait, the rest is counted.
import { constants, mkdirSync } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import type { Logger } from '#shared/lib/log.ts';
import { hostFile, pruneHostFiles } from '#shared/store/index.ts';

export const LOG_NAME = 'chat-host.log';
export const OLD_LOG_NAME = 'chat-host.old.log';
export const LOG_MAX = 1 << 20;
/** The most bytes of lines that wait for the file. */
const LOG_BACKLOG = 1 << 20;

/** A line's time as Go's log.LstdFlags writes it. */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function openAppend(path: string): Promise<{ f: FileHandle; size: number }> {
  const f = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new Error('chathost: the log is not a regular file');
    await f.chmod(0o600);
    return { f, size: st.size };
  } catch (e) {
    await f.close();
    throw e;
  }
}

/** The host's log file, started again past max bytes. */
export class LogFile {
  private f: FileHandle | null;
  private size: number;
  private queue: string[] = [];
  private queued = 0;
  private dropped = 0;
  private writing: Promise<void> | null = null;
  private readonly path: string;
  private readonly old: string;
  private readonly max: number;

  private constructor(path: string, old: string, max: number, f: FileHandle, size: number) {
    this.path = path;
    this.old = old;
    this.max = max;
    this.f = f;
    this.size = size;
  }

  /** Opens the host's log file in the data directory base (0600). */
  static async open(base: string, max = LOG_MAX): Promise<LogFile> {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    for (const name of [LOG_NAME, OLD_LOG_NAME]) {
      try {
        pruneHostFiles(base, name);
      } catch {
        // the others' files stay this time
      }
    }
    const path = hostFile(base, LOG_NAME);
    const { f, size } = await openAppend(path);
    return new LogFile(path, hostFile(base, OLD_LOG_NAME), max, f, size);
  }

  /** Appends text, after starting a new file when it would take the file
   * past its bounds. */
  write(text: string): void {
    if (!this.f) return;
    const n = Buffer.byteLength(text);
    if (this.queued + n > LOG_BACKLOG) {
      this.dropped++;
      return;
    }
    this.queue.push(text);
    this.queued += n;
    this.writing ??= this.pump().finally(() => (this.writing = null));
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0 && this.f) {
      let text = this.queue.shift()!;
      this.queued -= Buffer.byteLength(text);
      if (this.dropped > 0) {
        text = `${stamp()} (${this.dropped} lines of the log were left out: the file did not take them)\n` + text;
        this.dropped = 0;
      }
      const b = Buffer.from(text, 'utf8');
      try {
        if (this.size > 0 && this.size + b.length > this.max) {
          await this.f.close();
          this.f = null;
          await rename(this.path, this.old).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') throw e;
          });
          const o = await openAppend(this.path);
          this.f = o.f;
          this.size = o.size;
        }
        await this.f!.write(b);
        this.size += b.length;
      } catch {
        // A file that fails is left; standard error still has the log.
        await this.f?.close().catch(() => {});
        this.f = null;
      }
    }
  }

  /** Writes what waits, and closes the file. */
  async close(): Promise<void> {
    while (this.writing) await this.writing;
    await this.f?.close().catch(() => {});
    this.f = null;
  }
}

/** A logger that writes each line, prefixed and stamped as Go's log does,
 * to every one of outs, whatever one of them answers: a log that goes to a
 * file and to a terminal nobody reads stops at neither. */
export function teeLogger(prefix: string, ...outs: Array<(text: string) => void>): Logger {
  return (line) => {
    const text = `${prefix}${stamp()} ${line}\n`;
    for (const out of outs) {
      try {
        out(text);
      } catch {
        // the others still get it
      }
    }
  };
}

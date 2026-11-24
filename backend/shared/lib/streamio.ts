// Pull-style reading of a Node stream, for protocols that read a header
// (a JSON line, a length, a body) and then hand the rest of the stream on
// untouched, as Go's protocols read headers byte by byte to leave the
// following bytes in the stream. What was read past the header stays in the
// Reader and comes first from the stream release() returns.
import { PassThrough, type Readable, type Writable } from 'node:stream';

export class EOFError extends Error {
  readonly unexpected;

  constructor(unexpected = false) {
    super(unexpected ? 'unexpected EOF' : 'EOF');
    this.unexpected = unexpected;
  }
}

export class Reader {
  private ended = false;
  private failed?: Error;
  private pending: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private readonly wake = () => {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  };
  private readonly onEnd = () => {
    this.ended = true;
    this.wake();
  };
  private readonly onError = (e: Error) => {
    this.failed = e;
    this.wake();
  };

  readonly stream: Readable;

  constructor(stream: Readable) {
    this.stream = stream;
    // A 'readable' listener puts the stream in paused mode by itself; an
    // explicit pause() first would keep Bun's process.stdin from reading.
    stream.on('readable', this.wake).on('end', this.onEnd).on('close', this.onEnd).on('error', this.onError);
  }

  /** Stops reading and returns the rest of the stream for other code: the
   * stream itself when nothing was read ahead, else a stream of what was
   * read ahead followed by the stream's own data. ('data' listeners and
   * pipes see nothing while the Reader's 'readable' listener is attached.) */
  release(): Readable {
    this.stream.off('readable', this.wake).off('end', this.onEnd).off('close', this.onEnd).off('error', this.onError);
    if (!this.pending.length) return this.stream;
    const out = new PassThrough();
    for (const b of this.pending) out.write(b);
    this.pending = [];
    if (this.ended || this.stream.readableEnded) out.end();
    else {
      this.stream.pipe(out);
      this.stream.once('error', (e) => out.destroy(e));
    }
    return out;
  }

  /** Gives bytes back: the next read starts with them. */
  unread(b: Buffer): void {
    if (b.length) this.pending.unshift(b);
  }

  private waitMore(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  /** The next bytes the stream has, at most max; null at its end. */
  async chunk(max = Infinity): Promise<Buffer | null> {
    for (;;) {
      const b: Buffer | null = this.pending.length ? this.pending.shift()! : this.stream.read();
      if (b !== null) {
        if (b.length > max) {
          this.unread(b.subarray(max));
          return b.subarray(0, max);
        }
        return b;
      }
      if (this.failed) throw this.failed;
      if (this.ended || this.stream.readableEnded || this.stream.destroyed) return null;
      await this.waitMore();
    }
  }

  /** Exactly n bytes; EOFError when the stream ends first. */
  async exactly(n: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < n) {
      const b = await this.chunk(n - got);
      if (b === null) throw new EOFError(true);
      parts.push(b);
      got += b.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, n);
  }

  /** One line without its newline, at most max bytes; at the end of the
   * stream, what is left if anything (EOFError when nothing is). */
  async line(max: number): Promise<string> {
    const parts: Buffer[] = [];
    let got = 0;
    for (;;) {
      const b = await this.chunk();
      if (b === null) {
        if (got === 0) throw new EOFError();
        return Buffer.concat(parts).toString('utf8');
      }
      const i = b.indexOf(10);
      if (i >= 0) {
        this.unread(b.subarray(i + 1));
        parts.push(b.subarray(0, i));
        got += i;
        if (got > max) throw new Error('line too long');
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(b);
      got += b.length;
      if (got > max) throw new Error('line too long');
    }
  }
}

/** Writes and waits while the stream is backed up. */
export async function write(w: Writable, b: Buffer | Uint8Array | string): Promise<void> {
  if (!w.write(b))
    await new Promise<void>((resolve, reject) => {
      const done = (e?: Error) => {
        w.off('drain', done).off('error', done).off('close', closed);
        if (e) reject(e);
        else resolve();
      };
      const closed = () => done(new Error('stream closed'));
      w.once('drain', done).once('error', done).once('close', closed);
    });
}

/** Writes v as one JSON line. */
export function writeLine(w: Writable, v: unknown): Promise<void> {
  return write(w, JSON.stringify(v) + '\n');
}

/** Ends a writable side and waits until it is flushed. */
export function end(w: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    if (w.writableFinished) return resolve();
    w.once('error', reject);
    w.end(() => resolve());
  });
}

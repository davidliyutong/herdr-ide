// Bodies between HTTP and an agent's stream, without holding a file in
// memory: what the agent sends after its reply as a response body (a
// file's bytes, an archive's chunks), read as fast as the client takes it,
// and a request's body sent to the agent as chunks.
import { ChunkReader, ChunkWriter, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';

/** How a body ended: all of it went out, the client went away, or it was
 * broken off while the client was there (a cancel, the machine went
 * away). */
export type Ending = 'complete' | 'gone' | 'broken';

/** What a transfer is told and tells. */
export interface Transfer {
  /** The client's request: aborted when it goes away. */
  readonly request: AbortSignal;
  /** Aborted to break the transfer off while the client is still there
   * (the downloads panel). */
  readonly cancelled?: AbortSignal;
  /** Bytes of the body as they go out. */
  sent?(n: number): void;
  /** Why the transfer failed, as the downloads panel names it; the first
   * reason counts. */
  fail?(code: string): void;
  /** How the answer ended, once. An answer without a body from the agent
   * (an error, a HEAD) ends as complete or broken right away. */
  ended?(how: Ending): void;
}

/** Ends a response unfinished: the host drops the connection without the
 * body's end (its response is a breakableResponse), so the client sees a
 * failed transfer rather than a complete one that is short (an archive has
 * no length to check). No reason: Bun prints the reason of a response
 * body's error as an uncaught error. */
function breakOff(c: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    c.error();
  } catch {
    // closed already
  }
}

/** The bytes the agent sends after its reply on conn as a response body:
 * length bytes (fs.read), or ChunkWriter chunks up to their end marker
 * (fs.archive with chunked). The agent's stream is read only as the client
 * takes the body, which holds the agent back meanwhile. A client that goes
 * away, or a cancel, resets the stream, which ends the agent's read or
 * walk; a stream that ends before the body does (the machine went away)
 * breaks the body off. */
export function agentBody(conn: AgentStream, src: { length: number } | 'chunked', t: Transfer): ReadableStream<Uint8Array> {
  const frames = src === 'chunked' ? new ChunkReader(conn.reader) : undefined;
  let left = src === 'chunked' ? Infinity : src.length;
  let over = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const end = (how: Ending): boolean => {
    if (over) return false;
    over = true;
    t.request.removeEventListener('abort', gone);
    t.cancelled?.removeEventListener('abort', cancel);
    if (how === 'complete') {
      conn.reader.release();
      closeStream(conn.stream);
    } else conn.stream.destroy();
    t.ended?.(how);
    return true;
  };
  const gone = () => void end('gone');
  const cancel = () => {
    if (end('broken') && ctrl) breakOff(ctrl);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        ctrl = c;
        if (t.request.aborted) return gone();
        if (t.cancelled?.aborted) return cancel();
        t.request.addEventListener('abort', gone, { once: true });
        t.cancelled?.addEventListener('abort', cancel, { once: true });
      },
      async pull(c) {
        if (over) return;
        let b: Buffer | null | undefined;
        try {
          b = frames ? await frames.read() : left > 0 ? await conn.reader.chunk(left) : null;
        } catch {
          b = undefined; // the stream broke, or ended within a chunk
        }
        if (over) return; // ended meanwhile
        if (b === null && (frames || left === 0)) {
          end('complete');
          return c.close();
        }
        if (!b) {
          end('broken');
          return breakOff(c);
        }
        left -= b.length;
        t.sent?.(b.length);
        c.enqueue(b);
        if (left === 0) {
          end('complete');
          c.close();
        }
      },
      cancel() {
        end('gone');
      },
    },
    { highWaterMark: 0 },
  );
}

/** Sends a body to the agent on conn as ChunkWriter chunks: bytes, or a
 * request's body as it arrives, at most limit bytes of it (what follows is
 * not read). Then the end marker, and returns the line the agent answers
 * with; conn is closed. A body that breaks off (the client went away) is
 * not ended with the marker, so the agent keeps nothing of it: the error is
 * thrown. */
export async function sendChunks(conn: AgentStream, req: Request | Uint8Array, limit: number): Promise<Reply> {
  const cw = new ChunkWriter(conn.stream);
  const put = (b: Uint8Array) => cw.write(b);
  try {
    if (req instanceof Uint8Array) await put(req.subarray(0, limit));
    else if (req.body) {
      const declared = req.headers.has('Content-Length') ? Number(req.headers.get('Content-Length')) : -1;
      const r = req.body.getReader();
      let n = 0;
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        const take = Math.min(value.length, limit - n);
        if (take > 0) await put(value.subarray(0, take));
        n += take;
        if (n >= limit) {
          void r.cancel().catch(() => {});
          break;
        }
      }
      // A host that ends the body of a request whose client went away.
      if (req.signal.aborted || (declared >= 0 && n < Math.min(declared, limit))) throw new Error('unexpected EOF');
    }
    await cw.finish();
    return await readLine<Reply>(conn.reader);
  } finally {
    conn.reader.release();
    closeStream(conn.stream);
  }
}

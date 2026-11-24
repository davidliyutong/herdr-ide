import { expect, test } from 'bun:test';
import { abortable } from './abortable.ts';

/** A body of 64 KiB chunks at full speed that errors after n of them. */
const breaking = (n: number) => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i++ < n) c.enqueue(new Uint8Array(64 << 10));
      else c.error();
    },
  });
};

/** Reads the whole body; whether the transfer failed (within the bound). */
async function failed(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  try {
    await res.arrayBuffer();
    return false;
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error('the client was left waiting');
    return true;
  }
}

test('a body that breaks off fails the transfer instead of leaving the client waiting', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 0, fetch: () => abortable(new Response(breaking(200))) });
  try {
    for (let i = 0; i < 5; i++) expect(await failed(`http://127.0.0.1:${server.port}/`)).toBe(true);
  } finally {
    void server.stop(true);
  }
}, 40_000);

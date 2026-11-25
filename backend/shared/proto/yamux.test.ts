import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INITIAL_WINDOW, Session, Stream } from './yamux.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { extended } from '#shared/testdata/extended.ts';

// xorshift32: a pattern both ends compute.
function* pattern(n: number, seed: number, size = 64 * 1024): Generator<Buffer> {
  let s = (Math.imul(seed >>> 0, 2654435761) | 1) >>> 0;
  for (let left = n; left > 0;) {
    const m = Math.min(size, left);
    const b = Buffer.allocUnsafe(m);
    for (let i = 0; i < m; i++) {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >>> 17)) >>> 0;
      s = (s ^ (s << 5)) >>> 0;
      b[i] = s & 0xff;
    }
    left -= m;
    yield b;
  }
}
const digest = (parts: Iterable<Buffer>) => {
  const h = createHash('sha256');
  let n = 0;
  for (const b of parts) {
    h.update(b);
    n += b.length;
  }
  return `${n} ${h.digest('hex')}`;
};

async function writeAll(s: Stream, parts: Iterable<Buffer>) {
  for (const b of parts) if (!s.write(b)) await new Promise((r) => s.once('drain', r));
}
/** Everything until the other end's FIN, keeping the stream writable: a
 * for-await loop would destroy the stream once it ends, which resets a
 * half-closed one (Node's destroyOnReturn). */
function readAll(s: Stream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    s.on('data', (c: Buffer) => out.push(c))
      .once('end', () => resolve(Buffer.concat(out)))
      .once('error', reject);
    s.resume();
  });
}
/** The first line of a stream, and what came after it; the stream stays
 * open and paused (leaving a for-await loop early would destroy it). */
function readLine(s: Stream): Promise<[string, Buffer]> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const done = (line: string, rest: Buffer) => {
      s.off('data', data).off('end', end).off('error', reject);
      s.pause();
      resolve([line, rest]);
    };
    const data = (c: Buffer) => {
      acc = Buffer.concat([acc, c]);
      const i = acc.indexOf(10);
      if (i >= 0) done(acc.subarray(0, i).toString(), acc.subarray(i + 1));
    };
    const end = () => done(acc.toString(), Buffer.alloc(0));
    s.on('data', data).once('end', end).once('error', reject);
  });
}

/** Answers the client's commands (echo, sink, source). */
async function serve(s: Stream) {
  const [line, rest] = await readLine(s);
  const f = line.trim().split(/\s+/);
  if (f[0] === 'echo') {
    if (rest.length) s.write(rest);
    s.pipe(s);
  } else if (f[0] === 'sink') {
    const all = Buffer.concat([rest, await readAll(s)]);
    s.end(`${digest([all])}\n`);
  } else if (f[0] === 'source') {
    await writeAll(s, pattern(Number(f[1]), Number(f[2])));
    s.end();
  }
}
function serveAll(sess: Session) {
  (async () => {
    for (;;) {
      let s: Stream;
      try {
        s = await sess.accept();
      } catch {
        return;
      }
      serve(s).catch(() => s.destroy());
    }
  })();
}

/** The client's checks, against a server. */
async function exercise(sess: Session, size: number) {
  const echoes = await Promise.all(
    Array.from({ length: 32 }, async (_, i) => {
      const s = await sess.open();
      const n = Math.floor((size * (i + 1)) / 32);
      s.write('echo\n');
      const got = readAll(s);
      await writeAll(s, pattern(n, i));
      s.end();
      return digest([await got]) === digest(pattern(n, i));
    }),
  );
  expect(echoes.every(Boolean)).toBe(true);

  let s = await sess.open();
  s.write('sink\n');
  const answer = readLine(s);
  await writeAll(s, pattern(size, 7));
  s.end(); // a half-close: the answer still arrives
  expect((await answer)[0]).toBe(digest(pattern(size, 7)));

  s = await sess.open();
  s.end(`source ${size} 9\n`);
  expect(digest([await readAll(s)])).toBe(digest(pattern(size, 9)));

  expect(await sess.ping()).toBeGreaterThanOrEqual(0);
}

const dir = mkdtempSync(join(tmpdir(), 'yamux-'));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A client session to a TypeScript server over a unix socket. */
async function pair(serverConfig = {}, clientConfig = {}): Promise<[Session, Session]> {
  const path = join(dir, `s${servers.length}`);
  let server!: Session;
  const srv = createServer((c) => {
    server = new Session(c, false, serverConfig);
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(path, r));
  const c = connect(path);
  await new Promise((r) => c.once('connect', r));
  const client = new Session(c, true, clientConfig);
  while (!server) await Bun.sleep(1);
  return [client, server];
}

describe('TypeScript to TypeScript', () => {
  test('a reader that takes the whole buffer at once keeps the window open', async () => {
    // Reader.exactly reads with read() and no size: it takes everything
    // buffered, a full window's worth, after Node already called _read.
    const [client, server] = await pair();
    const s = await client.open();
    const accepted = await server.accept();
    const n = 3_000_000;
    const sent = Buffer.alloc(n, 7);
    s.end(sent);
    const got = await new Reader(accepted).exactly(n);
    expect(got.equals(sent)).toBe(true);
    client.close();
  }, 10_000);

  // Some 150 MiB of patterns made and digested byte by byte.
  extended(
    'echo, half-close, source',
    async () => {
      const [client, server] = await pair();
      serveAll(server);
      await exercise(client, 4 << 20);
      client.close();
    },
    60_000,
  );

  extended('a sender stops at the window until the reader reads', async () => {
    const [client, server] = await pair();
    const s = await client.open();
    const accepted = await server.accept();
    accepted.pause();
    let written = 0;
    const chunk = Buffer.alloc(64 * 1024);
    const writing = (async () => {
      for (let i = 0; i < 64; i++) {
        if (!s.write(chunk)) await new Promise((r) => s.once('drain', r));
        written += chunk.length;
      }
    })();
    await Bun.sleep(1000);
    // the window the server grew to (1 MiB) plus what the writable buffers
    expect(written).toBeLessThan(4 << 20);
    expect(written).toBeGreaterThanOrEqual(INITIAL_WINDOW);
    accepted.resume();
    await writing;
    expect(written).toBe(4 << 20);
    client.close();
  });

  test('a destroyed stream resets the other end', async () => {
    const [client, server] = await pair();
    const s = await client.open();
    s.write('x');
    const accepted = await server.accept();
    const err = new Promise<Error>((r) => accepted.once('error', r));
    s.destroy();
    expect(((await err) as NodeJS.ErrnoException).code).toBe('ECONNRESET');
    client.close();
  });

  test('streams beyond the backlog are refused', async () => {
    const [client] = await pair({ acceptBacklog: 2 });
    const streams = await Promise.all([client.open(), client.open(), client.open()]);
    const err = new Promise<Error>((r) => streams[2].once('error', r));
    streams[2].write('x');
    expect(((await err) as NodeJS.ErrnoException).code).toBe('ECONNRESET');
    client.close();
  });

  test('closing the session ends the streams and fails new ones', async () => {
    const [client, server] = await pair();
    const s = await client.open();
    s.write('hi');
    const accepted = await server.accept();
    const reading = readAll(accepted);
    client.close();
    expect((await reading).toString()).toBe('hi');
    expect(client.open()).rejects.toThrow('session shutdown');
  });

  test('an unanswered keepalive closes the session', async () => {
    const path = join(dir, 'silent');
    const srv = createServer(() => {}); // accepts and never answers
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(path, r));
    const c = connect(path);
    await new Promise((r) => c.once('connect', r));
    const sess = new Session(c, true, { keepAliveMs: 20, writeTimeoutMs: 50 });
    const closed = await new Promise<Error | undefined>((r) => sess.onClose(r));
    expect(closed?.message).toBe('keepalive timeout');
  });
});

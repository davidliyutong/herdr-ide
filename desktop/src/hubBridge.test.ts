// The bridge between the main process and the hub process
// (backend/hosts/desktop/bridge.ts), with worker_threads' MessagePorts
// standing in for Electron's: requests and their bodies, with credit both
// ways, failures and cancels; channels, with their opening, messages,
// acks and closes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import {
  ABNORMAL,
  ACK_BYTES,
  MAX_MESSAGE,
  TOO_BIG,
  channelClient,
  nodePort,
  request,
  serveChannel,
  serveRequest,
  WINDOW,
  type HubChannel,
  type RequestHead,
  type Upgrade,
} from '../../backend/hosts/desktop/bridge';
import { extended } from './extended';

/** A MessageChannel whose ports do not keep the test's process alive. */
function pair() {
  const c = new MessageChannel();
  c.port1.unref();
  c.port2.unref();
  return c;
}

const head = (o: Partial<RequestHead> = {}): RequestHead => ({
  method: 'GET',
  url: 'https://app.localhost/x',
  headers: [],
  body: false,
  ...o,
});

/** A request through the bridge to handle, as the hub would answer it. */
function roundTrip(
  h: RequestHead,
  handle: (req: Request) => Promise<Response>,
  body: ReadableStream<Uint8Array> | null = null,
  signal?: AbortSignal,
) {
  const { port1, port2 } = pair();
  const served = serveRequest(nodePort(port2), h, handle);
  return { response: request(nodePort(port1), h, body, signal), served };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const chunks = (n: number, size = 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size).fill(i));
      c.close();
    },
  });

test('a request and its answer: method, URL, headers, status, Set-Cookie lines one by one', async () => {
  let got: Request | undefined;
  const { response } = roundTrip(
    head({ method: 'POST', headers: [['x-a', '1']], body: true }),
    async (req) => {
      got = req;
      const h = new Headers({ 'content-type': 'text/plain' });
      h.append('set-cookie', 'a=1');
      h.append('set-cookie', 'b=2');
      return new Response(`got ${await req.text()}`, { status: 201, statusText: 'Made', headers: h });
    },
    new Blob(['hi']).stream(),
  );
  const res = await response;
  assert.equal(got?.method, 'POST');
  assert.equal(got?.url, 'https://app.localhost/x');
  assert.equal(got?.headers.get('x-a'), '1');
  assert.equal(res.status, 201);
  assert.equal(res.statusText, 'Made');
  assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.equal(await res.text(), 'got hi');
});

test('no body for HEAD, 204 and 304', async () => {
  for (const [method, status] of [
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 304],
  ] as const) {
    const { response } = roundTrip(head({ method }), async () => new Response(status === 200 ? 'x' : null, { status }));
    const res = await response;
    assert.equal(res.status, status);
    assert.equal(res.body, null);
  }
});

test('a body goes no further ahead than the window while its reader stalls', async () => {
  let pulled = 0;
  const big = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1000));
      if (pulled === 100) c.close();
    },
  });
  const { response } = roundTrip(head(), async () => new Response(big));
  const res = await response;
  await new Promise((r) => setTimeout(r, 50));
  // The window in flight, half of it queued for the reader, and what the
  // hub's stream pulled ahead.
  assert.ok(pulled <= WINDOW + WINDOW / 2 + 2, `pulled ${pulled}`);
  assert.equal((await res.arrayBuffer()).byteLength, 100_000);
});

test('an upload streams in chunks, and the hub reads it as it comes', async () => {
  const { response } = roundTrip(
    head({ method: 'PUT', body: true }),
    async (req) => new Response(String((await req.arrayBuffer()).byteLength)),
    chunks(50, 64 << 10),
  );
  assert.equal(await (await response).text(), String(50 * (64 << 10)));
});

test('an answer that breaks off fails the response body; a handler that throws answers 500', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
      c.error(new Error('the machine is gone'));
    },
  });
  const res = await roundTrip(head(), async () => new Response(broken)).response;
  await assert.rejects(res.arrayBuffer(), /the machine is gone/);
  const failed = await roundTrip(head(), async () => {
    throw new Error('bug');
  }).response;
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'internal', message: 'bug' });
});

test("the client's cancel reaches the hub: its request's signal aborts", async () => {
  let aborted = false;
  const give = new AbortController();
  const { response } = roundTrip(
    head(),
    (req) =>
      new Promise((resolve) =>
        req.signal.addEventListener('abort', () => {
          aborted = true;
          resolve(new Response('late'));
        }),
      ),
    null,
    give.signal,
  );
  give.abort();
  await assert.rejects(response, /aborted/);
  await until(() => aborted);
  // A response body the client stops reading is cancelled in the hub.
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull: (c) => c.enqueue(new Uint8Array(100)),
    cancel: () => {
      cancelled = true;
    },
  });
  const res = await roundTrip(head(), async () => new Response(endless)).response;
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  await until(() => cancelled);
});

test('a hub that goes away fails what is in flight', async () => {
  const { port1, port2 } = pair();
  const pending = request(nodePort(port1), head(), null);
  port2.close();
  await assert.rejects(pending, /the hub is gone/);
});

/** A channel served by behave, and its client. */
function channel(behave: (req: Request, upgrade: Upgrade) => Promise<Response>, opts?: { maxMessage?: number }) {
  const { port1, port2 } = pair();
  void serveChannel(nodePort(port2), { url: 'https://app.localhost/ws', headers: [['origin', 'https://app.localhost']] }, behave, opts);
  const got: Array<string | Uint8Array> = [];
  const ends: Array<[number, string]> = [];
  let opened = false;
  const client = channelClient(nodePort(port1), {
    open: () => (opened = true),
    message: (d) => got.push(d),
    close: (code, reason) => ends.push([code, reason]),
  });
  return { client, got, ends, opened: () => opened, hub: port2 };
}

/** A hub whose channel echoes and records. */
function echo() {
  const seen = { ch: undefined as HubChannel | undefined, closes: [] as Array<[number, string]>, drains: 0, origin: '' };
  const behave = async (req: Request, upgrade: Upgrade) => {
    seen.origin = req.headers.get('origin') ?? '';
    return upgrade((ch) => {
      seen.ch = ch;
      return {
        message: (d) => (d === 'bye' ? ch.close(4001, 'done') : ch.send(d)),
        close: (code, reason) => seen.closes.push([code, reason]),
        drain: () => seen.drains++,
      };
    });
  };
  return { seen, behave };
}

test('a channel opens, carries text and bytes in order, and counts what the client has not taken in', async () => {
  const hub = echo();
  const c = channel(hub.behave);
  await until(c.opened);
  assert.equal(hub.seen.origin, 'https://app.localhost');
  c.client.send('one');
  c.client.send(new Uint8Array([1, 2]));
  c.client.send('three');
  await until(() => c.got.length === 3);
  assert.deepEqual(c.got, ['one', new Uint8Array([1, 2]), 'three']);
  // Small messages are acked at the client's next turn.
  await until(() => hub.seen.ch!.buffered === 0);
  hub.seen.ch!.send(new Uint8Array(ACK_BYTES));
  assert.equal(hub.seen.ch!.buffered, ACK_BYTES);
  await until(() => hub.seen.ch!.buffered === 0);
  assert.ok(hub.seen.drains > 0);
  c.client.close();
  await until(() => c.ends.length === 1);
});

test("closes: the hub's with its code, the client's answered, a lost port abnormal", async () => {
  const a = echo();
  const one = channel(a.behave);
  await until(one.opened);
  one.client.send('bye');
  await until(() => one.ends.length === 1);
  assert.deepEqual(one.ends, [[4001, 'done']]);
  assert.deepEqual(a.seen.closes, [[4001, 'done']]);

  const b = echo();
  const two = channel(b.behave);
  await until(two.opened);
  two.client.close(1000, 'leaving');
  await until(() => two.ends.length === 1 && b.seen.closes.length === 1);
  assert.deepEqual(b.seen.closes, [[1000, 'leaving']]);

  const c = echo();
  const three = channel(c.behave);
  await until(three.opened);
  three.hub.close();
  await until(() => three.ends.length === 1 && c.seen.closes.length === 1);
  assert.deepEqual(three.ends, [[ABNORMAL, '']]);
  assert.deepEqual(c.seen.closes, [[ABNORMAL, '']]);
});

test('a channel the hub answers without upgrading is refused with its status and code', async () => {
  const c = channel(async () => Response.json({ error: 'origin_not_allowed' }, { status: 403 }));
  await until(() => c.ends.length === 1);
  assert.equal(c.opened(), false);
  assert.deepEqual(c.ends, [[ABNORMAL, 'refused 403 origin_not_allowed']]);
});

test("a channel the hub cannot take, or whose handler throws, ends as the server's failure", async () => {
  const failing = channel(async (_req, upgrade) =>
    upgrade(() => {
      throw new Error('posix_spawnp failed.');
    }),
  );
  await until(() => failing.ends.length === 1);
  assert.equal(failing.opened(), false);
  assert.deepEqual(failing.ends, [[1011, 'posix_spawnp failed.']]);
  const throwing = channel(async (_req, upgrade) =>
    upgrade(() => ({
      message: () => {
        throw new Error('bug');
      },
    })),
  );
  await until(throwing.opened);
  throwing.client.send('x');
  await until(() => throwing.ends.length === 1);
  assert.deepEqual(throwing.ends, [[1011, 'internal error']]);
});

test('a close handler that throws ends its channel only', async () => {
  let thrown = 0;
  const onError = () => thrown++;
  process.on('uncaughtException', onError);
  try {
    const c = channel(async (_req, upgrade) =>
      upgrade(() => ({
        message: () => {},
        close: () => {
          throw new Error('bug');
        },
      })),
    );
    await until(c.opened);
    c.client.close(1000, 'leaving');
    await until(() => c.ends.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(thrown, 0);
    assert.deepEqual(c.ends, [[1000, 'leaving']]);
  } finally {
    process.off('uncaughtException', onError);
  }
});

test("a client's message above maxMessage ends its channel as too big, also before the hub took it", async () => {
  const limit = 4096;
  const a = echo();
  const open = channel(a.behave, { maxMessage: limit });
  await until(open.opened);
  open.client.send(new Uint8Array(limit + 1));
  await until(() => open.ends.length === 1);
  assert.deepEqual(open.ends, [[TOO_BIG, 'message too big']]);
  assert.deepEqual(a.seen.closes, [[TOO_BIG, 'message too big']]);

  // Sent while the hub still decides: the channel opens, then ends. The
  // hub decides once both came (its port counts them).
  const b = echo();
  const { port1, port2 } = pair();
  let arrived = 0;
  const inner = nodePort(port2);
  const counting: typeof inner = {
    post: (m) => inner.post(m),
    close: () => inner.close(),
    listen: (message, closed) =>
      inner.listen((m) => {
        arrived++;
        message(m);
      }, closed),
  };
  const ends: Array<[number, string]> = [];
  void serveChannel(
    counting,
    { url: 'https://app.localhost/ws', headers: [] },
    async (req, upgrade) => {
      await until(() => arrived === 2, 10_000);
      return b.behave(req, upgrade);
    },
    { maxMessage: limit },
  );
  const early = nodePort(port1);
  early.listen(
    (m) => {
      const c = m as { t?: string; code?: number; reason?: string } | null;
      if (c?.t === 'close') ends.push([c.code!, c.reason!]);
    },
    () => {},
  );
  early.post(new Uint8Array(limit / 2 + 1));
  early.post(new Uint8Array(limit / 2 + 1));
  await until(() => ends.length === 1, 10_000);
  early.close();
  assert.deepEqual(ends, [[TOO_BIG, 'message too big']]);
});

extended("a client's message above the default 64 MiB MAX_MESSAGE ends its channel as too big", async () => {
  const a = echo();
  const open = channel(a.behave);
  await until(open.opened);
  open.client.send(new Uint8Array(MAX_MESSAGE + 1));
  await until(() => open.ends.length === 1, 10_000);
  assert.deepEqual(open.ends, [[TOO_BIG, 'message too big']]);
  assert.deepEqual(a.seen.closes, [[TOO_BIG, 'message too big']]);
});

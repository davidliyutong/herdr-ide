// The desktop app's host of the hub: both over MessagePorts and over the
// stdio multiplex (muxParent / muxChild) used by `<slug> desktop`, what
// the hub makes of the app's requests (the desktop client, on the hub's
// host, from the app's origin), and what it checks of its start.
import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import { SLUG } from '#shared/lib/brand.ts';
import { extended } from '#shared/testdata/extended.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { breakableResponse } from '#kernel/http/breakable.ts';
import { testHub, waitFor } from '#kernel/testing.ts';
import type { Composed } from '#hosts/common/compose.ts';
import {
  ABNORMAL,
  MAX_MESSAGE,
  TOO_BIG,
  channelClient,
  nodePort,
  pipePort,
  request,
  type HubStart,
  type FromHub,
  type Port,
  type RequestHead,
} from './bridge.ts';
import { startProblem } from './check.ts';
import { muxChild, muxParent } from './mux.ts';
import { serveParent } from './serve.ts';

const ORIGIN = `https://${SLUG}.localhost`;

/** A feature with what the tests ask of the hub. */
const probe = defineFeature({
  id: 'probe',
  toggle: false,
  setup(ctx) {
    ctx.api.get('/who', (c) => c.json({ client: c.var.client, sameHost: c.var.sameHost, trustedOrigin: c.var.trustedOrigin }));
    ctx.api.get('/empty', () => new Response(null, { status: 200 }));
    ctx.api.post('/echo', async (c) => c.body(await c.req.arrayBuffer()));
    ctx.api.get('/broken', () => {
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new Uint8Array(1000));
          ctl.error(new Error('the machine is gone'));
        },
      });
      return breakableResponse(body);
    });
    ctx.api.get('/hold', async (c) => {
      await new Promise<void>((r) => c.req.raw.signal.addEventListener('abort', () => r(), { once: true }));
      held.aborted = true;
      throw new Fail('gone', 499);
    });
    ctx.api.get('/ch', (c) => {
      if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
      return c.env.upgrade((ch) => ({
        message: (d) => {
          if (d === 'close') return ch.close(4000, 'asked');
          if (d === 'buffered') return ch.send(String(ch.buffered));
          if (d === 'hub-oversize') return ch.send(new Uint8Array(16_384));
          ch.send(d);
        },
        close: (code, reason) => closed.push([code, reason]),
      }));
    });
  },
});
const held = { aborted: false };
const closed: Array<[number, string]> = [];

/** Runs serveParent over the real binary stdio mux (PassThrough pipes),
 * matching `<slug> desktop` and Electron's main process. */
function stdioHost(opts: { maxMessage?: number; maxFrame?: number; onParentDisconnect?: () => void } = {}) {
  const tc = testHub({ features: [probe], guard: { allowedOrigins: [ORIGIN] } });
  const toChild = new PassThrough();
  const fromChild = new PassThrough();
  const replies: FromHub[] = [];
  const exits: number[] = [];
  let stopped: Promise<void> | undefined;
  const stop = new AbortController();

  const child = muxChild(
    toChild,
    fromChild,
    () => {
      if (!stop.signal.aborted) stop.abort();
    },
    { maxMessage: opts.maxMessage, maxFrame: opts.maxFrame },
  );
  serveParent<Port>(child, {
    start: (): Composed => ({
      hub: tc.hub,
      settings: undefined as never,
      specs: [],
      run: (signal) => (stopped = new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })))),
    }),
    port: (p) => p,
    logger: () => {},
    exit: (code) => void exits.push(code),
    stop,
    maxMessage: opts.maxMessage,
  });

  const parent = muxParent(fromChild, toChild, {
    onDisconnect: opts.onParentDisconnect,
    maxMessage: opts.maxMessage,
    maxFrame: opts.maxFrame,
  });
  parent.onMessage((m) => replies.push(m));

  return {
    parent,
    replies,
    exits,
    toChild,
    fromChild,
    stopped: () => stopped,
    start: async () => {
      parent.send({ t: 'start', start: {} as HubStart });
      await waitFor('ready', () => replies.length > 0);
    },
    stop: () => parent.send({ t: 'stop' }),
    fetch(
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal } = {},
    ) {
      const head: RequestHead = {
        method: init.method ?? 'GET',
        url: ORIGIN + path,
        headers: Object.entries({ host: `${SLUG}.localhost`, ...init.headers }),
        body: !!init.body,
      };
      const vport = parent.send({ t: 'request', head }, true)!;
      return request(vport, head, init.body ?? null, init.signal);
    },
    channel(path: string, origin = ORIGIN) {
      const { port1, port2 } = new MessageChannel();
      port1.unref();
      port2.unref();
      const vport = parent.send(
        {
          t: 'channel',
          head: {
            url: ORIGIN + path,
            headers: [
              ['host', `${SLUG}.localhost`],
              ['origin', origin],
              ['upgrade', 'websocket'],
              ['connection', 'Upgrade'],
            ],
          },
        },
        true,
      )!;
      pipePort(nodePort(port2), vport);
      const got: Array<string | Uint8Array> = [];
      const ends: Array<[number, string]> = [];
      let opened = false;
      const client = channelClient(nodePort(port1), {
        open: () => (opened = true),
        message: (d) => got.push(d),
        close: (code, reason) => ends.push([code, reason]),
      });
      return { client, got, ends, opened: () => opened };
    },
  };
}

const sameOrigin = { 'sec-fetch-site': 'same-origin' };

describe('requests of the app over stdio mux', () => {
  test('are the desktop client, on the hub host, of a trusted origin', async () => {
    const u = stdioHost();
    await u.start();
    expect(u.replies).toEqual([{ t: 'ready' }]);
    const res = await u.fetch('/api/p/probe/who', { headers: sameOrigin });
    expect(await res.json()).toEqual({ client: 'desktop', sameHost: true, trustedOrigin: ORIGIN });
  });

  test('the guard refuses another origin', async () => {
    const u = stdioHost();
    await u.start();
    const res = await u.fetch('/api/p/probe/echo', { method: 'POST', headers: { origin: 'https://evil.example' }, body: null });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('origin_not_allowed');
  });

  test('a body streams both ways', async () => {
    const u = stdioHost();
    await u.start();
    const chunks = 40;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(64 << 10).fill(i));
        c.close();
      },
    });
    const res = await u.fetch('/api/p/probe/echo', { method: 'POST', headers: { origin: ORIGIN }, body });
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(chunks * (64 << 10));
    expect(got[(64 << 10) * 7 + 5]).toBe(7);
  });

  test('an empty 200 response ends its body', async () => {
    const u = stdioHost();
    await u.start();
    const res = await u.fetch('/api/p/probe/empty');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    u.stop();
  });

  test('a response that breaks off fails, not ends short', async () => {
    const u = stdioHost();
    await u.start();
    const res = await u.fetch('/api/p/probe/broken');
    expect(res.status).toBe(200);
    const failed = await res.arrayBuffer().then(
      () => '',
      (e: Error) => e.message,
    );
    expect(failed).toBe('the machine is gone');
  });

  test('a request the client gives up aborts in the hub', async () => {
    const u = stdioHost();
    await u.start();
    held.aborted = false;
    const give = new AbortController();
    const res = u.fetch('/api/p/probe/hold', { signal: give.signal });
    await Bun.sleep(20);
    give.abort();
    await expect(res).rejects.toThrow('aborted');
    await waitFor('the hub to see the abort', () => held.aborted);
  });

  test('before the hub started: 503', async () => {
    const u = stdioHost();
    const res = await u.fetch('/api/p/probe/who');
    expect(res.status).toBe(503);
  });

  test('stop and stdin EOF both end the hub, then the process', async () => {
    const u = stdioHost();
    await u.start();
    u.stop();
    await u.stopped();
    await waitFor('the exit', () => u.exits.length > 0);
    expect(u.exits).toEqual([0]);

    const eof = stdioHost();
    await eof.start();
    eof.toChild.end();
    await eof.stopped();
    await waitFor('the exit on EOF', () => eof.exits.length > 0);
    expect(eof.exits).toEqual([0]);
  });

  test('stdout disconnect aborts in-flight work and immediately rejects new requests', async () => {
    let parentDisconnected = 0;
    const u = stdioHost({ onParentDisconnect: () => void parentDisconnected++ });
    await u.start();
    const inFlight = u.fetch('/api/p/probe/hold');
    await Bun.sleep(10);
    // Child stdout closes while child stdin / process has not exited yet.
    u.fromChild.end();
    await expect(inFlight).rejects.toThrow('the hub is gone');
    expect(parentDisconnected).toBe(1);
    expect(u.parent.closed).toBe(true);
    expect(() => u.fetch('/api/p/probe/who')).toThrow('stdio mux closed');
    expect(() => u.stop()).toThrow('stdio mux closed');
  });
});

describe('channels of the app over stdio mux', () => {
  test('open, carry text and bytes both ways, count what is buffered', async () => {
    const u = stdioHost();
    await u.start();
    const c = u.channel('/api/p/probe/ch');
    await waitFor('open', c.opened);
    c.client.send('hello');
    c.client.send(new Uint8Array([1, 2, 3]));
    await waitFor('the echoes', () => c.got.length === 2);
    expect(c.got[0]).toBe('hello');
    expect([...(c.got[1] as Uint8Array)]).toEqual([1, 2, 3]);
    await Bun.sleep(10);
    c.client.send('buffered');
    await waitFor('the count', () => c.got.length === 3);
    expect(c.got[2]).toBe('0');
  });

  test("the hub's close reaches the client with its code; the client's reaches the hub", async () => {
    const u = stdioHost();
    await u.start();
    closed.length = 0;
    const a = u.channel('/api/p/probe/ch');
    await waitFor('open', a.opened);
    a.client.send('close');
    await waitFor('the close', () => a.ends.length === 1);
    expect(a.ends[0]).toEqual([4000, 'asked']);
    const b = u.channel('/api/p/probe/ch');
    await waitFor('open', b.opened);
    b.client.close(1000, 'bye');
    await waitFor('the hub to see it', () => closed.some(([code, reason]) => code === 1000 && reason === 'bye'));
    await waitFor('the answer', () => b.ends.length === 1);
  });

  test('refusals close abnormally, and messages above even maxFrame close only their own channel', async () => {
    const u = stdioHost({ maxMessage: 4096, maxFrame: 8192 });
    await u.start();
    const c = u.channel('/api/p/probe/ch', 'https://evil.example');
    await waitFor('the close', () => c.ends.length === 1);
    expect(c.opened()).toBe(false);
    expect(c.ends[0]).toEqual([ABNORMAL, 'refused 403 origin_not_allowed']);
    const d = u.channel('/api/p/probe/nothing');
    await waitFor('the close', () => d.ends.length === 1);
    expect(d.ends[0]).toEqual([ABNORMAL, 'refused 404 not_found']);

    // Keep a healthy sibling channel open while sending messages larger than
    // both maxMessage (4 KiB) and maxFrame (8 KiB).
    const healthy = u.channel('/api/p/probe/ch');
    await waitFor('healthy open', healthy.opened);

    const bigBytes = u.channel('/api/p/probe/ch');
    await waitFor('bigBytes open', bigBytes.opened);
    bigBytes.client.send(new Uint8Array(16_384));
    await waitFor('bigBytes too-big close', () => bigBytes.ends.length === 1);
    expect(bigBytes.ends[0]).toEqual([TOO_BIG, 'message too big']);

    const bigText = u.channel('/api/p/probe/ch');
    await waitFor('bigText open', bigText.opened);
    bigText.client.send('x'.repeat(16_384));
    await waitFor('bigText too-big close', () => bigText.ends.length === 1);
    expect(bigText.ends[0]).toEqual([TOO_BIG, 'message too big']);

    const bigFromHub = u.channel('/api/p/probe/ch');
    await waitFor('bigFromHub open', bigFromHub.opened);
    bigFromHub.client.send('hub-oversize');
    await waitFor('bigFromHub too-big close', () => bigFromHub.ends.length === 1);
    expect(bigFromHub.ends[0]).toEqual([TOO_BIG, 'message too big']);

    // Sibling channel, requests and the hub process itself remain healthy.
    healthy.client.send('still-alive');
    await waitFor('sibling echo', () => healthy.got.length === 1);
    expect(healthy.got[0]).toBe('still-alive');
    expect(healthy.ends).toEqual([]);
    const res = await u.fetch('/api/p/probe/who', { headers: sameOrigin });
    expect(res.status).toBe(200);
    expect(u.exits).toEqual([]);
  });

  extended('default 64 MiB MAX_MESSAGE limit answers TOO_BIG over stdio mux', async () => {
    const u = stdioHost();
    await u.start();
    const big = u.channel('/api/p/probe/ch');
    await waitFor('open', big.opened);
    big.client.send(new Uint8Array(MAX_MESSAGE + 1));
    await waitFor('the too-big close', () => big.ends.length === 1, 10_000);
    expect(big.ends[0]).toEqual([TOO_BIG, 'message too big']);
  });

  test("the pages' event channel", async () => {
    const u = stdioHost();
    await u.start();
    const c = u.channel('/ws');
    await waitFor('open', c.opened);
    c.client.close();
  });
});

describe('start', () => {
  const good: HubStart = {
    instance: 'desktop',
    nodeInstance: '',
    localOnly: false,
    origin: ORIGIN,
    verifyKey: 'k'.repeat(64),
  };
  test('what the main process sends is checked', () => {
    expect(startProblem(good)).toBe('');
    expect(startProblem({ ...good, instance: 'Bad' })).toBe('invalid instance');
    expect(startProblem({ ...good, verifyKey: 'short' })).toBe('invalid verify key');
    for (const origin of ['http://x.localhost', 'https://example.com', `${ORIGIN}/`, 'nope'])
      expect(startProblem({ ...good, origin })).toBe('invalid origin');
  });
});

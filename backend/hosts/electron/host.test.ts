// The desktop app's host of the core: the utility process's side of the
// bridge with a real core (requests and channels through MessagePorts, as
// the main process hands them over), what the core makes of the app's
// requests (the desktop client, on the core's host, from the app's
// origin), and what it checks of its start.
import { describe, expect, test } from 'bun:test';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { SLUG } from '#shared/lib/brand.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import { breakableResponse } from '#kernel/http/breakable.ts';
import { testHub, waitFor } from '#kernel/testing.ts';
import type { Composed } from '#hosts/common/compose.ts';
import { ABNORMAL, channelClient, nodePort, request, type HubStart, type FromHub, type RequestHead } from './bridge.ts';
import { serveParent } from './serve.ts';
import { startProblem } from './start.ts';

const ORIGIN = `https://${SLUG}.localhost`;

/** A feature with what the tests ask of the core. */
const probe = defineFeature({
  id: 'probe',
  toggle: false,
  setup(ctx) {
    ctx.api.get('/who', (c) => c.json({ client: c.var.client, sameHost: c.var.sameHost, trustedOrigin: c.var.trustedOrigin }));
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
          ch.send(d);
        },
        close: (code, reason) => closed.push([code, reason]),
      }));
    });
  },
});
const held = { aborted: false };
const closed: Array<[number, string]> = [];

/** A utility process in this one: serveParent on one end of a channel,
 * the main process's side on the other. */
function utility() {
  const tc = testHub({ features: [probe], guard: { allowedOrigins: [ORIGIN] } });
  const replies: FromHub[] = [];
  const exits: number[] = [];
  let stopped: Promise<void> | undefined;
  const listeners: Array<(e: { data: unknown; ports: readonly MessagePort[] }) => void> = [];
  serveParent<MessagePort>(
    {
      on: (_event, fn) => listeners.push(fn),
      postMessage: (m) => void replies.push(m),
    },
    {
      start: (): Composed => ({
        core: tc.core,
        settings: undefined as never,
        specs: [],
        run: (signal) => (stopped = new Promise((r) => signal.addEventListener('abort', () => r(), { once: true }))),
      }),
      port: (p) => nodePort(p),
      logger: () => {},
      exit: (code) => void exits.push(code),
    },
  );
  const send = (data: unknown, ports: MessagePort[] = []) => listeners.forEach((l) => l({ data, ports }));
  return {
    replies,
    exits,
    stopped: () => stopped,
    start: () => send({ t: 'start', start: {} }),
    stop: () => send({ t: 'stop' }),
    /** A request of the app's window. */
    fetch(
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal } = {},
    ) {
      const { port1, port2 } = new MessageChannel();
      const head: RequestHead = {
        method: init.method ?? 'GET',
        url: ORIGIN + path,
        headers: Object.entries({ host: `${SLUG}.localhost`, ...init.headers }),
        body: !!init.body,
      };
      send({ t: 'request', head }, [port2]);
      return request(nodePort(port1), head, init.body ?? null, init.signal);
    },
    /** A channel of the app's window. */
    channel(path: string, origin = ORIGIN) {
      const { port1, port2 } = new MessageChannel();
      send(
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
        [port2],
      );
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

describe('requests of the app', () => {
  test('are the desktop client, on the core host, of a trusted origin', async () => {
    const u = utility();
    u.start();
    expect(u.replies).toEqual([{ t: 'ready' }]);
    const res = await u.fetch('/api/p/probe/who', { headers: sameOrigin });
    expect(await res.json()).toEqual({ client: 'desktop', sameHost: true, trustedOrigin: ORIGIN });
  });

  test('the guard refuses another origin', async () => {
    const u = utility();
    u.start();
    const res = await u.fetch('/api/p/probe/echo', { method: 'POST', headers: { origin: 'https://evil.example' }, body: null });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('origin_not_allowed');
  });

  test('a body streams both ways', async () => {
    const u = utility();
    u.start();
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

  test('a response that breaks off fails, not ends short', async () => {
    const u = utility();
    u.start();
    const res = await u.fetch('/api/p/probe/broken');
    expect(res.status).toBe(200);
    const failed = await res.arrayBuffer().then(
      () => '',
      (e: Error) => e.message,
    );
    expect(failed).toBe('the machine is gone');
  });

  test('a request the client gives up aborts in the core', async () => {
    const u = utility();
    u.start();
    held.aborted = false;
    const give = new AbortController();
    const res = u.fetch('/api/p/probe/hold', { signal: give.signal });
    await Bun.sleep(20);
    give.abort();
    await expect(res).rejects.toThrow('aborted');
    await waitFor('the core to see the abort', () => held.aborted);
  });

  test('before the core started: 503', async () => {
    const u = utility();
    const res = await u.fetch('/api/p/probe/who');
    expect(res.status).toBe(503);
  });

  test('stop ends the core, then the process', async () => {
    const u = utility();
    u.start();
    u.stop();
    await u.stopped();
    await waitFor('the exit', () => u.exits.length > 0);
    expect(u.exits).toEqual([0]);
  });
});

describe('channels of the app', () => {
  test('open, carry text and bytes both ways, count what is buffered', async () => {
    const u = utility();
    u.start();
    const c = u.channel('/api/p/probe/ch');
    await waitFor('open', c.opened);
    c.client.send('hello');
    c.client.send(new Uint8Array([1, 2, 3]));
    await waitFor('the echoes', () => c.got.length === 2);
    expect(c.got[0]).toBe('hello');
    expect([...(c.got[1] as Uint8Array)]).toEqual([1, 2, 3]);
    // Acked once the client took them in.
    await Bun.sleep(10);
    c.client.send('buffered');
    await waitFor('the count', () => c.got.length === 3);
    expect(c.got[2]).toBe('0');
  });

  test("the core's close reaches the client with its code; the client's reaches the core", async () => {
    const u = utility();
    u.start();
    closed.length = 0;
    const a = u.channel('/api/p/probe/ch');
    await waitFor('open', a.opened);
    a.client.send('close');
    await waitFor('the close', () => a.ends.length === 1);
    expect(a.ends[0]).toEqual([4000, 'asked']);
    const b = u.channel('/api/p/probe/ch');
    await waitFor('open', b.opened);
    b.client.close(1000, 'bye');
    await waitFor('the core to see it', () => closed.some(([code, reason]) => code === 1000 && reason === 'bye'));
    await waitFor('the answer', () => b.ends.length === 1);
  });

  test('a channel the core refuses closes abnormally with its status and code', async () => {
    const u = utility();
    u.start();
    const c = u.channel('/api/p/probe/ch', 'https://evil.example');
    await waitFor('the close', () => c.ends.length === 1);
    expect(c.opened()).toBe(false);
    expect(c.ends[0]).toEqual([ABNORMAL, 'refused 403 origin_not_allowed']);
    const d = u.channel('/api/p/probe/nothing');
    await waitFor('the close', () => d.ends.length === 1);
    expect(d.ends[0]).toEqual([ABNORMAL, 'refused 404 not_found']);
  });

  test("the pages' event channel", async () => {
    const u = utility();
    u.start();
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
    payload: '/app/payload',
    web: '/app/web',
  };
  test('what the main process sends is checked', () => {
    expect(startProblem(good)).toBe('');
    expect(startProblem({ ...good, instance: 'Bad' })).toBe('invalid instance');
    expect(startProblem({ ...good, verifyKey: 'short' })).toBe('invalid verify key');
    for (const origin of ['http://x.localhost', 'https://example.com', `${ORIGIN}/`, 'nope'])
      expect(startProblem({ ...good, origin })).toBe('invalid origin');
    expect(startProblem({ ...good, web: '' })).toBe('no payloads');
  });
});

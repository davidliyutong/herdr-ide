import { describe, expect, test } from 'bun:test';
import { CloseCode, channelPair, type Channel, type ChannelHandlers, type Message } from './channel.ts';
import { Pages, type Page } from './pages.ts';
import { memoryAudit, sleep } from './testing.ts';

/** A page connected over a channel pair: what it receives, and send. */
function connect(pages: Pages, readOnly = false) {
  const { a, b } = channelPair();
  const received: unknown[] = [];
  let closed: [number, string] | undefined;
  let page!: Page;
  pages.onOpen((p) => void (page ??= p));
  a.adopt((ch) => pages.connect(ch, { client: 'browser', readOnly, who: { remote: '127.0.0.1' } }));
  b.adopt(() => ({
    message: (m: Message) => void received.push(JSON.parse(m as string)),
    close: (code, reason) => void (closed = [code, reason]),
  }));
  return {
    received,
    send: (m: unknown) => b.send(typeof m === 'string' ? m : JSON.stringify(m)),
    close: () => b.close(),
    closed: () => closed,
    page: () => page,
  };
}

/** A channel that holds what it is given, buffered bytes as set. */
function heldChannel(buffered: number): Channel & { sent: Message[]; closedWith?: number; handlers?: ChannelHandlers } {
  const ch = {
    sent: [] as Message[],
    buffered,
    closedWith: undefined as number | undefined,
    send(d: Message) {
      ch.sent.push(d);
    },
    close(code?: number) {
      ch.closedWith = code;
    },
  };
  return ch;
}

describe('pages', () => {
  // The page that plays sounds is the one used most recently: pages report
  // how long ago, clamped to [0, maxIdle].
  test('sound page', () => {
    const pages = new Pages({ logger: () => {}, audit: memoryAudit().audit });
    expect(pages.soundPage()).toBeUndefined();
    const info = { client: 'browser' as const, readOnly: false, who: {} };
    let a!: Page;
    let b!: Page;
    pages.onOpen((p) => void (a ? (b = p) : (a = p)));
    pages.connect(heldChannel(0), info);
    pages.connect(heldChannel(0), info);
    pages.markActive(a, 60_000);
    pages.markActive(b, 3600_000);
    expect(pages.soundPage()).toBe(a);
    // Input on another page moves sounds there.
    pages.markActive(b, 0);
    expect(pages.soundPage()).toBe(b);
    // Negative or huge idle times from a browser are clamped.
    pages.markActive(a, -3600_000);
    expect(pages.soundPage()).toBe(a);
    expect((a as unknown as { active: number }).active).toBeLessThanOrEqual(Date.now());
    pages.markActive(a, 2 ** 62);
    expect(pages.soundPage()).toBe(b);
  });

  // "active" messages report idle times; ping is answered with its rid.
  test('messages', async () => {
    const pages = new Pages({ logger: () => {}, audit: memoryAudit().audit });
    const p1 = connect(pages);
    const p2 = connect(pages);
    p1.send({ t: 'active', idle: 1000 });
    p2.send({ t: 'active', idle: 5000 });
    p1.send({ t: 'ping', rid: 7 });
    await sleep(10);
    expect(pages.soundPage()).toBe(p1.page());
    expect(p1.received).toEqual([{ t: 'pong', rid: 7 }]);
    p2.send({ t: 'active', idle: 0 });
    await sleep(10);
    expect(pages.soundPage()).not.toBe(p1.page());
  });

  // Messages go to the handler of their type; what is not a message, has
  // no handler or makes its handler throw is dropped (and the last
  // logged); a type is handled once.
  test('dispatch', async () => {
    const logs: string[] = [];
    const pages = new Pages({ logger: (l) => void logs.push(l), audit: memoryAudit().audit });
    const got: unknown[] = [];
    pages.on('x', (p, m) => void got.push([p.readOnly, m]));
    pages.on('bad', () => {
      throw new Error('broken');
    });
    expect(() => pages.on('x', () => {})).toThrow('pages: x is handled already');
    const p = connect(pages, true);
    for (const m of ['not json', '[]', '{"t":1}', '{"t":"none"}', '{"t":"bad"}', '{"t":"x","v":1}']) p.send(m);
    await sleep(10);
    expect(got).toEqual([[true, { t: 'x', v: 1 }]]);
    expect(logs).toEqual(['ws: bad: broken']);
  });

  // onOpen runs for each page with the page listed; what it returns runs
  // when the page goes. Pages are audited coming and going.
  test('open and close', async () => {
    const audit = memoryAudit();
    const pages = new Pages({ logger: () => {}, audit: audit.audit });
    const events: string[] = [];
    pages.onOpen((p) => {
      events.push(`open ${pages.size}`);
      p.send({ t: 'hello' });
      return () => void events.push('gone');
    });
    const p = connect(pages);
    await sleep(10);
    expect(p.received).toEqual([{ t: 'hello' }]);
    pages.broadcast({ t: 'all' });
    pages.broadcast({ t: 'none' }, () => false);
    await sleep(10);
    expect(p.received).toEqual([{ t: 'hello' }, { t: 'all' }]);
    p.close();
    await sleep(10);
    expect(events).toEqual(['open 1', 'gone']);
    expect(pages.size).toBe(0);
    expect(audit.records().map((r) => [r.event, r.remote])).toEqual([
      ['ws.connect', '127.0.0.1'],
      ['ws.disconnect', '127.0.0.1'],
    ]);
  });

  // A page that does not read is disconnected once its channel holds more
  // than maxBuffered bytes; it reconnects to start from the current state.
  test('overflow', () => {
    const pages = new Pages({ logger: () => {}, audit: memoryAudit().audit, maxBuffered: 10 });
    const slow = heldChannel(11);
    const fast = heldChannel(0);
    pages.connect(slow, { client: 'browser', readOnly: false, who: {} });
    pages.connect(fast, { client: 'desktop', readOnly: false, who: {} });
    pages.broadcast({ t: 'x' });
    pages.broadcast({ t: 'y' });
    expect([slow.sent, slow.closedWith]).toEqual([[], CloseCode.Overflow]);
    expect(fast.sent).toEqual(['{"t":"x"}', '{"t":"y"}']);
  });
});

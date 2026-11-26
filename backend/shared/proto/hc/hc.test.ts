import { describe, expect, test } from 'bun:test';
import { duplexPair, type Duplex } from 'node:stream';
import { EOFError, Reader } from '#shared/lib/streamio.ts';
import { Conn, ERR_CLOSED, HCError, hasFeature, probe, type Hello } from './index.ts';
import { HEADER_LEN, Kind, MAX_HELLO, MAX_PAYLOAD, MAX_QUEUED, encodeFrame, readFrame, type Frame } from './wire.ts';

const helloOK =
  '{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"},"methods":["hello"],"features":["automatic_input"]}}';

/** The core's end of a connection: answers the hello, then hands the test
 * every frame the client sends. */
class FakeCore {
  frames: Frame[] = [];
  private waiters: Array<() => void> = [];
  closed = false;
  helloRequest!: Promise<string>;

  readonly conn: Duplex;

  constructor(conn: Duplex) {
    this.conn = conn;
  }

  start(reply: string) {
    const r = new Reader(this.conn);
    this.helloRequest = (async () => {
      const line = await r.line(1 << 20);
      this.conn.write(reply + '\n');
      (async () => {
        try {
          for (let f = await readFrame(r); f; f = await readFrame(r)) {
            this.frames.push(f);
            this.wake();
          }
        } catch {
          // the client went away
        }
        this.closed = true;
        this.wake();
      })();
      return line;
    })();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async next(): Promise<Frame> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const f = this.frames.shift();
      if (f) return f;
      if (this.closed) throw new Error('client closed the connection');
      if (Date.now() > deadline) throw new Error('no frame from the client');
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  /** The next call on channel 0. */
  async request(): Promise<{ id: number; method: string; params: string }> {
    const f = await this.next();
    expect([f.channel, f.kind]).toEqual([0, Kind.Data]);
    const m = JSON.parse(f.payload.toString());
    return { id: m.id, method: m.method, params: JSON.stringify(m.params) };
  }

  send(...frames: OutFrame[]) {
    this.conn.write(Buffer.concat(frames.map(([ch, kind, p]) => encodeFrame(ch, kind, typeof p === 'string' ? Buffer.from(p) : p))));
  }
}

type OutFrame = [number, number, (Uint8Array | string)?];

const result = (id: number, body: string): OutFrame => [0, Kind.Data, `{"jsonrpc":"2.0","id":${id},"result":${body}}`];

async function dial(reply: string): Promise<{ c: Conn; h: Hello; f: FakeCore }> {
  const [a, b] = duplexPair();
  const f = new FakeCore(b);
  f.start(reply);
  const dialing = Conn.dial(a, AbortSignal.timeout(5000));
  const req = JSON.parse(await f.helloRequest);
  expect(req).toMatchObject({ method: 'hello', params: { framed: true, generation: 1 } });
  const { conn, hello } = await dialing;
  return { c: conn, h: hello, f };
}

test('frames', async () => {
  const b = encodeFrame(7, Kind.Resize, Buffer.from([1, 2, 3, 4]));
  expect([...b]).toEqual([7, 0, 0, 0, 3, 4, 0, 0, 0, 1, 2, 3, 4]);
  const one = (bytes: Buffer) => {
    const [x, y] = duplexPair();
    x.end(bytes);
    return readFrame(new Reader(y));
  };
  expect(await one(b)).toEqual({ channel: 7, kind: Kind.Resize, payload: Buffer.from([1, 2, 3, 4]) });
  expect(await one(Buffer.alloc(0))).toBeNull();
  expect(one(b.subarray(0, 11))).rejects.toBeInstanceOf(EOFError);
  const big = Buffer.alloc(HEADER_LEN);
  big[0] = 1;
  big.writeUInt32LE(MAX_PAYLOAD + 1, 5);
  expect(one(big)).rejects.toThrow('exceeds');
});

test('hello', async () => {
  const { h, c } = await dial(helloOK);
  expect([h.version, h.core.name, hasFeature(h, 'automatic_input'), hasFeature(h, 'other')]).toEqual(['0.1.21', 'box', true, false]);
  c.close();
  const bad: Record<string, string> = {
    generation: '{"jsonrpc":"2.0","id":0,"result":{"generation":2,"framed":true}}',
    plain: '{"jsonrpc":"2.0","id":0,"result":{"generation":1,"framed":false}}',
    error: '{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"no","data":{"kind":"unsupported"}}}',
    garbage: 'hello',
    'too long': `{"x":"${'a'.repeat(MAX_HELLO + 1)}"}`,
  };
  for (const [name, reply] of Object.entries(bad)) {
    const err = await dial(reply).then(
      () => null,
      (e) => e,
    );
    expect([name, err !== null]).toEqual([name, true]);
    if (name === 'error') expect((err as HCError).kind).toBe('unsupported');
  }
});

test('probe asks and closes', async () => {
  const [a, b] = duplexPair();
  const f = new FakeCore(b);
  f.start('{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":false,"core":{"id":"c1","name":"box"}}}');
  const h = await probe(a, AbortSignal.timeout(5000));
  expect(JSON.parse(await f.helloRequest).params.framed).toBe(false);
  expect(h.version).toBe('0.1.21');
  expect(a.destroyed).toBe(true);
});

test('calls', async () => {
  const { c, f } = await dial(helloOK);
  const pa = c.call<Record<string, number>>('a');
  const pb = c.call('b');
  const ids: Record<string, number> = {};
  for (let i = 0; i < 2; i++) {
    const r = await f.request();
    expect(r.params).toBe('{}');
    ids[r.method] = r.id;
  }
  // Answered in the other order, one with an error.
  f.send([
    0,
    Kind.Data,
    `{"jsonrpc":"2.0","id":${ids.b},"error":{"code":-32000,"message":"no terminal t9","data":{"kind":"not_found","hint":"h"}}}`,
  ]);
  const e = (await pb.catch((e) => e)) as HCError;
  expect([e.kind, e.hint, e.code]).toEqual(['not_found', 'h', -32000]);
  f.send(result(ids.a, '{"n":3}'));
  expect((await pa).n).toBe(3);

  // A call given up is cancelled at the core, and its late reply dropped.
  const ac = new AbortController();
  const slow = c.call('slow', undefined, { signal: ac.signal });
  const { id } = await f.request();
  ac.abort();
  expect(slow).rejects.toThrow('aborted');
  const cancel = (await f.next()).payload.toString();
  expect(cancel).toContain('"$/cancelRequest"');
  expect(cancel).toContain(`"id":${id}`);
  f.send(result(id, '{}'));

  // The connection ending fails the calls waiting on it.
  const never = c.call('never');
  await f.request();
  f.conn.destroy();
  expect(never).rejects.toBeDefined();
  await c.done();
  expect(c.err).not.toBeNull();
  expect(c.call('x')).rejects.toBeDefined();
});

async function attach(c: Conn, f: FakeCore, reply: string, ...after: OutFrame[]) {
  const p = c.attach({ terminal: 't7', cols: 80, rows: 24, history: 100 }, { signal: AbortSignal.timeout(5000) });
  const { id, method, params } = await f.request();
  expect(method).toBe('terminal.attach');
  expect(JSON.parse(params)).toEqual({ terminal: 't7', cols: 80, rows: 24, history: 100 });
  // The reply and the first frames of the stream in one write: the channel
  // must be known before the frame behind the reply is read.
  f.send(result(id, reply), ...after);
  return p;
}

describe('streams', () => {
  test('attach', async () => {
    const { c, f } = await dial(helloOK);
    const { stream: s, attached: a } = await attach(
      c,
      f,
      '{"channel":5,"automatic_input":true,"resize_notifications":true,"terminal":{"address":"t7","state":"live","cols":80,"rows":24,"labels":{},"screen":"exact"}}',
      [5, Kind.Resize, Buffer.from([100, 0, 30, 0])],
      [5, Kind.Data, 'paint'],
    );
    expect([a.terminal.address, a.resize_notifications]).toEqual(['t7', true]);
    expect(await s.recv()).toEqual({ cols: 100, rows: 30 });
    expect(await s.recv()).toEqual({ data: Buffer.from('paint') });

    const expectFrame = async (kind: number, payload: number[] | string) => {
      const fr = await f.next();
      expect([fr.channel, fr.kind, fr.payload]).toEqual([5, kind, Buffer.from(payload as never)]);
    };
    s.ack(5);
    await expectFrame(Kind.Credit, [5, 0, 0, 0]);
    s.write(Buffer.from('ls\r'));
    await expectFrame(Kind.Data, 'ls\r');
    s.writeAutomatic(Buffer.from('\x1b[?1;2c'));
    await expectFrame(Kind.AutomaticInput, '\x1b[?1;2c');
    s.resize(120, 40);
    await expectFrame(Kind.Resize, [120, 0, 40, 0]);
    expect(() => s.resize(0, 40)).toThrow();
    expect(() => s.resize(70000, 40)).toThrow();
    s.focus(true);
    await expectFrame(Kind.Focus, [1]);
    s.facts({ bg: '#000000', cell: [8, 16] });
    await expectFrame(Kind.Facts, '{"bg":"#000000","cell":[8,16]}');

    // A stream waits without holding up calls or other streams.
    expect(s.recv(AbortSignal.timeout(20))).rejects.toThrow();

    // The program ends: what was sent before is received, then the end.
    expect(s.exit()).toBeNull();
    f.send([5, Kind.Data, 'bye'], [5, Kind.Close, '{"reason":"exited","exit_code":3,"signal":null}']);
    expect(await s.recv()).toEqual({ data: Buffer.from('bye') });
    expect(await s.recv()).toBeNull();
    expect(s.exit()).toEqual({ reason: 'exited', exit_code: 3, signal: null });
    // Closing a stream the core ended sends nothing more.
    s.close();
    c.call('after').catch(() => {}); // answered by nobody: the connection closes below
    expect((await f.request()).method).toBe('after');
    c.close();
  });

  test('without automatic input; detaching', async () => {
    const { c, f } = await dial(helloOK);
    const { stream: s } = await attach(c, f, '{"channel":2,"terminal":{"address":"t7"}}');
    s.writeAutomatic(Buffer.from('r'));
    let fr = await f.next();
    expect([fr.kind, fr.payload.toString()]).toEqual([Kind.Data, 'r']);

    // Detaching closes the channel; output still on its way is dropped.
    s.close();
    fr = await f.next();
    expect([fr.channel, fr.kind, fr.payload.length]).toEqual([2, Kind.Close, 0]);
    f.send([2, Kind.Data, 'late'], [2, Kind.Close]);
    expect(s.recv()).rejects.toBe(ERR_CLOSED);
    s.close();
    const after = c.call('after');
    const { id, method } = await f.request(); // not a second close
    expect(method).toBe('after');
    f.send(result(id, '{}'));
    await after;
    c.close();
  });

  test('an attach given up is detached when the core attached anyway', async () => {
    const { c, f } = await dial(helloOK);
    const ac = new AbortController();
    const p = c.attach({ terminal: 't7', cols: 80, rows: 24 }, { signal: ac.signal });
    const { id } = await f.request();
    ac.abort();
    expect(p).rejects.toThrow('aborted');
    await f.next(); // $/cancelRequest
    f.send(result(id, '{"channel":9,"terminal":{"address":"t7"}}'), [9, Kind.Data, 'paint']);
    const fr = await f.next();
    expect([fr.channel, fr.kind]).toEqual([9, Kind.Close]);
    c.close();
  });

  test('a core ignoring credit is disconnected', async () => {
    const { c, f } = await dial(helloOK);
    const { stream: s } = await attach(c, f, '{"channel":3,"terminal":{"address":"t7"}}');
    const chunk = Buffer.alloc(64 << 10);
    for (let i = 0; i <= MAX_QUEUED / chunk.length; i++) f.send([3, Kind.Data, chunk]);
    const err = await Promise.race([c.done(), Bun.sleep(5000).then(() => null)]);
    expect(err?.message).toContain('credit');
    expect(s.recv()).rejects.toBeDefined();
  });
});

test('events', async () => {
  const { c, f } = await dial(helloOK);
  const p = c.subscribe({ labels: { app: 'x' } });
  const { id, method, params } = await f.request();
  expect([method, params]).toEqual(['events.subscribe', '{"labels":{"app":"x"}}']);
  // Lines arrive split anywhere, several to a frame.
  const lines =
    '{"jsonrpc":"2.0","method":"event","params":{"seq":42,"type":"status","terminal":"rohan/t7","data":{"status":{"state":"working"}}}}\n' +
    '{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":42}}\n' +
    '{"jsonrpc":"2.0","method":"event","params":{"seq":43,"type":"doc","machine":"rohan","data":{"name":"layout","version":2}}}\n' +
    '{"jsonrpc":"2.0","method":"missed","params":{"seq":57,"terminals":[{"address":"t1","state":"live"}]}}\n';
  f.send(
    result(id, '{"channel":4,"seq":41,"terminals":[{"address":"t7","state":"live","status":{"state":"idle"}}]}'),
    [4, Kind.Data, lines.slice(0, 50)],
    [4, Kind.Data, lines.slice(50)],
  );
  const { events: e, subscribed: s } = await p;
  expect([s.seq, s.terminals?.length, s.terminals?.[0].status?.state]).toEqual([41, 1, 'idle']);
  let n = await e.recv();
  expect([n.method, n.seq, n.type, n.terminal]).toEqual(['event', 42, 'status', 'rohan/t7']);
  expect(JSON.stringify(n.data)).toContain('working');
  n = await e.recv();
  expect([n.method, n.seq]).toEqual(['heartbeat', 42]);
  n = await e.recv();
  expect([n.type, n.machine, n.terminal]).toEqual(['doc', 'rohan', '']);
  n = await e.recv();
  expect([n.method, n.seq, n.terminals?.[0].address]).toEqual(['missed', 57, 't1']);
  const credits = [await f.next(), await f.next()].map((fr) => [fr.channel, fr.kind, fr.payload.readUInt32LE(0)]);
  expect(credits).toEqual([
    [4, Kind.Credit, 50],
    [4, Kind.Credit, lines.length - 50],
  ]);
  e.close();
  const fr = await f.next();
  expect([fr.channel, fr.kind]).toEqual([4, Kind.Close]);
  expect(e.recv()).rejects.toBe(ERR_CLOSED);
  c.close();
});

test('a dial given up closes the connection', async () => {
  const [a, b] = duplexPair();
  b.resume(); // a core that never answers
  expect(Conn.dial(a, AbortSignal.timeout(30))).rejects.toThrow();
  await Bun.sleep(60);
  expect(a.destroyed).toBe(true);
});

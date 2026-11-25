import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { nodePort, serveChannel, serveRequest, type CoreStart, type NodePort, type ToCore } from '../../backend/hosts/electron/bridge';
import { APP_SLUG } from '../../web/src/brand';
import {
  channelHead,
  CoreHost,
  coreEnv,
  coreInstance,
  DesktopError,
  isChannelId,
  nodeInstance,
  verifyKey,
  type CoreChild,
  type CoreSpawner,
} from './core';
import { APP_HOST, APP_ORIGIN } from './origin';

test('development is isolated; packaged mode has its own instance', () => {
  assert.equal(coreInstance(false, 'e3'), 'desktop');
  assert.equal(coreInstance(true, undefined), 'dev');
  assert.equal(coreInstance(true, '1'), 'dev');
  assert.equal(coreInstance(true, 'e3'), 'e3');
  for (const bad of ['E3', '-x', 'a b', '../x', 'x'.repeat(33), 'desktop'])
    assert.throws(
      () => coreInstance(true, bad),
      (e: unknown) => e instanceof DesktopError && e.key === 'desktop.badInstance',
    );
  // The app's machines are the default instance's, shared with a server's
  // cores; a development instance keeps its own.
  assert.equal(nodeInstance('desktop'), '');
  assert.equal(nodeInstance('dev'), 'dev');
});

test('PATH gains the usual installations on macOS and Linux; Windows keeps its own', () => {
  for (const p of ['darwin', 'linux'] as const) {
    assert.ok(coreEnv({ PATH: '/custom/bin' }, '/home/test', p).PATH?.startsWith('/custom/bin'));
    assert.ok(coreEnv({ PATH: '/custom/bin' }, '/home/test', p).PATH?.includes('/home/test/.local/bin'));
    assert.ok(coreEnv({}, '/Users/test', p).PATH?.includes('/opt/homebrew/bin'));
  }
  const env = { Path: 'C:\\Windows\\System32' };
  assert.equal(coreEnv(env, 'C:\\Users\\test', 'win32'), env);
  // Nothing that switches the proxy on for every program the core starts
  // (the core sets its own, backend/shared/lib/proxy.ts).
  for (const p of ['darwin', 'linux', 'win32'] as const) {
    const out = coreEnv({ HTTPS_PROXY: 'http://proxy:3128' }, '/home/test', p);
    assert.equal(out.NODE_USE_ENV_PROXY, undefined);
    assert.equal(out.HTTPS_PROXY, 'http://proxy:3128');
  }
});

test("the app's origin: https under .localhost, named after the product", () => {
  assert.equal(APP_HOST, `${APP_SLUG}.localhost`);
  assert.equal(APP_ORIGIN, `https://${APP_SLUG}.localhost`);
});

test('the key of the system prompts: 32 random bytes as hex, for one launch', () => {
  const key = verifyKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(verifyKey(), key);
  assert.equal(
    verifyKey((n) => Buffer.alloc(n, 2)),
    '02'.repeat(32),
  );
});

const START: CoreStart = {
  instance: 'e2e-x',
  nodeInstance: 'e2e-x',
  localOnly: true,
  origin: APP_ORIGIN,
  verifyKey: 'k'.repeat(64),
  payload: '/p',
  web: '/w',
};

type Behavior = 'ready' | 'failed' | 'silent';

/** A utility process in this one: it answers start as told, serves
 * requests and channels with the bridge, exits on stop. */
class FakeChild extends EventEmitter implements CoreChild {
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly got: ToCore[] = [];
  killed = false;
  constructor(
    private readonly behavior: Behavior,
    private readonly answer: (req: Request) => Promise<Response>,
    private readonly stopping: 'exit' | 'stay' = 'exit',
  ) {
    super();
  }
  postMessage(m: ToCore, transfer: unknown[] = []): void {
    this.got.push(m);
    const port = transfer[0] as MessagePort | undefined;
    setImmediate(() => {
      if (m.t === 'start') {
        (this.stderr as unknown as EventEmitter).emit('data', Buffer.from('core: starting\n'));
        if (this.behavior === 'ready') this.emit('message', { t: 'ready' });
        if (this.behavior === 'failed') {
          // As the utility process does: it says why, then exits.
          this.emit('message', { t: 'failed', message: 'no payloads' });
          setImmediate(() => this.exit(1));
        }
      } else if (m.t === 'request' && port) void serveRequest(nodePort(port), m.head, this.answer);
      else if (m.t === 'channel' && port)
        void serveChannel(nodePort(port), m.head, async (_req, upgrade) => upgrade((ch) => ({ message: (d) => ch.send(d) })));
      else if (m.t === 'stop' && this.stopping === 'exit') this.exit(0);
    });
  }
  exit(code: number): void {
    this.emit('exit', code);
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.exit(-1));
    return true;
  }
}

function spawner(
  behaviors: Behavior[],
  answer = async (req: Request) => Response.json({ url: req.url, host: req.headers.get('host') }),
  stopping: 'exit' | 'stay' = 'exit',
) {
  const children: FakeChild[] = [];
  const s: CoreSpawner = {
    fork() {
      const child = new FakeChild(behaviors[Math.min(children.length, behaviors.length - 1)], answer, stopping);
      children.push(child);
      return child;
    },
    pair() {
      const { port1, port2 } = new MessageChannel();
      // Ports left open do not keep the test's process alive.
      port1.unref();
      port2.unref();
      return [port1, port2];
    },
    port: (end) => nodePort(end as NodePort),
  };
  return { s, children };
}

test('the core starts with what the main process holds for it, and answers the shell’s own requests', async () => {
  const { s, children } = spawner(['ready']);
  const logged: string[] = [];
  const host = new CoreHost({ spawner: s, start: START, lost: () => assert.fail('lost'), log: (t) => logged.push(t) });
  await host.start();
  assert.deepEqual(children[0].got[0], { t: 'start', start: START });
  const res = await host.fetch('/api/settings');
  assert.deepEqual(await res.json(), { url: `${APP_ORIGIN}/api/settings`, host: APP_HOST });
  assert.match(host.diagnostics, /core: starting/);
  assert.deepEqual(logged, ['core: starting\n']);
  await host.stop();
});

test("a window's request reaches the core with the origin of the page that made it as its Origin, in place of its own", async () => {
  const { s } = spawner(['ready'], async (req) => Response.json({ origin: req.headers.get('origin') }));
  const host = new CoreHost({ spawner: s, start: START, lost: () => assert.fail('lost') });
  await host.start();
  const origin = async (made: string | undefined, header?: string) =>
    (
      (await (await host.request(new Request(`${APP_ORIGIN}/api/config`, { headers: header ? { Origin: header } : {} }), made)).json()) as {
        origin: string | null;
      }
    ).origin;
  assert.equal(await origin(APP_ORIGIN), APP_ORIGIN);
  // A sandboxed frame's, another site's: the guard refuses them.
  assert.equal(await origin('null'), 'null');
  assert.equal(await origin('https://example.com', APP_ORIGIN), 'https://example.com');
  // One the browser or the shell started carries none.
  assert.equal(await origin(undefined, 'https://example.com'), null);
  assert.equal(((await (await host.fetch('/api/config')).json()) as { origin: string | null }).origin, null);
  await host.stop();
});

test('a core that cannot start fails the start, and is not started again', async () => {
  const failed = spawner(['failed']);
  const host = new CoreHost({ spawner: failed.s, start: START, lost: () => {} });
  await assert.rejects(
    host.start(),
    (e: unknown) => e instanceof DesktopError && e.key === 'desktop.coreFailed' && e.detail === 'no payloads',
  );
  // Stopping a core that is gone ends at once.
  await host.stop();
  const silent = spawner(['silent']);
  const slow = new CoreHost({ spawner: silent.s, start: START, lost: () => {}, startMs: 30 });
  await assert.rejects(slow.start(), (e: unknown) => e instanceof DesktopError && e.key === 'desktop.coreTimeout');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(silent.children[0].killed, true);
  assert.equal(silent.children.length, 1);
});

test('a crash restarts the core, the requests meanwhile wait for it; crashing on and on gives up', async () => {
  const { s, children } = spawner(['ready']);
  let now = 0;
  const lost: DesktopError[] = [];
  const host = new CoreHost({ spawner: s, start: START, lost: (e) => lost.push(e), maxRestarts: 2, restartWindowMs: 1000, now: () => now });
  await host.start();
  children[0].exit(9);
  const res = await host.fetch('/x');
  assert.equal(res.status, 200);
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].got[0], { t: 'start', start: START });
  children[1].exit(9);
  await host.fetch('/x');
  children[2].exit(9);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(lost.length, 1);
  assert.equal(lost[0].key, 'desktop.coreLost');
  assert.equal((await host.fetch('/x')).status, 503);
  // Crashes far apart are each restarted.
  const again = spawner(['ready']);
  const lasting = new CoreHost({
    spawner: again.s,
    start: START,
    lost: () => assert.fail('lost'),
    maxRestarts: 1,
    restartWindowMs: 1000,
    now: () => now,
  });
  await lasting.start();
  for (let i = 0; i < 4; i++) {
    now += 2000;
    again.children.at(-1)!.exit(1);
    assert.equal((await lasting.fetch('/x')).status, 200);
  }
});

test('channels: a frame’s end goes to the core once it serves; the shell’s own', async () => {
  const { s, children } = spawner(['ready']);
  const host = new CoreHost({ spawner: s, start: START, lost: () => {} });
  await host.start();
  const got: unknown[] = [];
  const ch = host.channel('/ws', { open: () => ch.send('ping'), message: (d) => got.push(d) });
  await new Promise<void>((r) => {
    const t = setInterval(() => got.length && (clearInterval(t), r()), 2);
  });
  assert.deepEqual(got, ['ping']);
  const sent = children[0].got.find((m) => m.t === 'channel');
  assert.deepEqual(sent, {
    t: 'channel',
    head: {
      url: `${APP_ORIGIN}/ws`,
      headers: [
        ['host', APP_HOST],
        ['upgrade', 'websocket'],
        ['connection', 'Upgrade'],
      ],
    },
  });
  ch.close();
  await host.stop();
  // A stopped core refuses the frame's channel on its end.
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  port2.unref();
  const closed = new Promise((r) => port2.once('message', r));
  await host.connect({ url: `${APP_ORIGIN}/ws`, headers: [] }, port1);
  assert.deepEqual(await closed, { t: 'close', code: 1006, reason: 'the core is not running' });
  port2.close();
});

test('stop asks the core to stop; one that stays is killed after the deadline', async () => {
  const graceful = spawner(['ready']);
  const a = new CoreHost({ spawner: graceful.s, start: START, lost: () => {} });
  await a.start();
  await a.stop();
  assert.equal(graceful.children[0].got.at(-1)?.t, 'stop');
  assert.equal(graceful.children[0].killed, false);
  assert.equal(a.stop(), a.stop());
  const stuck = spawner(['ready'], undefined, 'stay');
  const b = new CoreHost({ spawner: stuck.s, start: START, lost: () => assert.fail('a stop is no crash') });
  await b.start();
  await b.stop(30);
  assert.equal(stuck.children[0].killed, true);
  assert.equal(stuck.children.length, 1);
});

test("a frame's channel: of the app's origin, a path of it, WebSocket subprotocols", () => {
  assert.deepEqual(channelHead(APP_ORIGIN, '/m/local/code/x?t=1', ['a', 'b']), {
    url: `${APP_ORIGIN}/m/local/code/x?t=1`,
    headers: [
      ['host', APP_HOST],
      ['origin', APP_ORIGIN],
      ['upgrade', 'websocket'],
      ['connection', 'Upgrade'],
      ['sec-websocket-protocol', 'a, b'],
    ],
  });
  for (const origin of [undefined, 'https://example.com', 'null', `http://${APP_HOST}`])
    assert.equal(channelHead(origin, '/ws', []), undefined);
  for (const path of ['ws', '//evil.example/ws', 'https://evil.example/', 3, '/x'.repeat(5000)])
    assert.equal(channelHead(APP_ORIGIN, path, []), undefined, String(path));
  for (const protocols of [undefined, 'a', ['a b'], [1], Array(17).fill('a')])
    assert.equal(channelHead(APP_ORIGIN, '/ws', protocols), undefined);
  assert.ok(isChannelId('0123456789abcdef0123456789abcdef'));
  for (const id of ['', 'short', 'has space here', 3, 'x'.repeat(65)]) assert.equal(isChannelId(id), false);
});

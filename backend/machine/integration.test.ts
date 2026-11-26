// The agent's terminal core with a real herdr-core (HC_TEST_BIN; skipped
// without it, make it): installed through op hc and checked by its digest,
// started in the integration tests' session (veldr-it-<host id>, its
// state in a temporary directory, its home a temporary one), a program run
// through the API pipe, a hidden terminal run, found and killed by name,
// and the core stopped through its own instance.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { duplexPair } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { dirsFor, makeDirs } from '#shared/host/hostdirs.ts';
import { discard } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { ChunkWriter, HIDDEN_LABEL, Op, readLine, type Reply } from '#shared/proto/agentproto/index.ts';
import { Conn, type Terminal } from '#shared/proto/hc/index.ts';
import { closeStream, pairDuplex } from '#shared/proto/yamux.ts';
import { Session } from '#kernel/machines/transport/session.ts';
import { Agent } from './agent.ts';
import { hcSession } from './hc.ts';
import { dialHC } from './hidden.ts';

const BIN = process.env.HC_TEST_BIN || Bun.which('hc') || '';
const INSTANCE = 'it';
const saved: Record<string, string | undefined> = {};
let home = '';
let agent: Agent | undefined;
let session: Session | undefined;

beforeAll(() => {
  if (!BIN) return;
  home = realpathSync(mkdtempSync('/tmp/hit-'));
  // Everything the terminal core reads of the environment is the test's.
  for (const [k, v] of Object.entries({
    HOME: home,
    XDG_STATE_HOME: `${home}/state`,
    XDG_CONFIG_HOME: `${home}/config`,
    XDG_RUNTIME_DIR: undefined,
  }))
    ((saved[k] = process.env[k]), v === undefined ? delete process.env[k] : (process.env[k] = v));
  const dirs = dirsFor(INSTANCE);
  makeDirs(dirs);
  agent = new Agent({ instance: INSTANCE, dirs, logger: discard, features: [] });
  const [a, b] = duplexPair();
  void agent.serve(a, 'it', '');
  session = new Session(b, () => b.destroy());
});

afterAll(async () => {
  if (!BIN) return;
  try {
    await agent?.hc.stopIfRunning();
  } finally {
    session?.close();
    await agent?.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(home, { recursive: true, force: true });
  }
});

test.skipIf(!BIN)(
  'install, start, a program and a hidden terminal in the real terminal core, and its stop',
  async () => {
    const s = session!;
    const exe = readFileSync(BIN);
    const digest = createHash('sha256').update(exe).digest('hex');
    const { conn } = await s.open({ op: Op.HC, action: 'install', digest });
    const cw = new ChunkWriter(conn.stream);
    await cw.write(gzipSync(exe));
    await cw.finish();
    const installed = await readLine<Reply>(new Reader(conn.reader.release()));
    closeStream(conn.stream);
    expect(installed.hc?.digest).toBe(digest);

    const started = await s.request({ op: Op.HC, action: 'start', digest }, { timeoutMs: 60_000 });
    expect(started.hc?.running).toBe(true);
    expect(started.hc?.session).toBe(hcSession(INSTANCE));
    expect(statSync(started.hc!.socket).mode & 0o777).toBe(0o600);
    // Starting again finds it running.
    expect((await s.request({ op: Op.HC, action: 'start', digest }, { timeoutMs: 60_000 })).hc?.running).toBe(true);

    // A program through the API pipe.
    const api = await s.open({ op: Op.HCAPI });
    const { conn: hc } = await Conn.dial(pairDuplex(api.conn.reader.release(), api.conn.stream));
    const t = await hc.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "it-$((6*7))"; sleep 30'], cwd: home });
    let text = '';
    for (let i = 0; i < 100 && !text.includes('it-42'); i++) {
      text = (await hc.call<{ text?: string }>('terminal.read', { terminal: t.address })).text ?? '';
      if (!text.includes('it-42')) await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toContain('it-42');
    hc.close();

    // A hidden terminal: run by name with its label, a second run finds it,
    // kill ends it.
    const env = agent!.env();
    const argv = ['/bin/sh', '-c', 'sleep 60', 'helper'];
    await env.runHidden('veldr-it-helper', argv);
    await env.runHidden('veldr-it-helper', argv);
    const c = await dialHC(agent!.hc.socket);
    const rec = await c.call<Terminal>('terminal.get', { terminal: 'veldr-it-helper' });
    expect(rec.state).toBe('live');
    expect(rec.labels?.[HIDDEN_LABEL]).toBe('it-helper');
    c.close();
    expect(await env.killHidden('veldr-it-helper', argv, false)).toBe(true);
    expect(await env.killHidden('veldr-it-helper', argv, true)).toBe(true);
    expect(await env.killHidden('veldr-it-helper', argv, false)).toBe(false);

    // Stopped through its own instance's op.
    const stopped = await s.request({ op: Op.HC, action: 'stop' }, { timeoutMs: 60_000 });
    expect(stopped.hc?.running).toBe(false);
  },
  120_000,
);

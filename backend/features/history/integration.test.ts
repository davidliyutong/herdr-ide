// Captures against a real herdr-core in an isolated session with its own
// state, home and configuration (the instance's socket of a test agent):
//
//	HC_TEST_BIN=/path/to/herdr-core bun test features/history/integration.test.ts
//
// (`bun backend/scripts/fetch-hc.ts --exe <file> <os>/<arch>` fetches the pinned
// one.) Without HC_TEST_BIN it skips.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { HistoryGeneration } from '#shared/proto/agentproto/index.ts';
import type { Terminal } from '#shared/proto/hc/index.ts';
import { call } from '#kernel/agent.ts';
import { dialHC } from '#machine/hidden.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { historyMachine } from './machine.ts';
import { restoredByCore } from './machine/paint.ts';
import { historyProtocol } from './protocol.ts';

const bin = process.env.HC_TEST_BIN ?? '';
let r: Rig | undefined;
let core: (...args: string[]) => { status: number | null; out: string };

beforeAll(async () => {
  if (!bin) return;
  r = await rig({ features: [historyMachine()] });
  const state = join(r.home, 's');
  const cfg = join(r.home, 'c');
  for (const d of [state, cfg]) mkdirSync(d, { mode: 0o700 });
  // The terminal core of the test agent's socket, in a session and with
  // state of its own: never the user's.
  const env = {
    HOME: r.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HC_SESSION: `${SLUG}-it`,
    HC_SOCKET: r.agent.hc.socket,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: cfg,
  };
  core = (...args) => {
    const p = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 45_000 });
    return { status: p.status, out: `${p.stdout}${p.stderr}` };
  };
  const started = core('server', 'start', '--json');
  if (started.status !== 0) throw new Error(`server start: ${started.out}`);
});

afterAll(async () => {
  if (!r) return;
  core('server', 'stop', '--json');
  await r.close();
});

test.skipIf(!bin)(
  'a terminal with history and a title is captured with the lines asked for, without the title; an unchanged one is not written again',
  async () => {
    const signal = AbortSignal.timeout(60_000);
    const conn = await dialHC(r!.agent.hc.socket, signal);
    try {
      const term = await conn.call<Terminal>('terminal.run', { argv: ['/bin/sh'], cwd: r!.home, size: { cols: 80, rows: 24 } }, { signal });
      const { stream } = await conn.attach({ terminal: term.address, cols: 80, rows: 24 }, { signal });
      stream.write(
        Buffer.from(
          "printf '\\033]2;it-title\\033\\\\'; i=1; while [ $i -le 1500 ]; do echo line-$i; i=$((i+1)); done; echo done-$((40+2))\r",
        ),
      );
      let out = Buffer.alloc(0);
      while (!out.includes('done-42')) {
        const o = await stream.recv(signal);
        if (o === null) throw new Error('the terminal ended');
        if (!('data' in o)) continue;
        out = Buffer.concat([out, o.data]).subarray(-8192);
        stream.ack(o.data.length);
      }
      stream.close();
      // The screen settles (the prompt after the output). Read without
      // history lines: never scrolling a program.
      let last = '';
      for (let i = 0; ; i++) {
        const screen = await conn.call<{ text: string }>('terminal.read', { terminal: term.address }, { signal });
        if (screen.text === last && last.includes('done-42')) break;
        if (i > 50) throw new Error(`the screen does not settle: ${JSON.stringify(screen.text)}`);
        last = screen.text;
        await new Promise((res) => setTimeout(res, 100));
      }

      const m = machineOf(r!.session);
      const p = { lines: 500, maxTerminals: 8, maxTotalBytes: 64 << 20, days: 1 };
      let res = await call(m, historyProtocol, 'capture', p);
      expect([res.captured, res.failed]).toEqual([1, 0]);
      const d = await call(m, historyProtocol, 'read', { terminal: term.address, generation: HistoryGeneration.Current });
      const data = d.data;
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]).toBe(0x18);
      for (const bad of ['\x1b]0;', '\x1b]1;', '\x1b]2;', '\x1b[?9001', 'it-title'])
        expect([bad, data.includes(bad)]).toEqual([bad, false]);
      // The grid is the terminal's own: without a viewer that types, the
      // core gave it its size for headless terminals.
      const now = await conn.call<Terminal>('terminal.get', { terminal: term.address }, { signal });
      expect([d.lines, d.cols, d.rows, d.pid]).toEqual([500, now.cols, now.rows, term.pid!]);
      // The history part, between the first screen clear and the one before
      // the screen: every line of it is one of the program's.
      const clearScreen = Buffer.from('\x1b[H\x1b[2J');
      const first = data.indexOf(clearScreen);
      const second = data.indexOf(clearScreen, first + clearScreen.length);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      const history = data.subarray(first + clearScreen.length, second).toString('latin1');
      expect(history.split('line-').length - 1).toBe(500);
      expect(restoredByCore(data)).toBe(false);

      // Nothing changed: nothing attached to, nothing written.
      res = await call(m, historyProtocol, 'capture', p);
      expect([res.skipped, res.captured]).toEqual([1, 0]);
      const again = await call(m, historyProtocol, 'read', { terminal: term.address, generation: HistoryGeneration.Current });
      expect(again.data.equals(data)).toBe(true);
      expect(again.at).toBe(d.at);
    } finally {
      conn.close();
    }
  },
  90_000,
);

// Program windows on a real display through the TypeScript machine side
// and the GUI helper (the Go agent's TestGUIWindows): the display started,
// a program's window announced with its terminal and its pid, streamed,
// clicked, typed into and closed, the keeper started and holding the
// display; on the GPU display too where the machine has Xwayland and a
// render node it may open. Linux with Xvfb; the X program is e2e/xclient
// (GUI_TEST_XCLIENT, else built with go):
//
//	bun test features/gui/integration.test.ts        (make it)
//	scripts/gui-it.sh                                (in Docker, from any host)
//
// Skips without Xvfb, a helper for this architecture or the X program.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { posix } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  GUIDisplay,
  GUIEnc,
  GUIMessage,
  parseFrameHeader,
  readGUI,
  writeGUI,
  type GUIEvent,
  type GUIStatus,
} from '#shared/proto/agentproto/index.ts';
import { machineOf, rig, until, type Rig } from '#machine/testing.ts';
import { machineAgent } from './agent.ts';
import { guiMachine } from './machine.ts';
import { lookPath } from './machine/gpu.ts';

const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const helperBin = posix.join(import.meta.dir, '..', '..', '..', 'scripts', 'gui-helper', 'bin', `gui-helper-linux-${arch}`);

/** The X program: GUI_TEST_XCLIENT, else e2e/xclient built now. */
function xclient(): string {
  if (process.env.GUI_TEST_XCLIENT) return process.env.GUI_TEST_XCLIENT;
  const dir = mkdtempSync('/tmp/gx-');
  temps.push(dir);
  const out = posix.join(dir, 'e2e-xclient');
  const r = spawnSync('go', ['build', '-o', out, './e2e/xclient'], {
    cwd: posix.join(import.meta.dir, '..', '..', '..'),
    encoding: 'utf8',
  });
  return r.status === 0 ? out : '';
}

const temps: string[] = [];
const rigs: Rig[] = [];
const kill: number[] = [];
afterAll(async () => {
  for (const pid of kill) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  for (const r of rigs) await r.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const linux = process.platform === 'linux';
const haveXvfb = linux && ((await lookPath('Xvfb')) !== '' || existsSync('/usr/bin/Xvfb'));
const haveHelper = existsSync(helperBin);
const xprog = linux && haveHelper ? xclient() : '';
const why = !linux
  ? 'Linux only'
  : !haveXvfb
    ? 'no Xvfb'
    : !haveHelper
      ? `no ${helperBin}`
      : !xprog
        ? 'no X program (GUI_TEST_XCLIENT, or go)'
        : '';
if (why) console.warn(`gui integration: skipped (${why})`);

async function guiRig(): Promise<Rig> {
  const bytes = readFileSync(helperBin);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const r = await rig({ features: [guiMachine({ helper: async () => ({ bytes, digest }) })] });
  rigs.push(r);
  return r;
}

/** The lines a program prints. */
function lines(p: ChildProcess): { all: string[]; next(prefix: string): Promise<string> } {
  const all: string[] = [];
  let buf = '';
  p.stdout!.setEncoding('utf8');
  p.stdout!.on('data', (s: string) => {
    buf += s;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    all.push(...parts);
  });
  let taken = 0;
  return {
    all,
    async next(prefix) {
      await until(() => all.length > taken, `the program to print ${prefix}`, 20_000);
      const l = all[taken++];
      expect(l.startsWith(prefix)).toBe(true);
      return l;
    },
  };
}

/** The first pixel of a PNG of RGB rows (the helper's: filter bytes per
 * row), as [r, g, b]. */
function pngPixel(png: Buffer, x: number, y: number): number[] {
  let off = 8;
  let w = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const n = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString();
    const data = png.subarray(off + 8, off + 8 + n);
    if (type === 'IHDR') w = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    off += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const row = w * 3;
  let prev = Buffer.alloc(row);
  let cur = Buffer.alloc(row);
  for (let r = 0; r <= y; r++) {
    const f = raw[r * (row + 1)];
    const src = raw.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
    for (let i = 0; i < row; i++) {
      const a = i >= 3 ? cur[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      cur[i] = (src[i] + pred) & 0xff;
    }
    [prev, cur] = [cur, prev];
  }
  return [...prev.subarray(x * 3, x * 3 + 3)];
}

async function windowsOn(kind: string) {
  const r = await guiRig();
  const m = machineOf(r.session);
  const signal = new AbortController().signal;
  const st: GUIStatus = await machineAgent.request(m, 'start', { args: [kind], signal, timeoutMs: 60_000 });
  const state = JSON.parse(readFileSync(posix.join(r.dirs.run, 'gui.json'), 'utf8'));
  kill.push(state.pid);
  expect(st.running).toBe(true);
  expect(st.kind).toBe(kind);

  const { conn } = await machineAgent.attach(m, signal);
  const events: GUIEvent[] = [];
  const frames: Array<{ h: ReturnType<typeof parseFrameHeader>; data: Buffer }> = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await readGUI(conn.reader);
        if (msg.kind === GUIMessage.JSON) events.push(JSON.parse(msg.payload.toString()));
        else frames.push({ h: parseFrameHeader(msg.payload), data: msg.payload.subarray(21) });
      }
    } catch {
      // ended
    }
  })();
  const send = (c: object) => writeGUI(conn.stream, GUIMessage.JSON, Buffer.from(JSON.stringify(c)));

  const prog = spawn(xprog, [], {
    env: {
      PATH: '/usr/bin:/bin',
      DISPLAY: st.display!,
      XAUTHORITY: st.xauthority!,
      HC_TERMINAL_ID: 't2',
      HC_TERMINAL_SOCKET: r.agent.hc.socket,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  kill.push(prog.pid!);
  const out = lines(prog);
  await until(() => events.some((e) => e.ev === 'window' && e.window?.title === 'e2e window'), 'the window', 20_000);
  const w = events.find((e) => e.ev === 'window' && e.window?.title === 'e2e window')!.window!;
  expect(w).toMatchObject({ w: 320, h: 200, terminal: 't2', pid: prog.pid });
  await out.next('mapped');

  // Watched: pictures, then once settled the lossless one, all red.
  await send({ cmd: 'watch', id: w.id });
  await until(() => frames.some((f) => f.h.window === w.id && f.h.enc === GUIEnc.PNG), 'a PNG frame', 20_000);
  const png = frames.find((f) => f.h.window === w.id && f.h.enc === GUIEnc.PNG)!;
  expect(png.h.layer).toBe(w.id);
  const [red, green, blue] = pngPixel(png.data, 10, 10);
  expect(red).toBeGreaterThan(200);
  expect(green).toBeLessThan(60);
  expect(blue).toBeLessThan(60);
  await send({ cmd: 'ack', id: w.id, seq: frames[frames.length - 1].h.seq });

  // Input coordinates are relative to the window.
  await send({ cmd: 'focus', id: w.id });
  await send({ cmd: 'button', id: w.id, x: 12, y: 34, button: 1, down: true });
  await send({ cmd: 'button', id: w.id, x: 12, y: 34, button: 1 });
  expect(await out.next('button')).toBe('button 1 12 34');
  await send({ cmd: 'key', id: w.id, keycode: 38, down: true });
  await send({ cmd: 'key', id: w.id, keycode: 38 });
  expect(await out.next('key')).toBe('key 38');

  // The keeper holds the display.
  await machineAgent.request(m, 'keep', { signal });
  await until(
    () =>
      existsSync(posix.join(r.dirs.host, 'gui-keep.log')) &&
      readFileSync(posix.join(r.dirs.host, 'gui-keep.log'), 'utf8').includes('keeping display'),
    'the keeper',
    10_000,
  );

  await send({ cmd: 'close', id: w.id });
  await out.next('delete');
  await until(() => events.some((e) => e.ev === 'gone' && e.id === w.id), 'the window to go');
  conn.stream.destroy();
  process.kill(state.pid, 'SIGTERM');
  await until(
    () => readFileSync(posix.join(r.dirs.host, 'gui-keep.log'), 'utf8').includes('the display ended'),
    'the keeper to leave',
    10_000,
  );
}

describe.skipIf(!!why)('a real display', () => {
  test('windows on Xvfb', async () => windowsOn(GUIDisplay.Xvfb), 90_000);

  const gpu =
    linux &&
    existsSync('/usr/bin/Xwayland') &&
    spawnSync('sh', ['-c', 'for n in /dev/dri/renderD*; do [ -r "$n" ] && [ -w "$n" ] && exit 0; done; exit 1']).status === 0;
  test.skipIf(!gpu)('windows on the GPU display', async () => windowsOn(GUIDisplay.Xwayland), 90_000);
});

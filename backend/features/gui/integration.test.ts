// Program windows on a real display through the TypeScript machine side
// and the GUI helper: the display started,
// a program's window announced with its terminal and its pid, streamed,
// clicked, typed into and closed, the keeper started and holding the
// display; on the GPU display too where the machine has Xwayland and a
// render node it may open. Linux with Xvfb; the X program is
// e2e/fakes/xclient.ts (GUI_TEST_XCLIENT, else compiled now with bun build
// --compile):
//
//	bun test features/gui/integration.test.ts        (make it)
//	scripts/gui-it.sh                                (in Docker, from any host)
//
// Skips without Xvfb, a helper for this architecture or the X program.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { gzipSync, inflateSync } from 'node:zlib';
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

/** The X program: GUI_TEST_XCLIENT, else e2e/fakes/xclient.ts compiled now. */
function xclient(): string {
  if (process.env.GUI_TEST_XCLIENT) return process.env.GUI_TEST_XCLIENT;
  const dir = mkdtempSync('/tmp/gx-');
  temps.push(dir);
  const out = posix.join(dir, 'e2e-xclient');
  const src = posix.join(import.meta.dir, '..', '..', '..', 'e2e', 'fakes', 'xclient.ts');
  // In the temporary directory: Bun leaves a .<hash>.bun-build copy of the
  // executable in its working directory.
  const r = spawnSync(process.execPath, ['build', '--compile', src, '--outfile', out], { cwd: dir, encoding: 'utf8' });
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

async function guiRig(o: Parameters<typeof guiMachine>[0] = {}): Promise<Rig> {
  const bytes = readFileSync(helperBin);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const r = await rig({ features: [guiMachine({ helper: async () => ({ bytes, digest }), ...o })] });
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

  // The Go agent's TestGPUDisplayFallsBack: an Xwayland that does not come
  // up (here one that exits at once), on a machine whose GPU's render node
  // opens, leaves the plain display, and the next start keeps it.
  test('the GPU display falls back to Xvfb', async () => {
    const dir = mkdtempSync('/tmp/gx-');
    temps.push(dir);
    writeFileSync(
      `${dir}/Xwayland`,
      "#!/bin/sh\ncase \"$1\" in -help) echo '-terminate [delay]';; *) echo 'no GPU today' >&2; exit 1;; esac\n",
      { mode: 0o755 },
    );
    const gpu = { nvidiaProc: `${dir}/proc`, drmSys: `${dir}/sys`, drmDev: `${dir}/dev` };
    mkdirSync(gpu.drmDev, { recursive: true });
    writeFileSync(`${gpu.drmDev}/renderD128`, '', { mode: 0o600 });
    mkdirSync(`${dir}/devices/0000:00:02.0`, { recursive: true });
    mkdirSync(`${dir}/drivers/i915`, { recursive: true });
    symlinkSync(`${dir}/drivers/i915`, `${dir}/devices/0000:00:02.0/driver`);
    mkdirSync(`${gpu.drmSys}/renderD128`, { recursive: true });
    symlinkSync(`${dir}/devices/0000:00:02.0`, `${gpu.drmSys}/renderD128/device`);
    const r = await guiRig({ path: `${dir}:/usr/bin:/bin`, gpu });
    const m = machineOf(r.session);
    const signal = new AbortController().signal;
    expect((await machineAgent.request(m, 'status', { signal })).gpu_display).toBe(true);
    const st = await machineAgent.request(m, 'start', { signal, timeoutMs: 60_000 });
    const state = JSON.parse(readFileSync(posix.join(r.dirs.run, 'gui.json'), 'utf8'));
    kill.push(state.pid);
    expect(st).toMatchObject({ running: true, kind: GUIDisplay.Xvfb });
    expect(st.gpu_display).toBeUndefined();
    expect(readFileSync(posix.join(r.dirs.host, 'xwayland.log'), 'utf8')).toContain('no GPU today');
    // Asked again, the display that runs is kept.
    await machineAgent.request(m, 'start', { signal, timeoutMs: 60_000 });
    expect(JSON.parse(readFileSync(posix.join(r.dirs.run, 'gui.json'), 'utf8')).pid).toBe(state.pid);
    process.kill(state.pid, 'SIGTERM');
  }, 60_000);

  // Video through the helper with a stand-in encoder (the protocol of
  // scripts/encoder, VP8 only): probed, installed by digest, and a window
  // that keeps changing sent as a stream that ends when nobody watches.
  test('video through a stand-in encoder', async () => {
    const script = Buffer.from(STAND_IN_ENCODER);
    const digest = createHash('sha256').update(script).digest('hex');
    const r = await guiRig();
    const m = machineOf(r.session);
    const signal = new AbortController().signal;
    const vs = await machineAgent.installVideo(m, digest, gzipSync(script), { signal, timeoutMs: 60_000 });
    expect(vs?.video).toBe(true);
    expect(vs?.video_encoders).toEqual(['vp8']);
    const st = await machineAgent.request(m, 'start', { args: [GUIDisplay.Xvfb], signal, timeoutMs: 60_000 });
    kill.push(JSON.parse(readFileSync(posix.join(r.dirs.run, 'gui.json'), 'utf8')).pid);
    const { conn } = await machineAgent.attach(m, signal);
    const events: GUIEvent[] = [];
    const encs: number[] = [];
    const send = (c: object) => writeGUI(conn.stream, GUIMessage.JSON, Buffer.from(JSON.stringify(c)));
    void (async () => {
      try {
        for (;;) {
          const msg = await readGUI(conn.reader);
          if (msg.kind === GUIMessage.JSON) events.push(JSON.parse(msg.payload.toString()));
          else {
            const h = parseFrameHeader(msg.payload);
            encs.push(h.enc);
            void send({ cmd: 'ack', id: h.window, seq: h.seq });
          }
        }
      } catch {
        // ended
      }
    })();
    const prog = spawn(xprog, ['-anim'], {
      env: { PATH: '/usr/bin:/bin', DISPLAY: st.display!, XAUTHORITY: st.xauthority! },
      stdio: 'ignore',
    });
    kill.push(prog.pid!);
    await until(() => events.some((e) => e.ev === 'window' && e.window?.w === 640), 'the moving window', 20_000);
    const w = events.find((e) => e.ev === 'window' && e.window?.w === 640)!.window!;
    await send({ cmd: 'watch', id: w.id, codecs: ['avc1', 'vp8'] });
    await until(() => events.some((e) => e.ev === 'video' && e.video?.codec === 'vp8'), 'a VP8 stream', 20_000);
    expect(events.find((e) => e.ev === 'video' && e.video?.codec === 'vp8')!.video).toMatchObject({
      window: w.id,
      encoder: 'libvpx',
      w: 640,
      h: 360,
    });
    await until(() => encs.filter((e) => e === GUIEnc.Video).length >= 10, 'video frames', 20_000);
    expect(encs).toContain(GUIEnc.VideoKey);
    await send({ cmd: 'unwatch', id: w.id });
    await until(() => events.some((e) => e.ev === 'video' && e.video?.window === w.id && !e.video.codec), 'the stream to end', 15_000);
    prog.kill();
    conn.stream.destroy();
  }, 90_000);
});

/** A stand-in for scripts/encoder: VP8 only, a packet per frame. */
const STAND_IN_ENCODER = `#!/usr/bin/env bun
const a = process.argv.slice(2);
const arg = (k) => a[a.indexOf(k) + 1];
const w = Number(arg('-w')), h = Number(arg('-h')), kinds = arg('-kinds').split(',');
if (!kinds.includes('vp8')) {
  process.stdout.write('error no encoder for ' + kinds + '\\n');
  process.exit(0);
}
process.stdout.write('ok libvpx ' + w + ' ' + h + '\\n');
const need = 4 + w * h * 4;
let parts = [], have = 0, n = 0;
for await (const c of process.stdin) {
  parts.push(c);
  have += c.length;
  while (have >= need) {
    let buf = Buffer.concat(parts);
    const key = (buf.readUInt32LE(0) & 1) || n === 0 ? 1 : 0;
    buf = buf.subarray(need);
    parts = [buf];
    have = buf.length;
    const p = Buffer.from('frame ' + n++);
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32LE(p.length, 0);
    hdr.writeUInt32LE(key, 4);
    process.stdout.write(Buffer.concat([hdr, p]));
  }
}
`;

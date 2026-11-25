// Drives program windows of the TypeScript machine side on a machine of the
// matrix as a hub does over ssh: `node dial` of the machine executable
// (MACHINE_EXE), a yamux session over its standard input and output, the
// agent protocol's op gui on it. It checks that the display starts (the
// machine's Xvfb), that a program's window (XCLIENT, e2e/xclient) is
// announced with its terminal and its process through the GUI helper the
// executable carries, that its pixels arrive, that clicks and keys reach
// it and closing closes it, and that the keeper holds the display while a
// server listens on the terminal core's socket; then the same on the GPU
// display where the machine has Xwayland and a render node it may open.
// build.sh bundles it into driver.js; run.sh runs it with the machine
// executable acting as Bun (BUN_BE_BUN=1), which the node does not get.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  GUIEnc,
  GUIMessage,
  Op,
  parseFrameHeader,
  readGUI,
  writeGUI,
  type GUIEvent,
} from '../../../../backend/shared/proto/agentproto/index.ts';
import { pairDuplex } from '../../../../backend/shared/proto/yamux.ts';
import { Session } from '../../../../backend/kernel/machines/transport/session.ts';
import { machineOf } from '../../../../backend/machine/testing.ts';
import { pickEnv } from '../../../../backend/features/gui/state.ts';
import { machineAgent } from '../../../../backend/features/gui/agent.ts';
import { withoutForeignRuntimeVars } from '../../../../backend/shared/lib/bunenv.ts';

const home = process.env.HOME!;
const instance = 'gui-matrix';
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const step = async (what: string, f: () => Promise<void> | void) => {
  try {
    await f();
  } catch (e) {
    check(false, `${what}: ${(e as Error).stack ?? e}`);
  }
};
const until = async (cond: () => boolean, what: string, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const exe = process.env.MACHINE_EXE!;
const xclient = process.env.XCLIENT!;
const env = withoutForeignRuntimeVars({ ...process.env, HOME: home });
const dial = spawn(exe, ['node', 'dial', '--instance', instance, '--client', 'gui-matrix-driver'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
});
const session = new Session(pairDuplex(dial.stdout!, dial.stdin!), () => dial.kill());
const m = machineOf(session);
const signal = new AbortController().signal;
const hello = await session.request({ op: Op.Hello }, { timeoutMs: 60_000 });
const run = hello.info!.run_dir;
const host = join(hello.info!.data_dir, 'hosts', readdirSync(join(hello.info!.data_dir, 'hosts'))[0] ?? '');
console.log(`INFO ${exe}, run ${run}`);

// A stand-in for the terminal core: a server of this user on its socket,
// which the keeper follows.
const hc = createServer((c) => c.destroy());
await new Promise<void>((r) => hc.listen(join(run, 'hc.sock'), () => r()));

/** Pixel (x, y) of the helper's RGB PNG. */
function pngPixel(png: Buffer, x: number, y: number): number[] {
  let off = 8;
  let w = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const n = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString();
    if (type === 'IHDR') w = png.readUInt32BE(off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + n));
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
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      cur[i] = (src[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 0xff;
    }
    [prev, cur] = [cur, prev];
  }
  return [...prev.subarray(x * 3, x * 3 + 3)];
}

/** OpenGL and Vulkan of programs on the GPU display (GUI_MATRIX_GL=1, where
 * glxinfo, glxgears, vulkaninfo and vkcube are installed): direct
 * rendering on the GPU, a few seconds of glxgears, Vulkan presenting. */
function graphics(display: string, xauthority: string, displayUUID: string): void {
  const genv = { PATH: '/usr/bin:/bin', HOME: home, DISPLAY: display, XAUTHORITY: xauthority };
  const run = (argv: string[], ms: number, extra: Record<string, string> = {}) => {
    const r = spawnSync(argv[0], argv.slice(1), { env: { ...genv, ...extra }, encoding: 'utf8', timeout: ms });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const pick = (out: string, re: RegExp) =>
    out
      .split('\n')
      .find((l) => re.test(l))
      ?.trim() ?? '';
  const g = run(['glxinfo', '-B'], 15_000);
  const renderer = pick(g.out, /OpenGL renderer string/);
  check(
    g.code === 0 && /direct rendering: Yes/.test(g.out) && !/llvmpipe/.test(renderer),
    `GLX on the GPU display: ${pick(g.out, /direct rendering/)}; ${renderer}; ${pick(g.out, /OpenGL version string/)}`,
  );
  // glxgears prints its rate every 5 s: one report, then it is ended. Not
  // waiting for vertical sync, its rate tells whether the driver shares its
  // buffers with the display (thousands a second) or copies them.
  const gears = run(['timeout', '-s', 'INT', '7', 'glxgears', '-info'], 15_000, { __GL_SYNC_TO_VBLANK: '0', vblank_mode: '0' });
  check(/frames in 5\.0 seconds/.test(gears.out), `glxgears: ${pick(gears.out, /frames in/)}`);
  // Vulkan on the display's GPU (vkcube takes the first device otherwise),
  // found by its UUID in vulkaninfo's summary.
  const v = run(['vulkaninfo', '--summary'], 20_000);
  const devices = v.out.split(/^GPU(\d+):/m).slice(1);
  let n = -1;
  for (let i = 0; i + 1 < devices.length; i += 2) {
    const uuid = /deviceUUID\s*=\s*([0-9a-f-]+)/.exec(devices[i + 1])?.[1] ?? '';
    if (displayUUID && displayUUID.toLowerCase().endsWith(uuid) && uuid) n = Number(devices[i]);
  }
  console.log(
    `INFO vulkaninfo: ${v.out
      .split('\n')
      .filter((l) => /^GPU\d|deviceName|deviceUUID/.test(l.trim()))
      .map((l) => l.trim())
      .join('; ')}`,
  );
  if (n < 0) return console.log(`INFO vkcube not tried: no Vulkan device of the display's GPU ${displayUUID}`);
  const cube = run(['vkcube', '--c', '300', '--gpu_number', String(n)], 30_000);
  check(
    cube.code === 0,
    `vkcube presented 300 frames on the GPU display from Vulkan device ${n} (exit ${cube.code}) ${pick(cube.out, /Selected GPU/)}`,
  );
}

async function windows(kind: string): Promise<void> {
  const t0 = Date.now();
  const st = await machineAgent.request(m, 'start', { args: [kind], signal, timeoutMs: 60_000 });
  check(st.running === true && st.kind === kind, `the ${kind} display runs on ${st.display} (${Date.now() - t0} ms; ${st.error ?? 'ok'})`);
  if (st.kind !== kind) {
    const log = join(host, kind === 'xwayland' ? 'xwayland.log' : 'xvfb.log');
    if (existsSync(log)) console.log(`INFO ${log}: ${readFileSync(log, 'utf8').trim().slice(-600)}`);
    return;
  }
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
  const prog = spawn(xclient, [], {
    env: {
      PATH: '/usr/bin:/bin',
      DISPLAY: st.display!,
      XAUTHORITY: st.xauthority!,
      HC_TERMINAL_ID: 't9',
      HC_TERMINAL_SOCKET: join(run, 'hc.sock'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  prog.stdout!.setEncoding('utf8');
  prog.stdout!.on('data', (s: string) => lines.push(...s.split('\n').filter(Boolean)));
  try {
    await until(() => events.some((e) => e.ev === 'window' && e.window?.title === 'e2e window'), 'the window');
    const w = events.find((e) => e.ev === 'window' && e.window?.title === 'e2e window')!.window!;
    check(
      w.w === 320 && w.h === 200 && w.terminal === 't9' && w.pid === prog.pid,
      `the window announced with its terminal and process: ${JSON.stringify(w)}`,
    );
    await send({ cmd: 'watch', id: w.id });
    await until(() => frames.some((f) => f.h.window === w.id && f.h.enc === GUIEnc.PNG), 'a lossless frame');
    const jpeg = frames.find((f) => f.h.enc === GUIEnc.JPEG);
    if (jpeg) check(jpeg.data[0] === 0xff && jpeg.data[1] === 0xd8, `a JPEG frame (${jpeg.data.length} bytes)`);
    const px = pngPixel(frames.find((f) => f.h.enc === GUIEnc.PNG)!.data, 10, 10);
    check(px[0] > 200 && px[1] < 60 && px[2] < 60, `its pixels arrive: ${px}`);
    await send({ cmd: 'ack', id: w.id, seq: frames[frames.length - 1].h.seq });
    if (kind === 'xwayland' && process.env.GUI_MATRIX_GL === '1')
      graphics(st.display!, st.xauthority!, (st.gpus ?? []).find((g) => g.minor === st.display_minor)?.uuid.replace(/^GPU-/, '') ?? '');
    await send({ cmd: 'focus', id: w.id });
    await send({ cmd: 'button', id: w.id, x: 12, y: 34, button: 1, down: true });
    await send({ cmd: 'button', id: w.id, x: 12, y: 34, button: 1 });
    await send({ cmd: 'key', id: w.id, keycode: 38, down: true });
    await send({ cmd: 'key', id: w.id, keycode: 38 });
    await until(() => lines.includes('key 38'), 'the key');
    check(lines.includes('button 1 12 34') && lines.includes('key 38'), `input reaches the program: ${lines.join(', ')}`);
    await machineAgent.request(m, 'keep', { signal });
    const keepLog = join(host, 'gui-keep.log');
    await until(() => existsSync(keepLog) && readFileSync(keepLog, 'utf8').includes('keeping display'), 'the keeper', 10_000);
    check(true, 'the keeper holds the display');
    await send({ cmd: 'close', id: w.id });
    await until(() => lines.includes('delete') && events.some((e) => e.ev === 'gone' && e.id === w.id), 'the window to close');
    check(true, 'closing closes the program window');
    conn.stream.destroy();
    const state = JSON.parse(readFileSync(join(run, 'gui.json'), 'utf8'));
    process.kill(state.pid, 'SIGTERM');
    await until(() => readFileSync(keepLog, 'utf8').includes('the display ended'), 'the keeper to leave', 15_000);
    check(true, 'the keeper leaves with the display');
    // The next display starts on the same number.
    await until(() => !existsSync(`/tmp/.X11-unix/X${state.display}`), 'the socket to go', 10_000).catch(() => {});
  } finally {
    prog.kill();
  }
}

let plain = false;
await step('status', async () => {
  let st = await machineAgent.request(m, 'status', { signal });
  check(st.supported && !!st.display, `status: ${JSON.stringify(st)}`);
  if (!st.xvfb && st.installable) {
    // The distribution's package, fetched and unpacked in user space.
    st = await machineAgent.request(m, 'install', { signal, timeoutMs: 300_000 });
    check(!!st.xvfb, `Xvfb fetched with apt-get download: ${st.xvfb}`);
  }
  plain = !!st.xvfb;
});
if (plain) await step('windows on Xvfb', () => windows('xvfb'));
else check(false, 'no Xvfb on this machine, and none can be fetched');
const render = existsSync('/dev/dri') && readdirSync('/dev/dri').some((n) => n.startsWith('renderD'));
const st = await machineAgent.request(m, 'status', { signal });
const noGPU = process.env.GUI_MATRIX_NO_GPU === '1';
if (st.gpu_display && !noGPU) await step('windows on the GPU display', () => windows('xwayland'));
else if (st.gpu_display) console.log('INFO the GPU display not tried (GUI_MATRIX_NO_GPU)');
else console.log(`INFO no GPU display here (Xwayland ${existsSync('/usr/bin/Xwayland')}, render nodes ${render})`);

// Video: the encoder (ENCODER, scripts/build-ffmpeg.sh's encoder.gz) put on
// the machine as the hub pushes it, the kinds it makes here, and a window
// that keeps changing sent as a video stream.
async function video(): Promise<void> {
  const gz = readFileSync(process.env.ENCODER!);
  const digest = createHash('sha256').update(gunzipSync(gz)).digest('hex');
  const t0 = Date.now();
  const vs = await machineAgent.installVideo(m, digest, gz, { signal, timeoutMs: 120_000 });
  check(!!vs?.video, `the encoder installed and probed (${Date.now() - t0} ms): makes ${JSON.stringify(vs?.video_encoders ?? [])}`);
  if (!vs?.video_encoders?.length) return;
  const st = await machineAgent.request(m, 'start', { args: [process.env.VIDEO_DISPLAY ?? 'xvfb'], signal, timeoutMs: 60_000 });
  const { conn } = await machineAgent.attach(m, signal);
  const events: GUIEvent[] = [];
  let videoFrames = 0;
  let keyFrames = 0;
  let bytes = 0;
  const send = (c: object) => writeGUI(conn.stream, GUIMessage.JSON, Buffer.from(JSON.stringify(c)));
  void (async () => {
    try {
      for (;;) {
        const msg = await readGUI(conn.reader);
        if (msg.kind === GUIMessage.JSON) {
          events.push(JSON.parse(msg.payload.toString()));
          continue;
        }
        const h = parseFrameHeader(msg.payload);
        if (h.enc === GUIEnc.Video || h.enc === GUIEnc.VideoKey) {
          videoFrames++;
          bytes += msg.payload.length - 21;
          if (h.enc === GUIEnc.VideoKey) keyFrames++;
        }
        // Drawn at once: acknowledged, as a browser does.
        void send({ cmd: 'ack', id: h.window, seq: h.seq });
      }
    } catch {
      // ended
    }
  })();
  const prog = spawn(xclient, ['-anim'], {
    env: { PATH: '/usr/bin:/bin', DISPLAY: st.display!, XAUTHORITY: st.xauthority! },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await until(() => events.some((e) => e.ev === 'window' && e.window?.w === 640), 'the moving window');
    const w = events.find((e) => e.ev === 'window' && e.window?.w === 640)!.window!;
    await send({ cmd: 'watch', id: w.id, codecs: vs.video_encoders });
    await until(() => events.some((e) => e.ev === 'video' && !!e.video?.codec), 'a video stream', 30_000);
    const v = events.find((e) => e.ev === 'video' && !!e.video?.codec)!.video!;
    const at = Date.now();
    const from = videoFrames;
    await new Promise((r) => setTimeout(r, 3000));
    const fps = ((videoFrames - from) * 1000) / (Date.now() - at);
    check(
      videoFrames > 30 && keyFrames >= 1,
      `sent as video by ${v.encoder}, ${v.codec} ${v.w}x${v.h}: ${videoFrames} frames, ${keyFrames} key, ${fps.toFixed(0)} fps, ${(bytes / videoFrames / 1024).toFixed(1)} KiB a frame`,
    );
    const stats = events.filter((e) => e.ev === 'stats').pop()?.stats;
    if (stats) console.log(`INFO stats ${JSON.stringify(stats)}`);
    if (vs.video_encoders.includes('vp8') && v.codec !== 'vp8') {
      // The viewers now decode VP8 only: a new stream of that kind.
      await send({ cmd: 'codecs', id: w.id, codecs: ['vp8'] });
      await until(() => events.some((e) => e.ev === 'video' && e.video?.codec === 'vp8'), 'a VP8 stream', 30_000);
      const n = videoFrames;
      await new Promise((r) => setTimeout(r, 2000));
      const vp8 = events.find((e) => e.ev === 'video' && e.video?.codec === 'vp8')!.video!;
      check(videoFrames - n > 20, `then as ${vp8.encoder} ${vp8.codec}: ${((videoFrames - n) / 2).toFixed(0)} fps`);
    }
    await send({ cmd: 'unwatch', id: w.id });
    await until(() => events.some((e) => e.ev === 'video' && e.video?.window === w.id && !e.video.codec), 'the stream to end', 15_000);
    check(true, 'the stream ends when nobody watches');
  } finally {
    prog.kill();
    conn.stream.destroy();
    const state = JSON.parse(readFileSync(join(run, 'gui.json'), 'utf8'));
    process.kill(state.pid, 'SIGTERM');
  }
}
if (process.env.ENCODER && existsSync(process.env.ENCODER) && !noGPU) await step('video', video);
else console.log('INFO video not tried (no encoder in ENCODER, or GUI_MATRIX_NO_GPU)');

// The GPU selection library, written from the copy the build carries and
// checked by the loader.
await step('gpupick', async () => {
  const st = await machineAgent.request(m, 'pick', { signal, timeoutMs: 30_000 });
  const mode = st.pick ? statSync(st.pick).mode & 0o777 : 0;
  check(
    !!st.pick && mode === 0o600,
    `the GPU selection library installed: ${st.pick} (${mode.toString(8)}); GPUs ${JSON.stringify(st.gpus ?? [])}`,
  );
  // With several NVIDIA GPUs: a program of a pane with gpupick's
  // environment (as the hub gives it) and CUDA_VISIBLE_DEVICES sees only
  // that GPU: its device node opens, the others' do not, and NVML lists it
  // alone.
  const env = pickEnv(true, st);
  const gpus = st.gpus ?? [];
  if (!env) return console.log(`INFO gpupick's restriction not tried: ${gpus.length} NVIDIA GPUs`);
  const want = gpus[Number(process.env.GUI_MATRIX_PICK ?? '0')] ?? gpus[0];
  const script = `for n in ${gpus.map((g) => g.minor).join(' ')}; do r=$( (: < /dev/nvidia$n) 2>&1 ) && echo "$n open" || echo "$n hidden"; done; echo "CVD=$CUDA_VISIBLE_DEVICES KEEP=$GPUPICK_KEEP"; nvidia-smi -L 2>&1`;
  const r = spawnSync('/bin/sh', ['-c', script], {
    env: { PATH: '/usr/bin:/bin', HOME: home, ...env, CUDA_VISIBLE_DEVICES: String(want.index) },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const opened = out
    .split('\n')
    .filter((l) => / open$/.test(l))
    .map((l) => Number(l.split(' ')[0]));
  const listed = out.split('\n').filter((l) => /^GPU \d+:/.test(l));
  console.log(
    `INFO gpupick with CUDA_VISIBLE_DEVICES=${want.index} (${want.uuid}, minor ${want.minor}): ${out.trim().replaceAll('\n', ' | ')}`,
  );
  check(
    opened.length === 1 && opened[0] === want.minor && listed.length === 1 && listed[0].includes(want.uuid),
    `gpupick leaves the program only GPU ${want.index}: device ${opened.join(',')} opens, nvidia-smi lists ${listed.length}`,
  );
});

hc.close();
session.close();
const stop = Bun.spawnSync([exe, 'node', 'stop', '--instance', instance], { env });
check(stop.exitCode === 0, `node stop: ${stop.stdout.toString().trim()}`);
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);

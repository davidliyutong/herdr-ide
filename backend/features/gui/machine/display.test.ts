// The display's files, numbers and GPUs (the Go agent's gui_test.go and
// guigpu_test.go): the cookie rotated at each start and private, the
// display number kept only while nothing of another user is on it, the
// socket directory's check, unpacked Xvfb packages and their retention,
// shells recognized from their environment, the GPUs from the driver's
// description, the kind of display wanted, the GUI helper placed only as
// its digest says, the messages to the helper laid out as it reads them.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { posix } from 'node:path';
import { CORE_BIN } from '#shared/lib/brand.ts';
import { Display, FIRST_DISPLAY, VERSION_RETENTION_MS, parseXauth, rootOnly } from './display.ts';
import { gpuNode, nvidiaGPUs, type GPUPaths } from './gpu.ts';
import { HelperFile, JOB_LEN, STAGING_RETENTION_MS, decode, encodeJobs, helperRoot, Out, pruneHelpers } from './helper.ts';

const linux = process.platform === 'linux';
const temps: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync('/tmp/gd-');
  temps.push(d);
  return d;
};

function display(o: Partial<ConstructorParameters<typeof Display>[0]> = {}) {
  const home = tmp();
  const run = posix.join(home, 'run');
  const host = posix.join(home, '.d', 'hosts', 'h1');
  mkdirSync(run, { recursive: true, mode: 0o700 });
  mkdirSync(host, { recursive: true });
  const xTmp = tmp();
  mkdirSync(`${xTmp}/.X11-unix`, { mode: 0o1777 });
  chmodSync(`${xTmp}/.X11-unix`, 0o1777);
  const d = new Display({
    home,
    host,
    run,
    hcSocket: posix.join(run, 'hc.sock'),
    environ: () => ({ PATH: '/usr/bin:/bin' }),
    logger: () => {},
    helper: async () => '/nonexistent',
    xTmp,
    path: tmp(),
    linux: true,
    ...o,
  });
  return { d, home, run, xTmp };
}

test('each start writes a new private cookie for both files', async () => {
  const { d } = display();
  await (d as unknown as { newCookie(n: number): Promise<void> }).newCookie(21);
  const server = readFileSync(d.serverAuthPath());
  const c1 = parseXauth(server)!;
  expect(c1).toHaveLength(16);
  expect(parseXauth(readFileSync(d.xauthPath()))).toEqual(c1);
  for (const p of [d.serverAuthPath(), d.xauthPath()]) expect(statSync(p).mode & 0o777).toBe(0o600);
  // FamilyWild, address empty, display 21, MIT-MAGIC-COOKIE-1.
  expect([...server.subarray(0, 10)]).toEqual([0xff, 0xff, 0, 0, 0, 2, 0x32, 0x31, 0, 18]);
  await (d as unknown as { newCookie(n: number): Promise<void> }).newCookie(21);
  expect(parseXauth(readFileSync(d.serverAuthPath()))).not.toEqual(c1);
  expect(await d.serverAuth()).toBe(d.serverAuthPath());
});

// A reservation is kept only while nothing of another user's, and no other
// server, is on the number: another user could pose as the X server.
test('the display number', async () => {
  const { d } = display();
  const n = await d.locked(() => d.display());
  expect(n).toBe(FIRST_DISPLAY);
  expect(await d.locked(() => d.display())).toBe(n);
  const me = process.getuid!();
  const other = me + 1;
  expect(await d.usable(n, { display: 0 }, me)).toBe(true);
  // Files of another user (played by another uid) make it unusable.
  writeFileSync(d.xLock(n), '         0\n');
  expect(await d.usable(n, { display: 0 }, other)).toBe(false);
  expect(await d.usable(n, { display: 0 }, me)).toBe(true);
  // A live lock of another server of ours moves the reservation.
  writeFileSync(d.xLock(n), `${String(process.pid).padStart(10)}\n`);
  expect(await d.locked(() => d.display())).not.toBe(n);
  rmSync(d.xLock(n));
  if (!linux) return; // peer credentials of the display's sockets: Linux
  // A listener counts only when it is the server this instance started.
  const listen = (path: string) =>
    new Promise<void>((res) => {
      const s = createServer((c) => c.destroy());
      servers.push(s);
      s.listen(path, () => res());
    });
  await listen(d.xSocket(n));
  expect(await d.usable(n, { display: 0 }, me)).toBe(false);
  expect(await d.usable(n, { display: 0, pid: process.pid }, other)).toBe(false);
  expect(await d.usable(n, { display: n, pid: process.pid }, me)).toBe(true);
  await d.writeState({ display: n, pid: 999999999 });
  expect(await d.running(n)).toBe(false); // a server this instance did not start
  await d.writeState({ display: n, pid: process.pid });
  // Without its abstract socket, which anyone could take.
  expect(await d.running(n)).toBe(false);
  await listen('\0' + d.xSocket(n));
  expect(await d.running(n)).toBe(true);
});

// The socket directory must not be a link or an unprotected directory.
test('the socket directory', async () => {
  const { d, xTmp } = display();
  const dir = `${xTmp}/.X11-unix`;
  expect(await d.x11DirSafe()).toBe(true);
  chmodSync(dir, 0o777);
  expect(await d.x11DirSafe()).toBe(false);
  chmodSync(dir, 0o770);
  expect(await d.x11DirSafe()).toBe(false);
  chmodSync(dir, 0o755);
  expect(await d.x11DirSafe()).toBe(true);
  rmSync(dir, { recursive: true });
  symlinkSync(tmp(), dir);
  expect(await d.x11DirSafe()).toBe(false);
  await expect(d.locked(() => d.display())).rejects.toThrow('sticky bit');
});

test('unpacked packages are found, the old ones pruned', async () => {
  if (existsSync('/usr/bin/Xvfb') || existsSync('/usr/local/bin/Xvfb')) return; // installed system-wide
  const { d } = display();
  const exe = (dir: string) => {
    mkdirSync(posix.join(dir, 'usr', 'bin'), { recursive: true });
    writeFileSync(posix.join(dir, 'usr', 'bin', 'Xvfb'), '#!/bin/sh\n', { mode: 0o755 });
  };
  const old = posix.join(d.root(), '1.0');
  const cur = posix.join(d.root(), '2.0');
  const staging = posix.join(d.root(), '.fetch-x');
  exe(old);
  exe(cur);
  mkdirSync(staging);
  const past = (Date.now() - VERSION_RETENTION_MS - 3600_000) / 1000;
  utimesSync(old, past, past);
  utimesSync(staging, past, past);
  expect(await d.findXvfb()).toBe(posix.join(cur, 'usr', 'bin', 'Xvfb'));
  // Housekeeping removes only downloads that did not finish.
  await d.prune('', Date.now(), true);
  expect(existsSync(staging)).toBe(false);
  expect(existsSync(old)).toBe(true);
  await d.prune(cur);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(cur)).toBe(true);
});

test('shells started with the display are recognized', async () => {
  if (!linux) return; // reads /proc
  const { d } = display();
  const start = (display: string) => spawn('sleep', ['30'], { env: { ...process.env, DISPLAY: display } });
  const a = start(':77');
  const b = start(':78');
  try {
    for (const c of [a, b]) {
      const deadline = Date.now() + 5000;
      while ((await Bun.file(`/proc/${c.pid}/environ`).bytes()).length === 0 && Date.now() < deadline) await Bun.sleep(5);
    }
    const got = await d.shells([String(a.pid), String(b.pid), 'x', '1'], ':77');
    expect(got).toEqual([
      { pid: a.pid!, comm: 'sleep', display: true },
      { pid: b.pid!, comm: 'sleep' },
    ]);
  } finally {
    a.kill();
    b.kill();
  }
});

test('libraries preloaded into panes must be root-owned all the way up', async () => {
  const lib = posix.join(tmp(), 'libvglfaker.so');
  writeFileSync(lib, '');
  if (process.getuid!() !== 0) expect(await rootOnly(lib)).toBeNull();
  const sh = await rootOnly('/bin/sh');
  if (sh) expect(posix.isAbsolute(sh)).toBe(true);
});

/** The kernel's description of a machine's GPUs below a directory: NVIDIA
 * ones as "pci=minor", render nodes as "pci=driver" (renderD128 and up,
 * regular files that open). */
function fakeGPUs(gpus: string[], nodes: string[]): GPUPaths {
  const dir = tmp();
  const p = { nvidiaProc: `${dir}/proc`, drmSys: `${dir}/sys`, drmDev: `${dir}/dev` };
  mkdirSync(p.nvidiaProc, { recursive: true });
  gpus.forEach((g, i) => {
    const [pci, minor] = g.split('=');
    mkdirSync(`${p.nvidiaProc}/${pci}`, { recursive: true });
    const uuid = `GPU-${String(i).padStart(8, '0')}-ef14-0f75-9eae-00d68420e0d7`;
    writeFileSync(
      `${p.nvidiaProc}/${pci}/information`,
      `Model: \t\t NVIDIA RTX PRO 6000\nIRQ:   \t\t 292\nGPU UUID: \t ${uuid}\nBus Location: \t ${pci}\nDevice Minor: \t ${minor}\nGPU Excluded:\t No\n`,
    );
  });
  mkdirSync(p.drmDev, { recursive: true });
  nodes.forEach((n, i) => {
    const [pci, driver] = n.split('=');
    const name = `renderD${128 + i}`;
    writeFileSync(`${p.drmDev}/${name}`, '', { mode: 0o600 });
    const dev = `${dir}/devices/${pci}`;
    const drv = `${dir}/drivers/${driver}`;
    mkdirSync(dev, { recursive: true });
    mkdirSync(drv, { recursive: true });
    symlinkSync(drv, `${dev}/driver`);
    mkdirSync(`${p.drmSys}/${name}`, { recursive: true });
    symlinkSync(dev, `${p.drmSys}/${name}/device`);
  });
  return p;
}

describe('GPUs', () => {
  // NVIDIA GPUs are listed in bus order with the driver's own numbering;
  // the display draws with the driver's first one, whose render node need
  // not be the first.
  test('the display GPU', async () => {
    let p = fakeGPUs(
      ['0000:11:00.0=1', '0000:61:00.0=0', '0000:91:00.0=3', '0000:E1:00.0=2'],
      ['0000:61:00.0=nvidia', '0000:11:00.0=nvidia', '0000:e1:00.0=nvidia', '0000:91:00.0=nvidia'],
    );
    const gpus = await nvidiaGPUs(p);
    expect(gpus).toHaveLength(4);
    expect(gpus[1]).toMatchObject({ index: 1, minor: 0, pci: '0000:61:00.0' });
    expect(gpus[3].pci).toBe('0000:e1:00.0');
    expect(gpus[0]).toMatchObject({ uuid: 'GPU-00000000-ef14-0f75-9eae-00d68420e0d7', model: 'NVIDIA RTX PRO 6000' });
    expect(await gpuNode(gpus, p)).toEqual({ node: `${p.drmDev}/renderD128`, nvidia: true, minor: 0 });
    // Its node cannot be opened: the first one that can.
    rmSync(`${p.drmDev}/renderD128`);
    expect(await gpuNode(gpus, p)).toEqual({ node: `${p.drmDev}/renderD129`, nvidia: true, minor: 1 });
    // No NVIDIA GPU: the first render node.
    p = fakeGPUs([], ['0000:00:02.0=i915', '0000:01:00.0=amdgpu']);
    expect(await gpuNode(await nvidiaGPUs(p), p)).toEqual({ node: `${p.drmDev}/renderD128`, nvidia: false });
    p = fakeGPUs([], []);
    expect((await gpuNode(await nvidiaGPUs(p), p)).node).toBe('');
  });

  // A GPU whose description lacks the minor or a well-formed UUID, or that
  // the driver excludes, is not listed: its UUID goes into environments.
  test('malformed descriptions', async () => {
    const p = fakeGPUs(['0000:11:00.0=1', '0000:61:00.0=0'], []);
    writeFileSync(`${p.nvidiaProc}/0000:11:00.0/information`, "Model: X\nGPU UUID: GPU-12345678' ; rm -rf\nDevice Minor: 1\n");
    mkdirSync(`${p.nvidiaProc}/0000:91:00.0`);
    writeFileSync(
      `${p.nvidiaProc}/0000:91:00.0/information`,
      'Model: X\nGPU UUID: GPU-12345678-aaaa\nDevice Minor: 2\nGPU Excluded: Yes\n',
    );
    const gpus = await nvidiaGPUs(p);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({ pci: '0000:61:00.0', index: 0 });
  });

  // The plain display is started when it is asked for, where there is no
  // Xwayland or GPU, and after the GPU display failed to start.
  test('the kind of display wanted', async () => {
    if (!linux) return;
    const bin = tmp();
    writeFileSync(`${bin}/Xwayland`, '#!/bin/sh\n', { mode: 0o755 });
    let gpu = fakeGPUs([], ['0000:00:02.0=i915']);
    const { d } = display({ path: bin, gpu });
    expect(await d.wanted('auto')).toBe('xwayland');
    expect(await d.wanted('xvfb')).toBe('xvfb');
    d.accelErr = 'glamor';
    expect(await d.wanted('auto')).toBe('xvfb');
    d.accelErr = '';
    gpu = fakeGPUs([], []);
    const { d: none } = display({ path: bin, gpu });
    expect(await none.wanted('auto')).toBe('xvfb');
  });
});

describe('the GUI helper', () => {
  const bytes = Buffer.from('#!/bin/sh\necho helper\n');
  const digest = createHash('sha256').update(bytes).digest('hex');

  test('it is placed as its digest says, and placed again when changed', async () => {
    const base = tmp();
    const f = new HelperFile(base, async () => ({ bytes, digest }));
    const p = await f.path();
    expect(p).toBe(posix.join(helperRoot(base), digest.slice(0, 16), `${CORE_BIN}-gui`));
    expect(statSync(p).mode & 0o777).toBe(0o700);
    expect(statSync(helperRoot(base)).mode & 0o777).toBe(0o700);
    expect(readFileSync(p)).toEqual(bytes);
    // Changed on disk: replaced by the carried one before it is used.
    writeFileSync(p, '#!/bin/sh\necho another\n');
    expect(readFileSync(await f.path())).toEqual(bytes);
    // A build that carries none fails.
    await expect(new HelperFile(base, async () => null).path()).rejects.toThrow('carries no GUI helper');
    // Bytes that do not match their digest are refused.
    await expect(new HelperFile(tmp(), async () => ({ bytes, digest: 'a'.repeat(64) })).path()).rejects.toThrow('does not match');
  });

  test('helpers of other builds and unfinished extractions go', async () => {
    const base = tmp();
    const root = helperRoot(base);
    const keep = posix.join(root, 'keep');
    const old = posix.join(root, 'old');
    const fresh = posix.join(root, 'fresh');
    const staging = posix.join(root, '.fetch-1');
    for (const d of [keep, old, fresh, staging]) mkdirSync(d, { recursive: true });
    const now = Date.now();
    const age = (d: string, ms: number) => utimesSync(d, (now - ms) / 1000, (now - ms) / 1000);
    age(keep, 2 * VERSION_RETENTION_MS);
    age(old, VERSION_RETENTION_MS + 1000);
    age(staging, STAGING_RETENTION_MS + 1000);
    await pruneHelpers(base, 'keep', now);
    expect([keep, old, fresh, staging].map(existsSync)).toEqual([true, false, true, false]);
  });

  // The layout proto.zig reads (job_len, little-endian).
  test('jobs as the helper reads them', () => {
    const b = encodeJobs([
      { window: 0x01020304, drawable: 5, x: -1, y: 2, w: 640, h: 480, seq: 9, enc: 1 },
      { window: 7, drawable: 7, x: 0, y: 0, w: 64, h: 64, seq: 10, enc: 3, stream: 3, key: true, kinds: ['avc1', 'vp8'] },
    ]);
    expect(b.length).toBe(2 + 2 * JOB_LEN);
    expect(b.readUInt16LE(0)).toBe(2);
    expect([...b.subarray(2, 2 + JOB_LEN)]).toEqual([
      4, 3, 2, 1, 5, 0, 0, 0, 0xff, 0xff, 2, 0, 128, 2, 224, 1, 9, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const v = b.subarray(2 + JOB_LEN);
    expect([v[20], v.readUInt32LE(21), v[25], v[26], v[27], v[28]]).toEqual([3, 3, 1, 2, 1, 2]);
    expect(() => encodeJobs([])).toThrow();
  });

  test('its messages are read whole or refused', () => {
    expect(decode(Out.Gone, Buffer.from([5, 0, 0, 0]))).toEqual({ t: Out.Gone, id: 5 });
    expect(() => decode(Out.Gone, Buffer.from([5, 0]))).toThrow('short');
    expect(() => decode(99, Buffer.alloc(0))).toThrow('unknown');
    const title = Buffer.from('a ✓');
    const w = Buffer.alloc(20 + title.length + 2);
    w.writeUInt32LE(9, 0);
    w.writeUInt16LE(100, 4);
    w.writeUInt16LE(50, 6);
    w.writeUInt16LE(title.length, 16);
    title.copy(w, 18);
    expect(decode(Out.Window, w.subarray(0, 18 + title.length + 2))).toMatchObject({ id: 9, w: 100, h: 50, title: 'a ✓', terminal: '' });
  });
});

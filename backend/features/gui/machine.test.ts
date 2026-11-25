// Program windows' machine side through the wire, as the core speaks it
// (features/gui/agent.ts), with a fake GUI helper in place of the X
// window manager: two cores of one display, one controls and the other
// views until it takes control; frames go to the watchers, input only from
// the controller; a command of the wrong shape is ignored; the encoder's
// install is held to its digest. The real helper against a real Xvfb is
// gui's integration test (make it).
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { ChildProcess } from 'node:child_process';
import { Reader } from '#shared/lib/streamio.ts';
import { GUIMessage, readGUI, writeGUI, type GUIEvent } from '#shared/proto/agentproto/index.ts';
import { machineOf, rig, until, type Rig } from '#machine/testing.ts';
import { machineAgent } from './agent.ts';
import { guiMachine, parseCommand } from './machine.ts';
import { In, JOB_LEN, Out, type Proc } from './machine/helper.ts';

/** A fake helper: what the node sends it, and messages it sends. */
function fakeHelper() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const got: Array<{ t: number; p: Buffer }> = [];
  let buf = Buffer.alloc(0);
  stdin.on('data', (b: Buffer) => {
    buf = Buffer.concat([buf, b]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0);
      got.push({ t: buf[4], p: buf.subarray(5, 4 + n) });
      buf = buf.subarray(4 + n);
    }
  });
  let exit!: (c: number) => void;
  const exited = new Promise<number | null>((r) => (exit = r));
  let ended = false;
  const end = () => {
    ended = true;
    stdout.end();
    exit(0);
  };
  const proc: Proc = {
    child: { stdin } as unknown as ChildProcess,
    reader: new Reader(stdout),
    exited,
    stderr: () => '',
    send: async () => {},
    end,
    kill: end,
  };
  const emit = (t: number, p: Buffer = Buffer.alloc(0)) => {
    const h = Buffer.alloc(5);
    h.writeUInt32LE(p.length + 1);
    h[4] = t;
    stdout.write(Buffer.concat([h, p]));
  };
  return { proc, got, emit, ended: () => ended };
}

function windowMsg(id: number, title: string, w = 320, h = 200): Buffer {
  const t = Buffer.from(title);
  const b = Buffer.alloc(16 + 2 + t.length + 2);
  b.writeUInt32LE(id, 0);
  b.writeUInt16LE(w, 4);
  b.writeUInt16LE(h, 6);
  b.writeUInt32LE(4242, 8);
  b.writeUInt32LE(0, 12);
  b.writeUInt16LE(t.length, 16);
  t.copy(b, 18);
  b.writeUInt16LE(0, 18 + t.length);
  return b;
}

/** The frame of a job: its header fields, the encoding, the data. */
function frameMsg(job: Buffer, enc: number, data: Buffer): Buffer {
  const b = Buffer.alloc(34 + 2);
  job.copy(b, 0, 0, 20); // window, drawable, x, y, w, h, seq
  b[20] = enc;
  b.writeUInt32LE(100, 21); // capture µs
  b.writeUInt32LE(200, 25); // encode µs
  b.writeUInt32LE(0, 29); // stream
  b[33] = 0; // not started
  b.writeUInt16LE(0, 34); // no error
  return Buffer.concat([b, data]);
}

const rigs: Rig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function guiRig(o: Parameters<typeof guiMachine>[0] = {}) {
  const xTmp = mkdtempSync('/tmp/gx-');
  dirs.push(xTmp);
  const r = await rig({ features: [guiMachine({ linux: true, xTmp, path: '/nonexistent', ...o })] });
  rigs.push(r);
  return r;
}

/** A core attached to the display: its events as they come. */
async function attach(r: Rig, s = r.session) {
  const ac = new AbortController();
  const { conn } = await machineAgent.attach(machineOf(s), ac.signal);
  const events: GUIEvent[] = [];
  const frames: Buffer[] = [];
  void (async () => {
    try {
      for (;;) {
        const m = await readGUI(conn.reader);
        if (m.kind === GUIMessage.JSON) events.push(JSON.parse(m.payload.toString()));
        else frames.push(m.payload);
      }
    } catch {
      // ended
    }
  })();
  const send = (c: object) => writeGUI(conn.stream, GUIMessage.JSON, Buffer.from(JSON.stringify(c)));
  const role = (control: boolean) => until(() => events.some((e) => e.ev === 'role' && !!e.control === control), `role ${control}`);
  return { conn, events, frames, send, role, close: () => conn.stream.destroy() };
}

describe('two cores of one display', () => {
  test('one controls, the other views until it takes control', async () => {
    const fake = fakeHelper();
    let started = 0;
    const r = await guiRig({
      startWM: (args) => {
        started++;
        expect(args[0]).toBe('gui-wm');
        expect(args).toContain('--hc-socket');
        fake.emit(Out.Ready, Buffer.from([1, 0, 10, 0, 6]));
        fake.emit(Out.Window, windowMsg(5, 'helper window'));
        return fake.proc;
      },
    });
    const a = await attach(r);
    await a.role(true);
    await until(
      () => a.events.some((e) => e.ev === 'window' && e.window?.title === 'helper window' && e.window?.pid === 4242),
      'the window',
    );
    const b = await attach(r, r.connect('core-2'));
    await b.role(false);
    await until(() => b.events.some((e) => e.ev === 'window' && e.window?.id === 5), "b's window");
    expect(started).toBe(1);

    // a watches the window: the node asks the helper for it whole.
    await a.send({ cmd: 'watch', id: 5 });
    await until(() => fake.got.some((m) => m.t === In.Capture), 'a capture');
    const cap = fake.got.find((m) => m.t === In.Capture)!.p;
    expect(cap.readUInt16LE(0)).toBe(1);
    const job = cap.subarray(2, 2 + JOB_LEN);
    expect(job.readUInt32LE(0)).toBe(5);
    expect([job.readUInt16LE(12), job.readUInt16LE(14)]).toEqual([320, 200]);
    expect(job[20]).toBe(1); // JPEG
    fake.emit(Out.Frame, frameMsg(job, 1, Buffer.from('jpeg bytes')));
    fake.emit(Out.BatchDone);
    await until(() => a.frames.length === 1, "a's frame");
    expect(a.frames[0].readUInt32BE(0)).toBe(5);
    expect(a.frames[0].subarray(21).toString()).toBe('jpeg bytes');
    expect(b.frames).toHaveLength(0); // b does not watch it

    // The viewer's input does not reach the helper; the controller's does.
    const inputs = () => fake.got.filter((m) => m.t === In.Button);
    await b.send({ cmd: 'button', id: 5, x: 5, y: 6, button: 1, down: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(inputs()).toHaveLength(0);
    await a.send({ cmd: 'button', id: 5, x: 12, y: 34, button: 1, down: true });
    await until(() => inputs().length === 1, 'the click');
    const click = inputs()[0].p;
    expect([click.readUInt32LE(0), click.readInt32LE(4), click.readInt32LE(8), click[12], click[13]]).toEqual([5, 12, 34, 1, 1]);
    // A command of the wrong shape is dropped.
    await a.send({ cmd: 'key', id: 5, keycode: 'A', down: true });
    await a.send({ cmd: 'key', id: 5, keycode: 3, down: true }); // not an X keycode
    await new Promise((res) => setTimeout(res, 100));
    expect(fake.got.filter((m) => m.t === In.Key)).toHaveLength(0);

    // b takes control: held keys and buttons are let go.
    a.events.length = 0;
    await b.send({ cmd: 'control', id: 0 });
    await b.role(true);
    await a.role(false);
    expect(fake.got.some((m) => m.t === In.Release)).toBe(true);
    // b leaves: a controls again.
    a.events.length = 0;
    b.close();
    await a.role(true);
    a.close();
    // The last client gone, the window manager ends with its helper.
    await until(() => fake.ended(), 'the window manager to end');
  });

  test('a newer node taking over, or the agent ending, ends the window manager', async () => {
    for (const how of ['hand over', 'close'] as const) {
      const fake = fakeHelper();
      const r = await guiRig({
        startWM: () => {
          fake.emit(Out.Ready, Buffer.from([0, 0, 10, 0, 6]));
          return fake.proc;
        },
      });
      const a = await attach(r);
      await a.role(true);
      expect(fake.ended()).toBe(false);
      if (how === 'hand over') r.agent.drain({ pid: 1, version: 'next' } as never);
      else await r.agent.close();
      await until(() => fake.ended(), `the window manager to end (${how})`);
    }
  });

  test('a display that ends ends the streams', async () => {
    const fake = fakeHelper();
    const r = await guiRig({
      startWM: () => {
        fake.emit(Out.Ready, Buffer.from([0, 0, 10, 0, 6]));
        return fake.proc;
      },
    });
    const a = await attach(r);
    await a.role(true);
    fake.proc.end();
    let ended = false;
    void a.conn.reader
      .exactly(1)
      .catch(() => {})
      .finally(() => (ended = true));
    await until(() => ended, 'the stream to end');
  });

  test('a helper that does not start fails the attach', async () => {
    const fake = fakeHelper();
    const r = await guiRig({
      startWM: () => {
        setTimeout(() => fake.proc.end(), 10);
        return { ...fake.proc, stderr: () => 'gui-wm: another window manager runs on the display' };
      },
    });
    await expect(machineAgent.attach(machineOf(r.session), new AbortController().signal)).rejects.toThrow(
      'another window manager runs on the display',
    );
  });
});

test('status on another system says unsupported, and the rest is refused', async () => {
  const r = await guiRig({ linux: false });
  const m = machineOf(r.session);
  const signal = new AbortController().signal;
  expect(await machineAgent.request(m, 'status', { signal })).toEqual({ supported: false, running: false });
  await expect(machineAgent.request(m, 'start', { signal })).rejects.toThrow('no virtual display');
});

test('status reserves the display and names the cookie file', async () => {
  const r = await guiRig();
  const st = await machineAgent.request(machineOf(r.session), 'status', { signal: new AbortController().signal });
  expect(st.supported).toBe(true);
  expect(st.display).toBe(':20');
  expect(st.xauthority).toBe(`${r.dirs.run}/xauth`);
  expect(st.running).toBe(false);
});

test('the encoder is installed only as its digest says', async () => {
  const r = await guiRig();
  const m = machineOf(r.session);
  const signal = new AbortController().signal;
  const bin = Buffer.from('#!/bin/sh\necho error no encoder for $6\n');
  const digest = createHash('sha256').update(bin).digest('hex');
  await expect(machineAgent.installVideo(m, digest, gzipSync(Buffer.from('another program')), { signal })).rejects.toThrow(
    'does not match',
  );
  const st = await machineAgent.installVideo(m, digest, gzipSync(bin), { signal });
  // Installed; it makes no kind here.
  expect(st?.video).toBe(true);
  expect(st?.video_encoders).toBeUndefined();
  expect((await machineAgent.video(m, digest, { signal }))?.video).toBe(true);
  expect((await machineAgent.video(m, 'f'.repeat(64), { signal }))?.video).toBeUndefined();
});

test('commands are read as Go reads them', () => {
  const p = (o: unknown) => parseCommand(Buffer.from(JSON.stringify(o)));
  expect(p({ cmd: 'ack', id: 5, seq: 7, extra: 1 })).toEqual({ cmd: 'ack', id: 5, seq: 7 });
  expect(p({ cmd: 'watch', id: 5, codecs: ['avc1'] })).toEqual({ cmd: 'watch', id: 5, codecs: ['avc1'] });
  expect(p({ cmd: 'ack', id: -1 })).toBeNull();
  expect(p({ cmd: 'ack', id: 1.5 })).toBeNull();
  expect(p({ cmd: 5 })).toBeNull();
  expect(p({ cmd: 'button', id: 1, down: 'yes' })).toBeNull();
  expect(p({ cmd: 'watch', id: 1, codecs: [1] })).toBeNull();
  expect(p([1])).toBeNull();
  expect(parseCommand(Buffer.from('{'))).toBeNull();
});

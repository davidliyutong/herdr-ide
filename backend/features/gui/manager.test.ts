import { afterEach, describe, expect, test } from 'bun:test';
import { GUIEnc, parseFrameHeader, type GUIStatus } from '#shared/proto/agentproto/index.ts';
import { agentDialer, localSpec, memoryAudit, running, sleep, sshSpec, testMachines, waitFor } from '#kernel/testing.ts';
import type { Session } from '#kernel/machines/transport/session.ts';
import { Display } from './display.ts';
import { EnableError, type Shells } from './enable.ts';
import { Manager } from './manager.ts';
import { DEFAULT_LIMITS, DEFAULT_TIMING } from './timing.ts';
import type { State } from './state.ts';
import { FakeDisplay, testSettings } from './testing.ts';
import { Viewer } from './viewer.ts';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

interface SetupOptions {
  readOnly?: boolean;
  flags?: Record<string, string>;
  status?: Partial<GUIStatus>;
  encoder?: (os: string, arch: string) => Promise<{ gz: Uint8Array; digest: string }>;
}

/** A manager over a local machine and an ssh machine m1, whose agents
 * serve a fake display, running until the test ends. */
function setup(o: SetupOptions = {}) {
  const disp = new FakeDisplay(o.status);
  const dial = agentDialer({ serve: disp.serve });
  const machines = testMachines([localSpec(), sshSpec('m1')], { dial });
  const settings = testSettings(o.flags);
  const audit = memoryAudit();
  const states: State[] = [];
  const logs: string[] = [];
  const mgr = new Manager({
    machines,
    settings,
    readOnly: o.readOnly ?? false,
    audit: audit.audit,
    logger: (l) => void logs.push(l),
    publish: (st) => void states.push(st),
    encoder: o.encoder,
    timing: { retryMinMs: 30, retryMaxMs: 200, detachMs: 300, interruptPauseMs: 1 },
  });
  stops.push(running(machines), running(mgr));
  const m1 = () => machines.get('m1')!;
  const last = (id = 'm1') => states.filter((s) => s.m === id).at(-1);
  const phase = (p: string, id = 'm1') => waitFor(`${id} ${p}`, () => last(id)?.phase === p, 3000);
  /** The phases m1 went through, each once in a row. */
  const phases = () =>
    t.states
      .filter((s) => s.m === 'm1')
      .map((s) => s.phase)
      .filter((p, i, all) => p !== all[i - 1]);
  const t = { disp, dial, machines, settings, audit, states, logs, mgr, m1, last, phase, phases };
  return t;
}

describe('preparing a display', () => {
  // Once per connection: status, start, attach, and the keeper; the local
  // machine's windows open on the user's screen.
  test('starts and attaches', async () => {
    const t = setup();
    await t.phase('ready');
    await t.phase('local', 'local');
    await waitFor('keep', () => t.disp.count('keep') === 1);
    expect(t.disp.actions).toEqual(['status', 'start auto', 'attach', 'keep']);
    expect(t.phases()).toEqual(['starting', 'ready']);
    expect(t.audit.records().map((r) => [r.event, r.machine])).toEqual([
      ['gui.start', 'm1'],
      ['gui.keep', 'm1'],
    ]);
    expect(t.mgr.paneEnv(t.m1())).toEqual({ DISPLAY: ':20', XAUTHORITY: '/h/xauth' });
    expect(t.last()).toEqual({ m: 'm1', phase: 'ready', display: 'xvfb', windows: [] });
    // No encoder in this build: pictures.
    await waitFor('the log', () => t.logs.some((l) => l === 'gui m1: video: no video encoder for linux-amd64 in this build'));
  });

  // Windows reach the state and their viewers; commands reach the agent;
  // the stream ending is retried after a backoff, and viewers of a window
  // that comes back watch it again.
  test('windows and reattaching', async () => {
    const t = setup();
    await t.phase('ready');
    const a = await t.disp.attached();
    await a.event({ ev: 'window', window: { id: 7, title: 'plot', w: 640, h: 480, terminal: 'local:3' } });
    await waitFor('the window', () => t.last()?.windows.length === 1);
    expect(t.last()?.windows).toEqual([{ id: 7, title: 'plot', w: 640, h: 480, terminal: 'local:3' }]);
    expect(t.mgr.states()[1].windows).toEqual(t.last()!.windows);

    const frames: number[] = [];
    const v = new Viewer((m) => (typeof m !== 'string' && frames.push(parseFrameHeader(m).seq), true), ['vp8']);
    expect(t.mgr.attach('m1', 7, v)).toBe(true);
    expect(await a.command(0)).toEqual({ cmd: 'watch', id: 7, codecs: ['vp8'] });
    await a.frame({ window: 7, layer: 7, x: 0, y: 0, w: 1, h: 1, enc: GUIEnc.PNG, seq: 1 });
    await waitFor('the frame', () => frames.length === 1);
    t.mgr.command('m1', 7, v, { cmd: 'ack', id: 0, seq: 1 }, true);
    expect(await a.command(1)).toEqual({ cmd: 'ack', id: 7, seq: 1 });

    // The agent's window manager ends: an error, then a new attachment.
    a.end();
    await t.phase('error');
    expect(t.last()).toEqual({ m: 'm1', phase: 'error', error: 'EOF', windows: [] });
    const b = await t.disp.attached(1);
    await t.phase('ready');
    expect(t.disp.count('start')).toBe(1);
    await b.event({ ev: 'window', window: { id: 7, title: 'plot', w: 640, h: 480 } });
    expect(await b.command(0)).toEqual({ cmd: 'watch', id: 7, codecs: ['vp8'] });
    t.mgr.detach('m1', 7, v);
    expect(await b.command(2)).toEqual({ cmd: 'unwatch', id: 7 });
  });

  // A failure shows as an error and is retried with a backoff.
  test('retries failures', async () => {
    const t = setup();
    t.disp.failing.set('status', 'no display here');
    await t.phase('error');
    expect(t.last()?.error).toBe('agent gui: no display here');
    await waitFor('a retry', () => t.disp.count('status') >= 2);
    t.disp.failing.delete('status');
    await t.phase('ready');
  });

  // Without Xvfb it is installed first; installs and starts are audited.
  test('installs', async () => {
    const t = setup({ status: { xvfb: undefined, installable: true } });
    await t.phase('ready');
    expect(t.disp.actions.slice(0, 3)).toEqual(['status', 'install', 'start auto']);
    expect(t.phases()).toEqual(['installing', 'starting', 'ready']);
    expect(t.audit.records().map((r) => r.event)).toContain('gui.install');
  });

  test('unavailable and unsupported', async () => {
    const t = setup({ status: { xvfb: undefined } });
    await t.phase('unavailable');
    const u = setup({ status: { supported: false } });
    await u.phase('unsupported');
    expect(u.disp.actions).toEqual(['status']);
  });

  // Read-only mode attaches only to a display that runs, and starts
  // nothing: no display, no keeper, no encoder.
  test('read-only', async () => {
    const t = setup({ readOnly: true, encoder: async () => ({ gz: Buffer.from('x'), digest: 'abc' }) });
    await t.phase('not_running');
    expect(t.disp.actions).toEqual(['status']);
    const r = setup({ readOnly: true, status: { running: true, kind: 'xvfb' } });
    await r.phase('ready');
    r.mgr.terminalReady(r.m1(), true);
    await sleep(50);
    expect(r.disp.actions).toEqual(['status', 'attach']);
    expect(r.audit.records()).toEqual([]);
  });

  // The keeper is asked for again each time the terminal core is
  // reachable again, not on every state change.
  test('terminal core readiness', async () => {
    const t = setup();
    await t.phase('ready');
    await waitFor('keep', () => t.disp.count('keep') === 1);
    const m = t.m1();
    t.mgr.terminalReady(m, false);
    t.mgr.terminalReady(m, true);
    t.mgr.terminalReady(m, true);
    await waitFor('keep', () => t.disp.count('keep') === 2);
    t.mgr.terminalReady(m, false);
    t.mgr.terminalReady(m, true);
    await waitFor('keep', () => t.disp.count('keep') === 3);
    await sleep(30);
    expect(t.disp.count('keep')).toBe(3);
  });

  // The encoder this build carries goes to a machine that lacks it.
  test('video encoder', async () => {
    const gz = Buffer.alloc(3 << 20, 7);
    const t = setup({ encoder: async (os, arch) => ({ gz, digest: `${os}-${arch}-digest` }) });
    await waitFor('the install', () => t.disp.installed !== null);
    expect(t.disp.installed!.equals(gz)).toBe(true);
    expect(t.disp.actions).toContain('video linux-amd64-digest');
    expect(t.disp.actions).toContain('video-install linux-amd64-digest');
    expect(t.audit.records().find((r) => r.event === 'gui.video')).toMatchObject({ machine: 'm1', sha256: 'linux-amd64-digest' });
    await waitFor('the log', () => t.logs.includes('gui m1: video encoders [libvpx]'));
  });

  // With gpupick on, a machine with several NVIDIA GPUs gets the library.
  test('GPU selection', async () => {
    const gpus = [
      { index: 0, minor: 0, uuid: 'GPU-a' },
      { index: 1, minor: 1, uuid: 'GPU-b' },
    ];
    const t = setup({ status: { gpus } });
    await t.phase('ready');
    await sleep(30);
    expect(t.disp.count('pick')).toBe(0);
    t.settings.set('gui.gpuPick', 'm1', true);
    await waitFor('pick', () => t.last()?.pick === true);
    expect(t.mgr.paneEnv(t.m1())).toMatchObject({ LD_PRELOAD: '/h/gpupick.so', GPUPICK_TABLE: 'GPU-a=0,GPU-b=1' });
    expect(t.audit.records().find((r) => r.event === 'gui.pick')).toMatchObject({ machine: 'm1' });
  });
});

describe('settings and machines', () => {
  // Turning program windows off for a machine detaches (the agent sees
  // the stream end) and panes get no display; on again prepares it.
  test('gui.enabled', async () => {
    const t = setup();
    await t.phase('ready');
    const a = await t.disp.attached();
    t.settings.set('gui.enabled', 'm1', false);
    await t.phase('off');
    await waitFor('the stream to end', () => a.closed);
    expect(t.mgr.paneEnv(t.m1())).toBeUndefined();
    t.settings.reset('gui.enabled', 'm1');
    await t.phase('ready');
    expect(t.disp.attaches.length).toBe(2);
  });

  // A change of the display's kind prepares it anew.
  test('gui.display', async () => {
    const t = setup({ status: { gpu_display: true } });
    await t.phase('ready');
    expect(t.last()?.display).toBe('xwayland');
    t.settings.set('gui.display', 'm1', 'xvfb');
    await waitFor('the new display', () => t.last()?.phase === 'ready' && t.last()?.display === 'xvfb');
    expect(t.disp.actions.filter((a) => a.startsWith('start'))).toEqual(['start auto', 'start xvfb']);
    // The same kind again changes nothing.
    t.settings.set('gui.display', '', 'xvfb');
    await sleep(30);
    expect(t.disp.attaches.length).toBe(2);
  });

  // A machine that disconnects shows no windows or error; a removed one is
  // forgotten.
  test('disconnect and forget', async () => {
    const t = setup();
    await t.phase('ready');
    const a = await t.disp.attached();
    await a.event({ ev: 'window', window: { id: 7, title: 'plot', w: 1, h: 1 } });
    await waitFor('the window', () => t.last()?.windows.length === 1);
    t.machines.setEnabled('m1', false);
    await t.phase('disconnected');
    expect(t.last()).toEqual({ m: 'm1', phase: 'disconnected', windows: [] });
    await waitFor('the stream to end', () => a.closed);
    const n = t.states.length;
    t.mgr.disconnected(t.m1());
    expect(t.states.length).toBe(n);
    t.machines.setEnabled('m1', true);
    await t.phase('ready');
    t.mgr.forget('m1');
    expect(t.last()?.phase).toBe('disconnected');
    expect(t.mgr.states().map((s) => s.m)).toEqual(['local']);
  });
});

describe('ensure', () => {
  // A display is prepared once per connection: the machine's state
  // changes do not start it again after a failure; forced retries do, and
  // one arriving while a preparation runs is not lost.
  test('once per session', () => {
    const a = {} as Session;
    const b = {} as Session;
    const d = new Display({ id: 'm1' } as never, { video: () => true, now: Date.now, timing: DEFAULT_TIMING, limits: DEFAULT_LIMITS });
    expect(d.claim(null, false)).toBe(false);
    expect(d.claim(a, false)).toBe(true);
    expect(d.claim(a, false)).toBe(false);
    expect(d.again).toBe(false);
    expect([d.finish(a, a), d.ensuring]).toEqual([null, false]);
    // The preparation failed (no stream): state changes leave it alone.
    for (let i = 0; i < 3; i++) expect(d.claim(a, false)).toBe(false);
    d.failures = 2;
    expect(d.claim(a, true)).toBe(true);
    expect(d.failures).toBe(2);
    // A forced ensure while preparing runs it again afterwards.
    d.claim(a, true);
    expect([d.finish(a, a), d.ensuring]).toEqual([a, true]);
    d.finish(a, a);
    // A new connection is prepared, also when it came up meanwhile, and
    // starts the backoff over.
    expect([d.claim(b, false), d.failures]).toEqual([true, 0]);
    d.finish(b, b);
    d.claim(b, true);
    expect(d.finish(b, a)).toBe(a);
    d.finish(a, null);
    // Attached on the connection: nothing to do even when forced.
    d.stream = {} as never;
    d.sess = a;
    expect(d.claim(a, true)).toBe(false);
  });
});

describe('enable', () => {
  /** Terminals whose shells answer in turn (the last answer repeats). */
  function fakeShells(answers: Record<string, Array<{ pid?: number; idle?: boolean; err?: string }>>) {
    const asked: Record<string, number> = {};
    const sent: Record<string, string[]> = {};
    const shells: Shells = {
      all: () => Object.keys(answers).sort(),
      async shell(id) {
        const a = answers[id];
        const n = Math.min(asked[id] ?? 0, a.length - 1);
        asked[id] = (asked[id] ?? 0) + 1;
        if (a[n].err) throw new Error(a[n].err);
        return { pid: a[n].pid ?? 0, idle: a[n].idle ?? false };
      },
      async send(id, text) {
        (sent[id] ??= []).push(text);
      },
    };
    return { shells, sent };
  }

  // Enable types only into known shells waiting at their prompt, also when
  // checked again right before; busy terminals (a program in front, a
  // shell that started one meanwhile, no shell), unreachable ones and
  // shells started with the display are reported, not typed into.
  // Enabling again types into no shell twice, until the display changes.
  test('types into idle shells', async () => {
    const t = setup();
    await t.phase('ready');
    t.disp.procs = [
      { pid: 11, comm: 'zsh' },
      { pid: 12, comm: 'bash' },
      { pid: 13, comm: 'claude' },
      { pid: 15, comm: 'zsh' },
      { pid: 16, comm: 'bash', display: true },
    ];
    const sh = fakeShells({
      idle: [{ pid: 11, idle: true }],
      running: [{ pid: 12, idle: false }], // a program in front of its shell
      exec: [{ pid: 13, idle: true }], // claude replaced the shell
      noshell: [{ pid: 0 }],
      started: [
        { pid: 15, idle: true },
        { pid: 15, idle: false },
      ], // started a program meanwhile
      display: [{ pid: 16, idle: true }], // started with the display
      gone: [{ err: 'no such terminal' }],
    });
    const signal = AbortSignal.timeout(5000);
    const res = await t.mgr.enable(t.m1(), sh.shells, [], signal);
    expect({ ...res, busy: [...res.busy].sort() }).toEqual({
      enabled: 1,
      already: 1,
      busy: ['exec', 'noshell', 'running', 'started'],
      typed: ['idle'],
      failed: ['gone'],
      command: " export DISPLAY=':20' XAUTHORITY='/h/xauth'",
    });
    expect(sh.sent).toEqual({ idle: ['\x03', res.command + '\r'] });
    const asked = t.disp.actions.filter((a) => a.startsWith('shells'));
    expect([asked.length, asked[0].split(' ').slice(1).sort()]).toEqual([1, ['11', '12', '13', '15', '16']]);

    // Again: the shell typed into has the display; nothing is typed.
    delete sh.sent.idle;
    const again = await t.mgr.enable(t.m1(), sh.shells, ['idle', 'display'], signal);
    expect([again.enabled, again.already, sh.sent]).toEqual([0, 2, {}]);

    // A new display: the shell gets it.
    const d = t.mgr.display(t.m1());
    d.status = { ...d.status!, display: ':21' };
    const next = await t.mgr.enable(t.m1(), sh.shells, ['idle'], signal);
    expect([next.enabled, sh.sent.idle?.[1]]).toEqual([1, " export DISPLAY=':21' XAUTHORITY='/h/xauth'\r"]);

    // The agent cannot be asked: nothing is typed.
    t.disp.failing.set('shells', 'machine not connected');
    delete sh.sent.idle;
    const err = await t.mgr.enable(t.m1(), sh.shells, ['started'], signal).catch((e) => e);
    expect(err).toBeInstanceOf(EnableError);
    expect([(err as EnableError).message, (err as EnableError).result.typed, sh.sent]).toEqual([
      'agent gui: machine not connected',
      [],
      {},
    ]);
  });
});

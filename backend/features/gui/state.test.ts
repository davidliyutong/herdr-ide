import { describe, expect, test } from 'bun:test';
import { GUIDisplay, type GUIStatus } from '#shared/proto/agentproto/index.ts';
import { discard } from '#shared/lib/log.ts';
import { noAudit } from '#kernel/audit.ts';
import { sshSpec, localSpec, testMachines } from '#kernel/testing.ts';
import { decide, exportCommand, typeExport } from './enable.ts';
import { Manager } from './manager.ts';
import { afterAttach, plan, retryDelay } from './plan.ts';
import { Phase, type PhaseName } from './state.ts';
import { testSettings } from './testing.ts';
import { DEFAULT_TIMING } from './timing.ts';
import { marshalCommand, parseCodecs, parseViewerCommand, sharedCodecs } from './wire.ts';

const machines = () => testMachines([localSpec(), sshSpec('m1'), sshSpec('a'), sshSpec('b')]);

function manager(flags: Record<string, string> = {}, s = testSettings(flags)) {
  const ms = machines();
  const mgr = new Manager({ machines: ms, settings: s, readOnly: false, audit: noAudit, logger: discard, publish: () => {} });
  /** Gives machine id a display in phase with status. */
  const set = (id: string, status: GUIStatus, phase: PhaseName) => {
    const d = mgr.display(ms.get(id)!);
    d.status = status;
    d.phase = phase;
    return d;
  };
  return { mgr, ms, settings: s, set, m: (id: string) => ms.get(id)! };
}

describe('pane environment', () => {
  // Panes get the display, and VirtualGL as configured, only while the
  // display is usable and never on the local machine.
  test('the display while ready', () => {
    const status: GUIStatus = {
      supported: true,
      running: true,
      display: ':20',
      xauthority: '/h/.x/run/xauth',
      gpu: true,
      vgl_preload: '/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so',
    };
    const t = manager();
    t.set('m1', status, Phase.Ready);
    expect(t.mgr.paneEnv(t.m('m1'))).toEqual({ DISPLAY: ':20', XAUTHORITY: status.xauthority!, VGL_DISPLAY: 'egl0' });
    t.set('local', status, Phase.Ready);
    expect(t.mgr.paneEnv(t.m('local'))).toBeUndefined();
    t.set('m1', status, Phase.Unavailable);
    expect(t.mgr.paneEnv(t.m('m1'))).toBeUndefined();
    t.set('m1', status, Phase.Starting);
    expect(t.mgr.paneEnv(t.m('m1'))).toBeUndefined();

    const all = manager({ 'gui-gpu': 'all' });
    all.set('m1', status, Phase.Ready);
    expect(all.mgr.paneEnv(all.m('m1'))).toMatchObject({ LD_PRELOAD: status.vgl_preload!, VGL_ISACTIVE: '1' });
    const off = manager({ gui: 'off' });
    off.set('m1', status, Phase.Ready);
    expect(off.mgr.paneEnv(off.m('m1'))).toBeUndefined();
  });

  // A machine's own value decides; machines without one follow the
  // global.
  test('per machine', async () => {
    const t = manager();
    const status: GUIStatus = {
      supported: true,
      running: true,
      display: ':20',
      xauthority: '/x',
      gpu: true,
      vgl_preload: '/l/a.so:/l/b.so',
    };
    t.set('a', status, Phase.Ready);
    t.set('b', status, Phase.Ready);
    t.settings.set('gui.enabled', 'a', false);
    t.settings.set('gui.gpu', 'b', 'all');
    expect(t.mgr.paneEnv(t.m('a'))).toBeUndefined();
    expect(t.mgr.paneEnv(t.m('b'))?.LD_PRELOAD).toBe(status.vgl_preload!);
    t.settings.reset('gui.enabled', 'a');
    expect(t.mgr.paneEnv(t.m('a'))).toEqual({ DISPLAY: ':20', XAUTHORITY: '/x', VGL_DISPLAY: 'egl0' });

    const shells = { all: () => [], shell: async () => ({ pid: 0, idle: false }), send: async () => {} };
    t.set('a', status, Phase.Starting);
    await expect(t.mgr.enable(t.m('a'), shells, [], AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'not_ready', status: 409 });
    t.settings.set('gui.enabled', 'a', false);
    await expect(t.mgr.enable(t.m('a'), shells, [], AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'off', status: 409 });
  });

  // On a machine with several NVIDIA GPUs pages are told which one windows
  // of Vulkan programs come from. With the setting on and the library
  // installed, panes get it with the table of GPUs, before VirtualGL's
  // libraries; on the GPU display VirtualGL is not preloaded.
  test('GPUs', () => {
    const status = (): GUIStatus => ({
      supported: true,
      display: ':20',
      xauthority: '/h/.x/run/xauth',
      running: true,
      kind: GUIDisplay.Xvfb,
      gpu: true,
      vgl_preload: '/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so',
      pick: '/h/.x/gpupick/0123/gpupick.so',
      gpus: [
        { index: 0, minor: 1, uuid: 'GPU-70987003', model: 'A' },
        { index: 1, minor: 0, uuid: 'GPU-dd0ff3fe', model: 'A' },
      ],
    });
    const off = manager();
    off.set('m1', status(), Phase.Ready);
    expect(off.mgr.states()).toEqual([{ m: 'm1', phase: 'ready', gpu: true, display: 'xvfb', vulkan_gpu: 1, windows: [] }]);
    expect(off.mgr.paneEnv(off.m('m1'))).toEqual({ DISPLAY: ':20', XAUTHORITY: '/h/.x/run/xauth', VGL_DISPLAY: 'egl0' });

    const on = manager({ 'gui-gpu-pick': 'true' });
    on.set('m1', status(), Phase.Ready);
    expect(on.mgr.states()[0].pick).toBe(true);
    expect(on.mgr.paneEnv(on.m('m1'))).toEqual({
      DISPLAY: ':20',
      XAUTHORITY: '/h/.x/run/xauth',
      LD_PRELOAD: '/h/.x/gpupick/0123/gpupick.so',
      GPUPICK_TABLE: 'GPU-70987003=1,GPU-dd0ff3fe=0',
      VGL_DISPLAY: 'egl0',
    });
    // The GPU display draws with one of them; GPUs of two models.
    const gpu = status();
    gpu.kind = GUIDisplay.Xwayland;
    gpu.display_minor = 0;
    gpu.gpus![1].model = 'B';
    on.set('m1', gpu, Phase.Ready);
    expect(on.mgr.states()[0].display).toBe('xwayland');
    expect(on.mgr.paneEnv(on.m('m1'))).toMatchObject({ GPUPICK_DISPLAY: '0', GPUPICK_MIXED: '1' });
    // Not without the library, nor with a single GPU.
    on.set('m1', { ...status(), pick: undefined }, Phase.Ready);
    expect(on.mgr.states()[0].pick).toBeUndefined();
    expect(on.mgr.paneEnv(on.m('m1'))).toEqual({ DISPLAY: ':20', XAUTHORITY: '/h/.x/run/xauth', VGL_DISPLAY: 'egl0' });
    const one = status();
    one.gpus = one.gpus!.slice(0, 1);
    on.set('m1', one, Phase.Ready);
    expect(on.mgr.states()[0]).toEqual({ m: 'm1', phase: 'ready', gpu: true, display: 'xvfb', windows: [] });
    expect(on.mgr.paneEnv(on.m('m1'))?.LD_PRELOAD).toBeUndefined();

    // With every program under VirtualGL: both libraries, gpupick first.
    const all = manager({ 'gui-gpu-pick': 'true', 'gui-gpu': 'all' });
    all.set('m1', status(), Phase.Ready);
    expect(all.mgr.paneEnv(all.m('m1'))).toMatchObject({
      LD_PRELOAD: '/h/.x/gpupick/0123/gpupick.so:/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so',
      VGL_ISACTIVE: '1',
    });
    all.set('m1', gpu, Phase.Ready);
    const env = all.mgr.paneEnv(all.m('m1'))!;
    expect(env).toMatchObject({ LD_PRELOAD: '/h/.x/gpupick/0123/gpupick.so', VGL_DISPLAY: 'egl0' });
    expect(env.VGL_ISACTIVE).toBeUndefined();
  });
});

describe('states', () => {
  // The phase is starting before any; an error and the display's kind
  // show; machines come sorted.
  test('shape', () => {
    const t = manager();
    t.mgr.display(t.m('m1'));
    const d = t.set('a', { supported: true, running: true, kind: 'xvfb' }, Phase.Error);
    d.err = 'agent gui: no Xvfb';
    expect(t.mgr.states()).toEqual([
      { m: 'a', phase: 'error', error: 'agent gui: no Xvfb', windows: [] },
      { m: 'm1', phase: 'starting', windows: [] },
    ]);
    expect(JSON.stringify(t.mgr.states()[0])).toBe('{"m":"a","phase":"error","error":"agent gui: no Xvfb","windows":[]}');
  });
});

// Read-only mode shows a running display but installs and starts nothing.
// The GPU display is started where the machine can run it and the setting
// does not say xvfb; a display of the other kind is started anew (the
// agent replaces it while no program uses it).
test('plan', () => {
  const xvfb = GUIDisplay.Xvfb;
  const xwl = GUIDisplay.Xwayland;
  const auto = GUIDisplay.Auto;
  const s = (st: Partial<GUIStatus>): GUIStatus => ({ supported: false, running: false, ...st });
  const cases: Array<[GUIStatus, boolean, string, string, string]> = [
    [s({}), false, auto, '', Phase.Unsupported],
    [s({ supported: true, running: true }), true, auto, '', ''],
    [s({ supported: true, xvfb: '/usr/bin/Xvfb' }), true, auto, '', Phase.NotRunning],
    [s({ supported: true, installable: true }), true, auto, '', Phase.NotRunning],
    [s({ supported: true }), false, auto, '', Phase.Unavailable],
    [s({ supported: true, installable: true }), false, auto, 'install start', ''],
    [s({ supported: true, xvfb: '/usr/bin/Xvfb' }), false, auto, 'start', ''],
    // The GPU display needs no Xvfb; with xvfb asked for it is not used.
    [s({ supported: true, gpu_display: true }), false, auto, 'start', ''],
    [s({ supported: true, gpu_display: true }), false, xvfb, '', Phase.Unavailable],
    [s({ supported: true, gpu_display: true, installable: true }), false, xvfb, 'install start', ''],
    [s({ supported: true, gpu_display: true }), true, auto, '', Phase.NotRunning],
    // A display that runs: attached when it is of the kind wanted, or of
    // an agent that names none; started anew otherwise, never in
    // read-only mode.
    [s({ supported: true, running: true, kind: xwl, gpu_display: true }), false, auto, '', ''],
    [s({ supported: true, running: true, kind: xvfb, gpu_display: true }), false, auto, 'start', ''],
    [s({ supported: true, running: true, kind: xvfb, gpu_display: true }), true, auto, '', ''],
    [s({ supported: true, running: true, kind: xwl, gpu_display: true }), false, xvfb, 'start', ''],
    [s({ supported: true, running: true, kind: xvfb, gpu_display: true }), false, xvfb, '', ''],
    [s({ supported: true, running: true, kind: xvfb }), false, auto, '', ''],
    [s({ supported: true, running: true, gpu_display: true }), false, auto, '', ''],
  ];
  for (const [st, readOnly, asked, actions, stop] of cases) {
    const got = plan(st, readOnly, asked);
    expect([JSON.stringify(st), readOnly, asked, got.actions.join(' '), got.stop]).toEqual([
      JSON.stringify(st),
      readOnly,
      asked,
      actions,
      stop,
    ]);
  }
});

test('retry delay', () => {
  expect([retryDelay(0, DEFAULT_TIMING), retryDelay(1, DEFAULT_TIMING)]).toEqual([5000, 10_000]);
  expect([retryDelay(6, DEFAULT_TIMING), retryDelay(100, DEFAULT_TIMING)]).toEqual([300_000, 300_000]);
});

// Read-only mode neither starts a display keeper nor pushes the encoder;
// otherwise the keeper always, the encoder with video on.
test('after attach', () => {
  expect(afterAttach(true, true)).toEqual({ keep: false, push: false });
  expect(afterAttach(true, false)).toEqual({ keep: false, push: false });
  expect(afterAttach(false, true)).toEqual({ keep: true, push: true });
  expect(afterAttach(false, false)).toEqual({ keep: true, push: false });
});

describe('enable', () => {
  // Values are single-quoted for the shell, whatever they contain.
  test('export command', () => {
    expect(exportCommand({ XAUTHORITY: "/home/o'neil/.x/run/xauth", DISPLAY: ':20' })).toBe(
      ` export DISPLAY=':20' XAUTHORITY='/home/o'\\''neil/.x/run/xauth'`,
    );
  });

  // Only known shells waiting at their prompt are typed into.
  test('decide', () => {
    const shell = { pid: 10, comm: 'zsh' };
    const cases: Array<[Parameters<typeof decide>[0], boolean, boolean, string]> = [
      [shell, true, false, 'type'],
      [shell, false, false, 'busy'],
      [{ pid: 10, comm: 'python3' }, true, false, 'busy'], // exec python
      [{ pid: 10, comm: 'claude' }, true, false, 'busy'],
      [{ pid: 10, comm: 'tcsh' }, true, false, 'busy'], // no export
      [undefined, true, false, 'busy'],
      [{ pid: 10, comm: 'bash', display: true }, false, false, 'already'],
      [shell, true, true, 'already'],
    ];
    for (const [p, idle, typed, want] of cases) expect<unknown[]>([p, idle, typed, decide(p, idle, typed)]).toEqual([p, idle, typed, want]);
  });

  // Ctrl-C goes first, on its own, then the command with Enter; a failed
  // interrupt types nothing.
  test('type export', async () => {
    const sent: string[] = [];
    await typeExport(async (s) => void sent.push(s), " export DISPLAY=':20'", 1);
    expect(sent).toEqual(['\x03', " export DISPLAY=':20'\r"]);
    sent.length = 0;
    const failing = async (s: string) => {
      sent.push(s);
      throw new Error('gone');
    };
    await expect(typeExport(failing, 'x', 1)).rejects.toThrow('gone');
    expect(sent).toEqual(['\x03']);
  });
});

describe('wire', () => {
  // Browsers name the video streams they decode; anything else is dropped.
  test('video codecs parameter', () => {
    const cases: Record<string, string> = {
      '': '',
      'avc1,vp8': 'avc1,vp8',
      'vp8,vp8,AVC1,../x,a b': 'vp8',
      'a,b,c,d,e': 'a,b,c,d',
      averyverylongcodecname: '',
    };
    for (const [q, want] of Object.entries(cases)) expect([q, parseCodecs(q).join(',')]).toEqual([q, want]);
  });

  test('shared codecs', () => {
    expect(sharedCodecs([['vp8', 'avc1'], ['vp8']])).toEqual(['vp8']);
    expect(sharedCodecs([['zz', 'vp8', 'av01', 'avc1']])).toEqual(['avc1', 'vp8', 'av01', 'zz']);
    expect(sharedCodecs([])).toEqual([]);
  });

  // Commands as the Go hub wrote them: cmd and id always, zero values
  // left out.
  test('commands', () => {
    expect(marshalCommand({ cmd: 'control', id: 0 })).toBe('{"cmd":"control","id":0}');
    expect(marshalCommand({ cmd: 'watch', id: 7, codecs: [] })).toBe('{"cmd":"watch","id":7}');
    expect(marshalCommand({ cmd: 'key', id: 7, keycode: 38, down: true, x: 0 })).toBe('{"cmd":"key","id":7,"down":true,"keycode":38}');
    expect(marshalCommand({ cmd: 'refresh', id: 7, codecs: ['avc1'] })).toBe('{"cmd":"refresh","id":7,"codecs":["avc1"]}');
  });

  // A browser window's message keeps the fields of a command; anything
  // that is not one is ignored.
  test('viewer commands', () => {
    expect(parseViewerCommand('{"cmd":"pointer","x":3,"y":4,"extra":1}')).toEqual({ cmd: 'pointer', id: 0, x: 3, y: 4 });
    expect(parseViewerCommand('{"cmd":"ack","seq":4294967295,"codecs":null}')).toEqual({ cmd: 'ack', id: 0, seq: 4294967295 });
    for (const bad of ['[]', '"x"', '{"cmd":3}', '{"seq":-1}', '{"x":1.5}', '{"down":"yes"}', 'not json'])
      expect([bad, parseViewerCommand(bad)]).toEqual([bad, undefined]);
    expect(parseViewerCommand('null')).toEqual({ cmd: '', id: 0 });
  });
});

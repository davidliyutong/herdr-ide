import { describe, expect, it } from 'vitest';
import { xKeycode } from '../gui/keycodes';
import { guiKey, paneWindows, parseGuiPath, useGui, type GuiState } from '../gui/state';
import { serverSection } from '../components/SettingsDialog';
import { FrameStats, type MachineStats } from '../gui/stats';

describe('xKeycode', () => {
  it('maps physical keys to evdev keycodes plus 8', () => {
    expect(xKeycode('KeyA')).toBe(38);
    expect(xKeycode('Escape')).toBe(9);
    expect(xKeycode('Space')).toBe(65);
    expect(xKeycode('ArrowLeft')).toBe(113);
    expect(xKeycode('ControlLeft')).toBe(37);
    expect(xKeycode('Unidentified')).toBeUndefined();
  });
});

describe('parseGuiPath', () => {
  it('recognizes the page of a program window', () => {
    expect(parseGuiPath('/m/abc/gui/4194305')).toEqual({ m: 'abc', id: 4194305 });
    expect(parseGuiPath('/m/a%20b/gui/7/')).toEqual({ m: 'a b', id: 7 });
    expect(parseGuiPath('/m/abc/gui/x')).toBeUndefined();
    expect(parseGuiPath('/m/abc/code/')).toBeUndefined();
  });
});

const state = (m: string, ...windows: [number, string?][]): GuiState => ({
  m,
  phase: 'ready',
  windows: windows.map(([id, pane]) => ({ id, title: `w${id}`, w: 100, h: 80, pane })),
});

describe('gui state', () => {
  it('marks windows that appear after the first state as unseen', () => {
    const g = useGui.getState();
    g.setState(state('m1', [1, 'p1']));
    expect(useGui.getState().unseen).toEqual({});
    g.setState(state('m1', [1, 'p1'], [2, 'p1'], [3]));
    expect(Object.keys(useGui.getState().unseen).sort()).toEqual([guiKey('m1', 2), guiKey('m1', 3)]);
    expect(paneWindows(useGui.getState(), 'm1', 'p1').map((w) => w.id)).toEqual([1, 2]);

    g.markSeen('m1', 2);
    expect(Object.keys(useGui.getState().unseen)).toEqual([guiKey('m1', 3)]);
    g.setState(state('m1', [1, 'p1']));
    expect(useGui.getState().unseen).toEqual({});
  });
});

describe('settings sections', () => {
  it('groups the GUI settings', () => {
    expect(serverSection('gui')).toBe('gui');
    expect(serverSection('gui-gpu')).toBe('gui');
    expect(serverSection('code-server-install')).toBe('codeServer');
  });
});

describe('frame statistics', () => {
  const report = (o: Partial<MachineStats>): MachineStats => ({
    window: 7,
    interval_us: 1e6,
    updates: 0,
    frames: 0,
    jpeg: 0,
    png: 0,
    pixels: 0,
    bytes: 0,
    capture_us: 0,
    convert_us: 0,
    encode_us: 0,
    waits: 0,
    latency_us: 0,
    acked: 0,
    ...o,
  });

  it('rates frames, sizes and times over the period', () => {
    const s = new FrameStats(0);
    s.received(1, 10_000);
    s.drawn(4, 1);
    s.received(2, 30_000);
    s.drawn(6, 3);
    const v = s.take(2000);
    expect(v.fps).toBe(1);
    expect(v.kbPerFrame).toBe(20);
    expect(v.mbps).toBeCloseTo(0.16);
    expect(v.decodeMs).toBe(5);
    expect(v.drawMs).toBe(2);
    expect(v.machine).toBeUndefined();
    // The next period starts empty.
    expect(s.take(3000)).toMatchObject({ fps: 0, kbPerFrame: 0, decodeMs: 0 });
  });

  it('counts frames skipped for this window, not across reconnects', () => {
    const s = new FrameStats(0);
    s.received(1, 1);
    s.received(5, 1); // 2, 3 and 4 went elsewhere
    s.reconnected();
    s.received(1, 1);
    expect(s.take(1000).skipped).toBe(3);
  });

  it('shows the machine’s costs per update', () => {
    const s = new FrameStats(0);
    s.reported(
      report({
        updates: 20,
        frames: 40,
        pixels: 4e6,
        interval_us: 2e6,
        capture_us: 60_000,
        convert_us: 20_000,
        encode_us: 280_000,
        waits: 10,
        latency_us: 900_000,
        acked: 18,
        jpeg: 35,
        png: 5,
      }),
      500,
    );
    expect(s.take(1000).machine).toEqual({
      ups: 10,
      fps: 20,
      mpx: 2,
      captureMs: 3,
      convertMs: 1,
      encodeMs: 14,
      latencyMs: 50,
      waits: 5,
      jpeg: 35,
      png: 5,
      video: 0,
      encoder: undefined,
      fallback: undefined,
    });
  });

  it('drops the machine’s figures once reports stop', () => {
    const s = new FrameStats(0);
    s.reported(report({ updates: 1 }), 0);
    expect(s.take(1000).machine).toBeDefined();
    expect(s.take(4000).machine).toBeUndefined();
  });
});

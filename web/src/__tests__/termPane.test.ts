// @vitest-environment jsdom
//
// A terminal's pane (vt/pane.ts) with the real emulator, over a link that
// records what reaches the hub: a pane kept while its tab is not shown
// neither attaches nor draws (no renderer, so no WebGL context). A terminal's
// prelude (state/preludes.ts) is replayed into each new emulator before
// the stream's first paint, which leaves it in the scrollback; first
// paints here are built as herdr-core 0.1.21 sends them (their pieces
// copied from captured paints). Renderers and the cell's measure are
// stand-ins (jsdom has neither WebGL nor fonts); the emulator module is
// the real one, loaded when a test lets it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

const { gate, renderers } = vi.hoisted(() => {
  const gate: { vt?: Promise<unknown>; open?: () => void } = {};
  const renderers: Array<{ kind: 'webgl'; disposed: boolean; size?: [number, number] }> = [];
  return { gate, renderers };
});

// The emulator module loads when the test opens the gate.
vi.mock('../vt/module', async (actual) => {
  const real = await actual<typeof import('../vt/module')>();
  return { ...real, loadVt: () => gate.vt };
});
// Each renderer made, and whether it was given up.
vi.mock('../vt/renderer', async (actual) => {
  const real = await actual<typeof import('../vt/renderer')>();
  return {
    ...real,
    createRenderer: () => {
      const r = { kind: 'webgl' as const, disposed: false, size: undefined as [number, number] | undefined };
      renderers.push(r);
      return {
        kind: r.kind,
        setMetrics() {},
        invalidate() {},
        render() {},
        resize: (w: number, h: number) => void (r.size = [w, h]),
        dispose: () => void (r.disposed = true),
      };
    },
  };
});
// A cell of 8 by 16 device pixels.
vi.mock('../vt/atlas', async (actual) => {
  const real = await actual<typeof import('../vt/atlas')>();
  return {
    ...real,
    measureCell: (_ctx: unknown, o: { fontWeight: 400 | 500 }, dpr: number) => ({
      cw: 8,
      ch: 16,
      fontPx: 13,
      family: 'monospace',
      weight: o.fontWeight,
      baseline: 12,
      dpr,
    }),
  };
});

import { vtFromBytes, type Vt } from '../vt/module';
import { TermPane, type PaneOptions, type TermLink } from '../vt/pane';
import { Terminal, newFrame } from '../vt/terminal';
import { hexColor } from '../vt/renderer';
import { appearanceOf } from '../appearance';
import { getPrefs } from '../prefs';
import { setPrelude } from '../state/preludes';
import type { AttachOptions, StreamHandler } from '../term/connection';

// Node's file system, without its types in the browser project; under jsdom
// the module's URL is no file's, so the library is found from the web UI's
// directory, where the tests run.
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: string): Uint8Array<ArrayBuffer> };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const vt = vtFromBytes(fs.readFileSync(`${cwd}/src/vt/ghostty-vt.wasm`));

/** A link to a hub that takes every attach as stream 1 and records the
 * rest; held, an attach is answered only when release (or refuse) is
 * called. */
class Link implements TermLink {
  connected = true;
  attaches: AttachOptions[] = [];
  handler?: StreamHandler;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  detached: number[] = [];
  acked = 0;
  held = false;
  release?: () => void;
  refuse?: () => void;
  attach(o: AttachOptions, handler: StreamHandler) {
    this.attaches.push(o);
    this.handler = handler;
    if (!this.held) return Promise.resolve(1);
    return new Promise<number>((resolve, reject) => {
      this.release = () => resolve(1);
      this.refuse = () => reject(new Error('unavailable'));
    });
  }
  write(_s: number, data: Uint8Array) {
    this.written.push(new TextDecoder().decode(data));
  }
  ack(_s: number, n: number) {
    this.acked += n;
  }
  resize(_s: number, cols: number, rows: number) {
    this.resized.push([cols, rows]);
  }
  focus() {}
  detach(s: number) {
    this.detached.push(s);
  }
}

/** The pane's ResizeObservers, to tell them the pane's size changed. */
const observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    observers.push(() => this.cb());
  }
  observe() {}
  disconnect() {}
}

/** Lets the emulator module load, and what waits for it run. */
async function loadEmulator() {
  gate.open?.();
  await settle();
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Longer than the pane waits to try a refused attach again. */
const ATTACH_WAIT = 1600;

const enc = (s: string) => new TextEncoder().encode(s);

// What starts every first paint of the terminal core: CAN, a soft reset,
// the modes reset, the main screen, the screen cleared (not its history).
const PAINT_HEAD =
  '\x18\x1b[!p\x1b[?2026l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?1016l\x1b[?2004l\x1b[?1l\x1b[?66l\x1b[?2031l\x1b[?2048l\x1b[=0;1u\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[H\x1b[2J';
// The screen's part: cleared again, the tab stops, home.
const SCREEN_HEAD =
  '\x1b[H\x1b[2J\x1b[3g\x1b[9G\x1bH\x1b[17G\x1bH\x1b[25G\x1bH\x1b[33G\x1bH\x1b[41G\x1bH\x1b[49G\x1bH\x1b[57G\x1bH\x1b[65G\x1bH\x1b[73G\x1bH\x1b[H';
/** A line with styles, as a captured history has it: bold red, a 256
 * color, a true color on a true color, italic underlined. */
const styled = (n: number) =>
  `\x1b[0m\x1b[1m\x1b[38;5;1mred-${n}\x1b[0m \x1b[0m\x1b[38;5;45mc256\x1b[0m \x1b[0m\x1b[38;2;200;100;50m\x1b[48;2;10;20;30mtrue\x1b[0m ` +
  `\x1b[0m\x1b[3m\x1b[4munder-italic\x1b[0m`;
const styledText = (n: number) => `red-${n} c256 true under-italic`;

/** A first paint of a terminal of `rows` rows: its history lines, pushed
 * up by as many newlines as the screen has rows, then the screen, with the
 * cursor at its last row's end unless placed elsewhere ([row, col], from
 * 1), and the paint's end (a snapshot stops before it). */
function paint(history: string[], screen: string[], rows: number, o: { cursor?: [number, number]; end?: boolean } = {}): string {
  const hist = history.length ? history.join('\r\n') + '\x1b[0m\r\n' + '\n'.repeat(rows) : '';
  const [row, col] = o.cursor ?? [screen.length, screen[screen.length - 1].length + 1];
  return PAINT_HEAD + hist + SCREEN_HEAD + screen.join('\r\n') + `\x1b[${row};${col}H\x1b[0m` + (o.end === false ? '' : '\x1b[?9001l');
}

/** The first paint of a new shell after the terminal core started again, captured. */
const NEW_SHELL = PAINT_HEAD + SCREEN_HEAD + '$ \x1b[1;3H\x1b[0m\x1b[?9001l';

/** Every line of an emulator, its scrollback first, as text. */
function lines(term: Terminal): string[] {
  term.selectAll();
  const text = term.selectionText() ?? '';
  term.clearSelection();
  return text.split('\n').map((l) => l.trimEnd());
}

/** Records what is written into emulators, in order. */
function recordWrites(): Uint8Array[] {
  const writes: Uint8Array[] = [];
  const write = Terminal.prototype.write;
  vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: Terminal, data: Uint8Array) {
    writes.push(data.slice());
    write.call(this, data);
  });
  return writes;
}

describe('a terminal’s pane', () => {
  let made: TermPane[];
  let link: Link;

  beforeEach(() => {
    made = [];
    renderers.length = 0;
    observers.length = 0;
    gate.vt = new Promise<Vt>((resolve) => (gate.open = () => resolve(vt)));
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    // jsdom draws nothing: the pane's measuring context is not used (measureCell above).
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    link = new Link();
  });
  afterEach(() => {
    for (const p of made) p.dispose();
    setPrelude('a', 't1', undefined);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A pane laid out at w by h CSS pixels, as TerminalView makes it. */
  function pane(w = 800, h = 400, o: Partial<PaneOptions> = {}) {
    const host = document.createElement('div');
    const size = { w, h };
    Object.defineProperty(host, 'clientWidth', { get: () => size.w });
    Object.defineProperty(host, 'clientHeight', { get: () => size.h });
    const canvas = document.createElement('canvas');
    const textarea = document.createElement('textarea');
    host.append(canvas, textarea);
    document.body.append(host);
    const attached = vi.fn();
    const p = new TermPane(
      host,
      canvas,
      textarea,
      {
        m: 'a',
        address: 't1',
        connection: link,
        onConnection: () => () => {},
        readOnly: () => false,
        appKey: () => false,
        activate: () => {},
        linkContext: () => ({ m: 'a', pane: 't1' }),
        mathHover: () => false,
        copyOnSelect: () => false,
        scrollback: () => 1000,
        setTitle: () => {},
        onFind: () => {},
        onClosed: () => {},
        onBell: () => {},
        onAttached: attached,
        ...o,
      },
      appearanceOf(getPrefs()),
    );
    made.push(p);
    return { p, attached, size };
  }

  it('kept before it attached, neither attaches nor draws until it is shown', async () => {
    const { p } = pane();
    p.setShown(false);
    await loadEmulator();
    expect(link.attaches).toEqual([]);
    expect(renderers).toEqual([]);
    expect(p.usage).toEqual({ hidden: true, attached: false, renderer: undefined });
    // Its tab shown again: attached and drawn.
    p.setShown(true);
    expect(link.attaches).toHaveLength(1);
    expect(renderers).toHaveLength(1);
    expect(p.usage.renderer).toBe('webgl');
  });

  it('gives its renderer up while kept and makes another when shown again, attached once', async () => {
    const { p } = pane();
    await loadEmulator();
    expect(renderers).toHaveLength(1);
    p.setShown(false);
    expect(renderers[0].disposed).toBe(true);
    expect(p.usage.renderer).toBeUndefined();
    p.setShown(true);
    expect(renderers).toHaveLength(2);
    expect(link.attaches).toHaveLength(1);
  });

  describe('with a prelude', () => {
    // A saved snapshot of a terminal of 80 by 24 that ran a shell: plain
    // and styled history lines, then its screen (stopping before the
    // paint's end, as the machine keeps it).
    const savedHistory = Array.from({ length: 40 }, (_, i) => String(i + 1));
    const savedScreen = [...Array.from({ length: 22 }, (_, i) => String(7009 + i)), 'K2-42', '$ '];
    const saved = paint([...savedHistory, styled(1), styled(2)], savedScreen, 24, { end: false });
    const savedLines = [...savedHistory, styledText(1), styledText(2), ...savedScreen.map((l) => l.trimEnd())];

    it('is written before the stream’s first byte and stays in the scrollback above the first paint', async () => {
      const writes = recordWrites();
      setPrelude('a', 't1', enc(saved), 'saved output of before');
      const { p } = pane();
      await loadEmulator();
      expect(link.attaches).toHaveLength(1);
      // The snapshot's bytes as they are, first; then what the pane adds.
      expect(writes[0]).toEqual(enc(saved));
      const before = writes.length;
      const live = enc(paint(['new-1', 'new-2'], ['$ '], 25));
      link.handler!.output(live);
      expect(writes.slice(before)).toEqual([live]);
      await settle(120);
      const all = lines(p.term!);
      // The snapshot, its note below its last row, the live history, the
      // live screen (a paint pushing its history up by a screen of its own
      // height leaves a blank row before the screen).
      expect(all.slice(0, savedLines.length + 5)).toEqual([...savedLines, 'saved output of before', 'new-1', 'new-2', '', '$']);
      // Its styles are kept: the first styled line (the 41st), shown at the top.
      p.term!.scroll('top');
      p.term!.scroll(savedHistory.length);
      const f = newFrame(p.term!.cols, p.term!.rows);
      p.term!.update(f);
      p.term!.scroll('bottom');
      const row = f.lines.find((r) => String.fromCodePoint(...r.codes.slice(0, 5)) === 'red-1');
      expect(row).toBeDefined();
      expect(row!.fg[0]).not.toBe(-1);
      expect(row!.bg[11]).not.toBe(-1);
      // Nothing of it reached the program.
      expect(link.written).toEqual([]);
    });

    it('of a snapshot taken on the alternate screen, keeps the main screen and puts its note below it', async () => {
      const alt = saved + '\x1b[?1049h\x1b[!p\x1b[?1000h\x1b[H\x1b[1mALT-APP\x1b[0m\r\nALT-LINE-2';
      setPrelude('a', 't1', enc(alt), 'saved');
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      const all = lines(p.term!);
      expect(all.slice(0, savedLines.length + 2)).toEqual([...savedLines, 'saved', '$']);
      expect(all.join('\n')).not.toContain('ALT-');
      expect(p.term!.altScreen).toBe(false);
      // The program's mouse mode of the snapshot is not the live one's.
      expect(p.term!.mouseTracking).toBe(false);
    });

    it('keeps the rows below a cursor left above them, its note after the last of them', async () => {
      // An agent's screen: the cursor in its input box, a footer below.
      const tui = paint(['older'], ['answer', '╭────╮', '│ >  │', '╰────╯', '? for shortcuts'], 24, { cursor: [3, 5], end: false });
      setPrelude('a', 't1', enc(tui), 'saved');
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      expect(lines(p.term!).slice(0, 8)).toEqual(['older', 'answer', '╭────╮', '│ >  │', '╰────╯', '? for shortcuts', 'saved', '$']);
    });

    it('without a note, leaves the snapshot’s rows above the first paint and nothing between', async () => {
      setPrelude('a', 't1', enc(saved));
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      expect(lines(p.term!).slice(0, savedLines.length + 1)).toEqual([...savedLines, '$']);
    });

    it('drops what the emulator would answer, report or ring while it is written', async () => {
      const title = vi.fn();
      const bell = vi.fn();
      // Queries (device attributes, cursor position), a title, a bell and a clipboard write.
      const noisy = saved + '\x1b[c\x1b[6n\x1b]2;old title\x07\x07\x1b]52;c;aGVsbG8=\x07';
      const { p } = pane(800, 400, { onTitle: title, onBell: bell });
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      // Attached again for the prelude that came: the stream is there.
      setPrelude('a', 't1', enc(noisy), 'saved');
      await settle(120);
      expect(link.attaches).toHaveLength(2);
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      expect(link.written).toEqual([]);
      expect(title).not.toHaveBeenCalledWith('old title');
      expect(bell).not.toHaveBeenCalled();
      expect(lines(p.term!)).toContain('saved');
    });

    it('without one, writes the stream into the emulator as it comes and nothing else', async () => {
      const writes = recordWrites();
      const { p } = pane();
      await loadEmulator();
      const chunks = [enc(paint(['h1', 'h2'], ['$ '], 25)), enc('ls\r\n'), enc('a  b\r\n$ ')];
      for (const c of chunks) link.handler!.output(c);
      await settle(120);
      expect(writes).toEqual(chunks);
      expect(link.attaches).toHaveLength(1);
      expect(link.written).toEqual([]);
      expect(lines(p.term!).slice(0, 6)).toEqual(['h1', 'h2', '', '$ ls', 'a  b', '$']);
    });

    it('that comes while attached, attaches again once for a burst, with the same grid', async () => {
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      setPrelude('a', 't1', enc('one'), 'saved');
      setPrelude('a', 't1', enc('two'), 'saved');
      setPrelude('a', 't1', enc('three'), 'saved');
      await settle(120);
      expect(link.detached).toEqual([1]);
      expect(link.attaches).toHaveLength(2);
      expect(link.attaches[1]).toMatchObject({ cols: 100, rows: 25 });
      expect(link.resized).toEqual([]);
      expect(p.attached).toBe(true);
      link.handler!.output(enc(NEW_SHELL));
      expect(lines(p.term!).slice(0, 3)).toEqual(['three', 'saved', '$']);
      // The same again changes nothing; one gone is shown gone.
      setPrelude('a', 't1', enc('three'), 'saved');
      await settle(120);
      expect(link.attaches).toHaveLength(2);
      setPrelude('a', 't1', undefined);
      await settle(120);
      expect(link.attaches).toHaveLength(3);
      link.handler!.output(enc(NEW_SHELL));
      expect(lines(p.term!)[0]).toBe('$');
    });

    it('that comes while attaching, attaches again once attached', async () => {
      link.held = true;
      const { p } = pane();
      await loadEmulator();
      expect(link.attaches).toHaveLength(1);
      setPrelude('a', 't1', enc('late'), 'saved');
      await settle(120);
      expect(link.attaches).toHaveLength(1);
      link.held = false;
      link.release!();
      await settle(120);
      expect(link.detached).toEqual([1]);
      expect(link.attaches).toHaveLength(2);
      link.handler!.output(enc(NEW_SHELL));
      expect(lines(p.term!).slice(0, 2)).toEqual(['late', 'saved']);
    });

    it('does not attach a pane kept before it attached', async () => {
      const { p } = pane();
      p.setShown(false);
      await loadEmulator();
      setPrelude('a', 't1', enc('kept'), 'saved');
      await settle(120);
      expect(link.attaches).toEqual([]);
    });

    // Saved at one grid, shown in a pane of another: [saved cols, rows], [pane width, height] (cells of 8 by 16).
    it.each([
      ['24 rows into 50', [80, 24], [800, 800]],
      ['50 rows into 24', [80, 50], [640, 384]],
      ['120 columns into 80', [120, 24], [640, 384]],
      ['40 by 24 into 100 by 50', [40, 24], [800, 800]],
    ])(
      'painted at another grid (%s), keeps every saved line in the scrollback above the live terminal’s',
      async (_, [cols, rows], [w, h]) => {
        const history = Array.from({ length: 80 }, (_, i) => `h${i + 1}-${'y'.repeat(i % 3 === 0 ? cols - 10 : 5)}`);
        const screen = [...Array.from({ length: rows - 1 }, (_, i) => `s${i + 1}`), '$ '];
        setPrelude('a', 't1', enc(paint(history, screen, rows, { end: false })), 'NOTE', { cols, rows });
        const { p } = pane(w, h);
        await loadEmulator();
        const live = { cols: w / 8, rows: h / 16 };
        expect(link.attaches[0]).toMatchObject(live);
        // The emulator went back to the pane's grid before the stream's first byte.
        expect([p.term!.cols, p.term!.rows]).toEqual([live.cols, live.rows]);
        link.handler!.output(enc(paint(['new-1'], ['$ '], live.rows)));
        await settle(120);
        // As the paint left them at its own grid: its history, the blank row
        // it pushed up with it, its screen; then the note and the live history.
        const saved = [...history, '', ...screen.map((l) => l.trimEnd())];
        expect(lines(p.term!).slice(0, saved.length + 2)).toEqual([...saved, 'NOTE', 'new-1']);
      },
    );

    it('keeps the saved lines of an observer’s pane that the terminal core resizes before its first paint', async () => {
      const history = Array.from({ length: 80 }, (_, i) => `h${i + 1}`);
      const screen = [...Array.from({ length: 23 }, (_, i) => `s${i + 1}`), '$ '];
      setPrelude('a', 't1', enc(paint(history, screen, 24, { end: false })), 'NOTE', { cols: 80, rows: 24 });
      const { p } = pane(640, 384, { readOnly: () => true });
      await loadEmulator();
      expect(link.attaches[0]).toMatchObject({ observe: true });
      // The terminal's own grid, then its paint at that grid.
      link.handler!.resized!(100, 50);
      link.handler!.output(enc(paint(['new-1'], ['$ '], 50)));
      await settle(120);
      const saved = [...history, '', ...screen.map((l) => l.trimEnd())];
      expect(lines(p.term!).slice(0, saved.length + 2)).toEqual([...saved, 'NOTE', 'new-1']);
    });

    // A snapshot's bytes are a program's output: what they leave set must
    // not reach the live terminal. A link left open, black text colors,
    // reverse video, the mouse, pastes, focus and the size reported, kitty
    // keyboard flags on both screens.
    const hostile =
      saved +
      '\x1b[?1049h\x1b[>31u\x1b[>31u\x1b[?1049l' +
      '\x1b]8;;https://evil.example/\x1b\\\x1b]10;#000000\x07\x1b]11;#000000\x07\x1b[?5h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h' +
      '\x1b[>31u\x1b[?2048h\x1b[?1h\x1b[?67h\x1b[20h\x1b[?1007l\x1b[6 q linked';
    const ctrlA = (t: Terminal) => new TextDecoder().decode(t.encodeKey({ action: 'press', code: 'KeyA', mods: 2, text: 'a' }));

    it('of hostile output, leaves none of its state to the live terminal after its first paint', async () => {
      setPrelude('a', 't1', enc(hostile), 'saved');
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(paint(['new-1'], ['$ '], 25)));
      link.handler!.output(enc('echo hi'));
      await settle(120);
      const term = p.term!;
      expect(lines(term)).toContain('saved');
      // The live text links nowhere, and is drawn in the theme's colors.
      expect(p.screenText().split('\n')[0]).toBe('$ echo hi');
      for (let x = 0; x < 9; x++) expect(term.hyperlinkAt(x, 0)).toBeUndefined();
      const f = newFrame(term.cols, term.rows);
      term.update(f);
      const colors = appearanceOf(getPrefs()).colors;
      expect(f.colors.fg).toBe(hexColor(colors.foreground));
      expect(f.colors.bg).toBe(hexColor(colors.background));
      expect(term.mode(5)).toBe(false);
      expect(term.mouseTracking).toBe(false);
      expect(ctrlA(term)).toBe('\x01');
      // A program on the alternate screen: no flags of the snapshot's there either.
      link.handler!.output(enc('\x1b[?1049h'));
      expect(ctrlA(term)).toBe('\x01');
    });

    it('brings every mode the emulator has, flipped on both screens, back to a new emulator’s', async () => {
      // libghostty-vt's modes (DEC private, then ANSI); the ones that switch
      // screens or save the cursor are actions, and 3 (132 columns) takes
      // no effect without 40, which is reset.
      const dec = [1, 4, 5, 6, 7, 8, 9, 12, 25, 40, 45, 66, 67, 69, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016];
      const more = [1035, 1036, 1039, 1045, 2004, 2026, 2027, 2031, 2048];
      const ansi = [2, 4, 12, 20];
      // A new emulator as the pane makes it: the cursor of the settings.
      const a = appearanceOf(getPrefs());
      const fresh = new Terminal(vt, 100, 25);
      fresh.setCursorDefaults(a.cursorStyle, a.cursorBlink);
      fresh.write(enc('\x1b[0 q'));
      const flip =
        [...dec, ...more].map((n) => `\x1b[?${n}${fresh.mode(n) ? 'l' : 'h'}`).join('') +
        ansi.map((n) => `\x1b[${n}${fresh.mode(n, true) ? 'l' : 'h'}`).join('') +
        '\x1b[>31u\x1b[>4;2m\x1b(0\x0e\x1b[5;10r\x1b[1;7;38;5;9m\x1b]8;;https://evil.example/\x1b\\\x1b]4;1;#000000\x07\x1b]12;#000000\x07\x1b[6 q';
      setPrelude('a', 't1', enc(`${saved}${flip}\x1b[?1049h${flip}x`), 'saved');
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc('$ '));
      await settle(700);
      const term = p.term!;
      const keys = (t: Terminal) =>
        [
          { code: 'KeyA', mods: 2, text: 'a' },
          { code: 'KeyB', mods: 4, text: 'b' },
          { code: 'Enter', mods: 0 },
          { code: 'Enter', mods: 2 },
          { code: 'Backspace', mods: 0 },
          { code: 'ArrowUp', mods: 0 },
          { code: 'Numpad1', mods: 0, text: '1' },
          { code: 'Escape', mods: 0 },
          { code: 'Tab', mods: 1 },
        ].map((k) => new TextDecoder().decode(t.encodeKey({ action: 'press', ...k })));
      const state = (t: Terminal) => ({
        dec: [...dec, ...more].map((n) => [n, t.mode(n)]),
        ansi: ansi.map((n) => [n, t.mode(n, true)]),
        keys: keys(t),
        paste: new TextDecoder().decode(t.encodePaste('a\nb')),
        focus: new TextDecoder().decode(t.encodeFocus(true)),
        mouse: t.mouseTracking,
        cursor: (() => {
          const f = newFrame(t.cols, t.rows);
          t.update(f);
          return [f.cursor.style, f.cursor.blinking, f.cursor.visible];
        })(),
      });
      const want = state(fresh);
      expect(state(term)).toEqual(want);
      // And on the alternate screen a live program enters.
      term.write(enc('\x1b[?1049h'));
      fresh.write(enc('\x1b[?1049h'));
      expect(state(term)).toEqual(state(fresh));
      fresh.dispose();
      // What it writes is plain text, in the theme's styles, linked nowhere.
      term.write(enc('\x1b[Hqx'));
      const f = newFrame(term.cols, term.rows);
      term.update(f);
      expect(String.fromCodePoint(...f.lines[0].codes.slice(0, 2))).toBe('qx');
      expect([f.lines[0].fg[0], f.lines[0].bg[0], f.lines[0].flags[0]]).toEqual([-1, -1, 0]);
      expect(term.hyperlinkAt(0, 0)).toBeUndefined();
    });

    it('of hostile output, leaves none of its state to live output that comes without a first paint', async () => {
      setPrelude('a', 't1', enc(hostile), 'saved');
      const { p, size } = pane();
      await loadEmulator();
      // The terminal core dropped the paint (above 4 MiB): only the program's output comes.
      link.handler!.output(enc('$ echo hi\r\nhi\r\n$ '));
      await settle(700);
      const term = p.term!;
      // No bytes its modes would have the pane send.
      const fresh = new Terminal(vt, term.cols, term.rows);
      for (const mode of [1, 5, 67, 1003, 1004, 1006, 1007, 2004, 2048]) expect(term.mode(mode), `?${mode}`).toBe(fresh.mode(mode));
      expect(term.mode(20, true)).toBe(false);
      fresh.dispose();
      expect(term.mouseTracking).toBe(false);
      expect(ctrlA(term)).toBe('\x01');
      expect(term.hyperlinkAt(2, 0)).toBeUndefined();
      p.paste('ls\nrm x');
      expect(link.written).toEqual(['ls\rrm x']);
      p.focus();
      (document.activeElement as HTMLElement).blur();
      size.w = 640;
      observers.forEach((f) => f());
      expect(link.resized).toEqual([[80, 25]]);
      expect(link.written).toEqual(['ls\rrm x']);
    });

    it('keeps what is typed while it attaches again for one, and sends it on the new stream', async () => {
      const { p, attached } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      link.held = true;
      setPrelude('a', 't1', enc('late'), 'saved');
      await settle(120);
      expect(link.attaches).toHaveLength(2);
      expect(p.attached).toBe(false);
      p.type('claude --resume X\r');
      p.paste('more');
      expect(link.written).toEqual([]);
      link.release!();
      await settle();
      expect(link.written).toEqual(['claude --resume X\r', 'more']);
      expect(attached).toHaveBeenCalledTimes(2);
      // Attached, it sends at once.
      p.type('x');
      expect(link.written).toEqual(['claude --resume X\r', 'more', 'x']);
    });

    it('keeps at most 64 KiB of it, and drops it when that attach fails or the pane goes', async () => {
      const { p } = pane();
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      link.held = true;
      setPrelude('a', 't1', enc('one'), 'saved');
      await settle(120);
      p.type('a'.repeat(40 * 1024));
      p.type('b'.repeat(30 * 1024));
      p.type('c');
      link.release!();
      await settle();
      expect(link.written.map((s) => s[0] + s.length)).toEqual([`a${40 * 1024}`, 'c1']);
      // Refused: nothing of it is sent by a later attach.
      link.written = [];
      setPrelude('a', 't1', enc('two'), 'saved');
      await settle(120);
      p.type('lost');
      link.refuse!();
      await settle(ATTACH_WAIT);
      expect(link.attaches).toHaveLength(4);
      link.release!();
      await settle();
      expect(p.attached).toBe(true);
      expect(link.written).toEqual([]);
      // Gone while it attaches again: nothing is sent.
      setPrelude('a', 't1', enc('three'), 'saved');
      await settle(120);
      p.type('gone');
      p.dispose();
      link.release!();
      await settle();
      expect(link.written).toEqual([]);
    });
  });

  describe('whose program ended', () => {
    async function ended(o: Partial<PaneOptions> = {}, known = true) {
      const closed = vi.fn();
      const reopened = vi.fn();
      const made = pane(800, 400, { onClosed: closed, onReopen: reopened, ...o });
      if (known) made.p.setProgram(200);
      await loadEmulator();
      link.handler!.output(enc(NEW_SHELL));
      await settle(120);
      if (!known) made.p.setProgram(200);
      // The terminal core stopped: the program ended with it.
      link.handler!.closed('exited', 1);
      expect(closed).toHaveBeenCalledWith('exited', 1);
      return { ...made, closed, reopened };
    }

    it('attaches again once, when the terminal has another program', async () => {
      const { p, attached, reopened } = await ended();
      expect(p.attached).toBe(false);
      expect(attached).toHaveBeenCalledTimes(1);
      // The record says finished, then the terminal core is away: no program.
      p.setProgram(undefined);
      p.setProgram(undefined);
      await settle();
      expect(link.attaches).toHaveLength(1);
      // The terminal core started again and gave the kept terminal a new shell at its address.
      p.setProgram(201);
      expect(reopened).toHaveBeenCalledTimes(1);
      await settle();
      expect(link.attaches).toHaveLength(2);
      expect(attached).toHaveBeenCalledTimes(2);
      expect(p.attached).toBe(true);
      p.setProgram(201);
      await settle();
      expect(link.attaches).toHaveLength(2);
      // Input reaches the new program.
      p.type('ls\r');
      expect(link.written).toEqual(['ls\r']);
    });

    it('stays closed while the terminal is finished or runs the program that ended', async () => {
      const { p, attached, reopened } = await ended();
      p.setProgram(undefined);
      p.setProgram(200);
      await settle(50);
      expect(link.attaches).toHaveLength(1);
      expect(attached).toHaveBeenCalledTimes(1);
      expect(reopened).not.toHaveBeenCalled();
      p.type('x');
      expect(link.written).toEqual([]);
    });

    it('takes the program the record names once attached as the stream’s', async () => {
      const { p, reopened } = await ended({}, false);
      p.setProgram(200);
      await settle();
      expect(link.attaches).toHaveLength(1);
      p.setProgram(300);
      await settle();
      expect(reopened).toHaveBeenCalledTimes(1);
      expect(link.attaches).toHaveLength(2);
    });

    it('is not closed for good by the connection going: a program does not attach it, the connection coming back does', async () => {
      let connection: (up: boolean) => void = () => {};
      const onConnection = (fn: (up: boolean) => void) => ((connection = fn), () => {});
      const { p, attached } = pane(800, 400, { onConnection });
      p.setProgram(200);
      await loadEmulator();
      link.handler!.closed('disconnected');
      p.setProgram(201);
      await settle();
      expect(link.attaches).toHaveLength(1);
      expect(attached).toHaveBeenCalledTimes(1);
      connection(true);
      await settle();
      expect(link.attaches).toHaveLength(2);
      expect(attached).toHaveBeenCalledTimes(2);
    });

    it('lets appKey intercept Ctrl+B before Ghostty encodes it, and sends Ctrl+B when unbound', async () => {
      let intercept = true;
      const appKey = vi.fn(() => intercept);
      const { p } = pane(800, 400, { appKey });
      p.setProgram(100);
      await loadEmulator();
      const ta = document.querySelector('textarea')!;
      const ev1 = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true });
      ta.dispatchEvent(ev1);
      expect(appKey).toHaveBeenCalledTimes(1);
      expect(ev1.defaultPrevented).toBe(true);
      expect(link.written).toEqual([]);

      intercept = false;
      const ev2 = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true });
      ta.dispatchEvent(ev2);
      expect(ev2.defaultPrevented).toBe(true);
      expect(link.written).toEqual(['\x02']);
    });
  });
});

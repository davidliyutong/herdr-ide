// The terminal emulator (libghostty-vt as WebAssembly) loaded in Node:
// output to cells, colors and attributes, wide characters and graphemes,
// resizing, the terminal's answers through the callback path, encoders,
// selections and find.

import keyTable from './testdata/vt-keys.json';
import { describe, expect, it } from 'vitest';
import { trampolines, vtFromBytes } from '../vt/module';
import { keyInput, type KeyOptions } from '../vt/input';
import { drawRow, type Overlay } from '../vt/renderer';
import {
  F_BOLD,
  F_FAINT,
  F_INVERSE,
  F_ITALIC,
  F_STRIKE,
  MODS_ALT,
  MODS_CTRL,
  MODS_SHIFT,
  Terminal,
  UNDERLINE_SHIFT,
  WIDE_TAIL,
  WIDE_WIDE,
  keyName,
  newFrame,
  palette256,
  rowText,
  type TerminalCallbacks,
} from '../vt/terminal';

// Node's file system, without its types in the browser project.
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: URL): Uint8Array<ArrayBuffer> };
const vt = vtFromBytes(fs.readFileSync(new URL('../vt/ghostty-vt.wasm', import.meta.url)));
const ansi = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff,
  0xff00ff, 0x00ffff, 0xffffff,
];

function term(cols = 20, rows = 5, cb: TerminalCallbacks = {}) {
  const t = new Terminal(vt, cols, rows, cb);
  t.setColors({ fg: 0xf0f0f0, bg: 0x0a0a0a, cursor: 0xf0f0f0, palette: ansi });
  t.setScrollback(1000);
  return t;
}

function frameOf(t: Terminal) {
  const f = newFrame(t.cols, t.rows);
  t.update(f);
  return f;
}

const text = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s));
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe('wasm module', () => {
  it('frees all a terminal took, its input buffer too', () => {
    const t = term();
    const free = vt.free.bind(vt);
    t.write(new Uint8Array(100_000).fill(0x41));
    // What the terminal holds is freed by dispose: watch for its input buffer.
    const inBuf = (t as unknown as { inBuf: number; inCap: number }).inBuf;
    const inCap = (t as unknown as { inBuf: number; inCap: number }).inCap;
    expect(inBuf).not.toBe(0);
    const freed: [number, number][] = [];
    vt.free = (p: number, n: number) => (freed.push([p, n]), free(p, n));
    try {
      t.dispose();
    } finally {
      vt.free = free;
    }
    expect(freed).toContainEqual([inBuf, inCap]);
  });

  it('turns JavaScript functions into wasm functions a table takes', () => {
    const calls: number[] = [];
    const [f] = trampolines([{ params: ['i32', 'i32'], results: ['i32'], fn: (a: number, b: number) => (calls.push(a, b), a + b) }]);
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    table.set(0, f as never);
    expect((table.get(0) as (a: number, b: number) => number)(2, 3)).toBe(5);
    expect(calls).toEqual([2, 3]);
  });

  it('reads struct layouts and enums from the library', () => {
    expect(vt.size('GhosttyString')).toBe(8);
    expect(vt.enumValue('GhosttyKey', 'ARROW_UP')).toBeGreaterThan(0);
  });
});

describe('Terminal', () => {
  it('writes text into cells with colors and attributes', () => {
    const t = term();
    t.writeText('ab\x1b[1;31mR\x1b[0;3;4mi\x1b[0;7mv\x1b[0;2;9mf\x1b[38;2;1;2;3mt\x1b[48;5;21mb\x1b[0m');
    const f = frameOf(t);
    const r = f.lines[0];
    expect(rowText(r).trimEnd()).toBe('abRivftb');
    expect(r.fg[0]).toBe(-1);
    expect(r.flags[2] & F_BOLD).toBeTruthy();
    expect(r.fg[2]).toBe(ansi[1]);
    expect(r.flags[3] & F_ITALIC).toBeTruthy();
    expect((r.flags[3] >> UNDERLINE_SHIFT) & 7).toBe(1);
    expect(r.flags[4] & F_INVERSE).toBeTruthy();
    expect(r.flags[5] & F_FAINT && r.flags[5] & F_STRIKE).toBeTruthy();
    expect(r.fg[6]).toBe(0x010203);
    expect(r.bg[7]).toBe(palette256(ansi)[21]);
    expect(f.colors.bg).toBe(0x0a0a0a);
    expect(f.colors.palette[1]).toBe(ansi[1]);
    expect(f.dirty.has(0)).toBe(true);
    t.dispose();
  });

  it('shows bold text in the bright colors when asked', () => {
    const t = term();
    t.setBoldIsBright(true);
    t.writeText('\x1b[1;32mx\x1b[0;32my');
    const r = frameOf(t).lines[0];
    expect(r.fg[0]).toBe(ansi[10]);
    expect(r.fg[1]).toBe(ansi[2]);
    t.dispose();
  });

  it('keeps wide characters and grapheme clusters', () => {
    const t = term();
    t.writeText('中文 é 👍🏽');
    const r = frameOf(t).lines[0];
    expect(r.wide[0]).toBe(WIDE_WIDE);
    expect(r.wide[1]).toBe(WIDE_TAIL);
    expect(String.fromCodePoint(r.codes[2])).toBe('文');
    expect(r.text[5]).toBe(text('é'));
    expect(r.text[7]).toBe('👍🏽');
    expect(rowText(r).trimEnd()).toBe('中文 é 👍🏽');
    t.dispose();
  });

  it('reflows soft-wrapped lines when the width changes', () => {
    const t = term(10, 3);
    t.writeText('0123456789abcde');
    let f = frameOf(t);
    expect(f.lines[0].wrap).toBe(true);
    expect(rowText(f.lines[1]).trimEnd()).toBe('abcde');
    t.resize(20, 3);
    f = frameOf(t);
    expect(f.cols).toBe(20);
    expect(rowText(f.lines[0]).trimEnd()).toBe('0123456789abcde');
    t.dispose();
  });

  it('answers the program through the reply callback', () => {
    const replies: string[] = [];
    const t = term(20, 5, { reply: (d) => replies.push(str(d)) });
    t.writeText('\x1b[c\x1b[3;4H\x1b[6n\x1b]11;?\x07');
    expect(replies[0]).toMatch(/^\x1b\[\?[\d;]+c$/);
    expect(replies).toContain('\x1b[3;4R');
    expect(replies.some((r) => r.startsWith('\x1b]11;rgb:0a0a/0a0a/0a0a'))).toBe(true);
    t.dispose();
  });

  it('reports the bell, the title and the color scheme', () => {
    const got: string[] = [];
    const t = term(20, 5, {
      bell: () => got.push('bell'),
      title: (s) => got.push(`title:${s}`),
      dark: () => true,
      reply: (d) => got.push(str(d)),
    });
    t.writeText('\x07\x1b]2;hello\x07\x1b[?996n');
    expect(got).toEqual(['bell', 'title:hello', '\x1b[?997;1n']);
    expect(t.title).toBe('hello');
    t.dispose();
  });

  it('gives OSC 52 writes to the clipboard policy', () => {
    const copies: string[] = [];
    let allow = true;
    const t = term(20, 5, { clipboard: (s) => (copies.push(s), allow) });
    t.writeText(`\x1b]52;c;${btoa('copied')}\x07`);
    allow = false;
    t.writeText(`\x1b]52;c;${btoa('again')}\x07`);
    expect(copies).toEqual(['copied', 'again']);
    t.dispose();
  });

  it('places the cursor and follows its style', () => {
    const t = term();
    t.writeText('abc\x1b[5 q');
    const f = frameOf(t);
    expect(f.cursor).toMatchObject({ x: 3, y: 0, visible: true, style: 'bar', blinking: true });
    t.writeText('\x1b[?25l');
    t.update(f);
    expect(f.cursor.visible).toBe(false);
    t.dispose();
  });

  it('scrolls the view through the scrollback', () => {
    const t = term(10, 3);
    for (let i = 0; i < 10; i++) t.writeText(`line${i}\r\n`);
    expect(t.atBottom).toBe(true);
    const before = t.scrollbar();
    expect(before.total).toBeGreaterThan(before.len);
    t.scroll(-2);
    expect(t.scrollbar().offset).toBe(before.offset - 2);
    expect(rowText(frameOf(t).lines[0]).trimEnd()).toBe('line6');
    t.scroll('bottom');
    expect(t.atBottom).toBe(true);
    t.dispose();
  });

  it('selects by gestures and copies the text', () => {
    const t = term(20, 3);
    t.resize(20, 3, 10, 20);
    t.writeText('hello world\r\nsecond');
    t.selectPress(0, 0, 1, 1, 1000);
    t.selectDrag(4, 0, 48, 1);
    t.selectRelease(4, 0);
    expect(t.selectionText()).toBe('hello');
    expect(frameOf(t).lines[0].sel).toEqual([0, 4]);
    // A double click selects a word.
    t.selectPress(7, 0, 71, 1, 5000);
    t.selectRelease(7, 0);
    t.selectPress(7, 0, 71, 1, 5100);
    expect(t.selectionText()).toBe('world');
    t.clearSelection();
    expect(t.selectionText()).toBeUndefined();
    t.dispose();
  });

  it('finds text, ignoring case, and steps through matches', () => {
    const t = term(20, 4);
    t.writeText('Foo bar\r\nfoo\r\nbaz FOO');
    t.find('foo');
    expect(t.findState().total).toBe(3);
    expect(t.findStep(1)).toBe(true);
    expect(t.findState().selected).toBe(0);
    const m = t.findMatches();
    expect(m).toHaveLength(3);
    expect(m.find((x) => x.current)).toMatchObject({ y: 2, from: 4, to: 7 });
    t.find('');
    expect(t.findMatches()).toEqual([]);
    t.dispose();
  });

  it('reads hyperlinks of cells', () => {
    const t = term();
    t.writeText('\x1b]8;;https://example.com/x\x1b\\link\x1b]8;;\x1b\\ plain');
    expect(t.hyperlinkAt(1, 0)).toBe('https://example.com/x');
    expect(t.hyperlinkAt(6, 0)).toBeUndefined();
    expect(frameOf(t).lines[0].link[0]).toBe(1);
    t.dispose();
  });
});

describe('encoders', () => {
  it('names keys as libghostty does', () => {
    expect(keyName('KeyA')).toBe('A');
    expect(keyName('ArrowUp')).toBe('ARROW_UP');
    expect(keyName('Digit1')).toBe('DIGIT_1');
    expect(keyName('NumpadAdd')).toBe('NUMPAD_ADD');
    expect(keyName('F12')).toBe('F12');
    expect(keyName('BracketLeft')).toBe('BRACKET_LEFT');
  });

  it('encodes keys for the modes the program set', () => {
    const t = term();
    const key = (code: string, mods = 0, textIn = '', unshifted = 0) =>
      str(t.encodeKey({ action: 'press', code, mods, text: textIn, unshifted, consumed: textIn && mods & MODS_SHIFT ? MODS_SHIFT : 0 }));
    expect(key('ArrowUp')).toBe('\x1b[A');
    t.writeText('\x1b[?1h');
    expect(key('ArrowUp')).toBe('\x1bOA');
    expect(key('KeyC', MODS_CTRL, 'c', 0x63)).toBe('\x03');
    t.writeText('\x1b[>1u');
    expect(key('KeyC', MODS_CTRL, 'c', 0x63)).toBe('\x1b[99;5u');
    expect(key('Enter', MODS_SHIFT)).toBe('\x1b[13;2u');
    t.dispose();
  });

  it('encodes mouse events in the format the program asked for', () => {
    const t = term(80, 24);
    t.resize(80, 24, 10, 20);
    expect(t.mouseTracking).toBe(false);
    t.writeText('\x1b[?1000h\x1b[?1006h');
    expect(t.mouseTracking).toBe(true);
    expect(str(t.encodeMouse({ action: 'press', button: 1, mods: 0, x: 25, y: 45 }))).toBe('\x1b[<0;3;3M');
    expect(str(t.encodeMouse({ action: 'release', button: 1, mods: 0, x: 25, y: 45 }))).toBe('\x1b[<0;3;3m');
    expect(str(t.encodeMouse({ action: 'press', button: 4, mods: 0, x: 5, y: 5 }))).toBe('\x1b[<64;1;1M');
    t.dispose();
  });

  it('brackets pastes only when the program asked', () => {
    const t = term();
    expect(str(t.encodePaste('a\nb\x1bc'))).toBe('a\rb c');
    t.writeText('\x1b[?2004h');
    expect(str(t.encodePaste('a\nb'))).toBe('\x1b[200~a\nb\x1b[201~');
    t.dispose();
  });

  it('reports focus only to programs that asked', () => {
    const t = term();
    expect(t.encodeFocus(true).length).toBe(0);
    t.writeText('\x1b[?1004h');
    expect(str(t.encodeFocus(true))).toBe('\x1b[I');
    expect(str(t.encodeFocus(false))).toBe('\x1b[O');
    expect(MODS_ALT).toBe(4);
    t.dispose();
  });
});

describe('key table (testdata/vt-keys.json)', () => {
  const table = keyTable as {
    rows: Array<{ name: string; event: Record<string, unknown>; options?: KeyOptions; bytes: Record<string, string> | null }>;
  };
  const modes: Record<string, string> = { legacy: '', app: '\x1b[?1h\x1b=', kitty: '\x1b[>1u' };
  for (const row of table.rows) {
    it(row.name, () => {
      const ev = row.event;
      const like = {
        key: '',
        code: '',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        keyCode: 0,
        ...ev,
        getModifierState: (k: string) => k === 'AltGraph' && !!ev.altGraph,
      };
      const k = keyInput(like as never, { mac: false, ...row.options });
      if (row.bytes === null) return expect(k).toBeUndefined();
      expect(k).toBeDefined();
      for (const [mode, want] of Object.entries(row.bytes)) {
        const t = term();
        t.writeText(modes[mode]);
        expect(str(t.encodeKey(k!)), mode).toBe(want);
        t.dispose();
      }
    });
  }
});

describe('drawRow', () => {
  const look = { selection: 0x334455, match: 0x5c4813, matchCurrent: 0x9a6a00, cursorWidth: 1 };
  const ov = (o: Partial<Overlay> = {}): Overlay => ({ focused: true, blinkOn: true, matches: [], ...o });
  const frameWith = (text: string, cols = 20) => {
    const t = term(cols, 3);
    t.writeText(text);
    const f = newFrame(t.cols, t.rows);
    t.update(f);
    return { t, f };
  };
  const glyphs = (d: ReturnType<typeof drawRow>) =>
    d.glyphs.map((g) => ({ col: g.col, span: g.span, ...g.glyph, color: g.color, alpha: g.alpha }));

  it('gives cells their colors and glyphs: inverse, invisible, faint, wide, shapes', () => {
    const { t, f } = frameWith('\x1b[31ma\x1b[7mb\x1b[0m\x1b[8mc\x1b[0m\x1b[2md\x1b[0m中─\x1b[1;3me\x1b[0m\r\n');
    const d = drawRow(f.lines[0], 0, f, look, ov());
    const bg = 0x0a0a0a;
    const fg = 0xf0f0f0;
    // b keeps a's red and turns it around.
    expect([...d.bg.slice(0, 8)]).toEqual([bg, ansi[1], bg, bg, bg, bg, bg, bg]);
    expect(glyphs(d)).toEqual([
      { col: 0, span: 1, kind: 'text', text: 'a', bold: false, italic: false, color: ansi[1], alpha: 1 },
      // Inverse: the text in the background color.
      { col: 1, span: 1, kind: 'text', text: 'b', bold: false, italic: false, color: bg, alpha: 1 },
      // c is invisible; d is faint.
      { col: 3, span: 1, kind: 'text', text: 'd', bold: false, italic: false, color: fg, alpha: 0.5 },
      { col: 4, span: 2, kind: 'text', text: '中', bold: false, italic: false, color: fg, alpha: 1 },
      { col: 6, span: 1, kind: 'shape', text: '─', color: fg, alpha: 1 },
      { col: 7, span: 1, kind: 'text', text: 'e', bold: true, italic: true, color: fg, alpha: 1 },
    ]);
    t.dispose();
  });

  it('draws underlines in their color, strikethrough and overline', () => {
    const { t, f } = frameWith('\x1b[4:3;58;2;1;2;3mu\x1b[0m\x1b[9ms\x1b[0m\x1b[53mo\x1b[0m');
    const lines = glyphs(drawRow(f.lines[0], 0, f, look, ov())).filter((g) => g.kind === 'line');
    expect(lines).toEqual([
      { col: 0, span: 1, kind: 'line', style: 3, color: 0x010203, alpha: 1 },
      { col: 1, span: 1, kind: 'line', style: 'strike', color: 0xf0f0f0, alpha: 1 },
      { col: 2, span: 1, kind: 'line', style: 'overline', color: 0xf0f0f0, alpha: 1 },
    ]);
    t.dispose();
  });

  it('highlights the selection over the current match over other matches', () => {
    const { t, f } = frameWith('abcdefgh');
    const matches = [
      { y: 0, from: 0, to: 4, current: false },
      { y: 0, from: 2, to: 6, current: true },
    ];
    f.lines[0].sel = [5, 6];
    const d = drawRow(f.lines[0], 0, f, look, ov({ matches }));
    expect([...d.bg.slice(0, 8)]).toEqual([
      look.match,
      look.match,
      look.matchCurrent,
      look.matchCurrent,
      look.matchCurrent,
      look.selection,
      look.selection,
      0x0a0a0a,
    ]);
    t.dispose();
  });

  it('draws the cursor as the terminal and the focus want it', () => {
    const { t, f } = frameWith('ab');
    // A focused block: the cell in the cursor color, its text in the background color.
    let d = drawRow(f.lines[0], 0, f, look, ov());
    expect(d.bg[2]).toBe(0xf0f0f0);
    // Without the focus: a hollow box.
    d = drawRow(f.lines[0], 0, f, look, ov({ focused: false }));
    expect(d.bg[2]).toBe(0x0a0a0a);
    expect(glyphs(d).pop()).toMatchObject({ col: 2, kind: 'cursor', style: 'hollow' });
    // A bar, and nothing in the blink's off phase.
    t.writeText('\x1b[5 q');
    t.update(f);
    expect(glyphs(drawRow(f.lines[0], 0, f, look, ov())).pop()).toMatchObject({ kind: 'cursor', style: 'bar', width: 1 });
    // As thick as the settings ask.
    expect(glyphs(drawRow(f.lines[0], 0, f, { ...look, cursorWidth: 2.5 }, ov())).pop()).toMatchObject({ width: 2.5 });
    expect(glyphs(drawRow(f.lines[0], 0, f, look, ov({ blinkOn: false }))).some((g) => g.kind === 'cursor')).toBe(false);
    t.dispose();
  });

  it('underlines a hovered link and dots a formula', () => {
    const { t, f } = frameWith('see x and y');
    const d = drawRow(f.lines[0], 0, f, look, ov({ hover: [{ y: 0, from: 4, to: 5 }], math: [{ y: 0, from: 10, to: 11 }] }));
    expect(glyphs(d).filter((g) => g.kind === 'line')).toEqual([
      { col: 4, span: 1, kind: 'line', style: 1, color: 0xf0f0f0, alpha: 1 },
      { col: 10, span: 1, kind: 'line', style: 4, color: 0xf0f0f0, alpha: 1 },
    ]);
    t.dispose();
  });
});

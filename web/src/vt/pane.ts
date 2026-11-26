// One terminal of a machine's terminal core in the page: the hub's stream
// feeds libghostty-vt (terminal.ts), whose screen a renderer draws
// (renderer.ts), and the browser's keys, text, pastes, mouse and focus go
// back as the bytes the program asked for (input.ts). Output is
// acknowledged to the hub once it was drawn, so a busy program runs at the
// speed the page draws; the terminal's own answers (device attributes,
// colors, cursor position) go back as automatic input.
//
// Selections, find, links (OSC 8 and URLs or paths in the text), formulas
// under the pointer and programs' clipboard writes (clipboard.ts) are
// handled here too; components/TerminalView.tsx shows what goes over the
// canvas.

import type { AttachOptions, Display, StreamHandler } from '../term/connection';
import { displayColors, type Appearance } from '../appearance';
import { loadVt, type Vt } from './module';
import { Terminal, newFrame, type Frame, type Row } from './terminal';
import { createRenderer, replaceCanvas, lookOf, hexColor, type Cells, type Look, type Overlay, type Renderer } from './renderer';
import { measureCell, type Metrics } from './atlas';
import { keyInput, isMac, modsOf, mouseButton, textInput, wheelLines } from './input';
import { forgetProgramClipboard, programClipboard, programClipboardCopied, programCopied, userInput, userRelease } from './clipboard';
import { findResult, useFind } from './find';
import { findPlace, noteScroll, takeScroll } from './scrollMemory';
import { carriesFiles } from '../drop';
import { linksAround, linkTitle, safeUrl, selectedLink, type LinkContext, type RowText } from '../terminal/links';
import { openLink } from '../terminal/openLink';
import { mathAt } from '../terminal/math';
import { renderMath } from '../terminal/mathRender';
import { openMenu } from '../contextMenu';
import { surfaceMenu } from '../menus';
import { onPrelude, preludeOf, type Prelude } from '../state/preludes';

/** A formula in the terminal and the cells it covers. */
export interface ShownMath {
  cells: Cells[];
  tex: string;
  display: boolean;
  html: string;
}

/** How long the pointer rests on a formula before it is shown, how long it
 * stays after the pointer left it (so the pointer can reach the popover),
 * and how long while the pointer is on its way there but stopped. */
export const MATH_SHOW_MS = 300;
export const MATH_LEAVE_MS = 250;
export const MATH_APPROACH_MS = 800;

/** A program may hold the screen still (synchronized output) this long. */
const HOLD_MS = 1000;
// The first paint of an attach (the screen and its history) comes as output
// like any other, in as many frames as its size and the stream's credit
// make of it; drawn as it comes, it is the history running past before the
// screen stands. Nothing says where it ends, but it comes in bulk: so
// nothing is drawn until the bulk pauses, for PAINT_QUIET_MS after a paint
// that fits the stream's credit (it comes at once) and for
// PAINT_QUIET_LONG_MS after more than that (the next part waits for the
// credit returned). Frames under PAINT_BULK bytes are a program's own
// output (a spinner, a clock: an agent at work writes every few
// tens of milliseconds) and put the end off no further; PAINT_MAX_MS is the most a
// program that writes in bulk without a pause is waited for.
const PAINT_QUIET_MS = 40;
const PAINT_QUIET_LONG_MS = 250;
const PAINT_MAX_MS = 600;
const PAINT_BULK = 4096;
const PAINT_ONE_CREDIT = 192 * 1024;
// An attach that is refused (a kept terminal whose shell the core is
// starting again answers unavailable for a moment) is tried again.
const ATTACH_RETRY_MS = 1500;
const ATTACH_RETRIES = 5;
// A prelude (state/preludes.ts) that appears, changes or goes while the
// pane is attached is shown by attaching again: once, when its changes
// have paused this long.
const PRELUDE_SETTLE_MS = 50;
// Input sent while the pane attaches again to show a prelude waits for the
// new stream, up to this many bytes.
const SEND_QUEUE_MAX = 64 * 1024;

// What the pane writes after a prelude's bytes (replay). They are output a
// machine saved of a program, as untrusted as any program's: every state
// they may have set is brought back to the one of a new emulator
// (vt/terminal.ts makes each with libghostty-vt's defaults and grapheme
// clusters on), so that none of it reaches the live terminal, also when
// the core sends no first paint (it drops one above 4 MiB), which resets
// much of it.
const PRELUDE_RESET = [
  // A sequence the bytes cut short ends (CAN), and a hyperlink left open
  // is closed: every cell written after it would link to its target, and a
  // link is opened before the text's own.
  '\x18\x1b]8;;\x1b\\\x1b[0m',
  // The main screen, however the alternate one was entered (its content
  // is not kept), and there the same, a soft reset (margins, origin,
  // wrapping, insert, character sets, a visible cursor) and plain styles.
  '\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b]8;;\x1b\\\x1b[!p\x1b[0m',
  // The alternate screen has a cursor and keyboard flags of its own: the
  // same there, while it is empty (entering it clears it).
  '\x1b[?1049h\x1b]8;;\x1b\\\x1b[!p\x1b[0m\x1b[<99u\x1b[=0;1u\x1b[?1049l',
  // Keys as a new emulator encodes them: no kitty keyboard flags (every
  // pushed set popped), no modifyOtherKeys, normal cursor and keypad keys,
  // Backspace sending DEL, Alt as an ESC prefix, the keypad following Num
  // Lock.
  '\x1b[<99u\x1b[=0;1u\x1b[>4;0m\x1b[?1l\x1b[?66l\x1b[?67l\x1b[?1035h\x1b[?1036h\x1b[?1039l',
  // Nothing reported that the live program did not ask for: the mouse in
  // any encoding, focus, pastes bracketed, the color scheme, the size in
  // band; no synchronized output held; and the wheel as arrow keys on the
  // alternate screen, as new.
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?2004l' +
    '\x1b[?2031l\x1b[?2048l\x1b[?2026l\x1b[?1007h',
  // The display and the other modes: no reverse video, no slow scroll, no
  // autorepeat, no switching to 132 columns, grapheme clusters as wide as
  // Unicode has them, no local echo (SRM set), a line feed that only moves
  // down (LNM reset).
  '\x1b[?5l\x1b[?4l\x1b[?8l\x1b[?40l\x1b[?2027h\x1b[12h\x1b[20l',
  // The theme's palette, foreground, background and cursor colors, and
  // the cursor's style of the settings.
  '\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b[0 q',
].join('');

const utf8 = new TextEncoder();

/** Where a terminal's stream comes from: the hub's terminal protocol
 * (term/connection.ts), or a PTY of the hub host (components/AuthDialog.tsx). */
export interface TermLink {
  readonly connected: boolean;
  attach(o: AttachOptions, handler: StreamHandler): Promise<number>;
  write(stream: number, data: Uint8Array, automatic?: boolean): void;
  ack(stream: number, count: number): void;
  resize(stream: number, cols: number, rows: number): void;
  focus(stream: number, focused: boolean): void;
  /** Absent on links to no terminal core (the ssh login's PTY). */
  facts?(stream: number, display: Display): void;
  detach(stream: number): void;
}

/** What the pane shows over its canvas and asks of the page. */
export interface PaneOptions {
  m: string;
  address: string;
  connection: TermLink;
  /** Calls fn when the connection comes or goes. */
  onConnection(fn: (up: boolean) => void): () => void;
  /** Calls fn with the pid of the terminal's program now and whenever it
   * changes, undefined while the terminal is not live (setProgram). */
  onProgram?(fn: (pid: number | undefined) => void): () => void;
  readOnly(): boolean;
  /** Keys of the page's keybindings: true when one ran. */
  appKey(ev: KeyboardEvent): boolean;
  /** A press in the terminal: it becomes the focused one. */
  activate(): void;
  linkContext(): LinkContext;
  /** Whether formulas under the pointer are shown. */
  mathHover(): boolean;
  /** terminal.copyOnSelect. */
  copyOnSelect(): boolean;
  /** terminal.scrollback: lines kept above the screen. */
  scrollback(): number;
  /** Files pasted: the text to paste (their paths, after uploading). */
  onPasteFiles?(files: File[]): Promise<string | undefined>;
  /** Files dropped from outside the page: the text to paste. The items are
   * read before anything is awaited. */
  onDropFiles?(items: DataTransferItemList): Promise<string | undefined>;
  onDropTarget?(on: boolean): void;
  /** A tooltip for what is under the pointer (a link). */
  setTitle(title: string): void;
  onMath?(m: ShownMath | undefined): void;
  /** Opens find here, with a query when one line is selected. */
  onFind(text?: string): void;
  /** The stream ended for good: the program's end, with how. */
  onClosed(reason: string, exitCode?: number): void;
  /** The terminal has another program after its stream ended for good
   * (setProgram): what onClosed showed goes, and the pane attaches again. */
  onReopen?(): void;
  onBell(): void;
  /** The program's title changed. */
  onTitle?(title: string): void;
  /** The view moved in the scrollback: rows above and below, rows shown. */
  onScroll?(bar: { total: number; offset: number; len: number }): void;
  /** The cell size in CSS pixels changed. */
  onCell?(cw: number, ch: number): void;
  /** Renderer in use. */
  onRenderer?(kind: 'webgl' | 'canvas'): void;
  /** The terminal is attached: input reaches its program. */
  onAttached?(): void;
}

const overPopover = (target: EventTarget | null | undefined) => !!(target as Element | null)?.closest?.('.math-popover');

/** Whether (px, py) lies in the triangle a, b, c. */
function inTriangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]) {
  const side = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0]);
  const d1 = side(a, b);
  const d2 = side(b, c);
  const d3 = side(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** A row's text with the column of each UTF-16 index, as links.ts reads rows. */
export function rowCols(r: Row | undefined): RowText {
  const colOf: number[] = [];
  let text = '';
  if (!r) return { text, colOf: [0] };
  const cols = r.codes.length;
  for (let x = 0; x < cols; x++) {
    const w = r.wide[x];
    if (w === 2 || w === 3) continue;
    const s = r.text[x] ?? (r.codes[x] ? String.fromCodePoint(r.codes[x]) : ' ');
    for (let i = 0; i < s.length; i++) colOf.push(x);
    text += s;
  }
  colOf.push(cols);
  return { text, colOf };
}

interface PaneLink {
  cells: Cells[];
  link: { kind: 'url' | 'path'; text: string };
}

const cellsKey = (c: Cells[] | undefined) => (c ? c.map((x) => `${x.y}:${x.from}-${x.to}`).join(' ') : '');

/** What a terminal's pane holds now. */
export interface PaneUsage {
  hidden: boolean;
  attached: boolean;
  renderer?: 'webgl' | 'canvas';
}

const panes = new Set<TermPane>();

/** The page's terminal panes, shown and kept. */
export function paneUsage(): PaneUsage[] {
  return [...panes].map((p) => p.usage);
}

export class TermPane {
  private vt?: Vt;
  term?: Terminal;
  private renderer?: Renderer;
  private frame: Frame = newFrame(1, 1);
  private metrics?: Metrics;
  private look: Look = { selection: 0x3b4a6b, match: 0x5c4813, matchCurrent: 0x9a6a00, cursorWidth: 1 };
  private appearance: Appearance;
  private stream?: number;
  /** The display facts the core has for the stream (JSON), to send changes only. */
  private sentDisplay = '';
  private attaching = false;
  private attachFailures = 0;
  private attachTimer?: number;
  /** Output bytes written but not yet acknowledged. */
  private unacked = 0;
  private raf?: number;
  private disposed = false;
  private focused = false;
  private blinkOn = true;
  /** Where the cursor was last drawn (cursorMoved). */
  private cursorAt = '';
  private blinkTimer?: number;
  private held = false;
  private heldSince = 0;
  private holdTimer?: number;
  /** An attach's first paint is on its way: nothing is drawn. */
  private painting = false;
  /** The emulator's first paint is over and the view went back where it
   * was: from then on where its view is counts (noteScroll). */
  private viewed = false;
  /** When the first paint is taken to be over (performance.now()). */
  private paintEnd = 0;
  private paintBytes = 0;
  private paintTimer?: number;
  /** Kept while its tab is not shown: output is taken, nothing is drawn or measured. */
  private hidden = false;
  private composing = false;
  private readonly preedit: HTMLDivElement;
  private readonly ro: ResizeObserver;
  private dprQuery?: MediaQueryList;
  private dpr = 1;
  private grid = { cols: 0, rows: 0 };
  private overlay: Overlay = { focused: false, blinkOn: true, matches: [] };
  private wheelAccum = 0;
  private drag?: { kind: 'mouse'; button: number } | { kind: 'select'; x: number; y: number };
  private autoTimer?: number;
  private hover?: PaneLink;
  private math?: ShownMath;
  private mathWant?: { cells: Cells[]; tex: string; display: boolean };
  private mathTimer?: number;
  private mathFrom?: { x: number; y: number };
  private lastPointer?: { x: number; y: number; popover?: boolean };
  private offConnection: () => void;
  private offFind: () => void;
  private readonly offPrelude: () => void;
  private readonly offProgram: () => void;
  /** The prelude the emulator was given (state/preludes.ts): another one
   * is shown by attaching again. */
  private preludeShown?: Prelude;
  private preludeTimer?: number;
  /** A prelude is being written into the emulator: what it answers,
   * reports or rings is not the program's. */
  private replaying = false;
  /** Input sent while the pane attaches again for a prelude, and its size:
   * sent on the new stream once it is there (send). */
  private queue?: Uint8Array[];
  private queued = 0;
  private findQuery = '';
  /** The stream ended for good (the program's end): nothing attaches until
   * the terminal has another program (setProgram). */
  private closedFor = false;
  /** The pid of the terminal's program while its record says it is live
   * (setProgram); the program the stream was attached to; the one whose
   * stream ended for good. */
  private program?: number;
  private streamProgram?: number;
  private endedProgram?: number;
  private lastBar = '';
  private readonly measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Rendering with Canvas 2D was asked for (no WebGL2, or the context was lost). */
  private preferCanvas = false;
  /** Ends the pane's event listeners. */
  private readonly listeners = new AbortController();

  constructor(
    private readonly host: HTMLElement,
    private canvas: HTMLCanvasElement,
    private readonly textarea: HTMLTextAreaElement,
    private readonly o: PaneOptions,
    appearance: Appearance,
  ) {
    this.appearance = appearance;
    this.preedit = document.createElement('div');
    this.preedit.className = 'term-compose';
    host.appendChild(this.preedit);
    const mc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    this.measureCtx = mc.getContext('2d') as CanvasRenderingContext2D;
    this.preferCanvas = /(?:^|[?&])renderer=canvas(?:&|$)/.test(location.search);
    this.ro = new ResizeObserver(() => this.measureSize());
    this.ro.observe(host);
    this.offConnection = o.onConnection((up) => {
      if (!up) return;
      // The connection or the machine's terminals are back: a new round
      // of attempts.
      this.attachFailures = 0;
      this.attach();
    });
    this.offFind = useFind.subscribe((st, prev) => this.findChanged(st, prev));
    this.offPrelude = onPrelude(o.m, o.address, () => this.preludeChanged());
    this.offProgram = o.onProgram?.((pid) => this.setProgram(pid)) ?? (() => {});
    panes.add(this);
    this.install();
    void loadVt().then((vt) => {
      if (this.disposed) return;
      this.vt = vt;
      this.setAppearance(this.appearance);
    });
  }

  // ---- appearance and size ----

  setAppearance(a: Appearance) {
    this.appearance = a;
    this.look = lookOf(a.colors.selection, a.colors.background, a.cursorWidth);
    if (!this.vt) return;
    // Not shown: the emulator takes the colors; cells are measured and a
    // renderer made when it is shown again.
    if (this.hidden) {
      if (this.term) this.configure(this.term);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr || !this.dprQuery) {
      this.dpr = dpr;
      this.watchDpr();
    }
    this.metrics = measureCell(this.measureCtx, a, dpr);
    if (!this.renderer) {
      this.renderer = createRenderer(this.canvas, this.preferCanvas ? 'canvas' : 'webgl');
      this.o.onRenderer?.(this.renderer.kind);
    }
    this.renderer.setMetrics(this.metrics);
    this.o.onCell?.(this.metrics.cw / dpr, this.metrics.ch / dpr);
    if (this.term) this.configure(this.term);
    this.measureSize();
    this.renderer.invalidate();
    this.schedule();
  }

  /** The terminal's colors, scrollback and cursor from the settings. */
  private configure(term: Terminal) {
    const a = this.appearance;
    const c = a.colors;
    term.setColors({
      fg: hexColor(c.foreground),
      bg: hexColor(c.background),
      cursor: hexColor(c.cursor),
      palette: c.palette.map(hexColor),
    });
    term.setBoldIsBright(a.boldIsBright);
    term.setCursorDefaults(a.cursorStyle, a.cursorBlink);
    term.setScrollback(this.o.scrollback());
    // The core answers programs' color and size queries itself, from what
    // the viewer told it last.
    if (this.stream !== undefined && !this.o.readOnly()) {
      const d = this.display();
      const key = JSON.stringify(d);
      if (key !== this.sentDisplay) {
        this.sentDisplay = key;
        this.o.connection.facts?.(this.stream, d);
      }
    }
  }

  /** The display an attach sends, recorded as the one the core has. */
  private sentDisplayOf(): Display {
    const d = this.display();
    this.sentDisplay = JSON.stringify(d);
    return d;
  }

  /** What the core answers this terminal's programs with: the theme's
   * colors and the cell size in pixels. */
  private display(): Display {
    const d = displayColors(this.appearance.colors);
    if (this.metrics) d.cell = [Math.max(1, Math.round(this.metrics.cw)), Math.max(1, Math.round(this.metrics.ch))];
    return d;
  }

  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = undefined;
    if (this.disposed || typeof window.matchMedia !== 'function') return;
    this.dprQuery = window.matchMedia(`(resolution: ${this.dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private onDprChange = () => {
    if ((window.devicePixelRatio || 1) !== this.dpr) this.setAppearance(this.appearance);
  };

  /** The grid that fits the pane; a new one resizes the terminal and the program's. */
  private measureSize() {
    const m = this.metrics;
    if (this.disposed || this.hidden || !m || !this.renderer) return;
    // A zoom changes the pixel ratio and the pane's size at once; the size
    // may be seen first. The cells are measured again for the new ratio
    // (setAppearance measures the size after them), so text stays sharp.
    if ((window.devicePixelRatio || 1) !== this.dpr) return this.setAppearance(this.appearance);
    const w = Math.round(this.host.clientWidth * this.dpr);
    const h = Math.round(this.host.clientHeight * this.dpr);
    if (w <= 0 || h <= 0) return;
    this.renderer.resize(w, h);
    this.canvas.style.width = `${w / this.dpr}px`;
    this.canvas.style.height = `${h / this.dpr}px`;
    const cols = Math.max(2, Math.floor(w / m.cw));
    const rows = Math.max(1, Math.floor(h / m.ch));
    const changed = cols !== this.grid.cols || rows !== this.grid.rows;
    this.grid = { cols, rows };
    if (!this.o.readOnly()) this.term?.resize(cols, rows, m.cw, m.ch);
    if (changed && this.stream !== undefined && !this.o.readOnly()) this.o.connection.resize(this.stream, cols, rows);
    if (!this.term) this.attach();
    this.schedule();
  }

  // ---- the stream ----

  /** Attaches to the terminal once its grid is known and the connection is up. */
  attach() {
    if (this.disposed || this.stream !== undefined || this.attaching || !this.vt || !this.grid.cols || this.closedFor) return;
    if (!this.o.connection.connected) return;
    this.attaching = true;
    // A new emulator per attach: the first paint brings the screen and its
    // history, and the view goes back where it was (scrollMemory.ts).
    this.noteScroll();
    this.viewed = false;
    this.held = false;
    this.cancelHoldTimer();
    this.term?.dispose();
    // What a prelude written into it would answer, report or ring is dropped.
    const term = new Terminal(this.vt, this.grid.cols, this.grid.rows, {
      reply: (data) =>
        !this.replaying && this.stream !== undefined && !this.o.readOnly() && this.o.connection.write(this.stream, data, true),
      // Not for a bell of the history painted, nor of a terminal not shown.
      bell: () => !this.painting && !this.hidden && this.o.onBell(),
      title: (s) => !this.replaying && this.o.onTitle?.(s),
      clipboard: (text) => !this.replaying && !this.o.readOnly() && programCopied(this.o.m, text),
      dark: () => this.appearance.theme === 'dark',
      hold: (held) => {
        if (this.replaying || this.held === held) return;
        this.held = held;
        this.heldSince = performance.now();
        if (!held) {
          this.cancelHoldTimer();
          this.schedule();
        }
      },
    });
    if (this.metrics) term.resize(this.grid.cols, this.grid.rows, this.metrics.cw, this.metrics.ch);
    this.configure(term);
    this.term = term;
    this.frame = newFrame(this.grid.cols, this.grid.rows);
    this.cursorAt = '';
    this.startBlink();
    this.renderer?.invalidate();
    this.painting = true;
    this.preludeShown = preludeOf(this.o.m, this.o.address);
    if (this.preludeShown) this.replay(term, this.preludeShown);
    const paintLimit = performance.now() + PAINT_MAX_MS;
    this.paintBytes = 0;
    this.awaitPaint(paintLimit);
    const observe = this.o.readOnly();
    this.o.connection
      .attach(
        {
          machine: this.o.m,
          terminal: this.o.address,
          cols: this.grid.cols,
          rows: this.grid.rows,
          history: this.o.scrollback(),
          observe,
          display: this.sentDisplayOf(),
        },
        {
          output: (data) => {
            if (this.term !== term) return;
            term.write(data);
            this.unacked += data.length;
            if (!this.painting) return this.schedule();
            // Credit is returned at once: the rest of the paint waits for it.
            this.ack();
            this.paintBytes += data.length;
            const now = performance.now();
            // Bulk puts the end off; a program's own small output only brings it nearer.
            const quiet = now + (this.paintBytes > PAINT_ONE_CREDIT ? PAINT_QUIET_LONG_MS : PAINT_QUIET_MS);
            this.awaitPaint(data.length >= PAINT_BULK ? Math.min(paintLimit, quiet) : Math.min(this.paintEnd, now + PAINT_QUIET_MS));
          },
          resized: (cols, rows) => {
            if (this.term !== term) return;
            term.resize(cols, rows);
            this.schedule();
          },
          closed: (reason, exitCode) => {
            if (this.term !== term) return;
            this.stream = undefined;
            this.unacked = 0;
            this.dropQueue();
            const program = this.streamProgram ?? this.program;
            this.streamProgram = undefined;
            if (reason === 'disconnected') return; // attached again when the connection is back
            this.closedFor = true;
            this.endedProgram = program;
            this.o.onClosed(reason, exitCode);
            // Another program may be known already.
            this.reopen();
          },
        },
      )
      .then(
        (s) => {
          this.attaching = false;
          if (this.disposed || this.term !== term) return this.o.connection.detach(s);
          this.attachFailures = 0;
          this.stream = s;
          this.streamProgram = this.program;
          if (!observe && (this.grid.cols !== term.cols || this.grid.rows !== term.rows))
            this.o.connection.resize(s, this.grid.cols, this.grid.rows);
          if (this.focused) this.o.connection.focus(s, true);
          // The theme or font may have changed while attaching.
          if (!observe && JSON.stringify(this.display()) !== this.sentDisplay) this.configure(term);
          // What was typed while it attached again for a prelude.
          const queue = this.queue ?? [];
          this.dropQueue();
          for (const bytes of queue) this.o.connection.write(s, bytes);
          this.o.onAttached?.();
          // A prelude that changed while attaching is shown by attaching again.
          if (preludeOf(this.o.m, this.o.address) !== this.preludeShown) this.preludeChanged();
        },
        () => {
          this.attaching = false;
          // What was typed for it goes: the stream may come much later, or never.
          this.dropQueue();
          // No first paint comes: the remembered view waits for the next
          // emulator, which an empty one must not take.
          if (this.term === term) {
            window.clearTimeout(this.paintTimer);
            this.painting = false;
          }
          if (this.disposed || ++this.attachFailures > ATTACH_RETRIES) return;
          window.clearTimeout(this.attachTimer);
          this.attachTimer = window.setTimeout(() => this.attach(), ATTACH_RETRY_MS);
        },
      );
  }

  /** Ends the first paint at a time (performance.now()), unless more of it comes first. */
  private awaitPaint(at: number) {
    this.paintEnd = at;
    window.clearTimeout(this.paintTimer);
    this.paintTimer = window.setTimeout(
      () => {
        if (this.disposed || !this.painting) return;
        this.painting = false;
        this.viewed = true;
        this.restoreScroll();
        // A program that asked to be told has the focus again: it was told
        // of its loss when the pane before this one lost it, and the paint
        // brought the mode this emulator answers by.
        if (this.focused && this.term) this.send(this.term.encodeFocus(true), false);
        this.renderer?.invalidate();
        this.schedule();
      },
      Math.max(0, at - performance.now()),
    );
  }

  /** Writes a prelude (state/preludes.ts) into a new emulator before the
   * first byte of its stream, at the grid the output was painted at when
   * the prelude says (its paint pushed its history up by as many rows as
   * that grid has: on a taller screen the rows below them would stay on it,
   * for the first paint to clear): its output; then PRELUDE_RESET (the main
   * screen, an alternate screen's content not kept, and every state the
   * output set as a new emulator has it); its note, dim, on the line below
   * the last row of the screen with something on it (also when the output's
   * cursor was above it, as an agent's input box has it); and as many
   * newlines as the screen has rows, which move every row up to that one
   * into the scrollback. The cursor is left at the top of the blank
   * screen, so that going back to the pane's grid neither pulls rows of
   * the scrollback onto a taller screen nor pushes blank rows into it from
   * a shorter one (libghostty-vt keeps the rows around the cursor), nor
   * does a resize the core sends an observer before its first paint. The
   * first paint clears only the screen, so the prelude stays above the
   * terminal's own history. */
  private replay(term: Terminal, p: Prelude) {
    this.replaying = true;
    const live = { cols: term.cols, rows: term.rows };
    try {
      if (p.cols && p.rows) term.resize(p.cols, p.rows);
      term.write(p.bytes);
      term.write(utf8.encode(PRELUDE_RESET));
      const rows = term.rows;
      let last = this.lastContentRow(term);
      let tail = '';
      if (p.note) {
        tail = last + 1 < rows ? `\x1b[${last + 2};1H\x1b[2K` : `\x1b[${rows};1H\r\n`;
        tail += `\x1b[2m${p.note}\x1b[0m`;
        last = Math.min(last + 1, rows - 1);
      } else if (last >= 0) tail = `\x1b[${last + 1};1H`;
      // From row `last`, rows - 1 - last newlines reach the bottom and the
      // others scroll rows 0 to last away.
      if (last >= 0) tail += '\n'.repeat(rows);
      term.write(utf8.encode(`${tail}\x1b[H`));
      term.resize(live.cols, live.rows);
    } finally {
      this.replaying = false;
    }
  }

  /** The last row of the screen with something on it (a character, or a
   * background color), -1 for none. Read into the pane's frame, which is
   * the emulator's new one: later updates go on from it. */
  private lastContentRow(term: Terminal): number {
    term.update(this.frame);
    for (let y = this.frame.rows - 1; y >= 0; y--) {
      const r = this.frame.lines[y];
      for (let x = 0; x < r.codes.length; x++) if ((r.codes[x] !== 0 && r.codes[x] !== 32) || r.bg[x] !== -1) return y;
    }
    return -1;
  }

  /** The terminal's prelude appeared, changed or went: once its changes
   * paused, an attached pane attaches again to show what it is now (the
   * core keeps the program's stream meanwhile, so the program sees
   * nothing, and what is typed meanwhile waits for the new stream); one
   * attaching checks again once attached, and one not attached shows it
   * when it attaches. */
  private preludeChanged() {
    if (this.disposed) return;
    window.clearTimeout(this.preludeTimer);
    this.preludeTimer = window.setTimeout(() => {
      if (this.disposed || this.closedFor || this.attaching || this.stream === undefined) return;
      if (preludeOf(this.o.m, this.o.address) === this.preludeShown) return;
      this.o.connection.detach(this.stream);
      this.stream = undefined;
      this.unacked = 0;
      this.queue = [];
      this.queued = 0;
      this.attach();
      if (!this.attaching) this.dropQueue();
    }, PRELUDE_SETTLE_MS);
  }

  private dropQueue() {
    this.queue = undefined;
    this.queued = 0;
  }

  /** The pid of the terminal's program, as its record says (onProgram):
   * undefined unless the terminal is live. A pane whose stream ended for
   * good attaches again once the terminal has another program than the
   * stream had (the terminal core started a new shell at its address after
   * it started again); one whose terminal finished, or still runs the
   * program that ended, stays as it is. */
  setProgram(pid: number | undefined) {
    this.program = pid;
    // Attached before the record was known: the stream is the program's.
    if (pid !== undefined && this.stream !== undefined && this.streamProgram === undefined) this.streamProgram = pid;
    this.reopen();
  }

  private reopen() {
    const pid = this.program;
    if (this.disposed || !this.closedFor || pid === undefined || pid === this.endedProgram) return;
    this.closedFor = false;
    this.endedProgram = undefined;
    this.attachFailures = 0;
    this.o.onReopen?.();
    this.attach();
  }

  /** The rows a frame shows, as text. */
  private frameText(): string[] {
    return this.frame.lines.map((r) => rowCols(r).text.trimEnd());
  }

  /** Notes where the view is before its emulator goes (scrollMemory.ts). */
  private noteScroll() {
    const term = this.term;
    // An emulator before its first paint shows nothing of where the view was.
    if (!term || !this.viewed) return;
    if (term.altScreen || term.atBottom) return noteScroll(this.o.m, this.o.address, undefined);
    // A pane not shown has not read its rows since.
    term.update(this.frame);
    noteScroll(this.o.m, this.o.address, { ...term.scrollbar(), rows: this.frameText() });
  }

  /** Scrolls a new emulator, its first paint in, where the view was left. */
  private restoreScroll() {
    const was = takeScroll(this.o.m, this.o.address);
    const term = this.term;
    if (!was || !term || term.altScreen) return;
    const show = (offset: number) => term.scroll(offset - term.scrollbar().offset);
    const offset = findPlace(was, {
      bar: () => term.scrollbar(),
      rowsAt: (at) => {
        show(at);
        term.update(this.frame);
        return this.frameText();
      },
    });
    show(offset);
  }

  /** Whether input reaches the terminal's program now. */
  get attached(): boolean {
    return this.stream !== undefined;
  }

  /** Shows the pane again, or keeps it while its tab is not shown: a kept
   * pane stays attached and its emulator takes the output, so it is shown
   * as it was left, but it draws nothing, keeps the size it had and gives
   * up what it draws with (a WebGL context, of which a page has few, and
   * its glyphs' texture), made again when it is shown. A kept pane that
   * was never attached does not attach while kept. */
  setShown(shown: boolean) {
    if (this.hidden === !shown || this.disposed) return;
    this.hidden = !shown;
    this.startBlink();
    if (shown) return this.setAppearance(this.appearance);
    this.cancelHoldTimer();
    this.hideMath();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
      // A canvas keeps the context it gave up: the next renderer gets a new one.
      this.canvas = replaceCanvas(this.canvas);
      // No pixels are held for it meanwhile; shown again, it is sized anew.
      this.canvas.width = this.canvas.height = 0;
    }
  }

  /** What the pane holds, for the settings' Performance page. */
  get usage(): PaneUsage {
    return { hidden: this.hidden, attached: this.stream !== undefined, renderer: this.renderer?.kind };
  }

  // ---- drawing ----

  private schedule() {
    if (this.raf !== undefined || this.disposed) return;
    if (!this.hidden && !this.painting && this.renderer && this.waitForHold()) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = undefined;
      this.draw();
    });
  }

  private cancelHoldTimer() {
    window.clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  /** A held screen needs one deadline. Output still returns credit. */
  private waitForHold(): boolean {
    if (!this.held) return false;
    const left = HOLD_MS - (performance.now() - this.heldSince);
    if (left <= 0) return false;
    this.ack();
    this.holdTimer ??= window.setTimeout(() => {
      this.holdTimer = undefined;
      this.schedule();
    }, Math.ceil(left));
    return true;
  }

  private draw() {
    const term = this.term;
    if (!term) return;
    // Nothing is drawn, the output is taken: its credit goes back, so a
    // hidden terminal (which has no renderer) keeps up with its program.
    if (this.painting || this.hidden) return this.ack();
    const r = this.renderer;
    if (!r) return;
    if (this.waitForHold()) return;
    const changed = term.update(this.frame);
    this.cursorMoved();
    if (changed && useFind.getState().terminal === this.o.address && useFind.getState().m === this.o.m && this.findQuery) {
      term.findRefresh();
      this.matchesChanged();
    }
    this.overlay = { ...this.overlay, focused: this.focused, blinkOn: this.blinkOn };
    r.render(this.frame, this.look, this.overlay);
    if ('contextLost' in r && (r as { contextLost: boolean }).contextLost) {
      // The GPU took the context away (a reset, or the browser's limit of
      // contexts): draw with Canvas 2D from now on, on a canvas of its own,
      // rather than take another context from a terminal that has one.
      r.dispose();
      this.preferCanvas = true;
      this.renderer = undefined;
      this.canvas = replaceCanvas(this.canvas);
      this.setAppearance(this.appearance);
    }
    this.ack();
    this.placeTextarea();
    this.reportScroll();
  }

  /** Returns the credit of the output drawn. */
  private ack() {
    if (this.stream !== undefined && this.unacked > 0) this.o.connection.ack(this.stream, this.unacked);
    this.unacked = 0;
  }

  private reportScroll() {
    const bar = this.term?.scrollbar();
    if (!bar) return;
    const key = `${bar.total} ${bar.offset} ${bar.len}`;
    if (key === this.lastBar) return;
    this.lastBar = key;
    this.o.onScroll?.(bar);
  }

  /** Draws every row again (overlays changed). */
  private redraw() {
    this.renderer?.invalidate();
    this.schedule();
  }

  /** Keeps the hidden textarea at the cursor, where input methods show their candidates. */
  private placeTextarea() {
    const m = this.metrics;
    if (!m) return;
    const c = this.frame.cursor;
    this.textarea.style.left = `${(c.x * m.cw) / this.dpr}px`;
    this.textarea.style.top = `${(c.y * m.ch) / this.dpr}px`;
    this.textarea.style.height = `${m.ch / this.dpr}px`;
  }

  /** A blinking cursor stays lit while it moves, as in other terminals:
   * each move starts the blink's period again, so the cursor held by an
   * arrow key, or followed while typing, never goes dark. */
  private cursorMoved() {
    const c = this.frame.cursor;
    const at = `${c.x} ${c.y} ${c.visible} ${c.blinking}`;
    if (at === this.cursorAt) return;
    this.cursorAt = at;
    this.startBlink();
    this.frame.dirty.add(c.y);
  }

  private startBlink() {
    window.clearInterval(this.blinkTimer);
    this.blinkTimer = undefined;
    this.blinkOn = true;
    const c = this.frame.cursor;
    if (!this.focused || this.hidden || !c.visible || !c.blinking) return;
    this.blinkTimer = window.setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.frame.dirty.add(this.frame.cursor.y);
      this.schedule();
    }, 600);
  }

  // ---- input ----

  focus() {
    this.textarea.focus({ preventScroll: true });
  }

  /** Sends bytes to the program (not in read-only mode). While the pane
   * attaches again for a prelude they wait for the new stream, up to
   * SEND_QUEUE_MAX bytes (what does not fit is dropped, as is everything
   * when that attach fails or the pane goes); otherwise without a stream
   * they are dropped. */
  send(bytes: Uint8Array, user = true) {
    if (!bytes.length || (this.stream === undefined && !this.queue) || this.o.readOnly()) return;
    if (user) {
      userInput();
      if (this.term && !this.term.atBottom) {
        this.term.scroll('bottom');
        this.schedule();
      }
    }
    if (this.stream !== undefined) return this.o.connection.write(this.stream, bytes);
    if (!this.queue || this.queued + bytes.length > SEND_QUEUE_MAX) return;
    this.queue.push(bytes.slice());
    this.queued += bytes.length;
  }

  /** Pastes text as the program asked for pastes (bracketed or not). */
  paste(text: string) {
    if (this.term && text) this.send(this.term.encodePaste(text));
  }

  /** Types text as an input method commits it. */
  type(text: string) {
    if (text) this.send(textInput(text));
  }

  private install() {
    // Every listener goes with the pane, not only the window's: the host
    // and the textarea may outlive it.
    const signal = this.listeners.signal;
    const ta = this.textarea;
    ta.addEventListener('keydown', this.onKeyDown, { signal });
    ta.addEventListener('keyup', this.onKeyUp, { signal });
    ta.addEventListener('compositionstart', this.onComposition, { signal });
    ta.addEventListener('compositionupdate', this.onComposition, { signal });
    ta.addEventListener('compositionend', this.onCompositionEnd, { signal });
    ta.addEventListener('input', this.onInput, { signal });
    ta.addEventListener('paste', this.onPaste, { signal });
    ta.addEventListener('copy', this.onCopy, { signal });
    ta.addEventListener('focus', this.onFocusChange, { signal });
    ta.addEventListener('blur', this.onFocusChange, { signal });
    this.host.addEventListener('mousedown', this.onMouseDown, { signal });
    this.host.addEventListener('wheel', this.onWheel, { passive: false, signal });
    this.host.addEventListener('contextmenu', this.onContextMenu, { signal });
    this.host.addEventListener('dragover', this.onDragOver, { signal });
    this.host.addEventListener('dragleave', this.onDragLeave, { signal });
    this.host.addEventListener('drop', this.onDrop, { signal });
    this.host.addEventListener('mouseleave', this.onMouseLeave, { signal });
    this.host.addEventListener('mousemove', this.onHostMove, { signal });
    window.addEventListener('mousemove', this.onMouseMove, { signal });
    window.addEventListener('mouseup', this.onMouseUp, { signal });
    window.addEventListener('keydown', this.onModifier, { signal });
    window.addEventListener('keyup', this.onModifier, { signal });
  }

  private onKeyDown = (ev: KeyboardEvent) => {
    this.hideMath();
    if (this.o.appKey(ev)) {
      ev.preventDefault();
      return;
    }
    const term = this.term;
    const k = keyInput(ev, { optionIsMeta: this.appearance.optionIsMeta });
    if (!k || !term) return;
    const bytes = term.encodeKey(k);
    if (!bytes.length) return;
    // Consumed here: no keypress or input event follows.
    ev.preventDefault();
    forgetProgramClipboard();
    // Typing ends a selection, as in Ghostty.
    if (term.hasSelection) {
      term.clearSelection();
      this.frameAll();
    }
    this.send(bytes);
  };

  private onKeyUp = (ev: KeyboardEvent) => {
    const term = this.term;
    const k = keyInput(ev, { optionIsMeta: this.appearance.optionIsMeta });
    if (!k || !term) return;
    // Only programs that asked for releases (kitty's flags) get bytes.
    this.send(term.encodeKey({ ...k, action: 'release' }), false);
  };

  private onComposition = (ev: CompositionEvent) => {
    this.composing = true;
    this.showPreedit(ev.data ?? '');
  };

  /** Shows the composed text over the cells at the cursor, in the terminal's
   * font and colors; the program gets only the committed text. */
  private showPreedit(text: string) {
    const el = this.preedit;
    const m = this.metrics;
    if (!text || !m) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const c = this.frame.cursor;
    const a = this.appearance;
    el.textContent = text;
    Object.assign(el.style, {
      display: 'block',
      top: `${(c.y * m.ch) / this.dpr}px`,
      height: `${m.ch / this.dpr}px`,
      font: `${m.weight} ${m.fontPx / this.dpr}px ${m.family}`,
      lineHeight: `${m.ch / this.dpr}px`,
      color: a.colors.foreground,
      background: a.colors.background,
    });
    const left = (c.x * m.cw) / this.dpr;
    el.style.left = `${Math.max(0, Math.min(left, this.host.clientWidth - el.offsetWidth))}px`;
  }

  private onCompositionEnd = (ev: CompositionEvent) => {
    this.composing = false;
    this.showPreedit('');
    if (ev.data) this.type(ev.data);
    this.textarea.value = '';
  };

  /** Text the keydown handler did not send (dead keys, mobile keyboards). */
  private onInput = (ev: Event) => {
    const ie = ev as unknown as { data?: string | null; inputType?: string; isComposing?: boolean };
    if (this.composing || ie.isComposing) return;
    if (ie.inputType === 'insertText' && ie.data) this.type(ie.data);
    this.textarea.value = '';
  };

  private onPaste = (ev: ClipboardEvent) => {
    ev.preventDefault();
    const dt = ev.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files);
    if (files.length && this.o.onPasteFiles) {
      void this.o.onPasteFiles(files).then((text) => text && this.paste(text));
      return;
    }
    const text = dt.getData('text/plain');
    if (text) this.paste(text);
  };

  private onCopy = (ev: ClipboardEvent) => {
    const text = this.term?.selectionText();
    if (text) {
      ev.preventDefault();
      ev.clipboardData?.setData('text/plain', text);
      return;
    }
    // Without a selection of the page, the program's own copy.
    const program = programClipboard(this.o.m);
    if (program) {
      ev.preventDefault();
      ev.clipboardData?.setData('text/plain', program);
      programClipboardCopied(program);
    }
  };

  /** Copies the selection (the menu's Copy). */
  copySelection() {
    const text = this.term?.selectionText();
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  }

  selectionText(): string | undefined {
    return this.term?.selectionText();
  }

  /** The rows on screen as text, trailing blanks trimmed. */
  screenText(): string {
    return this.frame.lines.map((r) => rowCols(r).text.trimEnd()).join('\n');
  }

  private pasteClipboard() {
    void navigator.clipboard
      ?.readText()
      .then((text) => this.paste(text))
      .catch(() => {});
  }

  private onFocusChange = () => {
    const f = document.activeElement === this.textarea;
    if (f === this.focused) return;
    this.focused = f;
    if (!f) this.showPreedit('');
    if (this.stream !== undefined) this.o.connection.focus(this.stream, f);
    if (this.term) this.send(this.term.encodeFocus(f), false);
    this.startBlink();
    this.frame.dirty.add(this.frame.cursor.y);
    this.schedule();
  };

  // ---- pointer ----

  /** The cell under a client position and the position in device pixels. */
  private cellAt(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    const m = this.metrics ?? { cw: 8, ch: 16 };
    const px = (clientX - r.left) * this.dpr;
    const py = (clientY - r.top) * this.dpr;
    return { col: Math.floor(px / m.cw), row: Math.floor(py / m.ch), px, py };
  }

  private clampCell(c: { col: number; row: number }) {
    const t = this.term;
    return { col: Math.max(0, Math.min(c.col, (t?.cols ?? 1) - 1)), row: Math.max(0, Math.min(c.row, (t?.rows ?? 1) - 1)) };
  }

  /** The program gets the mouse (it asked, Shift not held, not read-only). */
  private mouseToProgram(ev: MouseEvent): boolean {
    return !!this.term?.mouseTracking && !ev.shiftKey && !this.o.readOnly();
  }

  private onMouseDown = (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest?.('button, input, .math-popover, .find-bar, .term-scrollbar')) return;
    this.hideMath();
    const term = this.term;
    if (!term) return;
    ev.preventDefault();
    this.focus();
    this.o.activate();
    const c = this.cellAt(ev.clientX, ev.clientY);
    // Cmd/Ctrl+click opens links.
    if (this.hover && (ev.metaKey || ev.ctrlKey) && ev.button === 0) {
      openLink(this.hover.link, this.o.linkContext());
      return;
    }
    // The right button (and Ctrl+click on macOS) opens the menu (onContextMenu).
    if (ev.button === 2 || (isMac && ev.ctrlKey && ev.button === 0)) return;
    forgetProgramClipboard();
    if (this.mouseToProgram(ev)) {
      term.clearSelection();
      const button = mouseButton(ev.button);
      this.drag = { kind: 'mouse', button };
      userInput();
      this.send(term.encodeMouse({ action: 'press', button, mods: modsOf(ev), x: c.px, y: c.py }), false);
      return;
    }
    if (ev.button !== 0) return;
    const cell = this.clampCell(c);
    term.selectPress(cell.col, cell.row, c.px, c.py, ev.timeStamp || performance.now());
    this.drag = { kind: 'select', x: ev.clientX, y: ev.clientY };
    this.frameAll();
  };

  /** The selection changed: rows' highlights are read again. */
  private frameAll() {
    for (let y = 0; y < this.frame.rows; y++) this.frame.dirty.add(y);
    this.schedule();
  }

  private onMouseMove = (ev: MouseEvent) => {
    const d = this.drag;
    const term = this.term;
    if (!d || !term) return;
    const c = this.cellAt(ev.clientX, ev.clientY);
    if (d.kind === 'mouse') {
      this.send(term.encodeMouse({ action: 'motion', button: d.button, mods: modsOf(ev), x: c.px, y: c.py, held: true }), false);
      return;
    }
    if (!(ev.buttons & 1)) return this.onMouseUp(ev);
    d.x = ev.clientX;
    d.y = ev.clientY;
    const cell = this.clampCell(c);
    term.selectDrag(cell.col, cell.row, c.px, c.py);
    this.frameAll();
    this.autoscroll();
  };

  /** Scrolls while a selection drag is held past the top or bottom edge. */
  private autoscroll() {
    const term = this.term;
    if (!term || this.drag?.kind !== 'select' || !term.autoscroll) {
      window.clearTimeout(this.autoTimer);
      this.autoTimer = undefined;
      return;
    }
    if (this.autoTimer !== undefined) return;
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = undefined;
      const d = this.drag;
      if (d?.kind !== 'select' || !this.term) return;
      const c = this.cellAt(d.x, d.y);
      const cell = this.clampCell(c);
      this.term.selectAutoscroll(cell.col, cell.row, c.px, c.py);
      this.frameAll();
      this.autoscroll();
    }, 50);
  }

  private onMouseUp = (ev: MouseEvent) => {
    const d = this.drag;
    const term = this.term;
    if (!d || !term) return;
    this.drag = undefined;
    window.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    const c = this.cellAt(ev.clientX, ev.clientY);
    if (d.kind === 'mouse') {
      // The program may answer the release with a copy of what was dragged
      // over: the automatic gate counts from here, not from the press.
      userRelease();
      this.send(term.encodeMouse({ action: 'release', button: d.button, mods: modsOf(ev), x: c.px, y: c.py }), false);
      return;
    }
    const cell = this.clampCell(c);
    term.selectRelease(cell.col, cell.row);
    if (this.o.copyOnSelect()) this.copySelection();
  };

  /** Moves over the terminal without a button: programs tracking every
   * motion get it; links and formulas follow the pointer. */
  private onHostMove = (ev: MouseEvent) => {
    if (this.drag) return;
    this.updateHover(ev);
    this.updateMath(ev);
    const term = this.term;
    if (term && this.mouseToProgram(ev) && term.mode(1003)) {
      const c = this.cellAt(ev.clientX, ev.clientY);
      this.send(term.encodeMouse({ action: 'motion', button: 0, mods: modsOf(ev), x: c.px, y: c.py }), false);
    }
  };

  private onWheel = (ev: WheelEvent) => {
    const term = this.term;
    const m = this.metrics;
    if (!term || !m) return;
    ev.preventDefault();
    this.hideMath();
    const step = wheelLines(ev, m.ch / this.dpr, term.rows, this.wheelAccum);
    this.wheelAccum = step.accum;
    const lines = step.lines;
    if (!lines) return;
    const n = Math.min(Math.abs(lines), 50);
    if (this.mouseToProgram(ev)) {
      const c = this.cellAt(ev.clientX, ev.clientY);
      const button = lines < 0 ? 4 : 5;
      for (let i = 0; i < n; i++) this.send(term.encodeMouse({ action: 'press', button, mods: modsOf(ev), x: c.px, y: c.py }), false);
      return;
    }
    // On the alternate screen without the mouse (less, man), the wheel is
    // the arrow keys (alternate scroll mode), as in Ghostty.
    if (term.altScreen && term.mode(1007) && !ev.shiftKey) {
      const code = lines < 0 ? 'ArrowUp' : 'ArrowDown';
      const key = term.encodeKey({ action: 'press', code, mods: 0 });
      for (let i = 0; i < n; i++) this.send(key, false);
      return;
    }
    term.scroll(lines);
    this.schedule();
  };

  /** Scrolls the view to a row of the scrollback (the scrollbar). */
  scrollTo(offset: number) {
    const term = this.term;
    if (!term) return;
    term.scroll(offset - term.scrollbar().offset);
    this.schedule();
  }

  private onContextMenu = (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest?.('button, input, .find-bar')) return;
    const term = this.term;
    if (!term) return;
    // Ctrl+click on macOS is a right click too, except the one opening a link.
    if (ev.ctrlKey && ev.button === 0 && this.hover) {
      ev.preventDefault();
      return;
    }
    const c = this.clampCell(this.cellAt(ev.clientX, ev.clientY));
    const selected = term.selectionText();
    const program = selected ? undefined : programClipboard(this.o.m);
    const fromSel = selected ? selectedLink(selected) : undefined;
    const atPointer = this.linkAt(c.col, c.row)?.link;
    const sel = this.frame.lines[c.row]?.sel;
    const inSel = !!sel && c.col >= sel[0] && c.col <= sel[1];
    const link = inSel ? (fromSel ?? atPointer) : (atPointer ?? fromSel);
    openMenu(
      ev,
      surfaceMenu({
        ctx: this.o.linkContext(),
        link,
        copy: selected
          ? () => this.copySelection()
          : program
            ? () => {
                void navigator.clipboard?.writeText(program).catch(() => {});
                programClipboardCopied(program);
              }
            : undefined,
        paste: this.o.readOnly() || !navigator.clipboard?.readText ? undefined : () => this.pasteClipboard(),
        find: () => this.openFind(),
      }),
    );
  };

  /** Opens find with the selection as the query when it is one short line. */
  openFind() {
    const text = this.term?.selectionText()?.trim();
    this.o.onFind(text && !text.includes('\n') && text.length <= 200 ? text : undefined);
  }

  // ---- dropped files ----

  private dropAllowed(ev: DragEvent): boolean {
    return !!this.o.onDropFiles && !this.o.readOnly() && carriesFiles(ev.dataTransfer);
  }

  private onDragOver = (ev: DragEvent) => {
    const ok = this.dropAllowed(ev);
    this.o.onDropTarget?.(ok);
    if (!ok) return;
    ev.preventDefault();
    ev.dataTransfer!.dropEffect = 'copy';
  };

  private onDragLeave = (ev: DragEvent) => {
    if (!this.host.contains(ev.relatedTarget as Node | null)) this.o.onDropTarget?.(false);
  };

  private onDrop = (ev: DragEvent) => {
    this.o.onDropTarget?.(false);
    if (!this.dropAllowed(ev)) return;
    ev.preventDefault();
    this.o.activate();
    this.focus();
    void this.o.onDropFiles!(ev.dataTransfer!.items).then((text) => text && this.paste(text));
  };

  // ---- links and formulas ----

  private rowText = (y: number) => rowCols(this.frame.lines[y]);

  /** The link at a cell: an OSC 8 hyperlink (web links only), or a URL or
   * path in the text, also one wrapped over several rows. */
  private linkAt(col: number, row: number): PaneLink | undefined {
    const r = this.frame.lines[row];
    if (!r || col < 0 || col >= r.codes.length) return;
    if (r.link[col]) {
      const target = this.term?.hyperlinkAt(col, row);
      if (target && safeUrl(target)) {
        let a = col;
        let b = col + 1;
        while (a > 0 && r.link[a - 1]) a--;
        while (b < r.codes.length && r.link[b]) b++;
        return { cells: [{ y: row, from: a, to: b }], link: { kind: 'url', text: target } };
      }
    }
    for (const l of linksAround(row, 0, this.frame.rows, this.rowText))
      if (l.cells.some((c) => c.y === row && col >= c.from && col < c.to)) return { cells: l.cells, link: { kind: l.kind, text: l.text } };
  }

  private onModifier = (ev: KeyboardEvent) => {
    if (ev.key !== 'Meta' && ev.key !== 'Control') return;
    const p = this.lastPointer;
    if (!p) return;
    const at = { clientX: p.x, clientY: p.y, metaKey: ev.metaKey, ctrlKey: ev.ctrlKey };
    this.updateHover(at);
    if (!p.popover) this.updateMath(at);
  };

  /** Underlines the link under the pointer while Cmd/Ctrl is held. */
  private updateHover(ev: { clientX: number; clientY: number; metaKey: boolean; ctrlKey: boolean; target?: EventTarget | null }) {
    this.lastPointer = { x: ev.clientX, y: ev.clientY, popover: overPopover(ev.target) };
    const c = this.cellAt(ev.clientX, ev.clientY);
    const next = ev.metaKey || ev.ctrlKey ? this.linkAt(c.col, c.row) : undefined;
    if (cellsKey(next?.cells) === cellsKey(this.hover?.cells)) return;
    this.hover = next;
    this.host.style.cursor = next ? 'pointer' : '';
    this.o.setTitle(next ? linkTitle(next.link) : '');
    this.overlay = { ...this.overlay, hover: next?.cells };
    this.redraw();
  }

  /** Shows the formula under the pointer, rendered, once the pointer rests
   * on it; not while Cmd/Ctrl shows links. Over the popover the formula
   * stays; moving off it hides it after MATH_LEAVE_MS. */
  private updateMath(ev: { clientX: number; clientY: number; metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget | null }) {
    if (!this.o.onMath) return;
    const from = this.mathFrom;
    this.mathFrom = { x: ev.clientX, y: ev.clientY };
    if (overPopover(ev.target)) {
      window.clearTimeout(this.mathTimer);
      this.mathWant = this.math;
      return;
    }
    // On the way to the popover the pointer crosses rows of other formulas:
    // the one shown stays, as long as the pointer keeps heading for it.
    if (this.math && from && this.towardPopover(from, ev.clientX, ev.clientY)) {
      window.clearTimeout(this.mathTimer);
      this.mathWant = this.math;
      this.mathTimer = window.setTimeout(() => this.hideMath(), MATH_APPROACH_MS);
      return;
    }
    const c = this.cellAt(ev.clientX, ev.clientY);
    const want = !ev.metaKey && !ev.ctrlKey && this.o.mathHover() && c.row >= 0 && c.row < this.frame.rows;
    const found = want ? mathAt(c.col, c.row, 0, this.frame.rows, this.rowText) : undefined;
    const next = found && { cells: found.cells, tex: found.tex, display: found.display };
    const key = (x?: { cells: Cells[]; tex: string }) => (x ? `${cellsKey(x.cells)} ${x.tex}` : '');
    if (key(next) === key(this.mathWant)) return;
    if (!next) return this.leaveMath();
    this.mathWant = next;
    window.clearTimeout(this.mathTimer);
    if (key(next) === key(this.math)) return;
    this.mathTimer = window.setTimeout(() => void this.showMath(next), this.math ? 0 : MATH_SHOW_MS);
  }

  private towardPopover(from: { x: number; y: number }, x: number, y: number): boolean {
    const el = this.host.querySelector('.math-popover');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    let a: [number, number];
    let b: [number, number];
    if (from.y < r.top)
      [a, b] = [
        [r.left, r.top],
        [r.right, r.top],
      ];
    else if (from.y > r.bottom)
      [a, b] = [
        [r.left, r.bottom],
        [r.right, r.bottom],
      ];
    else if (from.x < r.left)
      [a, b] = [
        [r.left, r.top],
        [r.left, r.bottom],
      ];
    else
      [a, b] = [
        [r.right, r.top],
        [r.right, r.bottom],
      ];
    return inTriangle(x, y, [from.x, from.y], a, b);
  }

  private leaveMath() {
    this.mathWant = undefined;
    window.clearTimeout(this.mathTimer);
    if (this.math) this.mathTimer = window.setTimeout(() => this.setMath(undefined), MATH_LEAVE_MS);
  }

  private async showMath(want: { cells: Cells[]; tex: string; display: boolean }) {
    const html = await renderMath(want.tex, want.display);
    if (this.disposed || this.mathWant !== want) return;
    this.setMath(html ? { ...want, html } : undefined);
  }

  private setMath(m: ShownMath | undefined) {
    if (m === this.math) return;
    this.math = m;
    this.o.onMath?.(m);
    this.overlay = { ...this.overlay, math: m?.cells };
    this.redraw();
  }

  /** Typing, clicking and scrolling move on from a formula. */
  hideMath() {
    window.clearTimeout(this.mathTimer);
    this.mathWant = undefined;
    this.setMath(undefined);
  }

  private onMouseLeave = (ev: MouseEvent) => {
    if (!overPopover(ev.relatedTarget)) this.leaveMath();
  };

  // ---- find ----

  private findChanged(st: ReturnType<typeof useFind.getState>, prev: ReturnType<typeof useFind.getState>) {
    const term = this.term;
    const mine = st.m === this.o.m && st.terminal === this.o.address;
    const was = prev.m === this.o.m && prev.terminal === this.o.address;
    if (!term) return;
    if (!mine) {
      if (was) {
        this.findQuery = '';
        term.find('');
        this.matchesChanged();
      }
      return;
    }
    if (st.query !== this.findQuery || !was) {
      this.findQuery = st.query;
      term.find(st.query);
      // The newest match is current.
      if (st.query) term.findStep(1);
      this.matchesChanged();
      this.schedule();
    } else if (st.stepSeq !== prev.stepSeq) {
      term.findStep(st.step);
      this.matchesChanged();
      this.schedule();
    }
  }

  private matchesChanged() {
    const term = this.term;
    if (!term) return;
    const matches = this.findQuery ? term.findMatches() : [];
    const st = this.findQuery ? term.findState() : { total: 0, selected: undefined };
    const s = useFind.getState();
    if (s.m === this.o.m && s.terminal === this.o.address && (s.total !== st.total || s.selected !== st.selected))
      findResult(st.total, st.selected);
    this.overlay = { ...this.overlay, matches };
    this.redraw();
  }

  // ---- teardown ----

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    panes.delete(this);
    this.noteScroll();
    if (this.stream !== undefined) this.o.connection.detach(this.stream);
    this.stream = undefined;
    this.dropQueue();
    this.offConnection();
    this.offFind();
    this.offPrelude();
    this.offProgram();
    window.clearTimeout(this.preludeTimer);
    this.ro.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.cancelHoldTimer();
    window.clearInterval(this.blinkTimer);
    window.clearTimeout(this.mathTimer);
    window.clearTimeout(this.autoTimer);
    window.clearTimeout(this.paintTimer);
    window.clearTimeout(this.attachTimer);
    this.preedit.remove();
    this.listeners.abort();
    this.renderer?.dispose();
    this.term?.dispose();
    this.term = undefined;
  }
}

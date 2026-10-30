// TermController binds one xterm.js instance to one herdr pane stream.
//
// herdr renders the pane with its own VT emulator and sends ANSI frames, so
// the xterm keeps no scrollback of its own: wheel and mouse events are
// forwarded to herdr (terminal.scroll / terminal.mouse), which routes them to
// the pane's application or to herdr's scrollback.

import { Terminal, type ILinkProvider, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { conn } from '../lib/conn';
import { routeKey } from './keys';

export type TermStatus = 'connecting' | 'open' | 'observe' | 'closed' | 'error';

export interface TermOptions {
  m: string;
  pane: string;
  mode: 'auto' | 'observe';
  fontSize?: number;
  onStatus?(s: TermStatus, msg?: string): void;
  onFocus?(): void;
  /** Return true when the key event was consumed by the app keymap. */
  onKey?(ev: KeyboardEvent): boolean;
  /** Called with pasted files (e.g. images for agents); returns text to type. */
  onPasteFiles?(files: File[]): Promise<string | undefined>;
  linkProvider?(term: Terminal): ILinkProvider | undefined;
}

export const theme: ITheme = {
  background: '#0e1116',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0e1116',
  selectionBackground: '#3b4a6b',
  black: '#1b1f27',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#565f89',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#7da6ff',
  brightMagenta: '#c0a8ff',
  brightCyan: '#a4daff',
  brightWhite: '#e6edf3',
};

export const fontFamily =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Code", "Fira Code", "Noto Sans Mono CJK SC", "PingFang SC", monospace';

function b64(binary: string): string {
  return btoa(binary);
}

export { bracketedPaste } from './paste';
import { bracketedPaste } from './paste';
import { storage } from '../brand';
import { t, type MessageKey } from '../i18n';

export class TermController {
  readonly term: Terminal;
  private fit = new FitAddon();
  private sid?: number;
  private ro: ResizeObserver;
  private resizeTimer?: number;
  private disposed = false;
  private wheelAccum = 0;
  private mouseDown?: number;
  private lastCell = '';
  private webgl?: WebglAddon;
  linkProvider?: ILinkProvider;
  /** Stream mode granted by the core. */
  private granted: 'control' | 'observe' | undefined;
  private queued: Array<Record<string, unknown>> = [];
  private claimed = false;

  constructor(
    private el: HTMLElement,
    private opts: TermOptions,
  ) {
    const term = new Terminal({
      scrollback: 0,
      fontFamily,
      fontSize: opts.fontSize ?? 13,
      lineHeight: 1.1,
      theme,
      allowProposedApi: true,
      cursorBlink: false,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: false,
      macOptionIsMeta: storage.get('optionIsMeta') === 'true',
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      disableStdin: opts.mode === 'observe',
    });
    this.term = term;
    term.loadAddon(this.fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        this.webgl = undefined;
      });
      term.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      // DOM renderer fallback (e.g. no WebGL2 on some mobile browsers).
    }
    const lp = opts.linkProvider?.(term);
    if (lp) {
      this.linkProvider = lp;
      term.registerLinkProvider(lp);
    }

    this.installInput();
    this.attach();
    this.ro = new ResizeObserver(() => this.scheduleResize());
    this.ro.observe(el);
  }

  private dims(): { cols: number; rows: number } {
    const d = this.fit.proposeDimensions();
    const cols = Math.max(2, d?.cols && isFinite(d.cols) ? d.cols : 80);
    const rows = Math.max(1, d?.rows && isFinite(d.rows) ? d.rows : 24);
    return { cols, rows };
  }

  private cellSize(): { w: number; h: number } {
    const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen || !this.term.cols || !this.term.rows) return { w: 8, h: 16 };
    const r = screen.getBoundingClientRect();
    return { w: r.width / this.term.cols, h: r.height / this.term.rows };
  }

  attach(takeover = false) {
    if (this.disposed) return;
    const { cols, rows } = this.dims();
    this.term.resize(cols, rows);
    this.granted = undefined;
    this.claimed = takeover;
    this.opts.onStatus?.('connecting');
    if (this.sid !== undefined) conn.detach(this.sid);
    const c = this.cellSize();
    this.sid = conn.attach(
      { m: this.opts.m, pane: this.opts.pane, cols, rows, mode: this.opts.mode, takeover, cw: Math.round(c.w), ch: Math.round(c.h) },
      {
        onFrame: (_full, w, h, data) => {
          if (w !== this.term.cols || h !== this.term.rows) {
            this.term.resize(w, h);
            this.fitObserver();
          }
          this.term.write(data);
        },
        onEvent: (ev) => {
          if (ev.ev === 'open') {
            // Every stream starts with a full frame; drop old state.
            this.term.reset();
            this.granted = ev.mode;
            this.claimed = false;
            if (ev.cols && ev.rows) this.term.resize(ev.cols, ev.rows);
            this.fitObserver();
            if (ev.mode === 'control') {
              this.opts.onStatus?.('open');
              const q = this.queued.splice(0);
              for (const m of q) this.send(m);
              // Our container may have changed while observing.
              this.scheduleResize(true);
            } else {
              this.opts.onStatus?.('observe');
            }
          } else if (ev.ev === 'notice') {
            this.opts.onStatus?.('observe', ev.code ? t(`term.notice.${ev.code}` as MessageKey) : ev.message);
          } else if (ev.ev === 'closed') this.opts.onStatus?.('closed', ev.reason);
          else this.opts.onStatus?.('error', ev.message);
        },
      },
    );
  }

  /** Ask the core for control (input from an observing browser). */
  claim() {
    if (this.sid === undefined || this.opts.mode === 'observe' || this.claimed) return;
    this.claimed = true;
    const { cols, rows } = this.dims();
    const c = this.cellSize();
    conn.stream(this.sid, { t: 'claim', cols, rows, cw: Math.round(c.w), ch: Math.round(c.h) });
  }

  /** Observers render at the controller's size, scaled down to fit. */
  private fitObserver() {
    const el = this.term.element;
    if (!el) return;
    if (this.granted !== 'observe') {
      el.style.transform = '';
      return;
    }
    const screen = el.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    el.style.transform = '';
    const sw = screen.offsetWidth;
    const sh = screen.offsetHeight;
    const scale = Math.min(1, this.el.clientWidth / (sw || 1), this.el.clientHeight / (sh || 1));
    el.style.transformOrigin = '0 0';
    el.style.transform = scale < 1 ? `scale(${scale})` : '';
  }

  private send(msg: Record<string, unknown>) {
    if (this.sid === undefined || this.opts.mode === 'observe') return;
    if (this.granted === 'control') {
      conn.stream(this.sid, msg);
      return;
    }
    // Typing into an observed pane claims it; replay once granted.
    if (msg.t === 'in' || msg.t === 'inb') this.queued.push(msg);
    this.claim();
  }

  input(text: string) {
    if (text) this.send({ t: 'in', d: text });
  }

  private scheduleResize(force = false) {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (this.disposed || !this.el.isConnected || this.el.clientWidth === 0) return;
      const { cols, rows } = this.dims();
      if (this.granted === 'observe') {
        this.fitObserver();
      } else if (!force && cols === this.term.cols && rows === this.term.rows) return;
      else this.term.resize(cols, rows);
      const c = this.cellSize();
      if (this.sid !== undefined) {
        conn.updateAttach(this.sid, { cols, rows });
        conn.stream(this.sid, { t: 'resize', cols, rows, cw: Math.round(c.w * devicePixelRatio), ch: Math.round(c.h * devicePixelRatio) });
      }
    }, 50);
  }

  private cellAt(ev: MouseEvent): { col: number; row: number } | undefined {
    const screen = this.term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const col = Math.floor(((ev.clientX - r.left) / r.width) * this.term.cols);
    const row = Math.floor(((ev.clientY - r.top) / r.height) * this.term.rows);
    if (col < 0 || row < 0 || col >= this.term.cols || row >= this.term.rows) return;
    return { col, row };
  }

  private mods(ev: MouseEvent | WheelEvent): number {
    return (ev.shiftKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.altKey ? 4 : 0);
  }

  private installInput() {
    const term = this.term;
    term.onData((d) => this.input(d));
    term.onBinary((d) => this.send({ t: 'inb', b: b64(d) }));

    term.attachCustomKeyEventHandler((ev) =>
      routeKey(
        ev,
        (e) => !!this.opts.onKey?.(e),
        (d) => this.input(d),
      ),
    );

    term.textarea?.addEventListener('focus', () => this.opts.onFocus?.());
    term.textarea?.addEventListener(
      'paste',
      (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const dt = ev.clipboardData;
        if (!dt) return;
        const files = Array.from(dt.files);
        const text = dt.getData('text/plain');
        if (files.length && this.opts.onPasteFiles) {
          this.opts.onPasteFiles(files).then((t) => t && this.input(t));
          return;
        }
        if (text) this.input(bracketedPaste(text));
      },
      { capture: true },
    );

    term.attachCustomWheelEventHandler((ev) => {
      const cell = this.cellAt(ev);
      const ch = this.cellSize().h || 16;
      let delta = ev.deltaY;
      if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= ch;
      else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= ch * this.term.rows;
      this.wheelAccum += delta;
      const lines = Math.trunc(this.wheelAccum / ch);
      if (lines !== 0) {
        this.wheelAccum -= lines * ch;
        this.send({
          t: 'scroll',
          dir: lines < 0 ? 'up' : 'down',
          lines: Math.min(Math.abs(lines), 50),
          col: cell?.col,
          row: cell?.row,
          mods: this.mods(ev),
        });
      }
      ev.preventDefault();
      return false;
    });

    const el = term.element!;
    const button = (b: number) => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left');
    el.addEventListener('mousedown', (ev) => {
      // Option/Alt-drag is a purely local selection.
      if (ev.altKey || ev.button === 2) return;
      const c = this.cellAt(ev);
      if (!c) return;
      this.mouseDown = ev.button;
      this.lastCell = `${c.col},${c.row}`;
      this.send({ t: 'mouse', action: 'down', button: button(ev.button), col: c.col, row: c.row, mods: this.mods(ev) });
    });
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  private onMouseMove = (ev: MouseEvent) => {
    if (this.mouseDown === undefined) return;
    const c = this.cellAt(ev);
    if (!c) return;
    const key = `${c.col},${c.row}`;
    if (key === this.lastCell) return;
    this.lastCell = key;
    this.send({
      t: 'mouse',
      action: 'drag',
      button: this.mouseDown === 1 ? 'middle' : 'left',
      col: c.col,
      row: c.row,
      mods: this.mods(ev),
    });
  };

  private onMouseUp = (ev: MouseEvent) => {
    if (this.mouseDown === undefined) return;
    const b = this.mouseDown;
    this.mouseDown = undefined;
    const c =
      this.cellAt(ev) ??
      (() => {
        const [col, row] = this.lastCell.split(',').map(Number);
        return { col, row };
      })();
    this.send({ t: 'mouse', action: 'up', button: b === 1 ? 'middle' : 'left', col: c.col, row: c.row, mods: this.mods(ev) });
  };

  focus() {
    this.term.focus();
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.resizeTimer);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.ro.disconnect();
    if (this.sid !== undefined) conn.detach(this.sid);
    this.webgl?.dispose();
    this.term.dispose();
  }
}

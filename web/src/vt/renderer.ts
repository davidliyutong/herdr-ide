// Draws a terminal's frame (terminal.ts) on a canvas: WebGL2 where the
// browser has it, Canvas 2D otherwise. What a row looks like (background per
// cell, and glyphs: text, shapes, lines, cursor) is worked out once by
// drawRow, a pure function both renderers share; only rows that changed are
// worked out again.
//
// WebGL draws every frame from a background texture of one texel per cell
// and one instanced quad per glyph from the atlas, tinted in the shader
// (emoji keep their colors). Canvas 2D paints the rows that changed with
// glyphs the atlas keeps per color.

import { Atlas, type GlyphSpec, isShape, type Metrics, textPad } from './atlas';
import {
  F_BOLD,
  F_FAINT,
  F_INVERSE,
  F_INVISIBLE,
  F_ITALIC,
  F_OVERLINE,
  F_STRIKE,
  UNDERLINE_SHIFT,
  WIDE_HEAD,
  WIDE_TAIL,
  WIDE_WIDE,
  type Frame,
  type Row,
} from './terminal';

/** Colors the renderer adds to the terminal's: selection and find matches. */
export interface Look {
  selection: number;
  match: number;
  matchCurrent: number;
}

/** A range of cells in a row: columns [from, to). */
export interface Cells {
  y: number;
  from: number;
  to: number;
}

/** What is drawn over the terminal's own content. */
export interface Overlay {
  focused: boolean;
  /** The blinking cursor's visible phase. */
  blinkOn: boolean;
  matches: Array<Cells & { current: boolean }>;
  /** A link under the pointer, underlined. */
  hover?: Cells[];
  /** A formula shown rendered, dotted underneath. */
  math?: Cells[];
}

export interface GlyphDraw {
  col: number;
  span: number;
  glyph: GlyphSpec;
  color: number;
  alpha: number;
}

export interface RowDraw {
  /** Background of each cell, 0xRRGGBB. */
  bg: Int32Array;
  glyphs: GlyphDraw[];
}

export function hexColor(css: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(css);
  return m ? parseInt(m[1], 16) : 0;
}

export function cssColor(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

function luminance(n: number): number {
  return (0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)) / 255;
}

/** The renderer's colors for a theme: the selection setting, amber matches
 * (dimmer on dark backgrounds so text keeps its contrast). */
export function lookOf(selection: string, background: string): Look {
  const dark = luminance(hexColor(background)) < 0.5;
  return { selection: hexColor(selection), match: dark ? 0x5c4813 : 0xfff2b3, matchCurrent: dark ? 0x9a6a00 : 0xffc94d };
}

const inside = (cells: Cells[] | undefined, y: number, x: number) => !!cells?.some((c) => c.y === y && x >= c.from && x < c.to);

/** A row's backgrounds and glyphs. */
export function drawRow(row: Row, y: number, frame: Frame, look: Look, ov: Overlay): RowDraw {
  const cols = row.codes.length;
  const { fg: dfg, bg: dbg } = frame.colors;
  const bgs = new Int32Array(cols);
  const glyphs: GlyphDraw[] = [];
  const cur = frame.cursor;
  const cursorHere = cur.visible && cur.y === y && (ov.blinkOn || !cur.blinking || !ov.focused);
  const cursorColor = frame.colors.cursor >= 0 ? frame.colors.cursor : dfg;
  const matches = ov.matches.filter((m) => m.y === y);
  const sel = row.sel;
  for (let x = 0; x < cols; x++) {
    const flags = row.flags[x];
    let fg = row.fg[x] >= 0 ? row.fg[x] : dfg;
    let bg = row.bg[x] >= 0 ? row.bg[x] : dbg;
    if (flags & F_INVERSE) [fg, bg] = [bg, fg];
    // The selection over the current match over other matches.
    let rank = 0;
    for (const m of matches) {
      if (x < m.from || x >= m.to) continue;
      const r = m.current ? 2 : 1;
      if (r > rank) {
        rank = r;
        bg = m.current ? look.matchCurrent : look.match;
      }
    }
    if (sel && x >= sel[0] && x <= sel[1]) bg = look.selection;
    bgs[x] = bg;
    const wide = row.wide[x];
    if (wide === WIDE_TAIL || wide === WIDE_HEAD) continue;
    const span = wide === WIDE_WIDE ? Math.min(2, cols - x) : 1;
    const onCursor = cursorHere && (cur.x === x || (cur.wideTail && cur.x === x + 1));
    let textColor = fg;
    if (onCursor && ov.focused && cur.style === 'block') {
      // A block cursor shows the cell's text in the background color.
      for (let i = 0; i < span; i++) bgs[x + i] = cursorColor;
      textColor = dbg;
    }
    const alpha = flags & F_FAINT ? 0.5 : 1;
    const code = row.codes[x];
    if (code && !(flags & F_INVISIBLE) && code !== 0x20) {
      const text = row.text[x] ?? String.fromCodePoint(code);
      const glyph: GlyphSpec = isShape(text)
        ? { kind: 'shape', text }
        : { kind: 'text', text, bold: !!(flags & F_BOLD), italic: !!(flags & F_ITALIC) };
      glyphs.push({ col: x, span, glyph, color: textColor, alpha });
    }
    let ul = (flags >> UNDERLINE_SHIFT) & 7;
    if (!ul && inside(ov.hover, y, x)) ul = 1;
    if (!ul && inside(ov.math, y, x)) ul = 4;
    if (ul)
      glyphs.push({
        col: x,
        span,
        glyph: { kind: 'line', style: ul },
        color: row.ul[x] >= 0 && !(flags & F_INVERSE) ? row.ul[x] : textColor,
        alpha,
      });
    if (flags & F_STRIKE) glyphs.push({ col: x, span, glyph: { kind: 'line', style: 'strike' }, color: textColor, alpha });
    if (flags & F_OVERLINE) glyphs.push({ col: x, span, glyph: { kind: 'line', style: 'overline' }, color: textColor, alpha });
  }
  if (cursorHere && cur.x < cols && !(ov.focused && cur.style === 'block')) {
    const span = row.wide[cur.x] === WIDE_WIDE ? Math.min(2, cols - cur.x) : 1;
    glyphs.push({ col: cur.x, span, glyph: { kind: 'cursor', style: ov.focused ? cur.style : 'hollow' }, color: cursorColor, alpha: 1 });
  }
  return { bg: bgs, glyphs };
}

export interface Renderer {
  readonly kind: 'webgl' | 'canvas';
  /** Draws the frame; rows not in frame.dirty are drawn as before unless
   * invalidate() was called. Clears frame.dirty. */
  render(frame: Frame, look: Look, ov: Overlay): void;
  /** Everything is drawn again at the next render (overlay, colors, metrics). */
  invalidate(): void;
  setMetrics(m: Metrics): void;
  /** The canvas's size in device pixels. */
  resize(width: number, height: number): void;
  dispose(): void;
}

/** A renderer for the canvas: WebGL2 unless it is unavailable or refused. */
export function createRenderer(canvas: HTMLCanvasElement, prefer: 'webgl' | 'canvas' = 'webgl'): Renderer {
  if (prefer === 'webgl') {
    try {
      return new GLRenderer(canvas);
    } catch {
      /* no WebGL2: Canvas 2D */
    }
  }
  return new CanvasRenderer(canvas);
}

/** Rows' drawings, worked out again for the rows that changed. */
abstract class Base implements Renderer {
  abstract readonly kind: 'webgl' | 'canvas';
  protected rows: RowDraw[] = [];
  protected all = true;
  protected m!: Metrics;
  protected width = 0;
  protected height = 0;
  protected readonly atlas = new Atlas();

  constructor(protected readonly canvas: HTMLCanvasElement) {}

  invalidate() {
    this.all = true;
  }

  setMetrics(m: Metrics) {
    this.m = m;
    this.atlas.setMetrics(m);
    this.all = true;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.all = true;
  }

  /** Works out the changed rows; returns their indexes. */
  protected build(frame: Frame, look: Look, ov: Overlay): number[] {
    if (this.rows.length !== frame.rows) {
      this.rows.length = frame.rows;
      this.all = true;
    }
    const ys = this.all ? Array.from({ length: frame.rows }, (_, i) => i) : [...frame.dirty].filter((y) => y < frame.rows);
    for (const y of ys) this.rows[y] = drawRow(frame.lines[y], y, frame, look, ov);
    frame.dirty.clear();
    return ys;
  }

  abstract render(frame: Frame, look: Look, ov: Overlay): void;
  abstract dispose(): void;
}

class CanvasRenderer extends Base {
  readonly kind = 'canvas' as const;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('no canvas');
    this.ctx = ctx;
  }

  render(frame: Frame, look: Look, ov: Overlay) {
    const all = this.all;
    const gen = this.atlas.generation;
    const ys = this.build(frame, look, ov);
    this.all = false;
    const { cw, ch } = this.m;
    const ctx = this.ctx;
    if (all) {
      ctx.fillStyle = cssColor(frame.colors.bg);
      ctx.fillRect(0, 0, this.width, this.height);
    }
    for (const y of ys) {
      const r = this.rows[y];
      if (!r) continue;
      const top = y * ch;
      // Backgrounds in runs of one color, then the margin right of the grid.
      let x = 0;
      while (x < r.bg.length) {
        let e = x + 1;
        while (e < r.bg.length && r.bg[e] === r.bg[x]) e++;
        ctx.fillStyle = cssColor(r.bg[x]);
        ctx.fillRect(x * cw, top, (e - x) * cw, ch);
        x = e;
      }
      ctx.fillStyle = cssColor(frame.colors.bg);
      ctx.fillRect(r.bg.length * cw, top, this.width - r.bg.length * cw, ch);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, this.width, ch);
      ctx.clip();
      for (const g of r.glyphs) {
        const s = this.atlas.get(g.glyph, g.span, cssColor(g.color));
        ctx.globalAlpha = g.alpha;
        ctx.drawImage(this.atlas.canvas, s.x, s.y, s.w, s.h, g.col * cw, top, s.w, s.h);
      }
      ctx.restore();
    }
    if (!all) {
      // The bottom margin below the grid.
      ctx.fillStyle = cssColor(frame.colors.bg);
      ctx.fillRect(0, frame.rows * ch, this.width, this.height - frame.rows * ch);
    }
    // The atlas started over while drawing: draw everything again from it.
    if (this.atlas.generation !== gen) this.all = true;
  }

  dispose() {}
}

const VERT_BG = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG_BG = `#version 300 es
precision highp float;
uniform sampler2D u_bg;
uniform vec2 u_cell;
uniform vec2 u_grid;
uniform float u_height;
uniform vec4 u_default;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y);
  vec2 c = floor(p / u_cell);
  if (c.x >= u_grid.x || c.y >= u_grid.y) { o = u_default; return; }
  o = texelFetch(u_bg, ivec2(c), 0);
}`;

const VERT_GLYPH = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
in vec4 a_uv;
in vec4 a_color;
in float a_colored;
uniform vec2 u_size;
uniform vec2 u_atlas;
out vec2 v_uv;
out vec4 v_color;
out float v_colored;
void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  v_uv = (a_uv.xy + a_corner * a_uv.zw) / u_atlas;
  v_color = a_color;
  v_colored = a_colored;
}`;

const FRAG_GLYPH = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_color;
in float v_colored;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  o = v_colored > 0.5 ? vec4(t.rgb, t.a * v_color.a) : vec4(v_color.rgb, v_color.a * t.a);
}`;

/** Floats per glyph instance: rect (4), atlas rect (4), colored (1), then the color's 4 bytes. */
const STRIDE = 40;

class GLRenderer extends Base {
  readonly kind = 'webgl' as const;
  private readonly gl: WebGL2RenderingContext;
  private readonly bgProg: WebGLProgram;
  private readonly glyphProg: WebGLProgram;
  private readonly bgTex: WebGLTexture;
  private readonly atlasTex: WebGLTexture;
  private readonly quad: WebGLBuffer;
  private readonly corners: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private readonly vaoBg: WebGLVertexArrayObject;
  private readonly vaoGlyph: WebGLVertexArrayObject;
  private bgCols = 0;
  private bgRows = 0;
  private atlasSize = 0;
  private atlasGen = -1;
  /** Each row's instance bytes. */
  private chunks: Uint8Array[] = [];
  private data = new ArrayBuffer(0);
  private lost = false;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onLost);
    const compile = (vs: string, fs: string) => {
      const p = gl.createProgram()!;
      for (const [type, src] of [
        [gl.VERTEX_SHADER, vs],
        [gl.FRAGMENT_SHADER, fs],
      ] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
      return p;
    };
    this.bgProg = compile(VERT_BG, FRAG_BG);
    this.glyphProg = compile(VERT_GLYPH, FRAG_GLYPH);
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.bgTex = texture();
    this.atlasTex = texture();
    // The background: two triangles over the canvas.
    this.vaoBg = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoBg);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(this.bgProg, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    // Glyphs: a corner per vertex, the rest per instance.
    this.vaoGlyph = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoGlyph);
    this.corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.glyphProg, 'a_corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const attr = (name: string, size: number, type: number, normalized: boolean, offset: number) => {
      const loc = gl.getAttribLocation(this.glyphProg, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr('a_rect', 4, gl.FLOAT, false, 0);
    attr('a_uv', 4, gl.FLOAT, false, 16);
    attr('a_colored', 1, gl.FLOAT, false, 32);
    attr('a_color', 4, gl.UNSIGNED_BYTE, true, 36);
    gl.bindVertexArray(null);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  /** The context was lost (GPU reset, too many contexts): the owner makes a new renderer. */
  get contextLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  private instanceBytes(r: RowDraw, y: number): Uint8Array {
    const { cw, ch } = this.m;
    const out = new Uint8Array(r.glyphs.length * STRIDE);
    const f = new Float32Array(out.buffer);
    for (let i = 0; i < r.glyphs.length; i++) {
      const g = r.glyphs[i];
      const s = this.atlas.get(g.glyph, g.span);
      const o = (i * STRIDE) / 4;
      f[o] = g.col * cw;
      f[o + 1] = y * ch;
      f[o + 2] = s.w;
      f[o + 3] = s.h;
      f[o + 4] = s.x;
      f[o + 5] = s.y;
      f[o + 6] = s.w;
      f[o + 7] = s.h;
      f[o + 8] = s.colored ? 1 : 0;
      const b = i * STRIDE + 36;
      out[b] = (g.color >> 16) & 0xff;
      out[b + 1] = (g.color >> 8) & 0xff;
      out[b + 2] = g.color & 0xff;
      out[b + 3] = Math.round(g.alpha * 255);
    }
    return out;
  }

  render(frame: Frame, look: Look, ov: Overlay) {
    if (this.contextLost) return;
    const gl = this.gl;
    const atlasGen = this.atlas.generation;
    const all = this.all || this.atlasGen !== atlasGen;
    this.all = all;
    const ys = this.build(frame, look, ov);
    this.all = false;
    // Background texels of the rows that changed.
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.bgCols !== frame.cols || this.bgRows !== frame.rows) {
      this.bgCols = frame.cols;
      this.bgRows = frame.rows;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.cols, frame.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    const line = new Uint8Array(frame.cols * 4);
    for (const y of ys) {
      const r = this.rows[y];
      for (let x = 0; x < frame.cols; x++) {
        const c = r.bg[x];
        line[x * 4] = (c >> 16) & 0xff;
        line[x * 4 + 1] = (c >> 8) & 0xff;
        line[x * 4 + 2] = c & 0xff;
        line[x * 4 + 3] = 255;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, frame.cols, 1, gl.RGBA, gl.UNSIGNED_BYTE, line);
    }
    // Glyph instances of those rows; a glyph new to the atlas may start it
    // over, which needs every row's instances again.
    this.chunks.length = frame.rows;
    for (const y of ys) this.chunks[y] = this.instanceBytes(this.rows[y], y);
    if (this.atlas.generation !== atlasGen) {
      const gen = this.atlas.generation;
      for (let y = 0; y < frame.rows; y++) this.chunks[y] = this.instanceBytes(this.rows[y], y);
      if (this.atlas.generation !== gen) this.all = true;
    }
    this.atlasGen = this.atlas.generation;
    this.uploadAtlas();
    let total = 0;
    for (const c of this.chunks) total += c?.length ?? 0;
    if (this.data.byteLength < total) this.data = new ArrayBuffer(Math.max(total, this.data.byteLength * 2));
    const bytes = new Uint8Array(this.data, 0, total);
    let at = 0;
    for (const c of this.chunks) {
      if (!c) continue;
      bytes.set(c, at);
      at += c.length;
    }
    // Draw.
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProg);
    gl.bindVertexArray(this.vaoBg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.uniform1i(gl.getUniformLocation(this.bgProg, 'u_bg'), 0);
    gl.uniform2f(gl.getUniformLocation(this.bgProg, 'u_cell'), this.m.cw, this.m.ch);
    gl.uniform2f(gl.getUniformLocation(this.bgProg, 'u_grid'), frame.cols, frame.rows);
    gl.uniform1f(gl.getUniformLocation(this.bgProg, 'u_height'), this.height);
    const d = frame.colors.bg;
    gl.uniform4f(gl.getUniformLocation(this.bgProg, 'u_default'), ((d >> 16) & 0xff) / 255, ((d >> 8) & 0xff) / 255, (d & 0xff) / 255, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const count = total / STRIDE;
    if (count) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.glyphProg);
      gl.bindVertexArray(this.vaoGlyph);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.uniform1i(gl.getUniformLocation(this.glyphProg, 'u_tex'), 0);
      gl.uniform2f(gl.getUniformLocation(this.glyphProg, 'u_size'), this.width, this.height);
      gl.uniform2f(gl.getUniformLocation(this.glyphProg, 'u_atlas'), this.atlas.size, this.atlas.size);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    gl.bindVertexArray(null);
  }

  private uploadAtlas() {
    const gl = this.gl;
    const a = this.atlas;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.atlasSize !== a.size) {
      this.atlasSize = a.size;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, a.size, a.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      a.dirty = [0, 0, a.size, a.size];
    }
    const d = a.dirty;
    if (!d) return;
    a.dirty = null;
    const [x0, y0, x1, y1] = d;
    const w = Math.min(x1, a.size) - x0;
    const h = Math.min(y1, a.size) - y0;
    if (w <= 0 || h <= 0) return;
    const img = a.ctx.getImageData(x0, y0, w, h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    const gl = this.gl;
    gl.deleteTexture(this.bgTex);
    gl.deleteTexture(this.atlasTex);
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.corners);
    gl.deleteBuffer(this.instances);
    gl.deleteVertexArray(this.vaoBg);
    gl.deleteVertexArray(this.vaoGlyph);
    gl.deleteProgram(this.bgProg);
    gl.deleteProgram(this.glyphProg);
    // Frees the context now rather than when the page collects it: browsers
    // keep only a few at a time.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export { textPad };

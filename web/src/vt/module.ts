// Ghostty's terminal emulator (libghostty-vt) compiled to WebAssembly
// (ghostty-vt.wasm, built by scripts/fetch-ghostty-vt.sh). This module loads
// it once and gives the rest of vt/ what the C API needs from JavaScript:
// the layouts of its structs and the values of its enums (from
// ghostty_type_json, so no offset is written here), memory access that
// survives the memory growing, opaque handles, and callbacks.
//
// The C API passes structs by value as pointers in wasm, and a struct return
// becomes a leading out-pointer. Callbacks are function-table indices: a
// JavaScript function cannot be put into a funcref table, so a tiny wasm
// module made here imports the JavaScript functions and exports them as wasm
// functions of the right types, which go into the library's table.

import wasmUrl from './ghostty-vt.wasm?url';

type Fn = (...args: number[]) => number;
type BigFn = (...args: (number | bigint)[]) => number;

/** The library's exports; functions are called by their C names. */
export interface VtExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  [name: string]: Fn | BigFn | WebAssembly.Memory | WebAssembly.Table | WebAssembly.Global;
}

interface FieldLayout {
  offset: number;
  size: number;
  type: string;
}

interface BitField {
  lsb: number;
  width: number;
}

interface TypeLayout {
  kind: string;
  size: number;
  values?: Record<string, number>;
  fields?: Record<string, FieldLayout>;
  bits?: Record<string, BitField>;
}

export const SUCCESS = 0;
export const NO_VALUE = -4;
export const OUT_OF_SPACE = -3;

/** Callbacks a terminal registers; called while it processes output. */
export interface VtCallbacks {
  writePty?(data: Uint8Array): void;
  bell?(): void;
  titleChanged?(): void;
  /** OSC 52 and the like: the request's address, answered before returning. */
  clipboardWrite?(request: number): void;
  /** CSI ? 996 n: true for dark. */
  colorScheme?(): boolean | undefined;
  /** XTWINOPS size reports: fills the GhosttySizeReportSize at out. */
  size?(out: number): boolean;
  /** Synchronized output (mode 2026) began (true) or ended. */
  renderHold?(held: boolean): void;
}

const valueTypes = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c } as const;
type ValueType = keyof typeof valueTypes;

/** A wasm module importing each function as e.f<i> with its signature and
 * exporting it again as f<i>: exported functions of a module can go into
 * another module's function table. */
export function trampolines(
  sigs: { params: ValueType[]; results: ValueType[]; fn: (...a: never[]) => unknown }[],
): WebAssembly.ExportValue[] {
  const name = (s: string) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
  const leb = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  };
  const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
  const types = sigs.flatMap((s) => [
    0x60,
    ...leb(s.params.length),
    ...s.params.map((p) => valueTypes[p]),
    ...leb(s.results.length),
    ...s.results.map((r) => valueTypes[r]),
  ]);
  const imports = sigs.flatMap((_, i) => [...name('e'), ...name(`f${i}`), 0x00, ...leb(i)]);
  const exports = sigs.flatMap((_, i) => [...name(`f${i}`), 0x00, ...leb(i)]);
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, [...leb(sigs.length), ...types]),
    ...section(2, [...leb(sigs.length), ...imports]),
    ...section(7, [...leb(sigs.length), ...exports]),
  ]);
  const env: Record<string, unknown> = {};
  sigs.forEach((s, i) => (env[`f${i}`] = s.fn));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: env as WebAssembly.ModuleImports });
  return sigs.map((_, i) => instance.exports[`f${i}`]);
}

/** The loaded library: its exports and what JavaScript needs to call them. */
export class Vt {
  readonly x: VtExports;
  private readonly types: Record<string, TypeLayout>;
  private buffer?: ArrayBuffer;
  private bytes!: Uint8Array;
  private view!: DataView;
  private readonly terminals = new Map<number, VtCallbacks>();
  /** Function-table indices of the callbacks, by terminal option. */
  readonly callbackIndex: Record<string, number> = {};
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as unknown as VtExports;
    const ptr = this.fn('ghostty_type_json')();
    const mem = this.u8();
    let end = ptr;
    while (mem[end]) end++;
    this.types = (JSON.parse(this.decoder.decode(mem.subarray(ptr, end))) as { types: Record<string, TypeLayout> }).types;
    this.installCallbacks();
  }

  /** A C function of the library. */
  fn(name: string): Fn {
    const f = this.x[name];
    if (typeof f !== 'function') throw new Error(`libghostty-vt has no ${name}`);
    return f as Fn;
  }

  /** The same, for functions with 64-bit arguments (BigInt). */
  fn64(name: string): BigFn {
    return this.fn(name) as unknown as BigFn;
  }

  /** The memory as bytes, read again whenever it grew. */
  u8(): Uint8Array {
    const buf = this.x.memory.buffer;
    if (buf !== this.buffer) {
      this.buffer = buf;
      this.bytes = new Uint8Array(buf);
      this.view = new DataView(buf);
    }
    return this.bytes;
  }

  dv(): DataView {
    this.u8();
    return this.view;
  }

  alloc(size: number): number {
    if (size <= 0) return 0;
    const p = this.fn('ghostty_wasm_alloc')(size);
    if (!p) throw new Error('libghostty-vt: out of memory');
    return p;
  }

  free(ptr: number, size: number): void {
    if (ptr && size > 0) this.fn('ghostty_wasm_free')(ptr, size);
  }

  /** Allocates zeroed storage of a struct's size. */
  allocStruct(type: string): number {
    const size = this.size(type);
    const p = this.alloc(size);
    this.u8().fill(0, p, p + size);
    return p;
  }

  /** Runs a constructor taking an out-pointer to a handle; returns the handle. */
  handle(make: (slot: number) => number): number {
    const slot = this.fn('ghostty_wasm_alloc_opaque')();
    try {
      const r = make(slot);
      if (r !== SUCCESS) throw new Error(`libghostty-vt: error ${r}`);
      return this.fn('ghostty_wasm_take_opaque')(slot);
    } finally {
      this.fn('ghostty_wasm_free_opaque')(slot);
    }
  }

  // ---- layouts ----

  private type(name: string): TypeLayout {
    const t = this.types[name];
    if (!t) throw new Error(`libghostty-vt has no type ${name}`);
    return t;
  }

  size(type: string): number {
    return this.type(type).size;
  }

  /** A field's offset in a struct. */
  off(type: string, field: string): number {
    const f = this.type(type).fields?.[field];
    if (!f) throw new Error(`libghostty-vt: ${type} has no field ${field}`);
    return f.offset;
  }

  /** An enum's value by its name without the prefix (GhosttyKey, "ARROW_UP"). */
  enumValue(type: string, name: string): number {
    const v = this.type(type).values?.[name];
    if (v === undefined) throw new Error(`libghostty-vt: ${type} has no ${name}`);
    return v;
  }

  enumValues(type: string): Record<string, number> {
    return this.type(type).values ?? {};
  }

  /** A packed struct's bit field. */
  bits(type: string, field: string): BitField {
    const b = this.type(type).bits?.[field];
    if (!b) throw new Error(`libghostty-vt: ${type} has no bits ${field}`);
    return b;
  }

  // ---- values in memory ----

  /** Bytes as a GhosttyString-like (ptr, len) in a fresh allocation; free with free(ptr, len). */
  copyIn(data: Uint8Array): number {
    const p = this.alloc(Math.max(1, data.length));
    this.u8().set(data, p);
    return p;
  }

  encode(text: string): Uint8Array {
    return this.encoder.encode(text);
  }

  decode(ptr: number, len: number): string {
    return len > 0 ? this.decoder.decode(this.u8().subarray(ptr, ptr + len)) : '';
  }

  /** A GhosttyString (pointer and length) at ptr, decoded. */
  string(ptr: number): string {
    const dv = this.dv();
    return this.decode(
      dv.getUint32(ptr + this.off('GhosttyString', 'ptr'), true),
      dv.getUint32(ptr + this.off('GhosttyString', 'len'), true),
    );
  }

  // ---- callbacks ----

  /** Calls for this terminal handle go to callbacks. */
  register(terminal: number, callbacks: VtCallbacks): void {
    this.terminals.set(terminal, callbacks);
  }

  unregister(terminal: number): void {
    this.terminals.delete(terminal);
  }

  private installCallbacks() {
    const cb = (t: number) => this.terminals.get(t);
    const defs: Array<[string, ValueType[], ValueType[], (...a: number[]) => unknown]> = [
      ['WRITE_PTY', ['i32', 'i32', 'i32', 'i32'], [], (t, _u, p, n) => cb(t)?.writePty?.(this.u8().slice(p, p + n))],
      ['BELL', ['i32', 'i32'], [], (t) => cb(t)?.bell?.()],
      ['TITLE_CHANGED', ['i32', 'i32'], [], (t) => cb(t)?.titleChanged?.()],
      ['CLIPBOARD_WRITE', ['i32', 'i32', 'i32'], [], (t, _u, w) => cb(t)?.clipboardWrite?.(w)],
      [
        'COLOR_SCHEME',
        ['i32', 'i32', 'i32'],
        ['i32'],
        (t, _u, out) => {
          const dark = cb(t)?.colorScheme?.();
          if (dark === undefined) return 0;
          this.dv().setInt32(out, this.enumValue('GhosttyColorScheme', dark ? 'DARK' : 'LIGHT'), true);
          return 1;
        },
      ],
      ['SIZE', ['i32', 'i32', 'i32'], ['i32'], (t, _u, out) => (cb(t)?.size?.(out) ? 1 : 0)],
      ['RENDER_HOLD', ['i32', 'i32', 'i32'], [], (t, _u, held) => cb(t)?.renderHold?.(held !== 0)],
    ];
    const fns = trampolines(defs.map(([, params, results, fn]) => ({ params, results, fn })));
    const table = this.x.__indirect_function_table;
    const base = table.grow(fns.length);
    defs.forEach(([opt], i) => {
      table.set(base + i, fns[i] as WebAssembly.ExportValue & ((...a: unknown[]) => unknown));
      this.callbackIndex[opt] = base + i;
    });
  }

  /** A function pointer of the library (a reply function it hands out). */
  call(index: number, ...args: number[]): unknown {
    const f = this.x.__indirect_function_table.get(index) as ((...a: number[]) => unknown) | null;
    return f?.(...args);
  }
}

let loading: Promise<Vt> | undefined;

/** Loads the library once (the page's copy). */
export function loadVt(): Promise<Vt> {
  loading ??= (async () => {
    const bytes = () => fetch(wasmUrl).then((r) => r.arrayBuffer());
    let instance: WebAssembly.Instance;
    try {
      instance = (await WebAssembly.instantiateStreaming(fetch(wasmUrl), {})).instance;
    } catch {
      // A server without the wasm media type, or no streaming compile.
      instance = (await WebAssembly.instantiate(await bytes(), {})).instance;
    }
    return new Vt(instance);
  })();
  loading.catch(() => (loading = undefined));
  return loading;
}

let ready: Vt | undefined;
void (typeof window !== 'undefined' && typeof WebAssembly !== 'undefined'
  ? loadVt().then(
      (vt) => (ready = vt),
      () => {},
    )
  : undefined);

/** The library when it has loaded, else undefined. */
export function loadedVt(): Vt | undefined {
  return ready;
}

/** The library from its bytes (tests, Node). */
export function vtFromBytes(bytes: BufferSource): Vt {
  return new Vt(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
}

// A WebSocket over a MessagePort: what a channel of the desktop app to its
// core (DesktopChannels in ../shell.ts) is to code that would open a
// WebSocket. transport.ts makes them for the web UI; the desktop app's
// preload installs the same into VS Code's frames in place of WebSocket
// for the core's own address. The preload hands this function to
// contextBridge.executeInMainWorld, which runs its source in the page:
// it references nothing outside its body (its constants are written out;
// the tests check them against shell.ts and the bridge,
// backend/hosts/electron/bridge.ts, whose frames it speaks).

/** What installPortSocket gives the web UI: WebSocket's constructor. */
export type PortSocketClass = new (url: string | URL, protocols?: string | string[]) => WebSocket;

/** Installs the PortSocket of this window once desktopChannels is there
 * (undefined otherwise). replace puts it in place of WebSocket for
 * ws(s) URLs of the page's own host (VS Code's frames) and returns
 * nothing; otherwise it returns the class. */
export function installPortSocket(replace: boolean): PortSocketClass | undefined {
  /** CHANNEL_PORT of shell.ts. */
  const KEY = 'desktopChannelPort';
  /** The bridge's ACK_BYTES and ABNORMAL. */
  const ACK_BYTES = 65536;
  const ABNORMAL = 1006;
  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;

  type Channels = { open(path: string, protocols: string[]): string };
  const g = globalThis as unknown as typeof globalThis & { desktopChannels?: Channels };
  const channels = g.desktopChannels;
  if (!channels) return undefined;
  const Native = g.WebSocket;
  const pending = new Map<string, PortSocket>();

  g.addEventListener(
    'message',
    (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      if (ev.origin !== g.location.origin || typeof d !== 'object' || d === null || typeof d[KEY] !== 'string') return;
      const s = pending.get(d[KEY] as string);
      if (!s) return;
      ev.stopImmediatePropagation();
      pending.delete(d[KEY] as string);
      if (ev.ports[0]) s._attach(ev.ports[0]);
      else s._ended(ABNORMAL, '', false);
    },
    true,
  );

  type Handler = ((this: PortSocket, ev: Event) => unknown) | null;

  class PortSocket extends EventTarget {
    readonly url: string;
    readyState: number;
    binaryType: BinaryType;
    readonly bufferedAmount: number;
    readonly extensions: string;
    protocol: string;
    onopen: Handler;
    onmessage: Handler;
    onerror: Handler;
    onclose: Handler;
    _port: MessagePort | null;
    _unacked: number;
    _ackTimer: ReturnType<typeof setTimeout> | undefined;
    _closing: { code: number; reason: string } | null;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const u = new URL(String(url), g.location.href);
      this.url = u.href;
      this.readyState = CONNECTING;
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.extensions = '';
      this.protocol = '';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._port = null;
      this._unacked = 0;
      this._ackTimer = undefined;
      this._closing = null;
      const list = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
      pending.set(channels!.open(u.pathname + u.search, list.map(String)), this);
    }

    get CONNECTING() {
      return CONNECTING;
    }
    get OPEN() {
      return OPEN;
    }
    get CLOSING() {
      return CLOSING;
    }
    get CLOSED() {
      return CLOSED;
    }

    _fire(ev: Event): void {
      const h = (this as unknown as Record<string, Handler>)['on' + ev.type];
      if (typeof h === 'function') {
        try {
          h.call(this, ev);
        } catch (e) {
          setTimeout(() => {
            throw e;
          });
        }
      }
      this.dispatchEvent(ev);
    }

    _attach(port: MessagePort): void {
      this._port = port;
      port.addEventListener('close', () => this._ended(ABNORMAL, '', false));
      port.onmessage = (e) => this._receive(e.data);
      if (this._closing) port.postMessage({ t: 'close', code: this._closing.code, reason: this._closing.reason });
    }

    _receive(d: unknown): void {
      if (this.readyState === CLOSED) return;
      if (typeof d === 'string' || d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {
        let data: string | ArrayBuffer | Blob;
        if (typeof d === 'string') data = d;
        else {
          const v = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
          const ab = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? (v.buffer as ArrayBuffer) : v.slice().buffer;
          data = this.binaryType === 'arraybuffer' ? ab : new Blob([ab]);
        }
        this._unacked += typeof d === 'string' ? d.length : d.byteLength;
        if (this._unacked >= ACK_BYTES) this._ack();
        else if (this._ackTimer === undefined) this._ackTimer = setTimeout(() => this._ack(), 0);
        this._fire(new MessageEvent('message', { data, origin: g.location.origin }));
        return;
      }
      const m = d as { t?: unknown; code?: unknown; reason?: unknown; protocol?: unknown } | null;
      if (m?.t === 'open' && this.readyState === CONNECTING) {
        this.readyState = OPEN;
        this.protocol = typeof m.protocol === 'string' ? m.protocol : '';
        this._fire(new Event('open'));
      } else if (m?.t === 'close') {
        const code = typeof m.code === 'number' ? m.code : 1005;
        this._ended(code, typeof m.reason === 'string' ? m.reason : '', code !== ABNORMAL);
      }
    }

    _ack(): void {
      clearTimeout(this._ackTimer);
      this._ackTimer = undefined;
      if (this._unacked > 0 && this._port && this.readyState !== CLOSED) this._port.postMessage({ t: 'ack', n: this._unacked });
      this._unacked = 0;
    }

    _ended(code: number, reason: string, clean: boolean): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      clearTimeout(this._ackTimer);
      if (!clean) this._fire(new Event('error'));
      this._fire(new CloseEvent('close', { code, reason, wasClean: clean }));
      this._port?.close();
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState === CONNECTING)
        throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      const port = this._port;
      if (this.readyState !== OPEN || !port) return;
      if (typeof data === 'string' || data instanceof ArrayBuffer) port.postMessage(data);
      else if (ArrayBuffer.isView(data)) port.postMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer);
      else if (data instanceof Blob) void data.arrayBuffer().then((ab) => this.readyState === OPEN && port.postMessage(ab));
      else port.postMessage(String(data));
    }

    close(code?: number, reason?: string): void {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      this._closing = { code: code ?? 1000, reason: reason ?? '' };
      this._port?.postMessage({ t: 'close', code: this._closing.code, reason: this._closing.reason });
    }
  }
  for (const [k, v] of [
    ['CONNECTING', CONNECTING],
    ['OPEN', OPEN],
    ['CLOSING', CLOSING],
    ['CLOSED', CLOSED],
  ] as const)
    Object.defineProperty(PortSocket, k, { value: v });

  if (!replace) return PortSocket as unknown as PortSocketClass;

  // VS Code's frames: WebSockets to the page's own host are channels; any
  // other address is a WebSocket of the network.
  function WebSocket(this: unknown, url: string | URL, protocols?: string | string[]): unknown {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
    let u: URL;
    try {
      u = new URL(String(url), g.location.href);
    } catch {
      return new Native(url, protocols);
    }
    if ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === g.location.host) return new PortSocket(u.href, protocols);
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  }
  WebSocket.prototype = PortSocket.prototype;
  for (const [k, v] of [
    ['CONNECTING', CONNECTING],
    ['OPEN', OPEN],
    ['CLOSING', CLOSING],
    ['CLOSED', CLOSED],
  ] as const)
    Object.defineProperty(WebSocket, k, { value: v });
  g.WebSocket = WebSocket as unknown as typeof Native;
  return undefined;
}

// Channels to the core (lib/transport.ts): a WebSocket in a browser; in the
// desktop app a PortSocket (lib/portSocket.ts) over the MessagePort the
// shell hands the page, speaking the bridge's frames with the core's side
// of it (backend/hosts/electron/bridge.ts serveChannel, run here as the
// core's utility process runs it). And uploads, which the desktop app
// streams with fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACK_BYTES, ABNORMAL, serveChannel, type HubChannel, type Port, type Upgrade } from '../../../backend/hosts/electron/bridge';
import { CHANNEL_PORT } from '../shell';
import { installPortSocket } from '../lib/portSocket';

const ORIGIN = 'https://app.localhost';

/** The bridge's view of a MessagePort of this runtime. */
function port(p: MessagePort): Port {
  return {
    post: (m) => p.postMessage(m),
    listen(message, closed) {
      let done = false;
      p.onmessage = (e) => message(e.data);
      p.addEventListener('close', () => {
        if (done) return;
        done = true;
        closed();
      });
    },
    close: () => p.close(),
  };
}

/** What the core does with a channel in these tests. */
type Behavior = (req: Request, upgrade: Upgrade) => Promise<Response>;

/** The page's window, the shell's channels and the core behind them. */
function desktop(behave: Behavior) {
  const win = new EventTarget();
  const opened: Array<{ path: string; protocols: string[]; core: MessagePort }> = [];
  let n = 0;
  vi.stubGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/`, host: 'app.localhost', protocol: 'https:' });
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
  vi.stubGlobal('desktopChannels', {
    open(path: string, protocols: string[]) {
      const id = `channel-${++n}`;
      const { port1, port2 } = new MessageChannel();
      opened.push({ path, protocols, core: port1 });
      void serveChannel(port(port1), { url: ORIGIN + path, headers: [] }, behave);
      // The port comes later, as a message to the window.
      setTimeout(() => win.dispatchEvent(new MessageEvent('message', { data: { [CHANNEL_PORT]: id }, origin: ORIGIN, ports: [port2] })), 1);
      return id;
    },
  });
  return { opened };
}

/** A core that echoes on its channel and records what it sees. */
function echoing() {
  const seen = { closes: [] as Array<[number, string]>, channel: undefined as HubChannel | undefined, messages: [] as unknown[] };
  const behave: Behavior = async (req, upgrade) => {
    if (new URL(req.url).pathname === '/nothing') return Response.json({ error: 'not_found' }, { status: 404 });
    return upgrade((ch) => {
      seen.channel = ch;
      return {
        message: (d) => {
          seen.messages.push(d);
          if (d === 'big') ch.send(new Uint8Array(ACK_BYTES + 1));
          else ch.send(d);
        },
        close: (code, reason) => seen.closes.push([code, reason]),
      };
    });
  };
  return { seen, behave };
}

const until = (ok: () => boolean) => vi.waitFor(() => expect(ok()).toBe(true), { timeout: 2000, interval: 2 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('openChannel', () => {
  it('is a WebSocket to the page’s own host in a browser', async () => {
    const urls: string[] = [];
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:7780', host: '127.0.0.1:7780', protocol: 'http:' });
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          urls.push(url);
        }
      },
    );
    const { openChannel, viaDesktop } = await import('../lib/transport');
    expect(viaDesktop).toBe(false);
    openChannel('/api/v1/term');
    vi.stubGlobal('location', { origin: 'https://ui.example', host: 'ui.example', protocol: 'https:' });
    openChannel('/m/a%20b/gui/3/ws?video=vp8');
    expect(urls).toEqual(['ws://127.0.0.1:7780/api/v1/term', 'wss://ui.example/m/a%20b/gui/3/ws?video=vp8']);
  });

  it('is a channel of the shell in the desktop app: open, text and bytes both ways, close', async () => {
    const core = echoing();
    const { opened } = desktop(core.behave);
    const { openChannel, viaDesktop } = await import('../lib/transport');
    expect(viaDesktop).toBe(true);
    const ws = openChannel('/ws?x=1');
    expect(opened[0].path).toBe('/ws?x=1');
    expect(ws.readyState).toBe(WebSocket.CONNECTING);
    expect(() => ws.send('early')).toThrow();
    const events: string[] = [];
    const got: unknown[] = [];
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => events.push('open');
    ws.onmessage = (e) => got.push(e.data);
    ws.onclose = (e) => events.push(`close ${e.code} ${e.reason} ${e.wasClean}`);
    await until(() => events.includes('open'));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send('hello');
    ws.send(new Uint8Array([9, 8, 7]).subarray(1));
    await until(() => got.length === 2);
    expect(got[0]).toBe('hello');
    expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([8, 7]);
    expect(core.seen.messages[1]).toEqual(new Uint8Array([8, 7]));
    ws.close(1000, 'bye');
    expect(ws.readyState).toBe(WebSocket.CLOSING);
    await until(() => events.length === 2);
    expect(events[1]).toBe('close 1000 bye true');
    expect(core.seen.closes).toEqual([[1000, 'bye']]);
  });

  it('acks what it took in, so the core sees nothing buffered', async () => {
    const core = echoing();
    desktop(core.behave);
    const { openChannel } = await import('../lib/transport');
    const ws = openChannel('/ws');
    const got: unknown[] = [];
    ws.onmessage = (e) => got.push(e.data);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send('big');
    await until(() => got.length === 1);
    expect(got[0]).toBeInstanceOf(Blob);
    // Over ACK_BYTES: acked at once.
    await until(() => core.seen.channel!.buffered === 0);
    ws.send('small');
    await until(() => got.length === 2);
    await until(() => core.seen.channel!.buffered === 0);
  });

  it('a channel the core refuses, or one whose core goes away, fails as a WebSocket does', async () => {
    const core = echoing();
    const { opened } = desktop(core.behave);
    const { openChannel } = await import('../lib/transport');
    const refused = openChannel('/nothing');
    const events: string[] = [];
    refused.onerror = () => events.push('error');
    refused.onclose = (e) => events.push(`close ${e.code} ${e.reason} ${e.wasClean}`);
    await until(() => events.length === 2);
    expect(events).toEqual(['error', `close ${ABNORMAL} refused 404 not_found false`]);

    const lost = openChannel('/ws');
    const ends: number[] = [];
    lost.onclose = (e) => ends.push(e.code);
    await new Promise<void>((r) => (lost.onopen = () => r()));
    opened[1].core.close();
    await until(() => ends.length === 1);
    expect(ends).toEqual([ABNORMAL]);
    expect(core.seen.closes).toEqual([[ABNORMAL, '']]);
  });

  it("in VS Code's frames it stands in for WebSocket, for the page's own host only", async () => {
    const core = echoing();
    desktop(core.behave);
    const native: string[] = [];
    class Native {
      constructor(url: string) {
        native.push(url);
      }
    }
    vi.stubGlobal('WebSocket', Native);
    expect(installPortSocket(true)).toBeUndefined();
    const Shim = globalThis.WebSocket;
    expect(Shim).not.toBe(Native);
    expect(Shim.OPEN).toBe(1);
    const ws = new Shim('wss://app.localhost/m/local/code/stable-1?reconnectionToken=t');
    expect(ws).toBeInstanceOf(Shim);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    new Shim('wss://open-vsx.org/socket');
    expect(native).toEqual(['wss://open-vsx.org/socket']);
  });

  it('runs from its own source alone, as the preload hands it to the page', () => {
    const core = echoing();
    desktop(core.behave);
    const again = new Function(`return (${installPortSocket.toString()})`)() as typeof installPortSocket;
    expect(typeof again(false)).toBe('function');
  });
});

describe('uploads in the desktop app', () => {
  beforeEach(() => {
    desktop(echoing().behave);
  });

  it('stream the body with fetch, reporting what the shell pulled', async () => {
    const bodies: Uint8Array[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit & { duplex?: string }) => {
      expect(url).toBe('/api/m/local/upload?name=a.bin&dir=%2Ftmp');
      expect(init.duplex).toBe('half');
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bodies.push(value);
      }
      return Response.json({ name: 'a.bin', size: 300_000 });
    });
    const { uploadFile } = await import('../lib/files');
    const progress: number[] = [];
    let sent = false;
    const st = await uploadFile('local', 'a.bin', new Blob([new Uint8Array(300_000)]), '/tmp', {
      onProgress: (n) => progress.push(n),
      onSent: () => (sent = true),
    });
    expect(st).toEqual({ name: 'a.bin', size: 300_000 });
    expect(bodies.reduce((n, b) => n + b.byteLength, 0)).toBe(300_000);
    expect(progress.at(-1)).toBe(300_000);
    expect(sent).toBe(true);
  });

  it('fail with the answer, are cancelled by their signal, and lose their connection', async () => {
    const { uploadFile, UploadCancelled, UploadDisconnected } = await import('../lib/files');
    vi.stubGlobal('fetch', async () => Response.json({ error: 'too_large' }, { status: 413 }));
    await expect(uploadFile('local', 'a', new Blob(['x']))).rejects.toThrow('too_large');
    const cancel = new AbortController();
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => {
      cancel.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError')).finally(() => expect(init.signal?.aborted).toBe(true));
    });
    await expect(uploadFile('local', 'a', new Blob(['x']), undefined, { signal: cancel.signal })).rejects.toBeInstanceOf(UploadCancelled);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('failed')));
    await expect(uploadFile('local', 'a', new Blob(['x']))).rejects.toBeInstanceOf(UploadDisconnected);
  });
});

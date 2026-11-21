// What the shell takes from its core: the keybindings in effect on its
// platform (for the menu), the theme, the language and the zoom. It is a client of the event channel like the page: once /ws is
// open it reads GET /api/keybindings and GET /api/settings, then applies the
// "keybindings" and "settings" messages the core sends after every change.
// The core is the shell's own child; the channel is opened again if it drops.

import type { Binding } from './menu';

export interface ShellSettings {
  /** appearance.theme: Electron's nativeTheme.themeSource. */
  theme: 'system' | 'light' | 'dark';
  /** appearance.language: "auto", "en", "zh-CN"… */
  language: string;
  /** window.zoom as a zoom factor (1 is 100%), within Chromium's 0.25 to 5. */
  zoom: number;
  /** appearance.uiFontSize in CSS pixels (11–20, default 13), used on macOS to
   * keep the traffic lights vertically centered in the header row. */
  uiFontSize: number;
}

/** The bindings in effect on platform in a /api/keybindings reply or a
 * "keybindings" message; undefined for one without them. */
export function bindingsOf(reply: unknown, platform: string): Binding[] | undefined {
  const list = (reply as { effective?: Record<string, unknown> } | null)?.effective?.[platform];
  if (!Array.isArray(list)) return;
  return list.filter(
    (b): b is Binding =>
      typeof b?.key === 'string' && typeof b?.when === 'string' && typeof b?.command === 'string' && /^[A-Za-z0-9_.:-]+$/.test(b.command),
  );
}

/** The settings the shell uses from a /api/settings reply or a "settings"
 * message; undefined for one without values. */
export function settingsOf(reply: unknown): ShellSettings | undefined {
  const values = (reply as { values?: Record<string, { value?: unknown } | undefined> } | null)?.values;
  if (!values || typeof values !== 'object') return;
  const theme = values['appearance.theme']?.value;
  const language = values['appearance.language']?.value;
  const zoom = values['window.zoom']?.value;
  const fontSize = values['appearance.uiFontSize']?.value;
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    language: typeof language === 'string' ? language : 'auto',
    zoom: typeof zoom === 'number' && zoom >= 25 && zoom <= 500 ? zoom / 100 : 1,
    uiFontSize: typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize >= 11 && fontSize <= 20 ? fontSize : 13,
  };
}

export interface Follower {
  bindings(b: Binding[]): void;
  settings(s: ShellSettings): void;
}

/** What followCore uses of the platform (stand-ins in tests). */
export interface Net {
  WebSocket: new (url: string) => {
    onopen: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    close(): void;
  };
  fetch: (url: URL) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/** Follows the core at origin; returns a function that stops it. */
export function followCore(origin: string, platform: string, on: Follower, net: Net = globalThis as unknown as Net): () => void {
  let stopped = false;
  let socket: InstanceType<Net['WebSocket']> | undefined;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (path: string, apply: (reply: unknown) => void) => {
    try {
      const r = await net.fetch(new URL(path, origin));
      if (r.ok && !stopped) apply(await r.json());
    } catch (error) {
      console.error(error);
    }
  };
  const keys = (reply: unknown) => {
    const b = bindingsOf(reply, platform);
    if (b) on.bindings(b);
  };
  const values = (reply: unknown) => {
    const s = settingsOf(reply);
    if (s) on.settings(s);
  };
  const connect = () => {
    const ws = new net.WebSocket(new URL('/ws', origin).href.replace(/^http/, 'ws'));
    socket = ws;
    ws.onopen = () => {
      delay = 500;
      void read('/api/settings', values);
      void read('/api/keybindings', keys);
    };
    ws.onmessage = (ev) => {
      let m: { t?: unknown };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m?.t === 'keybindings') keys(m);
      else if (m?.t === 'settings') values(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}

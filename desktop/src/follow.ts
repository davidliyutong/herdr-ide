// What the shell takes from its hub: the keybindings in effect on its
// platform (for the menu), the theme, the language and the zoom. It is a
// client of the event channel like the page: once /ws is open it reads GET
// /api/keybindings and GET /api/settings, then applies the "keybindings" and
// "settings" messages the hub sends after every change. The hub is the
// shell's own utility process, reached directly (hub.ts), not over a
// network; the channel is opened again if it drops (the hub restarted).

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

/** What followHub uses of the hub (hub.ts HubHost; stand-ins in
 * tests). */
export interface HubLink {
  fetch(path: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
  channel(path: string, on: { open(): void; message(data: string | Uint8Array): void; close(): void }): { close(): void };
}

/** Follows the hub; returns a function that stops it. */
export function followHub(hub: HubLink, platform: string, on: Follower): () => void {
  let stopped = false;
  let channel: { close(): void } | undefined;
  let delay = 500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (path: string, apply: (reply: unknown) => void) => {
    try {
      const r = await hub.fetch(path);
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
    channel = hub.channel('/ws', {
      open() {
        delay = 500;
        void read('/api/settings', values);
        void read('/api/keybindings', keys);
      },
      message(data) {
        if (typeof data !== 'string') return;
        let m: { t?: unknown };
        try {
          m = JSON.parse(data);
        } catch {
          return;
        }
        if (m?.t === 'keybindings') keys(m);
        else if (m?.t === 'settings') values(m);
      },
      close() {
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 8000);
      },
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    channel?.close();
  };
}

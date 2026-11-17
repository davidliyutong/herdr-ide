// The browser plugin's requests to the core (internal/plugins/browser): port
// forwards, and the machine's listening ports; and the rules for addresses:
// what the address field takes, and where a page is loaded from.
import { create } from 'zustand';
import { hasMessage, t } from '../../i18n';
import { actions, current } from '../../actions';
import { useStore } from '../../state/store';
import { desktopShell } from '../../shell';

/** A port of a machine reachable on the core's host: Port on machine M is
 * on the loopback port Local there. */
export interface Forward {
  m: string;
  port: number;
  local: number;
  created: string;
  connections: number;
}

export interface ListeningPort {
  port: number;
  process?: string;
}

/** A failure with the code the core gave (forward_local_only, offline,
 * too_many, local_machine, ...) or `network` when it did not answer. */
export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

async function answer<T>(r: Response): Promise<T> {
  let j: { error?: string; message?: string } = {};
  try {
    j = await r.json();
  } catch {
    /* the status says it */
  }
  if (!r.ok) throw new BrowserError(j.error ?? `http_${r.status}`, j.message ?? r.statusText);
  return j as T;
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new BrowserError('network', e instanceof Error ? e.message : String(e));
  }
  return answer<T>(r);
}

const forwardsUrl = (m: string) => `/api/m/${encodeURIComponent(m)}/p/browser/forwards`;

export const browserApi = {
  forwards: () => send<{ forwards: Forward[]; available: boolean }>('/api/p/browser/forwards', { cache: 'no-store' }),
  /** Makes or finds the forward of a machine's port; it counts as a use. */
  ensure: (m: string, port: number) =>
    send<Forward>(forwardsUrl(m), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    }),
  stop: (m: string, port: number) => send<{ ok: boolean }>(`${forwardsUrl(m)}/${port}`, { method: 'DELETE' }),
  listening: (m: string) =>
    send<{ ports: ListeningPort[] }>(`/api/m/${encodeURIComponent(m)}/p/browser/listening`, { cache: 'no-store' }).then(
      (r) => r.ports ?? [],
    ),
};

/** The forwards the core has and whether this client can use them (it is
 * on the core's own computer); `available` is unknown until the core
 * answers. */
export const useForwards = create<{ forwards: Forward[]; available?: boolean }>(() => ({ forwards: [] }));

let loading: Promise<boolean> | undefined;

/** Reads the forwards again. Resolves to whether forwards are available;
 * false when the core does not answer. */
export function loadForwards(): Promise<boolean> {
  loading ??= browserApi
    .forwards()
    .then(
      (r) => {
        useForwards.setState({ forwards: r.forwards ?? [], available: !!r.available });
        return !!r.available;
      },
      () => false,
    )
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

/** Whether forwards are available to this client: what the core last said,
 * else it is asked. */
export async function forwardsAvailable(): Promise<boolean> {
  return useForwards.getState().available ?? (await loadForwards());
}

/** Records a forward made or found. */
export function noteForward(f: Forward) {
  useForwards.setState((s) => ({ forwards: [...s.forwards.filter((x) => !(x.m === f.m && x.port === f.port)), f] }));
}

/** The text of a failure for the user. */
export function errorText(e: unknown, machine = ''): string {
  if (e instanceof BrowserError) {
    const key = `browser.error.${e.code}`;
    if (hasMessage(key)) return t(key, { machine, error: e.message });
    return t('browser.error.failed', { error: e.message || e.code });
  }
  return t('browser.error.failed', { error: e instanceof Error ? e.message : String(e) });
}

// Addresses.

/** The names of this computer's loopback a page may be on or ask for. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase());

/**
 * The other loopback name of the one the UI's page is on, or undefined on
 * any other host. A cookie ignores ports, so a page of another service on
 * the UI's host name could read the UI's cookies and the reverse: a
 * forwarded page is on the name the UI is not on (the CSP allows frames
 * from these two names only).
 */
export function otherHost(uiHost: string = globalThis.location?.hostname ?? ''): 'localhost' | '127.0.0.1' | undefined {
  const h = uiHost.toLowerCase();
  if (h === '127.0.0.1') return 'localhost';
  if (h === 'localhost') return '127.0.0.1';
  return undefined;
}

/** What the address field made of what was typed. */
export type Parsed =
  | { kind: 'empty' }
  | { kind: 'refused' }
  /** url is complete; loopback: on this computer's loopback (the machine's
   * localhost, in a pane of a machine); port: its port (80 and 443 by
   * default). */
  | { kind: 'page'; url: string; loopback: boolean; port: number };

/** Schemes that are not addresses of pages, however typed. */
const REFUSED = /^(?:javascript|data|file|blob|about|vbscript|view-source|chrome|ftp|ws|wss|mailto|tel|sms):/i;

/**
 * Reads an address as typed: a bare port (`3000`), `localhost:3000/docs`,
 * a host without a scheme (http:// for loopback names, https:// for any
 * other), or a full address; only http and https are taken. A loopback
 * name other than localhost (127.0.0.1, [::1], 0.0.0.0) is written as
 * localhost: for a machine it means that machine's own.
 */
export function parseAddress(input: string): Parsed {
  const s = input.trim();
  if (!s) return { kind: 'empty' };
  if (/^\d{1,5}$/.test(s)) {
    const port = Number(s);
    return port >= 1 && port <= 65535 ? { kind: 'page', url: `http://localhost:${port}/`, loopback: true, port } : { kind: 'refused' };
  }
  if (REFUSED.test(s) || /\s/.test(s)) return { kind: 'refused' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u: URL;
  try {
    if (hasScheme) u = new URL(s);
    else {
      const host = /^(\[[^\]]*\]|[^/:?#]*)/.exec(s)?.[0] ?? '';
      u = new URL(`${isLoopbackHost(host) ? 'http' : 'https'}://${s}`);
    }
  } catch {
    return { kind: 'refused' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'refused' };
  if (!u.hostname) return { kind: 'refused' };
  const loopback = isLoopbackHost(u.hostname);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (loopback && u.hostname !== 'localhost') u.hostname = 'localhost';
  return { kind: 'page', url: u.href, loopback, port };
}

/** The part of an address after its host and port. */
function rest(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The address a frame loads for a page of a machine's port shown through
 * the forward on local port `local`: on the other loopback name than the
 * UI's, over http (the CSP allows no more). Undefined on any other host. */
export function forwardedSrc(url: string, local: number, uiHost?: string): string | undefined {
  const host = otherHost(uiHost);
  if (!host) return undefined;
  try {
    return `http://${host}:${local}${rest(new URL(url))}`;
  } catch {
    return undefined;
  }
}

/** The address a frame loads for a loopback page of this computer (no
 * forward): the same port on the other loopback name than the UI's. */
export function loopbackSrc(url: string, uiHost?: string): string | undefined {
  const host = otherHost(uiHost);
  if (!host) return undefined;
  try {
    const u = new URL(url);
    return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${rest(u)}`;
  } catch {
    return undefined;
  }
}

/** The address as the user means it for a real one the frame is at: through
 * the forward of a machine's port (view.port on local), its own port;
 * undefined for a real address that is not on that forward. */
export function meantUrl(real: string, port: number, local: number): string | undefined {
  try {
    const u = new URL(real);
    if (!isLoopbackHost(u.hostname) || Number(u.port) !== local) return undefined;
    return `http://localhost:${port}${rest(u)}`;
  } catch {
    return undefined;
  }
}

/** Where a page may be shown: in the frame, or only outside the app. A
 * browser frames loopback addresses only (the page's CSP); the desktop
 * app's webview takes any http or https address. */
export function canFrame(url: string): boolean {
  const p = parseAddress(url);
  return p.kind === 'page' && (p.loopback || !!desktopShell?.browser);
}

/** The host and port of an address, for a title. */
export function hostPort(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The view fields of the page at an address in a pane of machine m: on a
 * remote machine a loopback address is that machine's port (shown through
 * a forward); anywhere else the address is its own. Undefined for what is
 * no address of a page. */
export function pageView(m: string, input: string): { url: string; m?: string; port?: number } | undefined {
  const p = parseAddress(input);
  if (p.kind !== 'page') return undefined;
  const remote = useStore.getState().machines[m]?.kind === 'ssh';
  if (!p.loopback || !remote) return { url: p.url };
  // The forward carries bytes: the page loads over http (the frame's CSP).
  return { url: `http://localhost:${p.port}${rest(new URL(p.url))}`, m, port: p.port };
}

/** Opens a browser pane in a new tab of machine m: empty, or at an
 * address (see pageView). Returns the pane's key. */
export async function openBrowserTab(m: string, input = ''): Promise<string | undefined> {
  const fields = input ? pageView(m, input) : { url: '' };
  if (!fields) return undefined;
  return actions.openView(m, { plugin: 'browser', kind: 'page', ...fields }, { tab: true });
}

/** Opens a popup's address (a webview's) as a browser tab of the machine
 * shown; an address on a forward's local port is that machine's port. */
export async function openPopup(url: string) {
  const m = current()?.m;
  if (!m) return;
  for (const f of useForwards.getState().forwards) {
    const meant = meantUrl(url, f.port, f.local);
    if (meant) return void (await openBrowserTab(f.m, meant));
  }
  await openBrowserTab(m, url);
}

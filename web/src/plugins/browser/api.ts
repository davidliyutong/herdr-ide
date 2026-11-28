// The browser plugin's requests to the hub (backend/features/browser): port
// forwards, and the machine's listening ports; and the rules for addresses:
// what the address field takes, and where a page is loaded from.
import { create } from 'zustand';
import { hasMessage, t } from '../../i18n';
import { actions, current } from '../../actions';
import { useStore } from '../../state/store';
import { desktopShell } from '../../shell';
import { answer, failureOf, jsonInit, PluginError } from '../../lib/pluginApi';
import { isLoopbackName, isOwnAddress } from '../../lib/webUrl';

/** A port of a machine reachable on the hub's host: Port on machine M is
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

/** A failure with the code the hub gave (forward_local_only, offline,
 * too_many, local_machine, ...) or `network` when it did not answer. */
export class BrowserError extends PluginError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'BrowserError';
  }
}

const failure = failureOf((code, message) => new BrowserError(code, message));

const isAbortError = (e: unknown, signal?: AbortSignal | null): boolean =>
  !!signal?.aborted || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError');

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    if (isAbortError(e, init?.signal)) throw e;
    throw new BrowserError('network', e instanceof Error ? e.message : String(e));
  }
  return answer<T>(r, failure);
}

const forwardsUrl = (m: string) => `/api/m/${encodeURIComponent(m)}/p/browser/forwards`;

export const browserApi = {
  forwards: () => send<{ forwards: Forward[]; available: boolean }>('/api/p/browser/forwards', { cache: 'no-store' }),
  /** Makes or finds the forward of a machine's port; it counts as a use. */
  ensure: (m: string, port: number) => send<Forward>(forwardsUrl(m), jsonInit('POST', { port })),
  stop: (m: string, port: number) => send<{ ok: boolean }>(`${forwardsUrl(m)}/${port}`, { method: 'DELETE' }),
  listening: (m: string, signal?: AbortSignal) =>
    send<{ ports: ListeningPort[] }>(
      `/api/m/${encodeURIComponent(m)}/p/browser/listening`,
      signal ? { cache: 'no-store', signal } : { cache: 'no-store' },
    ).then((r) => r.ports ?? []),
};

/** The forwards the hub has and whether this client can use them (it is
 * on the hub's own computer); `available` is unknown until the hub
 * answers. */
export const useForwards = create<{ forwards: Forward[]; available?: boolean }>(() => ({ forwards: [] }));

let loading: Promise<boolean> | undefined;

/** Reads the forwards again. Resolves to whether forwards are available;
 * false when the hub does not answer. */
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

/** Whether forwards are available to this client: what the hub last said,
 * else it is asked. */
export async function forwardsAvailable(): Promise<boolean> {
  return useForwards.getState().available ?? (await loadForwards());
}

/** Records a forward made or found. */
export function noteForward(f: Forward) {
  useForwards.setState((s) => ({ forwards: [...s.forwards.filter((x) => !(x.m === f.m && x.port === f.port)), f] }));
}

// Which forwards this page may make. A forward leads into a machine, so it
// is made only for a port the user asked for in this page: typed into a
// pane's address field or chosen in its Ports, a link Cmd/Ctrl-clicked in
// a terminal, or confirmed in a pane that asked (Forward and open). A view
// found in the layout, which every client and every script of the page
// writes, a popup of a page shown in a pane and a link clicked in a
// document (its text may hide where it leads) are no such request: for
// those a pane uses a forward that exists, or asks.

const granted = new Set<string>();
const grantKey = (m: string, port: number) => `${m}|${port}`;

/** The user asked, in this page, for the port of machine m: its forward
 * may be made, and made again when it ended, until the page is left. */
export function grantForward(m: string, port: number) {
  granted.add(grantKey(m, port));
}

/** Whether the user asked for the port of machine m in this page. */
export function forwardGranted(m: string, port: number): boolean {
  return granted.has(grantKey(m, port));
}

/** The user stopped the forward: a pane that shows the port asks before
 * it is made again. */
export function revokeForward(m: string, port: number) {
  granted.delete(grantKey(m, port));
}

/** Forgets what the user asked for (tests). */
export function resetGrants() {
  granted.clear();
}

/**
 * The forward of a machine's port for a pane that shows it, a use of it:
 * made or found when the user asked for the port in this page
 * (forwardGranted); else only found, when the hub's list has it, and
 * undefined when it has not: the pane asks the user. Fails as the hub's
 * requests do, and with forward_local_only, without asking for a forward,
 * when the hub says this client can use none.
 */
export async function attachForward(m: string, port: number): Promise<Forward | undefined> {
  if (!forwardGranted(m, port)) {
    const r = await browserApi.forwards();
    const forwards = r.forwards ?? [];
    useForwards.setState({ forwards, available: !!r.available });
    if (!r.available) throw new BrowserError('forward_local_only', '');
    if (!forwards.some((f) => f.m === m && f.port === port)) return undefined;
  }
  const f = await browserApi.ensure(m, port);
  noteForward(f);
  return f;
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

/** A name below localhost (app.localhost), which browsers resolve to the
 * loopback of the computer they run on. */
const belowLocalhost = (host: string): boolean => host.toLowerCase().endsWith('.localhost');

/**
 * The loopback name a browser pane loads a forwarded or local service from,
 * or undefined when the UI cannot safely frame one. In a browser, cookies
 * ignore ports, so a page on the UI's host name would share its cookies: a
 * forwarded page loads from the other loopback name (the CSP allows frames
 * from these two names only). The desktop app renders panes in an isolated
 * <webview> partition (persist:browser) and serves the UI from
 * https://<slug>.localhost, so localhost is always safe and preferred.
 */
export function otherHost(
  uiHost: string = globalThis.location?.hostname ?? '',
  webview: boolean = !!desktopShell?.browser,
): 'localhost' | '127.0.0.1' | undefined {
  if (webview) return 'localhost';
  const h = uiHost.toLowerCase();
  if (h === '127.0.0.1') return 'localhost';
  if (h === 'localhost') return '127.0.0.1';
  return undefined;
}

/** What the address field made of what was typed. */
export type Parsed =
  | { kind: 'empty' }
  /** own: the address is the app's own (isOwnAddress), which a pane does
   * not show; else it is no http(s) address of a page. */
  | { kind: 'refused'; own?: true }
  /** url is complete; loopback: on this computer's loopback (the machine's
   * localhost, in a pane of a machine); port: its port (80 and 443 by
   * default). */
  | { kind: 'page'; url: string; loopback: boolean; port: number };

/** Schemes that are not addresses of pages, however typed. */
const REFUSED = /^(?:javascript|data|file|blob|about|vbscript|view-source|chrome|ftp|ws|wss|mailto|tel|sms):/i;

/**
 * Reads an address as typed: a bare port (`3000`), `localhost:3000/docs`,
 * a host without a scheme (http:// for loopback names and the names below
 * localhost, https:// for any other), or a full address; only http and
 * https are taken. A loopback name other than localhost (127.0.0.1, [::1],
 * 0.0.0.0) is written as localhost: for a machine it means that machine's
 * own. The hub's own address, under any loopback name, is no page for a
 * pane (isOwnAddress): the UI is not shown inside itself, where a page of a
 * pane could send it. With theirs the address is a machine's own (a pane of
 * a remote machine, a view shown through a forward): its loopback is that
 * machine's, where the hub's port number is some other program's, and a
 * name below localhost (app.localhost) is that loopback too. Of this
 * computer such a name stays as written, a page a webview loads itself.
 */
export function parseAddress(input: string, theirs = false): Parsed {
  const s = input.trim();
  if (!s) return { kind: 'empty' };
  if (/^\d{1,5}$/.test(s)) {
    const port = Number(s);
    if (port < 1 || port > 65535) return { kind: 'refused' };
    const url = `http://localhost:${port}/`;
    return !theirs && isOwnAddress(new URL(url)) ? { kind: 'refused', own: true } : { kind: 'page', url, loopback: true, port };
  }
  if (REFUSED.test(s) || /\s/.test(s)) return { kind: 'refused' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u: URL;
  try {
    if (hasScheme) u = new URL(s);
    else {
      const host = /^(\[[^\]]*\]|[^/:?#]*)/.exec(s)?.[0] ?? '';
      u = new URL(`${isLoopbackHost(host) || belowLocalhost(host) ? 'http' : 'https'}://${s}`);
    }
  } catch {
    return { kind: 'refused' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'refused' };
  if (!u.hostname) return { kind: 'refused' };
  const loopback = isLoopbackHost(u.hostname) || (theirs && belowLocalhost(u.hostname));
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (loopback && u.hostname !== 'localhost') u.hostname = 'localhost';
  // As it is written now: 0.0.0.0 with the hub's port is the hub too. A
  // machine's own loopback is another computer's, whatever its port.
  if (!(theirs && loopback) && isOwnAddress(u)) return { kind: 'refused', own: true };
  return { kind: 'page', url: u.href, loopback, port };
}

/** The part of an address after its host and port. */
function rest(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The address a frame loads for a page of a machine's port shown through
 * the forward on local port `local`: on the other loopback name than the
 * UI's in a browser (the CSP allows no more), or localhost in the desktop
 * app's isolated webview partition. Undefined on any other host. */
export function forwardedSrc(url: string, local: number, uiHost?: string, webview?: boolean): string | undefined {
  const host = otherHost(uiHost, webview);
  if (!host) return undefined;
  try {
    return `http://${host}:${local}${rest(new URL(url))}`;
  } catch {
    return undefined;
  }
}

/** The address a frame loads for a loopback page of this computer (no
 * forward): the same port on the other loopback name than the UI's in a
 * browser, or localhost in the desktop app. */
export function loopbackSrc(url: string, uiHost?: string, webview?: boolean): string | undefined {
  const host = otherHost(uiHost, webview);
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
export function canFrame(url: string, theirs = false): boolean {
  const p = parseAddress(url, theirs);
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

/** Whether m is a machine reached over ssh: its loopback is its own, and a
 * pane shows it through a forward. */
export function isRemote(m: string): boolean {
  return useStore.getState().machines[m]?.kind === 'ssh';
}

/** The view fields of the page at an address in a pane of machine m: on a
 * remote machine a loopback address is that machine's port (shown through
 * a forward); anywhere else the address is its own. Undefined for what is
 * no address of a page. */
export function pageView(m: string, input: string): { url: string; m?: string; port?: number } | undefined {
  const remote = isRemote(m);
  const p = parseAddress(input, remote);
  if (p.kind !== 'page') return undefined;
  if (!p.loopback || !remote) return { url: p.url };
  // The forward carries bytes: the page loads over http (the frame's CSP).
  return { url: `http://localhost:${p.port}${rest(new URL(p.url))}`, m, port: p.port };
}

/** browser.openLinks: loopback addresses in a pane (the default), every
 * address a pane can show, or every address outside the app. */
export type LinkMode = 'loopback' | 'all' | 'external';

/** The mode a setting's value names; any other value (none, or one of an
 * earlier version) is the default. */
export const linkMode = (v: unknown): LinkMode => (v === 'all' || v === 'external' ? v : 'loopback');

/**
 * Where a web address the user clicked in a text of machine m (a
 * terminal's output, a document) opens: `pane`, a browser pane in a new
 * tab; `forward`, a pane of m's port, when this client can use forwards
 * (else outside); `outside`, the browser outside the app (the system's, in
 * the desktop app). An address of a computer's loopback opens in a pane: a
 * remote machine's through its forward, this computer's when the UI is on a
 * loopback host (one with a name below localhost in the desktop app only,
 * whose webview loads it as written). Any other address, another
 * computer's, opens outside; with `all`, in a pane where one shows it (the
 * desktop app's webview shows any).
 */
export function linkPlace(m: string, url: string, mode: LinkMode): 'pane' | 'forward' | 'outside' {
  if (mode === 'external') return 'outside';
  const remote = isRemote(m);
  const p = parseAddress(url, remote);
  if (p.kind !== 'page') return 'outside';
  const webview = !!desktopShell?.browser;
  if (p.loopback) return remote ? 'forward' : otherHost() ? 'pane' : 'outside';
  if (isLoopbackName(new URL(p.url).hostname)) return !remote && webview ? 'pane' : 'outside';
  return mode === 'all' && webview ? 'pane' : 'outside';
}

/** Opens a browser pane in a new tab of machine m: empty, or at an
 * address (see pageView). Its callers act for the user (a link
 * Cmd/Ctrl-clicked in a terminal, whose tooltip names it, the new-tab
 * menu, a command), so a port of the machine it leads to is one the user
 * asked for. With ask, the address is one the user did not see whole (a
 * document's link, whose text may hide it): the port is not granted, and
 * the pane uses the forward that exists or asks before it makes one, as
 * for a view found in the layout. Returns the pane's key. */
export async function openBrowserTab(m: string, input = '', opts: { ask?: boolean } = {}): Promise<string | undefined> {
  const fields = input ? pageView(m, input) : { url: '' };
  if (!fields) return undefined;
  if (fields.m && fields.port && !opts.ask) grantForward(fields.m, fields.port);
  return actions.openView(m, { plugin: 'browser', kind: 'page', ...fields }, { tab: true });
}

/** Opens a popup's address (a webview's) as a browser tab. A page asked
 * for it, not the user, so it leads into no machine by itself: an address
 * on the local port of a forward that exists is that forward's machine and
 * port, in a tab of that machine, which uses the forward and does not make
 * it again once it ended; any other address is its own, a loopback one this
 * computer's, in a tab of the machine shown. What is no http(s) page opens
 * nothing. */
export async function openPopup(url: string) {
  const m = current()?.m;
  if (!m) return;
  for (const f of useForwards.getState().forwards) {
    const meant = meantUrl(url, f.port, f.local);
    if (meant)
      return void (await actions.openView(f.m, { plugin: 'browser', kind: 'page', url: meant, m: f.m, port: f.port }, { tab: true }));
  }
  const p = parseAddress(url);
  if (p.kind !== 'page') return;
  await actions.openView(m, { plugin: 'browser', kind: 'page', url: p.url }, { tab: true });
}

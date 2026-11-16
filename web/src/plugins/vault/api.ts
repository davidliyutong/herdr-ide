// The variable vault's core routes (/api/p/vault, internal/plugins/vault)
// and what the pages know of it: variables without their values, the
// vault's state, requests waiting for an answer and the access log. Changes,
// reveals and approvals pass the vault's gate: a session the page opens
// with the passphrase, whose token it keeps in memory only (never in
// storage, which programs on the computer could read) and sends as
// X-Vault-Session; the core ends it once unused for a while (a setting),
// and a page that is refused asks for the passphrase again.
import { create } from 'zustand';
import { hasMessage, t } from '../../i18n';

export interface VaultStatus {
  /** '' (no passphrase yet) or 'passphrase'. */
  mode: string;
  locked: boolean;
  /** No passphrase yet: setPassphrase sets it. */
  setup?: boolean;
  /** When the passphrase was set or last changed (RFC 3339). */
  passphraseSet?: string;
}

export interface VaultVariable {
  name: string;
  description: string;
  /** Machine ids; '*' is every machine. */
  machines: string[];
  injectOnly: boolean;
  created: string;
  updated: string;
}

/** A process behind a request, as the machine's agent saw it. */
export interface VaultProcess {
  pid: number;
  name?: string;
}

export interface VaultRequest {
  id: string;
  m: string;
  tool: string;
  names: string[];
  client?: string;
  terminal?: string;
  cwd?: string;
  /** The process that asked, then its parents. */
  process?: VaultProcess[];
  created: string;
  expires: string;
}

export interface VaultAccess {
  id?: number;
  time: string;
  /** The machine whose MCP server asked; '' for a page (a reveal, an export). */
  m: string;
  /** get, env, list; reveal, export (a page's). */
  tool: string;
  names?: string[];
  client?: string;
  terminal?: string;
  cwd?: string;
  process?: VaultProcess[];
  /** A page's address and browser. */
  remote?: string;
  userAgent?: string;
  result: string;
  /** Identical list calls or refusals in a row (1 when absent). */
  count?: number;
}

/** A process chain as text: the asking process first, then its parents. */
export function processText(ps?: VaultProcess[]): string {
  return (ps ?? []).map((p) => (p.name ? `${p.name} (${p.pid})` : String(p.pid))).join(' ← ');
}

export type Answer = 'once' | 'always' | 'deny';

/** A failed call: the core's error code. */
export class VaultError extends Error {
  readonly code: string;
  /** The variable a failure of several is about (an import's, an export's). */
  readonly variable?: string;
  constructor(code: string, message?: string, variable?: string) {
    super(message || code);
    this.code = code;
    this.variable = variable;
  }
}

/** A failure's message in the UI's language. */
export function errorText(e: unknown): string {
  const code = e instanceof VaultError ? e.code : 'failed';
  const key = `vault.error.${code}`;
  return hasMessage(key) ? t(key) : t('vault.error.failed');
}

/** Why the vault did not load, in the UI's language: its file of another
 * version or unreadable, the core keeps no file, or a failure. */
export function loadErrorText(code: string): string {
  for (const key of [`vault.load.${code}`, `vault.error.${code}`]) if (hasMessage(key)) return t(key);
  return t('vault.load.failed');
}

const base = '/api/p/vault';

/** The page's vault session (memory only). */
let token = '';

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Vault-Session'] = token;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = String(data.error ?? res.status);
    // The gate refused: the session ended (idle, locked, passphrase changed).
    if (code === 'vault_session') endLocalSession();
    throw new VaultError(code, data.message, typeof data.name === 'string' ? data.name : undefined);
  }
  return res;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  return (await res.json().catch(() => ({}))) as T;
}

function endLocalSession() {
  token = '';
  useVault.setState({ session: false });
}

interface Opened {
  session: string;
  status: VaultStatus;
}

function opened(o: Opened) {
  token = o.session;
  useVault.setState({ session: true, status: o.status });
}

const enc = encodeURIComponent;

export const vaultApi = {
  list: () => call<{ status: VaultStatus; variables: VaultVariable[]; session?: boolean; idle?: number }>('GET', ''),
  /** Creates or changes a variable; `to` renames it in the same write. */
  set: (name: string, body: { to?: string; description?: string; machines?: string[]; injectOnly?: boolean; value?: string }) =>
    call<VaultVariable>('PUT', `/vars/${enc(name)}`, body),
  remove: (name: string) => call('DELETE', `/vars/${enc(name)}`),
  reveal: (name: string) => call<{ value: string }>('POST', `/vars/${enc(name)}/reveal`),
  session: (passphrase: string) => call<Opened>('POST', '/session', { passphrase }),
  endSession: () => call('DELETE', '/session'),
  passphrase: (passphrase: string, old?: string) =>
    call<Opened>('POST', '/passphrase', old === undefined ? { passphrase } : { old, passphrase }),
  lock: () => call<VaultStatus>('POST', '/lock'),
  requests: () => call<{ requests: VaultRequest[] }>('GET', '/requests'),
  answer: (id: string, answer: Answer) => call('POST', `/requests/${enc(id)}`, { answer }),
  log: () => call<{ log: VaultAccess[] }>('GET', '/log'),
  /** An export file of the variables named (or all), as its text: the core
   * seals it, so values never reach the page. */
  exportFile: async (body: { passphrase: string; filePassphrase: string; names?: string[]; all?: boolean }) =>
    (await request('POST', '/export', body)).text(),
  /** What an export file holds, without values. */
  importPreview: (file: string, passphrase: string) => call<ImportPreview>('POST', '/import/preview', { file, passphrase }),
  /** Imports a file's variables as chosen, in one write. */
  importFile: (file: string, passphrase: string, choices: ImportChoice[]) =>
    call<{ imported: string[] }>('POST', '/import', { file, passphrase, choices }),
};

/** A variable of an export file, as the preview shows it (never its value). */
export interface ImportVariable {
  name: string;
  description: string;
  injectOnly: boolean;
  /** The machines it maps to here ('*': all). */
  machines: string[];
  /** Machines of its list this core does not know: they will ask. */
  unknown?: string[];
  /** The vault has a variable of that name. */
  exists: boolean;
  /** Why it cannot be imported as it is: 'invalid_name' (under another
   * name only) or 'invalid'. */
  invalid?: string;
}

export interface ImportPreview {
  exported?: string;
  variables: ImportVariable[];
  machines: { id: string; label: string; local: boolean; known: boolean }[];
}

export type ImportAction = 'import' | 'overwrite' | 'rename' | 'skip';

/** What to do with the file's variable i. */
export interface ImportChoice {
  i: number;
  action: ImportAction;
  as?: string;
}

interface VaultState {
  status?: VaultStatus;
  /** This page has an open session: it may change, reveal and approve. */
  session: boolean;
  variables: VaultVariable[];
  log: VaultAccess[];
  /** By id: requests waiting for an answer. */
  requests: Record<string, VaultRequest>;
  /** The error code of the last load ('unavailable': the core keeps no
   * file; 'version', 'invalid': its file does not open). */
  error?: string;
  /** Seconds a session lasts unused (the core's setting). */
  idle?: number;
}

export const useVault = create<VaultState>(() => ({ variables: [], log: [], requests: {}, session: false }));

/** Opens a session with the passphrase (unlocking the vault). */
export async function openSession(passphrase: string) {
  opened(await vaultApi.session(passphrase));
  await loadVault();
}

/** Sets the first passphrase or, with old, changes it; either opens a
 * session. */
export async function setPassphrase(passphrase: string, old?: string) {
  opened(await vaultApi.passphrase(passphrase, old));
  await loadVault();
}

/** Ends this page's session. */
export async function endSession() {
  await vaultApi.endSession().catch(() => undefined);
  endLocalSession();
}

/** Locks the vault, which ends every page's session. */
export async function lockVault() {
  await vaultApi.lock();
  endLocalSession();
  await loadVault();
}

/** Loads the variables and the log again. */
export async function loadVault() {
  try {
    // What the core says of the session counts only for the token sent: a
    // load that crossed a session's start or end says nothing of it.
    const sent = token;
    const [list, log] = await Promise.all([vaultApi.list(), vaultApi.log()]);
    if (token === sent && !list.session) token = '';
    useVault.setState({
      status: list.status,
      variables: list.variables ?? [],
      log: log.log ?? [],
      session: !!token,
      idle: list.idle,
      error: undefined,
    });
  } catch (e) {
    useVault.setState({ error: e instanceof VaultError ? e.code : 'failed' });
  }
}

/** Loads the requests that wait for an answer (a page opened while one waits). */
export async function loadRequests() {
  try {
    const { requests } = await vaultApi.requests();
    useVault.setState({ requests: Object.fromEntries((requests ?? []).map((r) => [r.id, r])) });
  } catch {
    /* the plugin is off or the core is gone */
  }
}

/** A message of the core's side (/ws plugin {plugin: 'vault', m, data}). */
export function vaultMessage(_m: string, data: unknown) {
  const d = data as { type?: string; request?: VaultRequest; id?: string };
  switch (d?.type) {
    case 'request':
      if (d.request) {
        const r = d.request;
        useVault.setState((s) => ({ requests: { ...s.requests, [r.id]: r } }));
      }
      break;
    case 'resolved':
      if (d.id) {
        const id = d.id;
        useVault.setState((s) => {
          const requests = { ...s.requests };
          delete requests[id];
          return { requests };
        });
      }
      break;
    case 'changed':
      void loadVault();
      break;
  }
}

/** Answers a request; the first answer of any page wins, and every page
 * drops it when the core says it is resolved. A request the core no longer
 * has (answered elsewhere or expired: 404) is dropped; any other failure
 * (the gate, which allowing passes only with the page's session, the
 * network, the core) leaves it and is thrown, for the prompt to say. */
export async function answerRequest(id: string, answer: Answer) {
  try {
    await vaultApi.answer(id, answer);
  } catch (e) {
    if (!(e instanceof VaultError && e.code === 'not_found')) throw e;
  }
  useVault.setState((s) => {
    const requests = { ...s.requests };
    delete requests[id];
    return { requests };
  });
}

/** Loads the requests, and the vault if it was loaded, again: the page's
 * connection to the core came back, and the core may have restarted (its
 * requests and sessions gone, the vault locked) or changed meanwhile. */
export function reloadVault() {
  void loadRequests();
  const s = useVault.getState();
  if (s.status || s.error) void loadVault();
}

// The variable vault's core routes (/api/p/vault, internal/plugins/vault)
// and what the pages know of it: variables without their values, the
// vault's state, requests waiting for an answer and the access log. Changes,
// reveals and approvals pass the vault's gate: a session the page opens
// with the passphrase, whose token it keeps in memory only (never in
// storage, which programs on the computer could read) and sends as
// X-Vault-Session; the core ends it after 30 idle minutes, and a page
// that is refused asks for the passphrase again.
import { create } from 'zustand';

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

export interface VaultRequest {
  id: string;
  m: string;
  tool: string;
  names: string[];
  client?: string;
  terminal?: string;
  cwd?: string;
  created: string;
  expires: string;
}

export interface VaultAccess {
  time: string;
  m: string;
  tool: string;
  names?: string[];
  client?: string;
  terminal?: string;
  result: string;
  /** Identical list calls or busy refusals in a row (1 when absent). */
  count?: number;
}

export type Answer = 'once' | 'always' | 'deny';

/** A failed call: the core's error code. */
export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

const base = '/api/p/vault';

/** The page's vault session (memory only). */
let token = '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Vault-Session'] = token;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data.error ?? res.status);
    // The gate refused: the session ended (idle, locked, passphrase changed).
    if (code === 'vault_session') endLocalSession();
    throw new VaultError(code, data.message);
  }
  return data as T;
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
  list: () => call<{ status: VaultStatus; variables: VaultVariable[]; session?: boolean }>('GET', ''),
  set: (name: string, body: { description?: string; machines?: string[]; injectOnly?: boolean; value?: string }) =>
    call<VaultVariable>('PUT', `/vars/${enc(name)}`, body),
  remove: (name: string) => call('DELETE', `/vars/${enc(name)}`),
  rename: (name: string, to: string) => call('POST', `/vars/${enc(name)}/rename`, { to }),
  reveal: (name: string) => call<{ value: string }>('POST', `/vars/${enc(name)}/reveal`),
  session: (passphrase: string) => call<Opened>('POST', '/session', { passphrase }),
  endSession: () => call('DELETE', '/session'),
  passphrase: (passphrase: string, old?: string) =>
    call<Opened>('POST', '/passphrase', old === undefined ? { passphrase } : { old, passphrase }),
  lock: () => call<VaultStatus>('POST', '/lock'),
  requests: () => call<{ requests: VaultRequest[] }>('GET', '/requests'),
  answer: (id: string, answer: Answer) => call('POST', `/requests/${enc(id)}`, { answer }),
  log: () => call<{ log: VaultAccess[] }>('GET', '/log'),
};

interface VaultState {
  status?: VaultStatus;
  /** This page has an open session: it may change, reveal and approve. */
  session: boolean;
  variables: VaultVariable[];
  log: VaultAccess[];
  /** By id: requests waiting for an answer. */
  requests: Record<string, VaultRequest>;
  /** The error code of the last load ('unavailable': the core keeps no file). */
  error?: string;
}

export const useVault = create<VaultState>(() => ({ variables: [], log: [], requests: {}, session: false }));

/** Opens a session with the passphrase (unlocking the vault). */
export async function openSession(passphrase: string) {
  opened(await vaultApi.session(passphrase));
  await loadVault();
}

/** Sets the first passphrase (converting a keychain vault) or, with old,
 * changes it; either opens a session. */
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
    useVault.setState({ status: list.status, variables: list.variables ?? [], log: log.log ?? [], session: !!token, error: undefined });
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
 * drops it when the core says it is resolved. Allowing needs the page's
 * session (the gate refuses it otherwise and the request stays). */
export async function answerRequest(id: string, answer: Answer) {
  try {
    await vaultApi.answer(id, answer);
  } catch (e) {
    if (e instanceof VaultError && e.code === 'vault_session') throw e;
    /* answered elsewhere or expired */
  }
  useVault.setState((s) => {
    const requests = { ...s.requests };
    delete requests[id];
    return { requests };
  });
}

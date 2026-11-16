// The variable vault's core routes (/api/p/vault, internal/plugins/vault)
// and what the pages know of it: variables without their values, the
// vault's state, requests waiting for an answer and the access log.
import { create } from 'zustand';

export interface VaultStatus {
  /** '' (no key yet), 'keychain' or 'passphrase'. */
  mode: string;
  locked: boolean;
  /** Passphrase mode without a passphrase: unlocking sets it. */
  setup?: boolean;
  /** Why the keychain's key could not be read: key_missing, keychain_unavailable. */
  error?: string;
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VaultError(String(data.error ?? res.status), data.message);
  return data as T;
}

const enc = encodeURIComponent;

export const vaultApi = {
  list: () => call<{ status: VaultStatus; variables: VaultVariable[] }>('GET', ''),
  set: (name: string, body: { description?: string; machines?: string[]; injectOnly?: boolean; value?: string }) =>
    call<VaultVariable>('PUT', `/vars/${enc(name)}`, body),
  remove: (name: string) => call('DELETE', `/vars/${enc(name)}`),
  rename: (name: string, to: string) => call('POST', `/vars/${enc(name)}/rename`, { to }),
  reveal: (name: string) => call<{ value: string }>('POST', `/vars/${enc(name)}/reveal`),
  unlock: (passphrase: string) => call<VaultStatus>('POST', '/unlock', { passphrase }),
  lock: () => call<VaultStatus>('POST', '/lock'),
  requests: () => call<{ requests: VaultRequest[] }>('GET', '/requests'),
  answer: (id: string, answer: Answer) => call('POST', `/requests/${enc(id)}`, { answer }),
  log: () => call<{ log: VaultAccess[] }>('GET', '/log'),
};

interface VaultState {
  status?: VaultStatus;
  variables: VaultVariable[];
  log: VaultAccess[];
  /** By id: requests waiting for an answer. */
  requests: Record<string, VaultRequest>;
  /** The error code of the last load ('unavailable': the core keeps no file). */
  error?: string;
}

export const useVault = create<VaultState>(() => ({ variables: [], log: [], requests: {} }));

/** Loads the variables and the log again. */
export async function loadVault() {
  try {
    const [list, log] = await Promise.all([vaultApi.list(), vaultApi.log()]);
    useVault.setState({ status: list.status, variables: list.variables ?? [], log: log.log ?? [], error: undefined });
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
 * drops it when the core says it is resolved. */
export async function answerRequest(id: string, answer: Answer) {
  useVault.setState((s) => {
    const requests = { ...s.requests };
    delete requests[id];
    return { requests };
  });
  try {
    await vaultApi.answer(id, answer);
  } catch {
    /* answered elsewhere or expired */
  }
}

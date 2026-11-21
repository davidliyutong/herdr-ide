// The vault's authenticators from the page's side (the core's model is in
// internal/plugins/vault/proof.go): a proof is the user's word, made by
// the desktop app's system prompt or by a WebAuthn credential, that stands
// for the passphrase while the vault is unlocked. The core issues a nonce
// for one purpose, the page has it signed, and the core checks it.
import { APP_NAME } from '../../brand';
import type { DesktopVerifyUser } from '../../shell';
import {
  addAuthenticator,
  vaultApi,
  VaultError,
  type DesktopProof,
  type Proof,
  type ProofChallenge,
  type ProofPurpose,
  type VaultGuard,
  type WebAuthnProof,
} from './api';

// ---- base64url without padding, as the core's byte strings ----

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- what this page can do ----

export type WebAuthnState = 'ready' | 'ip-host' | 'untrusted' | 'unavailable';

/** Whether the browser can make WebAuthn assertions on this page. */
function browserCan(): boolean {
  return window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

/** What this page can do with WebAuthn credentials:
 * - 'ip-host': the page is on an IP address (a LAN address, 127.0.0.1),
 *   where the browser refuses them; opened by name (localhost for the same
 *   computer) it may work;
 * - 'unavailable': the browser or the connection has no WebAuthn;
 * - 'untrusted': the core does not vouch for this origin, so a credential
 *   is neither added nor taken here (another program may answer on a
 *   localhost address, and its page would collect the user's touch);
 * - 'ready': credentials can be added and used from this origin. */
export function webauthnState(guard?: VaultGuard | null): WebAuthnState {
  const host = location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'ip-host';
  if (!browserCan()) return 'unavailable';
  return guard?.webauthn ? 'ready' : 'untrusted';
}

/** This page's address under localhost, when it is on a loopback IP: the
 * same server, a name WebAuthn accepts. Null on any other address. */
export function localhostUrl(): string | null {
  const host = location.hostname;
  if (!/^127(\.\d{1,3}){3}$/.test(host) && host !== '[::1]' && host !== '::1') return null;
  return `http://localhost${location.port ? ':' + location.port : ''}${location.pathname}${location.search}`;
}

/** The desktop app's prompt, when this page runs in the app. Read at the
 * call, not at load, which is also what lets a test supply one. */
export function verifyUser(): DesktopVerifyUser | undefined {
  return (globalThis as { desktopShell?: { verifyUser?: DesktopVerifyUser } }).desktopShell?.verifyUser;
}

export interface Ways {
  /** The app's own prompt. */
  desktop: boolean;
  /** A WebAuthn credential added from this page's origin. */
  webauthn: boolean;
}

/** Which proofs this page can make now. */
export function ways(guard?: VaultGuard | null): Ways {
  const list = guard?.authenticators ?? [];
  return {
    desktop: !!guard?.desktop && !!verifyUser() && list.some((a) => a.kind === 'desktop'),
    webauthn: webauthnState(guard) === 'ready' && list.some((a) => a.kind === 'webauthn' && a.origin === location.origin),
  };
}

// ---- making a proof ----

const cancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');

const failed = () => new VaultError('proof_failed');

function assertionProof(nonce: string, cred: Credential | null): WebAuthnProof {
  const pk = cred as PublicKeyCredential | null;
  const r = pk?.response as AuthenticatorAssertionResponse | undefined;
  if (!pk || !r?.signature) throw failed();
  return {
    nonce,
    credential: b64urlEncode(pk.rawId),
    clientDataJSON: b64urlEncode(r.clientDataJSON),
    authenticatorData: b64urlEncode(r.authenticatorData),
    signature: b64urlEncode(r.signature),
  };
}

async function webauthnGet(ch: ProofChallenge, ids: string[]): Promise<WebAuthnProof | null> {
  try {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlDecode(ch.nonce),
        rpId: ch.rpId,
        allowCredentials: ids.map((id) => ({ type: 'public-key' as const, id: b64urlDecode(id) })),
        userVerification: 'required',
        timeout: ch.ttl * 1000,
      },
    });
    return assertionProof(ch.nonce, cred);
  } catch (e) {
    if (cancelled(e)) return null;
    throw e instanceof VaultError ? e : failed();
  }
}

async function desktopMac(nonce: string): Promise<DesktopProof | null> {
  try {
    const mac = await verifyUser()?.prove(nonce);
    return mac ? { nonce, mac } : null;
  } catch {
    throw failed();
  }
}

/** Asks the core for a nonce for the purpose and has it proved: by the
 * desktop prompt when the app has one on, else by a WebAuthn credential of
 * this origin (the core lists only those). Null when the user did not confirm. */
export async function prove(purpose: ProofPurpose): Promise<Proof | null> {
  const ch = await vaultApi.proof(purpose);
  if (ch.desktop && verifyUser()) return desktopMac(ch.nonce);
  if (browserCan() && ch.credentials.length) return webauthnGet(ch, ch.credentials);
  throw new VaultError('vault_proof');
}

// ---- adding an authenticator ----

/** Adds a WebAuthn credential for this host: the browser creates it for the
 * core's nonce, then the new credential signs the same nonce, which shows
 * the core that the key it stores is the authenticator's. False when the
 * user cancelled. */
export async function registerWebAuthn(label: string, passphrase: string): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'register' });
  const challenge = b64urlDecode(ch.nonce);
  try {
    const created = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: location.hostname, name: APP_NAME },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
        pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: 'public-key' as const, alg })),
        authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
        attestation: 'none',
        excludeCredentials: ch.credentials.map((id) => ({ type: 'public-key' as const, id: b64urlDecode(id) })),
        timeout: ch.ttl * 1000,
      },
    })) as PublicKeyCredential | null;
    const r = created?.response as AuthenticatorAttestationResponse | undefined;
    const key = r?.getPublicKey?.();
    if (!created || !r || !key) throw failed();
    const assertion = await webauthnGet({ ...ch, credentials: [b64urlEncode(created.rawId)] }, [b64urlEncode(created.rawId)]);
    if (!assertion) return false;
    await addAuthenticator({
      kind: 'webauthn',
      label,
      passphrase,
      nonce: ch.nonce,
      clientDataJSON: b64urlEncode(r.clientDataJSON),
      authenticatorData: b64urlEncode(r.getAuthenticatorData()),
      publicKey: b64urlEncode(key),
      alg: r.getPublicKeyAlgorithm(),
      assertion,
    });
    return true;
  } catch (e) {
    if (cancelled(e)) return false;
    throw e instanceof VaultError ? e : failed();
  }
}

/** Turns the desktop app's prompt on: the user answers it once for the
 * core's nonce. False when the user did not confirm. */
export async function registerDesktop(label: string, passphrase: string): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'register' });
  const p = await desktopMac(ch.nonce);
  if (!p) return false;
  await addAuthenticator({ kind: 'desktop', label, passphrase, nonce: ch.nonce, mac: p.mac });
  return true;
}

// ---- a proof or the passphrase for one action ----

/** What goes with an action where every Allow is verified. */
export type Fresh = { proof: Proof } | { passphrase: string };

export type FreshResult<T> =
  | { done: true; value: T }
  /** The user did not confirm the proof. */
  | { done: false; reason: 'cancelled' }
  /** No proof can be made here: the passphrase is needed. */
  | { done: false; reason: 'passphrase' };

/** Runs send for an action of the vault that, where every Allow is
 * verified, needs the user's word made for it (purpose): a proof when the
 * page can make one, else the passphrase given. `needed` is what the page
 * knows of the rule; a core that refuses with vault_proof anyway (the rule
 * was turned on elsewhere) gets the same. A proof the core refuses, or a
 * wrong passphrase, is thrown for the caller to say. */
export async function withFresh<T>(o: {
  guard?: VaultGuard | null;
  purpose: ProofPurpose;
  needed: boolean;
  passphrase?: string;
  send: (fresh?: Fresh) => Promise<T>;
}): Promise<FreshResult<T>> {
  const make = async (): Promise<Fresh | 'passphrase' | null> => {
    if (o.passphrase) return { passphrase: o.passphrase };
    const w = ways(o.guard);
    if (!w.desktop && !w.webauthn) return 'passphrase';
    const proof = await prove(o.purpose);
    return proof ? { proof } : null;
  };
  const sent = async (f: Fresh | undefined): Promise<FreshResult<T>> => ({ done: true, value: await o.send(f) });
  if (o.needed || o.passphrase) {
    const f = await make();
    if (f === null) return { done: false, reason: 'cancelled' };
    if (f === 'passphrase') return { done: false, reason: 'passphrase' };
    return sent(f);
  }
  try {
    return await sent(undefined);
  } catch (e) {
    if (!(e instanceof VaultError && e.code === 'vault_proof')) throw e;
    const f = await make();
    if (f === null) return { done: false, reason: 'cancelled' };
    if (f === 'passphrase') return { done: false, reason: 'passphrase' };
    return sent(f);
  }
}

/** Whether a change lets a variable's value go where it did not (the
 * core's test): a machine added to those that may read it without asking,
 * or inject-only dropped. */
export function widens(cur: { machines: string[]; injectOnly: boolean }, u: { machines?: string[]; injectOnly?: boolean }): boolean {
  if (u.injectOnly === false && cur.injectOnly) return true;
  const allowed = (m: string) => cur.machines.includes('*') || cur.machines.includes(m);
  return (u.machines ?? []).some((m) => !allowed(m));
}

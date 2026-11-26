// The vault's authenticators from the page's side (the hub's model is in
// backend/features/vault): a proof is the user's word, made by
// the desktop app's system prompt or by a WebAuthn credential, that stands
// for the passphrase while the vault is unlocked. The hub issues a nonce
// for one purpose, the page has it signed, and the hub checks it. A
// locked vault has forgotten its key: an authenticator unlocks it only
// with an unlock entry, the key wrapped under what the authenticator alone
// gives (the desktop app's Secure Enclave or Windows Hello key, which the
// app answers sealed for the hub; a credential's PRF output), and only
// within vault.passphraseDays of the passphrase.
import { APP_NAME } from '../../brand';
import type { DesktopVerifyUser } from '../../shell';
import {
  addAuthenticator,
  openSessionWithUnlock,
  vaultApi,
  VaultError,
  type DesktopProof,
  type Proof,
  type ProofChallenge,
  type ProofPurpose,
  type VaultGuard,
  type VaultUnlock,
  type WebAuthnProof,
} from './api';

// ---- base64url without padding, as the hub's byte strings ----

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A WebAuthn byte string (a PRF output) as bytes. */
function bytesOf(b: BufferSource): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
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
 * - 'untrusted': the hub does not vouch for this origin, so a credential
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

/** How this page can unlock a locked vault without the passphrase. */
export interface UnlockWays {
  /** The desktop app's key: 'enclave' (Touch ID) or 'hello'; null: none. */
  desktop: 'enclave' | 'hello' | null;
  /** A WebAuthn credential of this origin, by its PRF. */
  prf: boolean;
}

/** The ways of the list's unlock this page can use: the desktop app's
 * where the app can keep an unlock key (canUnlock), a credential's PRF
 * where the browser has WebAuthn. Nothing once the hint says the
 * passphrase is due. */
export function unlockWays(u: VaultUnlock | undefined, canUnlock: boolean, now = Date.now()): UnlockWays {
  const none = { desktop: null, prf: false };
  if (!u?.ways?.length || (u.due && Date.parse(u.due) <= now)) return none;
  const desktop = canUnlock && verifyUser() ? (u.ways.find((w) => w === 'enclave' || w === 'hello') ?? null) : null;
  return { desktop: desktop as UnlockWays['desktop'], prf: u.ways.includes('prf') && browserCan() };
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

/** An assertion of the nonce by one of the credentials, with the PRF
 * output of the one that answered when salts (by credential id) are
 * given; null when the user cancelled. */
async function webauthnAssert(
  ch: ProofChallenge,
  ids: string[],
  prf?: Record<string, string>,
): Promise<{ proof: WebAuthnProof; output?: string } | null> {
  try {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlDecode(ch.nonce),
        rpId: ch.rpId,
        allowCredentials: ids.map((id) => ({ type: 'public-key' as const, id: b64urlDecode(id) })),
        userVerification: 'required',
        timeout: ch.ttl * 1000,
        ...(prf && {
          extensions: {
            prf: { evalByCredential: Object.fromEntries(Object.entries(prf).map(([id, salt]) => [id, { first: b64urlDecode(salt) }])) },
          },
        }),
      },
    });
    const proof = assertionProof(ch.nonce, cred);
    if (!prf) return { proof };
    const first = (cred as PublicKeyCredential).getClientExtensionResults?.().prf?.results?.first;
    const bytes = first ? bytesOf(first) : undefined;
    const output = bytes ? b64urlEncode(bytes) : undefined;
    bytes?.fill(0);
    return { proof, output };
  } catch (e) {
    if (cancelled(e)) return null;
    throw e instanceof VaultError ? e : failed();
  }
}

async function webauthnGet(ch: ProofChallenge, ids: string[]): Promise<WebAuthnProof | null> {
  return (await webauthnAssert(ch, ids))?.proof ?? null;
}

async function desktopMac(nonce: string): Promise<DesktopProof | null> {
  try {
    const mac = await verifyUser()?.prove(nonce);
    return mac ? { nonce, mac } : null;
  } catch {
    throw failed();
  }
}

/** Asks the hub for a nonce for the purpose and has it proved: by the
 * desktop prompt when the app has one on, else by a WebAuthn credential of
 * this origin (the hub lists only those). Null when the user did not confirm. */
export async function prove(purpose: ProofPurpose): Promise<Proof | null> {
  const ch = await vaultApi.proof(purpose);
  if (ch.desktop && verifyUser()) return desktopMac(ch.nonce);
  if (browserCan() && ch.credentials.length) return webauthnGet(ch, ch.credentials);
  throw new VaultError('vault_proof');
}

// ---- unlocking a locked vault ----

/** Unlocks the locked vault with the desktop app's unlock key: the app
 * prompts, and answers the entry it used and the relay sealed for the
 * hub, which the page passes on. False when the user did not confirm;
 * unlock_stale when this install has no unlock entry (the app says so
 * without a prompt), which only the passphrase and a new enrollment mend. */
export async function unlockWithDesktop(): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'session' });
  let r;
  try {
    r = await verifyUser()?.unlock(ch.nonce);
  } catch {
    throw failed();
  }
  if (r === 'none') throw new VaultError('unlock_stale');
  if (!r) return false;
  await openSessionWithUnlock({ nonce: ch.nonce, id: r.id, relay: r.relay });
  return true;
}

/** Unlocks the locked vault with a WebAuthn credential of this origin: its
 * PRF of the entry's salt unwraps the key, and its assertion of the nonce
 * comes with it. False when the user cancelled. */
export async function unlockWithPrf(): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'session' });
  const salts = ch.prf ?? {};
  const ids = Object.keys(salts);
  if (!ids.length) throw new VaultError('unlock_stale');
  const got = await webauthnAssert(ch, ids, salts);
  if (!got) return false;
  // The browser or the authenticator gave no PRF: nothing to unwrap with.
  if (!got.output) throw failed();
  const p = got.proof;
  const assertion = {
    credential: p.credential,
    clientDataJSON: p.clientDataJSON,
    authenticatorData: p.authenticatorData,
    signature: p.signature,
  };
  await openSessionWithUnlock({ nonce: ch.nonce, prf: { credential: p.credential, output: got.output }, assertion });
  return true;
}

// ---- adding an authenticator ----

/** Adds a WebAuthn credential for this host: the browser creates it for the
 * hub's nonce with the PRF extension, then the new credential signs the
 * same nonce, which shows the hub that the key it stores is the
 * authenticator's, and evaluates its PRF of the hub's salt, under which
 * the hub wraps the vault's key. A credential without PRF cannot unlock
 * the vault and is not added (prf_required). False when the user
 * cancelled. */
export async function registerWebAuthn(label: string, passphrase: string): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'register' });
  const challenge = b64urlDecode(ch.nonce);
  const noPrf = () => new VaultError('prf_required');
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
        extensions: { prf: {} },
      },
    })) as PublicKeyCredential | null;
    const r = created?.response as AuthenticatorAttestationResponse | undefined;
    const key = r?.getPublicKey?.();
    if (!created || !r || !key) throw failed();
    // The authenticator said it has no PRF: no second prompt for nothing.
    if (created.getClientExtensionResults?.().prf?.enabled === false || !ch.prfSalt) throw noPrf();
    const id = b64urlEncode(created.rawId);
    const got = await webauthnAssert({ ...ch, credentials: [id] }, [id], { [id]: ch.prfSalt });
    if (!got) return false;
    if (!got.output) throw noPrf();
    await addAuthenticator({
      kind: 'webauthn',
      label,
      passphrase,
      nonce: ch.nonce,
      clientDataJSON: b64urlEncode(r.clientDataJSON),
      authenticatorData: b64urlEncode(r.getAuthenticatorData()),
      publicKey: b64urlEncode(key),
      alg: r.getPublicKeyAlgorithm(),
      assertion: got.proof,
      prf: got.output,
    });
    return true;
  } catch (e) {
    if (cancelled(e)) return false;
    throw e instanceof VaultError ? e : failed();
  }
}

/** Turns the desktop app's prompt on: the user answers it once for the
 * hub's nonce, and the app makes this install's unlock key, which it
 * hands the hub sealed (the relay). False when the user did not confirm
 * or the key could not be made. */
export async function registerDesktop(label: string, passphrase: string): Promise<boolean> {
  const ch = await vaultApi.proof({ for: 'register' });
  let r;
  try {
    r = await verifyUser()?.enroll(ch.nonce);
  } catch {
    throw failed();
  }
  if (!r) return false;
  await addAuthenticator({ kind: 'desktop', label, passphrase, nonce: ch.nonce, mac: r.mac, relay: r.relay });
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
 * knows of the rule; a hub that refuses with vault_proof anyway (the rule
 * was turned on elsewhere) gets the same. A proof the hub refuses, or a
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
 * hub's test): a machine added to those that may read it without asking,
 * or inject-only dropped. */
export function widens(cur: { machines: string[]; injectOnly: boolean }, u: { machines?: string[]; injectOnly?: boolean }): boolean {
  if (u.injectOnly === false && cur.injectOnly) return true;
  const allowed = (m: string) => cur.machines.includes('*') || cur.machines.includes(m);
  return (u.machines ?? []).some((m) => !allowed(m));
}

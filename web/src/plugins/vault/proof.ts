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

export type WebAuthnState = 'ready' | 'ip-host' | 'unavailable';

/** WebAuthn credentials are for a host name: on an IP address (a LAN
 * address, 127.0.0.1) the browser refuses them, so the page must be opened
 * by name (localhost for the same computer). */
export function webauthnState(): WebAuthnState {
  const host = location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'ip-host';
  if (!window.isSecureContext || typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return 'unavailable';
  return 'ready';
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
  /** A WebAuthn credential of this host. */
  webauthn: boolean;
}

/** Which proofs this page can make now. */
export function ways(guard?: VaultGuard | null): Ways {
  const list = guard?.authenticators ?? [];
  return {
    desktop: !!guard?.desktop && !!verifyUser() && list.some((a) => a.kind === 'desktop'),
    webauthn: webauthnState() === 'ready' && list.some((a) => a.kind === 'webauthn' && a.rpId === location.hostname),
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
 * this host. Null when the user did not confirm. */
export async function prove(purpose: ProofPurpose): Promise<Proof | null> {
  const ch = await vaultApi.proof(purpose);
  if (ch.desktop && verifyUser()) return desktopMac(ch.nonce);
  if (webauthnState() === 'ready' && ch.credentials.length) return webauthnGet(ch, ch.credentials);
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

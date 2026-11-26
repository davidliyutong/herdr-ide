// Unlock entries: an authenticator that can unlock the vault keeps the
// master key wrapped in the file, outside the sealed guard (which needs the
// key to be read), with AES-256-GCM under a key-encryption key (KEK) only
// the authenticator can give again, HKDF-SHA256 of
//
//   - enclave (the desktop app on macOS): the P-256 ECDH secret of an
//     ephemeral key the hub made when the entry was added (only its public
//     half is kept) and the app's Secure Enclave key, which the enclave
//     gives only after Touch ID, with the desktop shell's own secret;
//   - hello (the desktop app on Windows): the Windows Hello key's signature
//     (RSA PKCS#1 v1.5, deterministic) of a challenge the hub chose, with
//     the shell's secret;
//   - prf (a WebAuthn credential): its PRF output for a salt the hub chose.
//
// The wrap's additional data binds every member of the entry and the hash
// of the file's check, so an edited entry does not open and a new
// passphrase leaves the old entries unusable (keptEntries drops them).
// Vectors: spec/vectors/vault-unlock/kek.json.
import { createHash } from 'node:crypto';
import { SLUG } from '#shared/lib/brand.ts';
import { b64url, goJSON, hkdf, unb64, validPoint, type Sealed } from './crypto.ts';

export const UNLOCK_ENCLAVE = 'enclave';
export const UNLOCK_HELLO = 'hello';
export const UNLOCK_PRF = 'prf';

/** Desktop entries (enclave and hello) a vault keeps: one per install. */
export const MAX_DESKTOP_UNLOCKS = 4;
const KEY_LEN = 32;
const MAX_BLOB = 4 << 10;
export const MAX_SIGNATURE = 1 << 10;
const MAX_PUBLIC_KEY = 2 << 10;
const MAX_ORIGIN = 512;
const MAX_RPID = 253;
const MAX_CREDENTIAL = 1023;
export const MAX_AUTH_ID = 128;

const VALID_INSTALL = /^[A-Za-z0-9_-]{16,64}$/;
export const VALID_UNLOCK_ID = /^[A-Za-z0-9_-]{22}$/;
const VALID_CHECK = /^[0-9a-f]{64}$/;

export const validInstall = (s: string) => VALID_INSTALL.test(s);
export const helloKeyName = (install: string) => `${SLUG}-vault-${install}`;

/** Binary members are base64 (standard, padded), as in the Go store's file. */
export interface EnclaveParams {
  install: string;
  blob: string;
  sePub: string;
  ephPub: string;
}
export interface HelloParams {
  install: string;
  keyName: string;
  challenge: string;
  publicKey: string;
}
export interface PRFParams {
  origin: string;
  rpId: string;
  credential: string;
  salt: string;
}

export interface UnlockEntry {
  id: string;
  /** The guard's authenticator: the desktop one for enclave and hello, the
   * webauthn credential for prf. */
  authenticator: string;
  kind: string;
  created: string;
  /** The hex SHA-256 of the file's check when the entry was made. */
  check: string;
  enclave?: EnclaveParams;
  hello?: HelloParams;
  prf?: PRFParams;
  wrapped: Sealed | null;
}

export const isDesktop = (e: { kind: string }) => e.kind === UNLOCK_ENCLAVE || e.kind === UNLOCK_HELLO;
export const installOf = (e: UnlockEntry) => e.enclave?.install ?? e.hello?.install ?? '';

/** The wrap's additional data: the canonical JSON (keys sorted, binary
 * members base64url) of the file's version, the entry's id, authenticator,
 * kind, check and its kind's parameters. */
export function entryAD(e: UnlockEntry, version: number): string {
  const u = (s: string) => b64url(unb64(s));
  const m: Record<string, unknown> = { v: version, t: 'unlock', id: e.id, authenticator: e.authenticator, kind: e.kind, check: e.check };
  if (e.kind === UNLOCK_ENCLAVE && e.enclave)
    Object.assign(m, { install: e.enclave.install, blob: u(e.enclave.blob), sePub: u(e.enclave.sePub), ephPub: u(e.enclave.ephPub) });
  else if (e.kind === UNLOCK_HELLO && e.hello)
    Object.assign(m, {
      install: e.hello.install,
      keyName: e.hello.keyName,
      challenge: u(e.hello.challenge),
      publicKey: u(e.hello.publicKey),
    });
  else if (e.kind === UNLOCK_PRF && e.prf)
    Object.assign(m, { origin: e.prf.origin, rpId: e.prf.rpId, credential: u(e.prf.credential), salt: u(e.prf.salt) });
  return goJSON(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** The hex SHA-256 of the check's ciphertext ("" for none). */
export const checkHash = (c: Sealed | undefined): string => (c ? createHash('sha256').update(unb64(c.ciphertext)).digest('hex') : '');

/** s is not empty, at most max bytes and without control characters. */
export const validText = (s: unknown, max: number): s is string =>
  typeof s === 'string' && s !== '' && Buffer.byteLength(s) <= max && !/[\p{Cc}]/u.test(s);

const between = (s: string | undefined, lo: number, hi: number) => {
  const n = unb64(s).length;
  return n >= lo && n <= hi;
};

const validEnclave = (p: EnclaveParams | undefined) =>
  !!p && validInstall(p.install) && between(p.blob, 1, MAX_BLOB) && validPoint(unb64(p.sePub)) && validPoint(unb64(p.ephPub));
const validHello = (p: HelloParams | undefined) =>
  !!p &&
  validInstall(p.install) &&
  p.keyName === helloKeyName(p.install) &&
  unb64(p.challenge).length === KEY_LEN &&
  between(p.publicKey, 1, MAX_PUBLIC_KEY);
export const validPRF = (p: PRFParams | undefined) =>
  !!p &&
  validText(p.origin, MAX_ORIGIN) &&
  validText(p.rpId, MAX_RPID) &&
  between(p.credential, 1, MAX_CREDENTIAL) &&
  unb64(p.salt).length === KEY_LEN;

/** A known kind with its parameters only, and a wrap of a 32-byte key. */
function validEntry(e: UnlockEntry): boolean {
  if (
    typeof e.id !== 'string' ||
    !VALID_UNLOCK_ID.test(e.id) ||
    !validText(e.authenticator, MAX_AUTH_ID) ||
    typeof e.check !== 'string' ||
    !VALID_CHECK.test(e.check) ||
    !e.wrapped ||
    unb64(e.wrapped.nonce).length !== 12 ||
    unb64(e.wrapped.ciphertext).length !== KEY_LEN + 16
  )
    return false;
  switch (e.kind) {
    case UNLOCK_ENCLAVE:
      return !e.hello && !e.prf && validEnclave(e.enclave);
    case UNLOCK_HELLO:
      return !e.enclave && !e.prf && validHello(e.hello);
    case UNLOCK_PRF:
      return !e.enclave && !e.hello && validPRF(e.prf);
  }
  return false;
}

/** Whether a and b may not both be kept: the same id, or the same desktop
 * install, or the same credential. */
export const clash = (a: UnlockEntry, b: UnlockEntry) =>
  a.id === b.id ||
  (isDesktop(a) && isDesktop(b) && installOf(a) === installOf(b)) ||
  (!!a.prf && !!b.prf && unb64(a.prf.credential).equals(unb64(b.prf.credential)));

/** The entries of a file kept at its opening: well formed, made for its
 * check, distinct, within the bounds. */
export function keptEntries(list: unknown, check: Sealed | undefined, maxPRF: number): UnlockEntry[] {
  if (!Array.isArray(list)) return [];
  const sum = checkHash(check);
  const out: UnlockEntry[] = [];
  let desktop = 0;
  let prf = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as UnlockEntry;
    try {
      if (!validEntry(e) || e.check !== sum || out.some((o) => clash(o, e))) continue;
    } catch {
      continue;
    }
    if (isDesktop(e)) {
      if (desktop >= MAX_DESKTOP_UNLOCKS) continue;
      desktop++;
    } else {
      if (prf >= maxPRF) continue;
      prf++;
    }
    out.push(structuredClone(e));
  }
  return out;
}

/** An enclave entry's KEK: ikm Z ‖ shellSecret, salt ephPub ‖ sePub. */
export const enclaveKEK = (z: Uint8Array, shellSecret: Uint8Array, ephPub: Uint8Array, sePub: Uint8Array) =>
  wiping(Buffer.concat([z, shellSecret]), (ikm) => hkdf(ikm, Buffer.concat([ephPub, sePub]), 'vault-unlock enclave'));
/** A hello entry's KEK: ikm signature ‖ shellSecret, salt the challenge. */
export const helloKEK = (signature: Uint8Array, shellSecret: Uint8Array, challenge: Uint8Array) =>
  wiping(Buffer.concat([signature, shellSecret]), (ikm) => hkdf(ikm, challenge, 'vault-unlock hello'));
/** A prf entry's KEK: ikm the PRF output, salt the entry's PRF salt. */
export const prfKEK = (output: Uint8Array, salt: Uint8Array) => hkdf(output, salt, 'vault-unlock prf');

function wiping<T>(b: Buffer, fn: (b: Buffer) => T): T {
  try {
    return fn(b);
  } finally {
    b.fill(0);
  }
}

// The vault's cryptography: Argon2id (node:crypto), AES-256-GCM and HKDF
// (WebCrypto), and the encodings the Go store wrote, which files of either
// hub keep.
//
// The master key is a WebCrypto CryptoKey that cannot be exported: its
// bytes live in the runtime's native memory, never in JavaScript's. They
// pass through JavaScript only for the moment a passphrase's derivation
// returns them, before they are imported and wiped; an unlock entry's wrap
// is opened by unwrapKey straight into such a key.
import { argon2, createPublicKey, hkdfSync, webcrypto } from 'node:crypto';
import { Fail } from '#kernel/fail.ts';

export type Key = webcrypto.CryptoKey;
const subtle = webcrypto.subtle;

/** Bytes AES-256-GCM sealed (base64, as Go's []byte in JSON). */
export interface Sealed {
  nonce: string;
  ciphertext: string;
}

/** Argon2id's parameters; memory in KiB. */
export interface KDF {
  salt: string;
  time: number;
  memory: number;
  threads: number;
}

// The store's errors: Fails with the status the routes answer them with,
// as the Go plugin's fail() mapped the store's codes.
const STATUS: Record<string, number> = {
  not_found: 404,
  exists: 409,
  vault_locked: 409,
  no_passphrase: 409,
  has_passphrase: 409,
  unlock_stale: 409,
  vault_changed: 409,
  wrong_passphrase: 403,
  passphrase_due: 403,
  vault_proof: 401,
  too_large: 413,
  failed: 500,
};

/** A failure of the store or of an export file. why tells failures of one
 * code apart (an unlock's wrap that did not open, an orphan entry);
 * variable is the variable a failure of several is about, which the answer
 * names. */
export class VaultError extends Fail {
  readonly why: string;
  readonly variable: string;

  constructor(code: string, message = code, o: { why?: string; variable?: string } = {}) {
    super(code, STATUS[code] ?? 400, message);
    this.why = o.why ?? '';
    this.variable = o.variable ?? '';
  }

  body(): { error: string; message: string } {
    return this.variable ? Object.assign(super.body(), { name: this.variable }) : super.body();
  }
}

/** Whether e is a vault error of code. */
export const isCode = (e: unknown, code: string): e is VaultError => e instanceof Fail && e.code === code;

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const unb64 = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64');
export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
/** base64url (padding allowed); empty for what is not. */
export function unb64url(s: unknown): Buffer {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return Buffer.alloc(0);
  return Buffer.from(s.replace(/=+$/, ''), 'base64url');
}

/** v as Go's json.Marshal writes it: JSON.stringify's text with <, >, &,
 * U+2028 and U+2029 escaped. Additional data is compared byte for byte, so
 * it must be what the Go store sealed with. */
export function goJSON(v: unknown): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Strings in Go's order (by their UTF-8 bytes). */
export const goSort = (list: readonly string[]): string[] => [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

const enc = new TextEncoder();
/** b as WebCrypto's parameters are typed (Node's buffers are of an
 * ArrayBuffer). */
const bs = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

/** Seals plain with ad as additional data, under a new random nonce. */
export async function seal(key: Key, plain: Uint8Array, ad: string): Promise<Sealed> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const c = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(ad) }, key, bs(plain));
  return { nonce: b64(nonce), ciphertext: b64(new Uint8Array(c)) };
}

/** Opens v sealed with ad; corrupt when it does not (another key, another
 * ad, changed bytes). */
export async function open(key: Key, v: Sealed | undefined | null, ad: string): Promise<Buffer> {
  const nonce = unb64(v?.nonce);
  if (!v || nonce.length !== 12) throw new VaultError('corrupt', 'a value cannot be decrypted');
  try {
    return Buffer.from(
      await subtle.decrypt({ name: 'AES-GCM', iv: bs(nonce), additionalData: enc.encode(ad) }, key, bs(unb64(v.ciphertext))),
    );
  } catch {
    throw new VaultError('corrupt', 'a value cannot be decrypted');
  }
}

/** An AES-256-GCM key of raw, which is wiped. Not extractable unless asked
 * for (a key that is wrapped for an authenticator). */
export async function importKey(raw: Uint8Array, extractable = false): Promise<Key> {
  try {
    return await subtle.importKey('raw', bs(raw), 'AES-GCM', extractable, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

/** The key of passphrase with k's parameters (Argon2id, 32 bytes). */
export function derive(passphrase: string, k: KDF, extractable = false): Promise<Key> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(passphrase, 'utf8'),
        nonce: unb64(k.salt),
        parallelism: k.threads,
        tagLength: 32,
        memory: k.memory,
        passes: k.time,
      },
      (err, raw) => (err ? reject(err) : resolve(importKey(raw, extractable))),
    );
  });
}

/** HKDF-SHA256 of 32 bytes (the KEKs' and the relay key's derivation). */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

/** A key-encryption key: AES-256-GCM that wraps and unwraps, of raw (wiped). */
export async function kekKey(raw: Uint8Array): Promise<Key> {
  try {
    return await subtle.importKey('raw', bs(raw), 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
  } finally {
    raw.fill(0);
  }
}

/** key (extractable) sealed under kek with ad: the same bytes as seal of
 * its raw bytes, which never reach JavaScript. */
export async function wrap(kek: Key, key: Key, ad: string): Promise<Sealed> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const c = await subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(ad) });
  return { nonce: b64(nonce), ciphertext: b64(new Uint8Array(c)) };
}

/** The key w wraps under kek, not extractable; null when it does not open. */
export async function unwrap(kek: Key, w: Sealed, ad: string): Promise<Key | null> {
  try {
    return await subtle.unwrapKey(
      'raw',
      bs(unb64(w.ciphertext)),
      kek,
      { name: 'AES-GCM', iv: bs(unb64(w.nonce)), additionalData: enc.encode(ad) },
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return null;
  }
}

/** A new P-256 key pair whose private half cannot leave WebCrypto, and the
 * ECDH secret with pub (X9.63 uncompressed); null for a point not on the
 * curve. The private half is dropped with the pair. */
export async function ecdhEphemeral(pub: Uint8Array): Promise<{ z: Buffer; ephPub: Buffer } | null> {
  let peer: Key;
  try {
    peer = await subtle.importKey('raw', bs(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    return null;
  }
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const z = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
  return { z, ephPub: Buffer.from(await subtle.exportKey('raw', eph.publicKey)) };
}

/** Whether b is a P-256 point (X9.63 uncompressed, 65 bytes). */
export function validPoint(b: Uint8Array): boolean {
  if (b.length !== 65 || b[0] !== 4) return false;
  const c = (from: number, to: number) => Buffer.from(b.subarray(from, to)).toString('base64url');
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: c(1, 33), y: c(33, 65) }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

/** A serial section for async work: run's functions run one at a time, in
 * the order they asked (Go's sync.Mutex around work that awaits). */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise((r) => (release = r));
    return prev.then(fn).finally(release);
  }
}

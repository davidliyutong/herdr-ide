// The relay: what the shell hands the hub through the page for the
// variable vault's unlock keys (a Secure Enclave secret, a Windows Hello
// signature, this install's shellSecret). It is sealed with AES-256-GCM under
// a key derived from the verify key of this launch, which only this process
// and the hub hold, so the page passes it on without reading it. The
// additional data names the purpose, the nonce and the hub's unlock entry,
// so a relay made for one cannot be used for another.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** The relay's purposes, as the hub names its nonces. */
export type RelayPurpose = 'session' | 'register';

/** The relay key: HKDF-SHA256 of the verify key's hex string (its UTF-8
 * bytes), no salt, info "vault-relay v1". */
export function relayKey(verifyKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(verifyKey, 'utf8'), Buffer.alloc(0), 'vault-relay v1', 32));
}

/** The additional data of a relay; the entry is "" for register. */
export function relayAD(purpose: RelayPurpose, nonce: string, entry: string): Buffer {
  return Buffer.from(`vault-relay\n${purpose}\n${nonce}\n${entry}`, 'utf8');
}

const IV = 12;
const TAG = 16;

/** Seals plaintext for the hub: base64url (no padding) of iv ‖ ciphertext ‖
 * tag. The iv is random unless given (the vectors fix it). */
export function sealRelay(
  key: Buffer,
  purpose: RelayPurpose,
  nonce: string,
  entry: string,
  plaintext: Buffer,
  iv = randomBytes(IV),
): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(relayAD(purpose, nonce, entry));
  const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString('base64url');
}

/** Opens a relay sealed for purpose, nonce and entry; null when it does not
 * open. The hub does this; the shell only in its tests. */
export function openRelay(key: Buffer, purpose: RelayPurpose, nonce: string, entry: string, relay: string): Buffer | null {
  const sealed = fromBase64url(relay);
  if (!sealed || sealed.length < IV + TAG) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV));
    decipher.setAAD(relayAD(purpose, nonce, entry));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(IV, sealed.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of unpadded base64url text, or null for anything else (padding,
 * other alphabets, a length no encoding has, non-canonical trailing bits). */
export function fromBase64url(text: unknown, maxBytes = 1 << 20): Buffer | null {
  if (typeof text !== 'string' || text.length > Math.ceil((maxBytes * 4) / 3) || !BASE64URL.test(text) || text.length % 4 === 1)
    return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text && bytes.length <= maxBytes ? bytes : null;
}

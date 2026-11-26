// WebAuthn for the vault's authenticators, on @simplewebauthn/server: a
// credential's assertion of a nonce proves the user without the
// passphrase. The page sends what the browser's create() answered through
// getAuthenticatorData() and getPublicKey() (a SubjectPublicKeyInfo) with
// getPublicKeyAlgorithm(), never the attestation object: no attestation is
// parsed (the vault does not ask which authenticator holds the key), and an
// assertion by the new credential proves the key is the authenticator's.
// The Go hub stored the same SubjectPublicKeyInfo, which is turned into
// the COSE key the library verifies with.
//
// Beyond the library's checks: every input is bounded, the client data's
// challenge is compared as bytes, crossOrigin must be absent or false, and
// the user must be present and verified.
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoCBOR, parseAuthenticatorData } from '@simplewebauthn/server/helpers';
import { b64url } from './crypto.ts';

export const ES256 = -7;
export const EDDSA = -8;
export const RS256 = -257;

const MAX_CLIENT_DATA = 4 << 10;
const MAX_AUTH_DATA = 8 << 10;
const MAX_SIGNATURE = 1 << 10;
const MAX_SPKI = 2 << 10;
const MAX_CRED_ID = 1023;

/** What a ceremony must match: the nonce the hub issued, the page's
 * origin and its host name (the relying party). */
export interface Expect {
  challenge: Uint8Array;
  origin: string;
  rpId: string;
}

export class WebAuthnError extends Error {}
const fail = (why: string): never => {
  throw new WebAuthnError(`webauthn: ${why}`);
};

function checkSizes(clientData: Uint8Array, authData: Uint8Array, e: Expect): void {
  if (clientData.length > MAX_CLIENT_DATA) fail('client data too large');
  if (authData.length > MAX_AUTH_DATA) fail('authenticator data too large');
  if (e.challenge.length < 16 || e.challenge.length > 128) fail('expected challenge of 16 to 128 bytes');
}

/** The client data of a ceremony of type, by its exact member names. */
function checkClientData(data: Uint8Array, type: string, e: Expect): void {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return fail('client data is not JSON');
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('client data is not an object');
  if (c.type !== type) fail(`want ${type}`);
  const ch = typeof c.challenge === 'string' && /^[A-Za-z0-9_-]*$/.test(c.challenge) ? Buffer.from(c.challenge, 'base64url') : null;
  // Strict: the text is the canonical encoding of its bytes.
  if (!ch || b64url(ch) !== c.challenge || ch.length !== e.challenge.length || !timingSafeEqual(ch, e.challenge)) fail('challenge');
  if (!e.origin || c.origin !== e.origin) fail('origin');
  if ('crossOrigin' in c && c.crossOrigin !== false) fail('cross-origin ceremony');
}

/** The user present and verified, for rpId. */
function checkAuthData(ad: Uint8Array, e: Expect): ReturnType<typeof parseAuthenticatorData> {
  if (ad.length < 37) fail('authenticator data too short');
  const want = createHash('sha256').update(e.rpId).digest();
  if (!e.rpId || !timingSafeEqual(Buffer.from(ad.subarray(0, 32)), want)) fail('relying party id');
  let p: ReturnType<typeof parseAuthenticatorData>;
  try {
    p = parseAuthenticatorData(new Uint8Array(ad));
  } catch (x) {
    return fail(`authenticator data: ${(x as Error).message}`);
  }
  if (!p.flags.up || !p.flags.uv) fail('user presence or verification missing');
  return p;
}

/** The credential key of SubjectPublicKeyInfo spki for COSE algorithm alg,
 * as COSE; throws when they do not fit (ES256 on P-256, RS256 of 2048 bits
 * at least, EdDSA on Ed25519). */
export function coseKey(alg: number, spki: Uint8Array): Uint8Array {
  if (spki.length > MAX_SPKI) fail('public key too large');
  let k: ReturnType<typeof createPublicKey>;
  try {
    k = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  } catch {
    return fail('public key');
  }
  const jwk = k.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string };
  const b = (s: string | undefined) => new Uint8Array(Buffer.from(s ?? '', 'base64url'));
  let m: Map<number, number | Uint8Array>;
  if (alg === ES256 && jwk.kty === 'EC' && jwk.crv === 'P-256')
    m = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, ES256],
      [-1, 1],
      [-2, b(jwk.x)],
      [-3, b(jwk.y)],
    ]);
  else if (alg === RS256 && jwk.kty === 'RSA' && (k.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048)
    m = new Map<number, number | Uint8Array>([
      [1, 3],
      [3, RS256],
      [-1, b(jwk.n)],
      [-2, b(jwk.e)],
    ]);
  else if (alg === EDDSA && jwk.kty === 'OKP' && jwk.crv === 'Ed25519')
    m = new Map<number, number | Uint8Array>([
      [1, 1],
      [3, EDDSA],
      [-1, 6],
      [-2, b(jwk.x)],
    ]);
  else return fail(`key does not fit algorithm ${alg}`);
  return isoCBOR.encode(m);
}

/** Checks what navigator.credentials.create() answered and returns the new
 * credential's id. */
export function verifyRegistration(clientData: Uint8Array, authData: Uint8Array, e: Expect): Buffer {
  checkSizes(clientData, authData, e);
  checkClientData(clientData, 'webauthn.create', e);
  const p = checkAuthData(authData, e);
  if (!p.flags.at || !p.credentialID) fail('no attested credential data');
  const id = Buffer.from(p.credentialID!);
  if (id.length < 1 || id.length > MAX_CRED_ID) fail('credential id length');
  return id;
}

export interface Assertion {
  credential: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
}

/** Checks navigator.credentials.get() of the credential whose key is spki
 * (COSE algorithm alg) and returns the counter it signed. */
export async function verifyAssertion(alg: number, spki: Uint8Array, a: Assertion, e: Expect): Promise<number> {
  checkSizes(a.clientDataJSON, a.authenticatorData, e);
  if (a.signature.length > MAX_SIGNATURE) fail('signature too large');
  checkClientData(a.clientDataJSON, 'webauthn.get', e);
  checkAuthData(a.authenticatorData, e);
  const publicKey = coseKey(alg, spki);
  const id = b64url(a.credential);
  let r: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    r = await verifyAuthenticationResponse({
      response: {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(a.clientDataJSON),
          authenticatorData: b64url(a.authenticatorData),
          signature: b64url(a.signature),
        },
        clientExtensionResults: {},
      },
      expectedChallenge: b64url(e.challenge),
      expectedOrigin: e.origin,
      expectedRPID: e.rpId,
      credential: { id, publicKey: new Uint8Array(publicKey), counter: 0 },
      requireUserVerification: true,
    });
  } catch (x) {
    return fail((x as Error).message);
  }
  if (!r.verified) fail('signature invalid');
  return r.authenticationInfo.newCounter;
}

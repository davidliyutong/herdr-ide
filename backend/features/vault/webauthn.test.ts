// WebAuthn's checks on @simplewebauthn/server: the three algorithms, every
// refusal the Go core made, and malformed input that only ever fails.
import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { coseKey, EDDSA, ES256, RS256, verifyAssertion, verifyRegistration, WebAuthnError, type Expect } from './webauthn.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const E: Expect = { challenge: randomBytes(32), origin: 'https://vault.example', rpId: 'vault.example' };

function keyOf(alg: number): { spki: Buffer; priv: KeyObject } {
  const pair =
    alg === ES256
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : alg === RS256
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ed25519');
  return { spki: pair.publicKey.export({ format: 'der', type: 'spki' }), priv: pair.privateKey };
}

interface Opts {
  type?: string;
  challenge?: Buffer;
  origin?: string;
  rpId?: string;
  flags?: number;
  count?: number;
  cross?: unknown;
}

function assertion(alg: number, priv: KeyObject, o: Opts = {}) {
  const cd: Record<string, unknown> = {
    type: o.type ?? 'webauthn.get',
    challenge: Buffer.from(o.challenge ?? E.challenge).toString('base64url'),
    origin: o.origin ?? E.origin,
  };
  if ('cross' in o) cd.crossOrigin = o.cross;
  const clientDataJSON = Buffer.from(JSON.stringify(cd));
  const c = Buffer.alloc(4);
  c.writeUInt32BE(o.count ?? 7);
  const authenticatorData = Buffer.concat([sha(o.rpId ?? E.rpId), Buffer.from([o.flags ?? 0x05]), c]);
  const msg = Buffer.concat([authenticatorData, sha(clientDataJSON)]);
  const signature = sign(alg === EDDSA ? null : 'sha256', msg, priv);
  return { credential: Buffer.from('cred'), clientDataJSON, authenticatorData, signature };
}

describe('assertions', () => {
  for (const alg of [ES256, RS256, EDDSA])
    test(`verify with ${alg}`, async () => {
      const { spki, priv } = keyOf(alg);
      expect(await verifyAssertion(alg, spki, assertion(alg, priv), E)).toBe(7);
    });

  test('every check refuses', async () => {
    const { spki, priv } = keyOf(ES256);
    const refused = async (o: Opts, e: Expect = E, a = assertion(ES256, priv, o)) =>
      expect(verifyAssertion(ES256, spki, a, e)).rejects.toBeInstanceOf(WebAuthnError);
    await refused({ type: 'webauthn.create' });
    await refused({ challenge: randomBytes(32) });
    await refused({ origin: 'https://other.example' });
    await refused({ cross: true });
    await refused({ cross: 'false' });
    await refused({ rpId: 'other.example' });
    await refused({ flags: 0x01 }); // present, not verified
    await refused({ flags: 0x04 });
    await refused({}, { ...E, challenge: randomBytes(8) });
    const a = assertion(ES256, priv);
    a.signature[a.signature.length - 1] ^= 1;
    await refused({}, E, a);
    // Another algorithm's or a weaker key.
    await expect(verifyAssertion(RS256, spki, assertion(ES256, priv), E)).rejects.toBeInstanceOf(WebAuthnError);
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => coseKey(RS256, weak.publicKey.export({ format: 'der', type: 'spki' }))).toThrow(WebAuthnError);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    expect(() => coseKey(ES256, p384.publicKey.export({ format: 'der', type: 'spki' }))).toThrow(WebAuthnError);
    // crossOrigin false passes.
    expect(await verifyAssertion(ES256, spki, assertion(ES256, priv, { cross: false }), E)).toBe(7);
  });

  test('malformed input only fails', async () => {
    const { spki, priv } = keyOf(ES256);
    const good = assertion(ES256, priv);
    for (let i = 0; i < 200; i++) {
      const a = { ...good };
      const k = (['clientDataJSON', 'authenticatorData', 'signature'] as const)[i % 3];
      a[k] = i % 2 ? randomBytes(i) : Buffer.concat([a[k].subarray(0, i % a[k].length), randomBytes(3)]);
      const r = await verifyAssertion(ES256, spki, a, E).then(
        () => 'ok',
        (e) => e,
      );
      expect(r).toBeInstanceOf(WebAuthnError);
    }
    expect(verifyAssertion(ES256, randomBytes(91), good, E)).rejects.toBeInstanceOf(WebAuthnError);
  });
});

test('registrations name their credential', () => {
  const cd = (type = 'webauthn.create') =>
    Buffer.from(JSON.stringify({ type, challenge: Buffer.from(E.challenge).toString('base64url'), origin: E.origin }));
  const ad = (flags: number, id = Buffer.from('credential-id')) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    // A COSE key of the credential (an empty map does as well for the id).
    return Buffer.concat([sha(E.rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, Buffer.from([0xa0])]);
  };
  expect(verifyRegistration(cd(), ad(0x45), E).toString()).toBe('credential-id');
  expect(() => verifyRegistration(cd('webauthn.get'), ad(0x45), E)).toThrow(WebAuthnError);
  expect(() => verifyRegistration(cd(), ad(0x05), E)).toThrow(WebAuthnError); // no attested data
  expect(() => verifyRegistration(cd(), ad(0x41), E)).toThrow(WebAuthnError); // not verified
  expect(() => verifyRegistration(cd(), ad(0x45, Buffer.alloc(0)), E)).toThrow(WebAuthnError);
});

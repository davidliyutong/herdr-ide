import assert from 'node:assert/strict';
import { createECDH, hkdfSync } from 'node:crypto';
import test from 'node:test';
import kek from '../../spec/vectors/vault-unlock/kek.json';
import vectors from '../../spec/vectors/vault-unlock/relay.json';
import { fromBase64url, openRelay, relayAD, relayKey, sealRelay, type RelayPurpose } from './relay';

const b = (s: string) => Buffer.from(s, 'base64url');

test('the relay key is the vectors’ (HKDF of the verify key’s hex text)', () => {
  assert.equal(relayKey(vectors.verifyKey).toString('base64url'), vectors.relayKey);
});

test('every vector opens with its purpose, nonce and entry, and seals to the same bytes with its iv', () => {
  const key = relayKey(vectors.verifyKey);
  for (const v of vectors.relays) {
    const purpose = v.purpose as RelayPurpose;
    assert.equal(relayAD(purpose, v.nonce, v.id).toString('utf8'), v.ad);
    assert.equal(openRelay(key, purpose, v.nonce, v.id, v.relay)?.toString('utf8'), v.plaintext);
    assert.equal(sealRelay(key, purpose, v.nonce, v.id, Buffer.from(v.plaintext, 'utf8'), b(v.iv)), v.relay);
  }
});

test('a relay does not open for another purpose, nonce, entry or key, nor changed', () => {
  const key = relayKey(vectors.verifyKey);
  const [v] = vectors.relays;
  assert.equal(openRelay(key, 'register', v.nonce, v.id, v.relay), null);
  assert.equal(openRelay(key, 'session', 'B' + v.nonce.slice(1), v.id, v.relay), null);
  assert.equal(openRelay(key, 'session', v.nonce, 'u2', v.relay), null);
  assert.equal(openRelay(key, 'session', v.nonce, '', v.relay), null);
  assert.equal(openRelay(relayKey('00' + vectors.verifyKey.slice(2)), 'session', v.nonce, v.id, v.relay), null);
  const bytes = b(v.relay);
  for (const at of [0, 12, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[at] ^= 1;
    assert.equal(openRelay(key, 'session', v.nonce, v.id, changed.toString('base64url')), null, `byte ${at}`);
  }
  for (const bad of ['', 'AAAA', v.relay + '=', v.relay.replace(/-/g, '+')])
    assert.equal(openRelay(key, 'session', v.nonce, v.id, bad), null);
});

test('sealing uses a random iv and round-trips', () => {
  const key = relayKey('ab'.repeat(32));
  const plaintext = Buffer.from('{"invalidated":true}');
  const one = sealRelay(key, 'session', 'n'.repeat(43), 'E'.repeat(22), plaintext);
  const two = sealRelay(key, 'session', 'n'.repeat(43), 'E'.repeat(22), plaintext);
  assert.notEqual(one, two);
  assert.match(one, /^[A-Za-z0-9_-]+$/);
  assert.equal(b(one).length, 12 + plaintext.length + 16);
  assert.deepEqual(openRelay(key, 'session', 'n'.repeat(43), 'E'.repeat(22), two), plaintext);
  assert.deepEqual(openRelay(key, 'register', 'n'.repeat(43), '', sealRelay(key, 'register', 'n'.repeat(43), '', plaintext)), plaintext);
});

test('the enclave vector’s Z is the P-256 ECDH of its keys, both ways, with X9.63 public keys', () => {
  const se = createECDH('prime256v1');
  se.setPrivateKey(b(kek.enclave.sePriv));
  const eph = createECDH('prime256v1');
  eph.setPrivateKey(b(kek.enclave.ephPriv));
  assert.equal(se.getPublicKey().toString('base64url'), kek.enclave.sePub);
  assert.equal(eph.getPublicKey().toString('base64url'), kek.enclave.ephPub);
  assert.equal(b(kek.enclave.sePub).length, 65);
  assert.equal(eph.computeSecret(b(kek.enclave.sePub)).toString('base64url'), kek.enclave.z);
  assert.equal(se.computeSecret(b(kek.enclave.ephPub)).toString('base64url'), kek.enclave.z);
});

test('the key-encryption keys of the vectors: HKDF of what the shell relays', () => {
  const hkdf = (ikm: Buffer, salt: Buffer, info: string) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32)).toString('base64url');
  const e = kek.enclave;
  assert.equal(hkdf(Buffer.concat([b(e.z), b(e.shellSecret)]), Buffer.concat([b(e.ephPub), b(e.sePub)]), 'vault-unlock enclave'), e.kek);
  const h = kek.hello;
  assert.equal(hkdf(Buffer.concat([b(h.signature), b(h.shellSecret)]), b(h.challenge), 'vault-unlock hello'), h.kek);
  assert.equal(hkdf(b(kek.prf.output), b(kek.prf.salt), 'vault-unlock prf'), kek.prf.kek);
});

test('base64url is read only unpadded, in its own alphabet, canonical and bounded', () => {
  assert.deepEqual(fromBase64url('AQID'), Buffer.from([1, 2, 3]));
  assert.deepEqual(fromBase64url('AQ'), Buffer.from([1]));
  assert.deepEqual(fromBase64url(''), Buffer.alloc(0));
  assert.deepEqual(fromBase64url('_-8'), Buffer.from([0xff, 0xef]));
  for (const bad of ['AQ==', 'A+8', 'A/8', 'AR', 'A', 'AQID A', 'AQ\n', 5, null, undefined, ['AQ']]) {
    assert.equal(fromBase64url(bad), null, String(bad));
  }
  assert.deepEqual(fromBase64url('AQID', 3), Buffer.from([1, 2, 3]));
  assert.equal(fromBase64url('AQIDBA', 3), null);
  assert.equal(fromBase64url('A'.repeat(1000), 3), null);
});

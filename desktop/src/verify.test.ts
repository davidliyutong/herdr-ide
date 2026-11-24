import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import kek from '../../spec/vectors/vault-unlock/kek.json';
import { APP_SLUG } from '../../web/src/brand';
import { translate } from '../../web/src/i18n';
import type { AgreeResult, Enclave } from './enclave';
import type { Platform } from './platform';
import { openRelay, relayKey } from './relay';
import type { UnlockKeys, UnlockStore } from './unlockStore';
import { clean, helloKeyName, proofMac, verifier, type VerifyDeps } from './verify';
import type { HelloKeys, KeyResult } from './windowsHello';

const key = 'k3'.repeat(20);
const nonce = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123x';
const request = { id: 'r1', machine: 'build-box', target: '', tool: 'run', names: ['A', 'B'] };

test('the MAC matches the core: the same vectors as its proofMessage', () => {
  assert.equal(
    proofMac(key, nonce, { for: 'answer', request, answer: 'once' }),
    '1afd96561024d832a5c57420c354c3f731c098bcd46c5023d75184c846ddb63e',
  );
  assert.equal(proofMac(key, nonce, { for: 'session' }), '699277e0dbc28eea46e8923901d22f826a86be22c8cd2a04ac8a30de0e06a307');
  assert.equal(proofMac(key, nonce, { for: 'register' }), '7776425c6474e2ac900eacbe4962d3f1b4ad33195e2c3bfae40bbc2f32fc1c8a');
});

test('a reveal and a change sign the variable’s name where an answer signs the request id', () => {
  const mac = (message: string) => createHmac('sha256', Buffer.from(key, 'utf8')).update(message).digest('hex');
  const reveal = proofMac(key, nonce, { for: 'reveal', name: 'API_KEY' });
  const change = proofMac(key, nonce, { for: 'change', name: 'API_KEY' });
  assert.equal(reveal, mac(`vault-proof\n${nonce}\nreveal\nAPI_KEY\n`));
  assert.equal(change, mac(`vault-proof\n${nonce}\nchange\nAPI_KEY\n`));
  assert.notEqual(reveal, change);
  assert.notEqual(reveal, proofMac(key, nonce, { for: 'reveal', name: 'OTHER' }));
  assert.notEqual(reveal, proofMac(key, nonce, { for: 'session' }));
});

/** A verifier of a platform, with its prompts recorded; `answer` is what the
 * prompts do. */
function setup(
  over: { platform?: Platform; key?: string; purpose?: unknown; touch?: () => Promise<void>; hello?: boolean; can?: boolean } = {},
) {
  const prompts: string[] = [];
  const fetched: string[] = [];
  const deps: VerifyDeps = {
    platform: over.platform ?? 'darwin',
    canPromptTouchID: () => over.can ?? true,
    promptTouchID: async (reason) => {
      prompts.push(reason);
      await over.touch?.();
    },
    hello: {
      available: async () => over.hello ?? true,
      request: async (message) => {
        prompts.push(message);
        return over.hello ?? true;
      },
    },
    purpose: async (n) => {
      fetched.push(n);
      return 'purpose' in over ? over.purpose : { for: 'session', answer: '' };
    },
    t: (k, vars) => translate('en', k, vars),
  };
  return { v: verifier(over.key ?? key, deps), prompts, fetched };
}

test('which prompt there is: Touch ID on macOS, Hello on Windows, none else or without a key', async () => {
  assert.equal(await setup().v.available(), 'touchid');
  assert.equal(await setup({ can: false }).v.available(), null);
  assert.equal(await setup({ platform: 'win32' }).v.available(), 'hello');
  assert.equal(await setup({ platform: 'win32', hello: false }).v.available(), null);
  assert.equal(await setup({ platform: 'linux' }).v.available(), null);
  assert.equal(await setup({ key: '' }).v.available(), null);
  assert.equal(await setup({ key: '', platform: 'win32' }).v.available(), null);
});

const answer = (a: string, over: object = {}) => ({ for: 'answer', answer: a, request: { ...request, ...over } });

test('a confirmed prompt gives the MAC, and its text names what is approved', async () => {
  const cases: Array<[Platform, unknown, string, Parameters<typeof proofMac>[2]]> = [
    ['darwin', { for: 'session', answer: '' }, 'open the variable vault', { for: 'session' }],
    ['darwin', { for: 'register', answer: '' }, 'turn on Touch ID for the variable vault', { for: 'register' }],
    ['darwin', answer('once'), 'allow build-box to read A, B once', { for: 'answer', answer: 'once', request }],
    ['darwin', answer('always'), 'allow build-box to always read A, B', { for: 'answer', answer: 'always', request }],
    ['win32', { for: 'session', answer: '' }, 'Confirm to open the variable vault.', { for: 'session' }],
    ['win32', { for: 'register', answer: '' }, 'Confirm to turn on Windows Hello for the variable vault.', { for: 'register' }],
    ['win32', answer('once'), 'Confirm to allow build-box to read A, B once.', { for: 'answer', answer: 'once', request }],
    ['win32', answer('always'), 'Confirm to allow build-box to always read A, B.', { for: 'answer', answer: 'always', request }],
    [
      'darwin',
      { for: 'reveal', answer: '', name: 'API_KEY' },
      'show the value of API_KEY in the variable vault',
      { for: 'reveal', name: 'API_KEY' },
    ],
    [
      'darwin',
      { for: 'change', answer: '', name: 'API_KEY' },
      'let more machines read API_KEY in the variable vault',
      { for: 'change', name: 'API_KEY' },
    ],
    [
      'win32',
      { for: 'reveal', name: 'API_KEY' },
      'Confirm to show the value of API_KEY in the variable vault.',
      { for: 'reveal', name: 'API_KEY' },
    ],
    [
      'win32',
      { for: 'change', name: 'API_KEY' },
      'Confirm to let more machines read API_KEY in the variable vault.',
      { for: 'change', name: 'API_KEY' },
    ],
  ];
  for (const [platform, purpose, text, p] of cases) {
    const { v, prompts, fetched } = setup({ platform, purpose });
    assert.equal(await v.prove(nonce), proofMac(key, nonce, p), text);
    assert.deepEqual(prompts, [text]);
    assert.deepEqual(fetched, [nonce]);
  }
});

test('a malformed nonce is refused before anything is asked', async () => {
  for (const bad of [
    undefined,
    null,
    5,
    {},
    ['x'.repeat(30)],
    '',
    'short',
    'x'.repeat(129),
    nonce + '!',
    nonce + '\n',
    'a b'.padEnd(30, 'c'),
  ]) {
    const { v, prompts, fetched } = setup();
    assert.equal(await v.prove(bad), null);
    assert.deepEqual([prompts, fetched], [[], []]);
  }
  assert.notEqual(await setup().v.prove('x'.repeat(128)), null);
  assert.notEqual(await setup().v.prove('x'.repeat(20)), null);
});

test('without a key, on another system or without the prompt there is no proof and no question', async () => {
  for (const o of [{ key: '' }, { platform: 'linux' as const }, { can: false }]) {
    const { v, prompts, fetched } = setup(o);
    assert.equal(await v.prove(nonce), null);
    assert.deepEqual([prompts, fetched], [[], []]);
  }
});

test('an unknown nonce and every malformed purpose give null without a prompt', async () => {
  const bad: unknown[] = [
    undefined,
    null,
    'session',
    [],
    {},
    { for: 'unlock' },
    { for: 'session', request: {} },
    { for: 'session', answer: 'once' },
    { for: 'register', answer: 'always' },
    { for: 'answer' },
    { for: 'answer', answer: 'once' },
    { for: 'answer', answer: 'sometimes', request },
    { for: 'answer', answer: '', request },
    { for: 'answer', answer: 'once', request: null },
    { for: 'answer', answer: 'once', request: 'r1' },
    answer('once', { id: 1 }),
    answer('once', { id: undefined }),
    answer('once', { machine: 3 }),
    answer('once', { tool: null }),
    answer('once', { names: 'A' }),
    answer('once', { names: ['A', 2] }),
    answer('once', { names: [] }),
    answer('once', { target: undefined }),
    answer('once', { target: 5 }),
    { ...answer('once'), name: 'A' },
    { for: 'session', name: 'A' },
    { for: 'reveal' },
    { for: 'reveal', name: '' },
    { for: 'reveal', name: '1ABC' },
    { for: 'reveal', name: 'A-B' },
    { for: 'reveal', name: 'A B' },
    { for: 'reveal', name: 'A\n' },
    { for: 'reveal', name: 'A'.repeat(65) },
    { for: 'reveal', name: ['A'] },
    { for: 'change', name: 'A', request },
    { for: 'change', name: 'A', answer: 'once' },
    { for: 'change', request: 'A' },
    answer('once', { names: Array.from({ length: 17 }, (_, i) => `N${i}`) }),
  ];
  for (const purpose of bad) {
    const { v, prompts } = setup({ purpose });
    assert.equal(await v.prove(nonce), null, JSON.stringify(purpose));
    assert.deepEqual(prompts, []);
  }
  assert.notEqual(await setup({ purpose: answer('once', { names: Array.from({ length: 16 }, (_, i) => `N${i}`) }) }).v.prove(nonce), null);
  assert.notEqual(await setup({ purpose: { for: 'reveal', name: 'A'.repeat(64) } }).v.prove(nonce), null);
});

test('a purpose that cannot be fetched gives null', async () => {
  const prompts: string[] = [];
  const v = verifier(key, {
    platform: 'darwin',
    canPromptTouchID: () => true,
    promptTouchID: async (r) => void prompts.push(r),
    hello: { available: async () => false, request: async () => false },
    purpose: async () => {
      throw new Error('offline');
    },
    t: (k) => k,
  });
  assert.equal(await v.prove(nonce), null);
  assert.deepEqual(prompts, []);
});

test('a prompt the user cancelled or that failed gives null, on both systems', async () => {
  const cancelled = setup({
    touch: async () => {
      throw new Error('User canceled');
    },
  });
  assert.equal(await cancelled.v.prove(nonce), null);
  assert.equal(cancelled.prompts.length, 1);
  // Hello answers false for the user's no.
  const refusing = verifier(key, {
    platform: 'win32',
    canPromptTouchID: () => false,
    promptTouchID: async () => {},
    hello: { available: async () => true, request: async () => false },
    purpose: async () => ({ for: 'session', answer: '' }),
    t: (k) => k,
  });
  assert.equal(await refusing.prove(nonce), null);
  // After a failure the next try runs.
  assert.notEqual(await setup().v.prove(nonce), null);
});

test('a machine label and names are cleaned and cut before they go in a prompt', async () => {
  assert.equal(clean('a\nb\u0000c\u202Ed\t e', 60), 'a b c d e');
  assert.equal(clean('x'.repeat(61), 60), 'x'.repeat(59) + '…');
  assert.equal(clean('x'.repeat(60), 60), 'x'.repeat(60));
  assert.equal(clean('😀'.repeat(61), 60), '😀'.repeat(59) + '…');
  const { v, prompts } = setup({
    purpose: answer('once', {
      machine: 'evil\nAllow everything\u202E' + 'm'.repeat(100),
      names: ['A\r\nB', 'n'.repeat(100), 'z'.repeat(100)],
    }),
  });
  assert.notEqual(await v.prove(nonce), null);
  const [text] = prompts;
  assert.ok(!/[\u0000-\u001f\u202e]/.test(text));
  const machine = /^allow (.*) to read /.exec(text)![1];
  assert.equal(Array.from(machine).length, 60);
  assert.ok(machine.startsWith('evil Allow everything'));
  // The first two names fit; the third would pass 120 characters and is counted.
  assert.match(text, / to read A B, n{100} and 1 more once$/);
});

test('names are never cut silently: as many as fit in 120 characters, then how many more', async () => {
  const many = Array.from({ length: 16 }, (_, i) => `NAME_${String(i).padStart(2, '0')}`);
  // Seven characters each, joined by ", ": 13 names take 13*7 + 12*2 = 115, a 14th would pass 120.
  const { v, prompts } = setup({ purpose: answer('once', { names: many }) });
  assert.notEqual(await v.prove(nonce), null);
  assert.match(prompts[0], new RegExp(`^allow build-box to read ${many.slice(0, 13).join(', ')} and 3 more once$`));
  const exact = setup({ purpose: answer('once', { names: ['a'.repeat(59), 'b'.repeat(59)] }), platform: 'win32' });
  assert.notEqual(await exact.v.prove(nonce), null);
  assert.equal(exact.prompts[0], `Confirm to allow build-box to read ${'a'.repeat(59)}, ${'b'.repeat(59)} once.`);
  const over = setup({ purpose: answer('once', { names: ['a'.repeat(60), 'b'.repeat(60)] }) });
  assert.notEqual(await over.v.prove(nonce), null);
  assert.equal(over.prompts[0], `allow build-box to read ${'a'.repeat(60)} and 1 more once`);
  // One name longer than the room is cut with the mark, and the rest counted.
  const long = setup({ purpose: answer('once', { names: ['c'.repeat(200), 'd'] }) });
  assert.notEqual(await long.v.prove(nonce), null);
  assert.equal(long.prompts[0], `allow build-box to read ${'c'.repeat(119)}… and 1 more once`);
});

test('the machine is its label, then its ssh address in parentheses when that differs', async () => {
  const text = async (platform: Platform, machine: string, target: string) => {
    const { v, prompts } = setup({ platform, purpose: answer('once', { machine, target }) });
    assert.notEqual(await v.prove(nonce), null);
    return prompts[0];
  };
  assert.equal(await text('darwin', 'build-box', ''), 'allow build-box to read A, B once');
  assert.equal(await text('darwin', 'build-box', 'build-box'), 'allow build-box to read A, B once');
  assert.equal(await text('darwin', 'build-box', 'me@10.0.0.5'), 'allow build-box (me@10.0.0.5) to read A, B once');
  assert.equal(await text('win32', 'prod', 'root@evil.example'), 'Confirm to allow prod (root@evil.example) to read A, B once.');
  // Both are cleaned: a label that says another address cannot hide the real one.
  assert.equal(await text('darwin', 'me@safe\nhost', 'me@evil.example\u202E'), 'allow me@safe host (me@evil.example) to read A, B once');
  const long = await text('darwin', 'x'.repeat(100), 'y'.repeat(100));
  assert.equal(long, `allow ${'x'.repeat(59)}… (${'y'.repeat(59)}…) to read A, B once`);
});

test('a call while a prompt is open gives null; the next one after it runs', async () => {
  let release = () => {};
  const open = new Promise<void>((r) => (release = r));
  const { v, prompts, fetched } = setup({ touch: () => open });
  const first = v.prove(nonce);
  assert.equal(await v.prove(nonce), null);
  assert.equal(await v.prove(nonce + 'y'), null);
  release();
  assert.equal(await first, proofMac(key, nonce, { for: 'session' }));
  assert.equal(prompts.length, 1);
  assert.equal(fetched.length, 1);
  assert.notEqual(await v.prove(nonce), null);
});

// The vault's unlock key: the Secure Enclave on macOS, Hello keys on Windows.

const sePub = Buffer.from(kek.enclave.sePub, 'base64url');
const ephPub = Buffer.from(kek.enclave.ephPub, 'base64url');
const install = 'install-0123456789ab';
const otherInstall = 'install-of-another-mac';
const ownId = 'E'.repeat(22);
const otherId = 'F'.repeat(22);
const shellSecret = Buffer.alloc(32, 9);
const z = Buffer.alloc(32, 5);
const challenge = Buffer.alloc(32, 3);
const signature = Buffer.alloc(256, 4);
const helloPub = Buffer.alloc(294, 6);

const enclaveEntry = (id: string, inst: string, blob = `blob of ${inst}`) => ({
  id,
  kind: 'enclave',
  install: inst,
  enclave: { blob: Buffer.from(blob).toString('base64url'), ephPub: kek.enclave.ephPub },
});
const helloEntry = (id: string, inst: string) => ({
  id,
  kind: 'hello',
  install: inst,
  hello: { keyName: helloKeyName(inst), challenge: challenge.toString('base64url') },
});
const sessionLocked = (...unlock: object[]) => ({ for: 'session', answer: '', unlock });
const register = { for: 'register', answer: '', register: { challenge: challenge.toString('base64url') } };

interface UnlockOver {
  platform?: Platform;
  key?: string;
  purpose?: unknown;
  can?: boolean;
  enclave?: { enclave: boolean; biometry: boolean };
  agree?: (blob: Buffer, peer: Buffer, reason: string) => Promise<AgreeResult>;
  create?: () => Promise<{ blob: Buffer; pub: Buffer } | null>;
  touch?: () => Promise<void>;
  supported?: boolean;
  helloCreate?: (name: string) => Promise<KeyResult>;
  helloSign?: (name: string, challenge: Buffer) => Promise<KeyResult>;
  safe?: boolean;
  keys?: UnlockKeys | null;
}

/** A verifier with fakes of the helper, Hello keys, the store and the
 * purpose, and what each was asked. */
function unlockSetup(over: UnlockOver = {}) {
  const log: string[] = [];
  const agreed: Array<{ blob: string; peer: string; reason: string }> = [];
  const signed: Array<{ name: string; challenge: string }> = [];
  const enclave: Enclave = {
    available: async () => over.enclave ?? { enclave: true, biometry: true },
    create: async () => {
      log.push('create');
      return over.create ? over.create() : { blob: Buffer.from('new blob'), pub: sePub };
    },
    agree: async (blob, peer, reason) => {
      log.push('agree');
      agreed.push({ blob: blob.toString(), peer: peer.toString('base64url'), reason });
      return over.agree ? over.agree(blob, peer, reason) : { ok: true, secret: Buffer.from(z) };
    },
  };
  const helloKeys: HelloKeys = {
    supported: async () => over.supported ?? true,
    create: async (name) => {
      log.push(`hello-create ${name}`);
      return over.helloCreate ? over.helloCreate(name) : { ok: true, value: Buffer.from(helloPub) };
    },
    sign: async (name, c) => {
      log.push(`hello-sign ${name}`);
      signed.push({ name, challenge: c.toString('base64url') });
      return over.helloSign ? over.helloSign(name, c) : { ok: true, value: Buffer.from(signature) };
    },
  };
  const keys = () =>
    'keys' in over ? over.keys && { ...over.keys, secret: Buffer.from(over.keys.secret) } : { install, secret: Buffer.from(shellSecret) };
  const unlockStore: UnlockStore = {
    available: async () => over.safe ?? true,
    load: async () => {
      log.push('load');
      return keys() ?? null;
    },
    loadOrCreate: async () => {
      log.push('loadOrCreate');
      return keys() ?? null;
    },
  };
  const deps: VerifyDeps = {
    platform: over.platform ?? 'darwin',
    canPromptTouchID: () => over.can ?? true,
    promptTouchID: async (reason) => {
      log.push(`touch ${reason}`);
      await over.touch?.();
    },
    hello: {
      available: async () => true,
      request: async (message) => {
        log.push(`consent ${message}`);
        return true;
      },
    },
    purpose: async () =>
      'purpose' in over ? over.purpose : sessionLocked(enclaveEntry(otherId, otherInstall), enclaveEntry(ownId, install)),
    t: (k, vars) => translate('en', k, vars),
    enclave,
    helloKeys,
    unlockStore,
  };
  return { v: verifier(over.key ?? key, deps), log, agreed, signed };
}

/** The relay's plaintext as the core would open it. */
function opened(purpose: 'session' | 'register', entry: string, relay: string): unknown {
  const plain = openRelay(relayKey(key), purpose, nonce, entry, relay);
  assert.ok(plain, 'the relay opens for its purpose, nonce and entry');
  return JSON.parse(plain.toString('utf8'));
}

test('canUnlock: the Enclave with Touch ID on macOS, Hello keys on Windows, each with safeStorage and the key', async () => {
  assert.equal(await unlockSetup().v.canUnlock(), true);
  assert.equal(await unlockSetup({ enclave: { enclave: true, biometry: false } }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ enclave: { enclave: false, biometry: true } }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ safe: false }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ key: '' }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ platform: 'win32' }).v.canUnlock(), true);
  assert.equal(await unlockSetup({ platform: 'win32', supported: false }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ platform: 'win32', safe: false }).v.canUnlock(), false);
  assert.equal(await unlockSetup({ platform: 'linux' }).v.canUnlock(), false);
  // Without the helper or Hello keys in the deps there is no unlock.
  const bare = setup();
  assert.equal(await bare.v.canUnlock(), false);
  assert.equal(await bare.v.unlock(nonce), null);
  assert.equal(await bare.v.enroll(nonce), null);
});

test('unlock on macOS: the entry of this install, chosen by the shell, a Touch ID prompt, and the relay of Z and the shellSecret', async () => {
  const { v, log, agreed } = unlockSetup();
  const got = await v.unlock(nonce);
  assert.ok(got && got !== 'none');
  assert.equal(got.id, ownId);
  assert.deepEqual(agreed, [{ blob: `blob of ${install}`, peer: kek.enclave.ephPub, reason: 'open the variable vault' }]);
  assert.deepEqual(log, ['load', 'agree']);
  assert.deepEqual(opened('session', ownId, got.relay), { z: z.toString('base64url'), shellSecret: shellSecret.toString('base64url') });
  // The relay does not open for the other entry or another purpose.
  assert.equal(openRelay(relayKey(key), 'session', nonce, otherId, got.relay), null);
  assert.equal(openRelay(relayKey(key), 'register', nonce, ownId, got.relay), null);
});

test('unlock on Windows: this install’s Hello key signs the entry’s challenge; the relay carries the signature', async () => {
  const { v, signed } = unlockSetup({
    platform: 'win32',
    purpose: sessionLocked(helloEntry(otherId, otherInstall), helloEntry(ownId, install)),
  });
  const got = await v.unlock(nonce);
  assert.ok(got && got !== 'none');
  assert.equal(got.id, ownId);
  assert.deepEqual(signed, [{ name: `${APP_SLUG}-vault-${install}`, challenge: challenge.toString('base64url') }]);
  assert.deepEqual(opened('session', ownId, got.relay), {
    signature: signature.toString('base64url'),
    shellSecret: shellSecret.toString('base64url'),
  });
  // A macOS entry is not a Windows one.
  const mixed = unlockSetup({ platform: 'win32', purpose: sessionLocked(enclaveEntry(ownId, install)) });
  assert.equal(await mixed.v.unlock(nonce), 'none');
  assert.deepEqual(mixed.signed, []);
});

test('a key the system no longer has gives a relay that says so; a cancel or a failure gives null', async () => {
  const gone = unlockSetup({ agree: async () => ({ ok: false, error: 'invalidated' }) });
  const got = await gone.v.unlock(nonce);
  assert.ok(got && got !== 'none');
  assert.deepEqual(opened('session', ownId, got.relay), { invalidated: true });
  const helloGone = unlockSetup({
    platform: 'win32',
    purpose: sessionLocked(helloEntry(ownId, install)),
    helloSign: async () => ({ ok: false, error: 'invalidated' }),
  });
  const helloGot = await helloGone.v.unlock(nonce);
  assert.ok(helloGot && helloGot !== 'none');
  assert.deepEqual(opened('session', ownId, helloGot.relay), { invalidated: true });
  for (const error of ['cancel', 'unavailable', 'failed'] as const) {
    assert.equal(await unlockSetup({ agree: async () => ({ ok: false, error }) }).v.unlock(nonce), null, error);
  }
  for (const error of ['cancel', 'failed'] as const) {
    const s = unlockSetup({
      platform: 'win32',
      purpose: sessionLocked(helloEntry(ownId, install)),
      helloSign: async () => ({ ok: false, error }),
    });
    assert.equal(await s.v.unlock(nonce), null, error);
  }
  const throwing = unlockSetup({
    agree: async () => {
      throw new Error('helper gone');
    },
  });
  assert.equal(await throwing.v.unlock(nonce), null);
});

test('no entry of this install, no keys of its own: none without a prompt; no safeStorage or no way: null', async () => {
  for (const [over, want] of [
    [{ purpose: sessionLocked(enclaveEntry(otherId, otherInstall)) }, 'none'],
    [{ purpose: sessionLocked() }, 'none'],
    [{ keys: null }, 'none'],
    [{ keys: { install: otherInstall + 'x', secret: shellSecret } }, 'none'],
    [{ platform: 'win32' as const, purpose: sessionLocked(enclaveEntry(ownId, install)) }, 'none'],
    [{ safe: false }, null],
    [{ platform: 'linux' as const }, null],
  ] as const) {
    const { v, agreed, signed } = unlockSetup(over);
    assert.equal(await v.unlock(nonce), want, JSON.stringify(over));
    assert.deepEqual([agreed, signed], [[], []]);
  }
});

test('unlock takes only a session nonce of a locked vault with entries of exactly the core’s shape', async () => {
  const own = enclaveEntry(ownId, install);
  const bad: unknown[] = [
    undefined,
    { for: 'session', answer: '' },
    register,
    { for: 'register', answer: '', unlock: [own] },
    { for: 'session', answer: '', unlock: own },
    { for: 'session', answer: '', unlock: [own], register: register.register },
    { for: 'session', answer: 'once', unlock: [own] },
    sessionLocked({ ...own, id: 'E'.repeat(21) }),
    sessionLocked({ ...own, id: 'E'.repeat(23) }),
    sessionLocked({ ...own, id: 'E'.repeat(21) + '+' }),
    sessionLocked({ ...own, install: 'short' }),
    sessionLocked({ ...own, kind: 'prf' }),
    sessionLocked({ ...own, extra: 1 }),
    sessionLocked({ ...own, hello: helloEntry(ownId, install).hello }),
    sessionLocked({ ...own, enclave: { ...own.enclave, extra: 1 } }),
    sessionLocked({ ...own, enclave: { blob: own.enclave.blob } }),
    sessionLocked({ ...own, enclave: { ...own.enclave, blob: '' } }),
    sessionLocked({ ...own, enclave: { ...own.enclave, blob: 'not base64!' } }),
    sessionLocked({ ...own, enclave: { ...own.enclave, ephPub: ephPub.subarray(0, 64).toString('base64url') } }),
    sessionLocked({
      ...own,
      enclave: { ...own.enclave, ephPub: Buffer.concat([Buffer.from([2]), ephPub.subarray(1)]).toString('base64url') },
    }),
    sessionLocked({ ...own, enclave: { ...own.enclave, ephPub: ephPub.toString('base64') } }),
    { for: 'session', answer: '', unlock: [own, 'entry'] },
    sessionLocked(
      own,
      enclaveEntry(otherId, otherInstall),
      enclaveEntry('G'.repeat(22), 'install-third-one'),
      enclaveEntry('H'.repeat(22), 'install-fourth-one'),
      enclaveEntry('I'.repeat(22), 'install-fifth-one'),
    ),
  ];
  for (const purpose of bad) {
    const { v, agreed } = unlockSetup({ purpose });
    assert.equal(await v.unlock(nonce), null, JSON.stringify(purpose));
    assert.deepEqual(agreed, []);
  }
  const hello = helloEntry(ownId, install);
  for (const purpose of [
    sessionLocked({ ...hello, hello: { ...hello.hello, keyName: `${APP_SLUG}-vault-${otherInstall}` } }),
    sessionLocked({ ...hello, hello: { ...hello.hello, keyName: 'any-key' } }),
    sessionLocked({ ...hello, hello: { ...hello.hello, challenge: Buffer.alloc(31).toString('base64url') } }),
    sessionLocked({ ...hello, hello: { keyName: hello.hello.keyName } }),
  ]) {
    const { v, signed } = unlockSetup({ platform: 'win32', purpose });
    assert.equal(await v.unlock(nonce), null, JSON.stringify(purpose));
    assert.deepEqual(signed, []);
  }
  // Four entries are the most, and fine.
  const four = sessionLocked(
    own,
    enclaveEntry(otherId, otherInstall),
    enclaveEntry('G'.repeat(22), 'install-third-one'),
    helloEntry('H'.repeat(22), 'install-fourth-one'),
  );
  assert.ok(await unlockSetup({ purpose: four }).v.unlock(nonce));
});

test('a session purpose with unlock entries still gives the MAC for a proof', async () => {
  const { v, log } = unlockSetup();
  assert.equal(await v.prove(nonce), proofMac(key, nonce, { for: 'session' }));
  assert.deepEqual(log, ['touch open the variable vault']);
});

test('enroll on macOS: Touch ID first, then a new Enclave key; the MAC and the register relay', async () => {
  const { v, log } = unlockSetup({ purpose: register });
  const got = await v.enroll(nonce);
  assert.ok(got);
  assert.equal(got.mac, proofMac(key, nonce, { for: 'register' }));
  assert.deepEqual(log, ['touch turn on Touch ID for the variable vault', 'loadOrCreate', 'create']);
  assert.deepEqual(opened('register', '', got.relay), {
    kind: 'enclave',
    install,
    sePub: kek.enclave.sePub,
    blob: Buffer.from('new blob').toString('base64url'),
    shellSecret: shellSecret.toString('base64url'),
  });
  // The page cannot pass it off as a session's.
  assert.equal(openRelay(relayKey(key), 'session', nonce, '', got.relay), null);
});

test('enroll on Windows: the Hello key of this install is made and signs the challenge, no third prompt', async () => {
  const { v, log, signed } = unlockSetup({ platform: 'win32', purpose: register });
  const got = await v.enroll(nonce);
  assert.ok(got);
  assert.equal(got.mac, proofMac(key, nonce, { for: 'register' }));
  const name = `${APP_SLUG}-vault-${install}`;
  assert.deepEqual(log, ['loadOrCreate', `hello-create ${name}`, `hello-sign ${name}`]);
  assert.deepEqual(signed, [{ name, challenge: challenge.toString('base64url') }]);
  assert.deepEqual(opened('register', '', got.relay), {
    kind: 'hello',
    install,
    keyName: name,
    publicKey: helloPub.toString('base64url'),
    signature: signature.toString('base64url'),
    shellSecret: shellSecret.toString('base64url'),
  });
});

test('enroll gives null when the user says no, a key cannot be made, or the purpose is not a register with its challenge', async () => {
  const cancelled = unlockSetup({
    purpose: register,
    touch: async () => {
      throw new Error('User canceled');
    },
  });
  assert.equal(await cancelled.v.enroll(nonce), null);
  assert.ok(!cancelled.log.includes('create') && !cancelled.log.includes('loadOrCreate'));
  assert.equal(await unlockSetup({ purpose: register, create: async () => null }).v.enroll(nonce), null);
  assert.equal(await unlockSetup({ purpose: register, keys: null }).v.enroll(nonce), null);
  assert.equal(
    await unlockSetup({ purpose: register, helloCreate: async () => ({ ok: false, error: 'cancel' }), platform: 'win32' }).v.enroll(nonce),
    null,
  );
  assert.equal(
    await unlockSetup({ purpose: register, helloSign: async () => ({ ok: false, error: 'failed' }), platform: 'win32' }).v.enroll(nonce),
    null,
  );
  for (const over of [
    { enclave: { enclave: true, biometry: false } },
    { can: false },
    { safe: false },
    { platform: 'linux' as const },
    { platform: 'win32' as const, supported: false },
  ]) {
    const s = unlockSetup({ purpose: register, ...over });
    assert.equal(await s.v.enroll(nonce), null, JSON.stringify(over));
    assert.ok(!s.log.some((l) => l.startsWith('touch') || l.includes('create')), JSON.stringify(s.log));
  }
  for (const purpose of [
    { for: 'register', answer: '' },
    { for: 'session', answer: '' },
    sessionLocked(enclaveEntry(ownId, install)),
    { ...register, register: { challenge: Buffer.alloc(16).toString('base64url') } },
    { ...register, register: { challenge: challenge.toString('base64url'), extra: 1 } },
    { ...register, register: challenge.toString('base64url') },
    { ...register, unlock: [] },
  ]) {
    const s = unlockSetup({ purpose });
    assert.equal(await s.v.enroll(nonce), null, JSON.stringify(purpose));
    assert.ok(!s.log.some((l) => l.startsWith('touch')), JSON.stringify(s.log));
  }
  // A register purpose without the challenge still gives a proof.
  assert.equal(await unlockSetup({ purpose: { for: 'register', answer: '' } }).v.prove(nonce), proofMac(key, nonce, { for: 'register' }));
});

test('malformed nonces and a missing key give null before anything is asked', async () => {
  for (const bad of [undefined, 5, 'short', nonce + '!']) {
    const { v, log } = unlockSetup();
    assert.equal(await v.unlock(bad), null);
    assert.equal(await v.enroll(bad), null);
    assert.deepEqual(log, []);
  }
  const { v, log } = unlockSetup({ key: '' });
  assert.equal(await v.unlock(nonce), null);
  assert.equal(await v.enroll(nonce), null);
  assert.deepEqual(log, []);
});

test('one prompt at a time across prove, unlock and enroll', async () => {
  let release = () => {};
  const open = new Promise<void>((r) => (release = r));
  const { v, agreed } = unlockSetup({
    agree: async () => {
      await open;
      return { ok: true, secret: Buffer.from(z) };
    },
  });
  const first = v.unlock(nonce);
  assert.equal(await v.unlock(nonce), null);
  assert.equal(await v.prove(nonce), null);
  assert.equal(await v.enroll(nonce), null);
  release();
  const firstGot = await first;
  assert.ok(firstGot && firstGot !== 'none');
  assert.equal(firstGot.id, ownId);
  assert.equal(agreed.length, 1);
  assert.ok(await v.unlock(nonce));
});

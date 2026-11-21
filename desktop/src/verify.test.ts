import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { translate } from '../../web/src/i18n';
import type { Platform } from './platform';
import { clean, proofMac, verifier, type VerifyDeps } from './verify';

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

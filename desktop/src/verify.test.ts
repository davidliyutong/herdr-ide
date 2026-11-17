import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../../web/src/i18n';
import type { Platform } from './platform';
import { clean, proofMac, verifier, type VerifyDeps } from './verify';

const key = 'k3'.repeat(20);
const nonce = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123x';
const request = { id: 'r1', machine: 'build-box', tool: 'run', names: ['A', 'B'] };

test('the MAC matches the core: the same vectors as its proofMessage', () => {
  assert.equal(
    proofMac(key, nonce, { for: 'answer', request, answer: 'once' }),
    '1afd96561024d832a5c57420c354c3f731c098bcd46c5023d75184c846ddb63e',
  );
  assert.equal(proofMac(key, nonce, { for: 'session' }), '699277e0dbc28eea46e8923901d22f826a86be22c8cd2a04ac8a30de0e06a307');
  assert.equal(proofMac(key, nonce, { for: 'register' }), '7776425c6474e2ac900eacbe4962d3f1b4ad33195e2c3bfae40bbc2f32fc1c8a');
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
    answer('once', { names: Array.from({ length: 17 }, (_, i) => `N${i}`) }),
  ];
  for (const purpose of bad) {
    const { v, prompts } = setup({ purpose });
    assert.equal(await v.prove(nonce), null, JSON.stringify(purpose));
    assert.deepEqual(prompts, []);
  }
  assert.notEqual(await setup({ purpose: answer('once', { names: Array.from({ length: 16 }, (_, i) => `N${i}`) }) }).v.prove(nonce), null);
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
  const names = /to read (.*) once$/.exec(text)![1];
  assert.equal(Array.from(names).length, 120);
  assert.ok(names.startsWith('A B, nnn'));
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

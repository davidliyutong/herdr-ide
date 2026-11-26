import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { APP_NAME } from '../../web/src/brand';
import kek from '../../spec/vectors/vault-unlock/kek.json';
import { enclaveFor, HELPER_MAX_OUTPUT, HELPER_NAME, HELPER_TIMEOUT_MS, helperPath, runBounded, type RunHelper } from './enclave';

const pub = Buffer.from(kek.enclave.sePub, 'base64url');
const peer = Buffer.from(kek.enclave.ephPub, 'base64url');
const blob = Buffer.from('a key blob');
const secret = Buffer.alloc(32, 7);

/** The helper answering out (an Error rejects, a function answers by input),
 * with the requests recorded. */
function helper(out: string | Error | ((input: string) => string | Promise<string>)) {
  const inputs: string[] = [];
  const run: RunHelper = async (input) => {
    inputs.push(input);
    if (out instanceof Error) throw out;
    return typeof out === 'function' ? out(input) : out;
  };
  return { e: enclaveFor(run), inputs };
}

const line = (v: object) => JSON.stringify(v) + '\n';

test('the helper is an app bundle named for the app, in Contents/Helpers or the development build', () => {
  assert.equal(HELPER_NAME, `${APP_NAME} Enclave`);
  // The system's own separators (the shell's tests run on Windows, too).
  const exe = join(`${APP_NAME} Enclave.app`, 'Contents', 'MacOS', `${APP_NAME} Enclave`);
  assert.equal(helperPath('/Applications/X.app/Contents/Resources', '/ignored'), join('/Applications/X.app/Contents/Helpers', exe));
  assert.equal(helperPath(undefined, '/repo/desktop'), join('/repo/desktop/dist/helper', exe));
  assert.equal(HELPER_TIMEOUT_MS, 120_000);
  assert.equal(HELPER_MAX_OUTPUT, 65_536);
});

test('available: only the exact answer counts; anything else is neither', async () => {
  const none = { enclave: false, biometry: false };
  for (const [out, want] of [
    [line({ ok: true, enclave: true, biometry: true }), { enclave: true, biometry: true }],
    [line({ ok: true, enclave: true, biometry: false }), { enclave: true, biometry: false }],
    [JSON.stringify({ ok: true, enclave: false, biometry: true }), { enclave: false, biometry: true }],
    [line({ ok: true, enclave: 'yes', biometry: true }), none],
    [line({ ok: true, enclave: true }), none],
    [line({ ok: true, enclave: true, biometry: true, extra: 1 }), none],
    [line({ ok: false, error: 'failed' }), none],
    [line({ ok: true, enclave: true, biometry: true }) + line({ ok: true, enclave: true, biometry: true }), none],
    ['garbage', none],
    ['', none],
    ['[true]', none],
    [new Error('exit 1'), none],
  ] as const) {
    const { e, inputs } = helper(out as string | Error);
    assert.deepEqual(await e.available(), want, String(out));
    assert.deepEqual(inputs, ['{"op":"available"}\n']);
  }
});

test('create: a blob and an X9.63 public key, or null', async () => {
  const good = { ok: true, blob: blob.toString('base64url'), pub: pub.toString('base64url') };
  const { e, inputs } = helper(line(good));
  assert.deepEqual(await e.create(), { blob, pub });
  assert.deepEqual(inputs, ['{"op":"create"}\n']);
  for (const bad of [
    { ...good, pub: pub.subarray(0, 64).toString('base64url') },
    { ...good, pub: Buffer.concat([Buffer.from([2]), pub.subarray(1)]).toString('base64url') },
    { ...good, pub: pub.toString('base64') },
    { ...good, blob: '' },
    { ...good, blob: Buffer.alloc(4000).toString('base64url') },
    { ...good, blob: 'not base64url!' },
    { ...good, extra: true },
    { ok: false, blob: good.blob, pub: good.pub },
    { ok: false, error: 'unavailable' },
  ]) {
    assert.equal(await helper(line(bad)).e.create(), null, JSON.stringify(bad));
  }
  assert.equal(await helper(new Error('timeout')).e.create(), null);
});

test('agree: the request carries the blob, the peer and the reason; the secret or the error comes back', async () => {
  const { e, inputs } = helper(line({ ok: true, secret: secret.toString('base64url') }));
  assert.deepEqual(await e.agree(blob, peer, 'open the vault'), { ok: true, secret });
  assert.deepEqual(JSON.parse(inputs[0]), {
    op: 'agree',
    blob: blob.toString('base64url'),
    peer: kek.enclave.ephPub,
    reason: 'open the vault',
  });
  assert.ok(inputs[0].endsWith('}\n'));
  for (const error of ['cancel', 'invalidated', 'unavailable', 'failed'] as const) {
    assert.deepEqual(await helper(line({ ok: false, error })).e.agree(blob, peer, 'r'), { ok: false, error });
  }
  for (const out of [
    line({ ok: false, error: 'something' }),
    line({ ok: false, error: 'cancel', detail: 'x' }),
    line({ ok: true, secret: Buffer.alloc(31).toString('base64url') }),
    line({ ok: true, secret: Buffer.alloc(33).toString('base64url') }),
    line({ ok: true, secret: secret.toString('base64url'), more: 1 }),
    line({ ok: false, secret: secret.toString('base64url') }),
    line({ ok: true, error: 'cancel' }),
    'Touch ID\n' + line({ ok: true, secret: secret.toString('base64url') }),
    '',
  ]) {
    assert.deepEqual(await helper(out).e.agree(blob, peer, 'r'), { ok: false, error: 'failed' }, out);
  }
  assert.deepEqual(await helper(new Error('timeout')).e.agree(blob, peer, 'r'), { ok: false, error: 'failed' });
});

test('agree refuses a peer that is not an X9.63 key and an empty or oversized blob without running', async () => {
  const { e, inputs } = helper(line({ ok: true, secret: secret.toString('base64url') }));
  for (const [b, p] of [
    [blob, peer.subarray(1)],
    [blob, Buffer.concat([Buffer.from([3]), peer.subarray(1)])],
    [Buffer.alloc(0), peer],
    [Buffer.alloc(3073), peer],
  ] as const) {
    assert.deepEqual(await e.agree(b, p, 'r'), { ok: false, error: 'failed' });
  }
  assert.deepEqual(inputs, []);
});

test('one prompt at a time: a second agree or create while one runs fails without running', async () => {
  let release = (_: string) => {};
  const { e, inputs } = helper(() => new Promise<string>((r) => (release = r)));
  const first = e.agree(blob, peer, 'r');
  assert.deepEqual(await e.agree(blob, peer, 'r'), { ok: false, error: 'failed' });
  assert.equal(await e.create(), null);
  assert.equal(inputs.length, 1);
  release(line({ ok: true, secret: secret.toString('base64url') }));
  assert.deepEqual(await first, { ok: true, secret });
  // After it, the next one runs.
  const next = e.agree(blob, peer, 'r');
  release(line({ ok: false, error: 'cancel' }));
  assert.deepEqual(await next, { ok: false, error: 'cancel' });
});

const node = process.execPath;
const opts = { timeoutMs: 5000, maxOutput: 1024 };

test('runBounded runs an absolute path only, with stdin, and answers its stdout', async () => {
  await assert.rejects(runBounded('node', ['-e', ''], '', opts), /absolute/);
  const out = await runBounded(node, ['-e', 'process.stdin.pipe(process.stdout)'], '{"op":"available"}\n', opts);
  assert.equal(out, '{"op":"available"}\n');
});

test('runBounded fails on a non-zero exit, too much output and a timeout', async () => {
  await assert.rejects(runBounded(node, ['-e', 'process.exit(3)'], '', opts), /exit 3/);
  await assert.rejects(
    runBounded(node, ['-e', 'process.stdout.write("x".repeat(5000)); setTimeout(() => {}, 5000)'], '', opts),
    /too much output/,
  );
  const started = Date.now();
  await assert.rejects(runBounded(node, ['-e', 'setTimeout(() => {}, 30000)'], '', { ...opts, timeoutMs: 200 }), /timeout/);
  assert.ok(Date.now() - started < 5000);
});

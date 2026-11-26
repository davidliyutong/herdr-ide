import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { INSTALL, UNLOCK_FILE, unlockStore, type SafeStorage } from './unlockStore';

/** A stand-in for safeStorage: reversible, marked, and failing on demand. */
function fakeSafe(over: { available?: boolean; broken?: boolean } = {}) {
  const calls = { encrypt: 0, decrypt: 0 };
  const safe: SafeStorage = {
    isEncryptionAvailable: () => over.available ?? true,
    encryptString(s) {
      calls.encrypt++;
      return Buffer.from('enc:' + [...s].reverse().join(''));
    },
    decryptString(b) {
      calls.decrypt++;
      if (over.broken) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const s = b.toString();
      if (!s.startsWith('enc:')) throw new Error('not ours');
      return [...s.slice(4)].reverse().join('');
    },
  };
  return { safe, calls };
}

async function dir() {
  return mkdtemp(join(tmpdir(), 'unlock-store-'));
}

test('the first enroll makes an install id and a secret, kept 0600 with the secret encrypted; later reads give the same', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe } = fakeSafe();
  const store = unlockStore(d, safe);
  assert.equal(await store.available(), true);
  assert.equal(await store.load(), null);
  const made = await store.loadOrCreate();
  assert.ok(made);
  assert.match(made.install, INSTALL);
  assert.equal(made.install.length, 22);
  assert.equal(made.secret.length, 32);
  const file = join(d, UNLOCK_FILE);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes(made.secret.toString('base64url')));
  assert.ok(!text.includes(made.secret.toString('base64')));
  const again = unlockStore(d, safe);
  assert.deepEqual(await again.load(), made);
  assert.deepEqual(await again.loadOrCreate(), made);
  assert.equal(await readFile(file, 'utf8'), text);
});

test('without safeStorage nothing is offered, read or written', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe, calls } = fakeSafe({ available: false });
  const store = unlockStore(d, safe);
  assert.equal(await store.available(), false);
  assert.equal(await store.loadOrCreate(), null);
  assert.equal(await store.load(), null);
  assert.deepEqual(calls, { encrypt: 0, decrypt: 0 });
  await assert.rejects(stat(join(d, UNLOCK_FILE)));
  const throwing = unlockStore(d, {
    ...safe,
    isEncryptionAvailable: () => {
      throw new Error('not ready');
    },
  });
  assert.equal(await throwing.available(), false);
});

test('a secret that no longer decrypts is none; enrolling again keeps the install id with a new secret', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const made = (await unlockStore(d, fakeSafe().safe).loadOrCreate())!;
  const broken = unlockStore(d, fakeSafe({ broken: true }).safe);
  assert.equal(await broken.load(), null);
  // The keychain was reset: a new secret is made under the same install.
  await writeFile(
    join(d, UNLOCK_FILE),
    JSON.stringify({ v: 1, install: made.install, secret: Buffer.from('other ciphertext').toString('base64') }),
  );
  const store = unlockStore(d, fakeSafe().safe);
  assert.equal(await store.load(), null);
  const again = (await store.loadOrCreate())!;
  assert.equal(again.install, made.install);
  assert.notDeepEqual(again.secret, made.secret);
  assert.deepEqual(await store.load(), again);
});

test('a file of another shape is not read: a new install is made', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe } = fakeSafe();
  const file = join(d, UNLOCK_FILE);
  for (const body of [
    'not json',
    '[]',
    'null',
    JSON.stringify({ v: 2, install: 'install-0123456789ab', secret: '' }),
    JSON.stringify({ v: 1, install: 'short', secret: '' }),
    JSON.stringify({ v: 1, install: '../../etc/passwd/xx', secret: '' }),
    JSON.stringify({ v: 1, install: 'x'.repeat(65), secret: '' }),
  ]) {
    await writeFile(file, body);
    const store = unlockStore(d, safe);
    assert.equal(await store.load(), null, body);
    const made = (await store.loadOrCreate())!;
    assert.match(made.install, INSTALL);
    assert.notEqual(made.install, 'install-0123456789ab');
  }
  // A secret that decrypts to something else than 32 bytes is none.
  await writeFile(
    file,
    JSON.stringify({
      v: 1,
      install: 'install-0123456789ab',
      secret: safe.encryptString(Buffer.alloc(31).toString('base64url')).toString('base64'),
    }),
  );
  assert.equal(await unlockStore(d, safe).load(), null);
});

test('the file is read only as a small regular file, never through a link', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe } = fakeSafe();
  const other = join(d, 'elsewhere');
  await mkdir(other);
  const made = (await unlockStore(other, safe).loadOrCreate())!;
  const file = join(d, UNLOCK_FILE);
  if (process.platform !== 'win32') {
    await symlink(join(other, UNLOCK_FILE), file);
    assert.equal(await unlockStore(d, safe).load(), null);
    await rm(file);
  }
  await writeFile(file, JSON.stringify({ v: 1, install: made.install, secret: 'A'.repeat(5000) }));
  assert.equal(await unlockStore(d, safe).load(), null);
  await rm(file);
  await mkdir(file);
  assert.equal(await unlockStore(d, safe).load(), null);
  // The file cannot be written over a directory: no keys.
  assert.equal(await unlockStore(d, safe).loadOrCreate(), null);
});

test('the step before safeStorage runs once, before its first use; one that fails leaves safeStorage as it was', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe, calls } = fakeSafe();
  const order: string[] = [];
  let runs = 0;
  const watched: SafeStorage = {
    isEncryptionAvailable: () => (order.push('safeStorage'), safe.isEncryptionAvailable()),
    encryptString: (s) => safe.encryptString(s),
    decryptString: (b) => safe.decryptString(b),
  };
  const store = unlockStore(d, watched, {
    prepare: async () => {
      runs++;
      order.push('step');
      return { use: true };
    },
  });
  const [a, b] = await Promise.all([store.available(), store.loadOrCreate()]);
  assert.equal(a, true);
  assert.ok(b);
  assert.equal(runs, 1);
  assert.equal(order[0], 'step');
  assert.deepEqual(await store.load(), b);
  assert.equal(runs, 1);
  const failing = unlockStore(d, safe, {
    prepare: async () => {
      throw new Error('broken');
    },
  });
  assert.deepEqual(await failing.load(), b);
  assert.ok(calls.decrypt > 0);
});

test('a step that leaves safeStorage alone: its keys for this launch, copies each time, nothing written; none without keys', async (t) => {
  const d = await dir();
  t.after(() => rm(d, { recursive: true, force: true }));
  const { safe, calls } = fakeSafe();
  const keys = { install: 'install-0123456789ab', secret: Buffer.alloc(32, 7) };
  const store = unlockStore(d, safe, { prepare: async () => ({ use: false, keys }) });
  assert.equal(await store.available(), true);
  const got = (await store.load())!;
  assert.deepEqual(got, keys);
  got.secret.fill(0);
  assert.deepEqual(await store.loadOrCreate(), keys);
  assert.deepEqual(calls, { encrypt: 0, decrypt: 0 });
  await assert.rejects(stat(join(d, UNLOCK_FILE)));
  const none = unlockStore(d, safe, { prepare: async () => ({ use: false }) });
  assert.equal(await none.available(), false);
  assert.equal(await none.load(), null);
  assert.equal(await none.loadOrCreate(), null);
  assert.deepEqual(calls, { encrypt: 0, decrypt: 0 });
  await assert.rejects(stat(join(d, UNLOCK_FILE)));
});

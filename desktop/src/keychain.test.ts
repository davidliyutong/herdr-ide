import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { APP_SLUG } from '../../web/src/brand';
import {
  CODESIGN,
  codeIdentity,
  identityOf,
  instanceFiles,
  isV10,
  KEYCHAIN_RECORD,
  keychainMigration,
  LOCK_STALE_MS,
  oscryptDecrypt,
  READ_TIMEOUT_MS,
  runTool,
  safeStorageItem,
  SECURITY,
  securityKeychain,
  TOOL_TIMEOUT_MS,
  type Keychain,
  type RunTool,
  type ToolResult,
} from './keychain';
import { UNLOCK_FILE, unlockStore, type SafeStorage } from './unlockStore';

const buildA = `cdhash:${'a'.repeat(40)}`;
const buildB = `cdhash:${'b'.repeat(40)}`;

/** The login keychain's item of safeStorage, as macOS keeps it: its
 * password, which build made it, and whom the system asked for it. */
interface Item {
  password: string;
  maker: string;
}
function fakeMac() {
  const mac = {
    item: undefined as Item | undefined,
    /** Every prompt macOS showed, by the program it named. */
    prompts: [] as string[],
    reads: 0,
    removes: 0,
    restores: 0,
    /** The user refuses security's read. */
    deny: false,
    /** The keychain refuses an item safeStorage makes, a deletion, a restore. */
    failAdd: false,
    failRemove: false,
    failRestore: false,
  };
  /** security, as keychain.ts drives it. */
  const keychain: Keychain = {
    exists: async () => mac.item !== undefined,
    async read() {
      mac.reads++;
      if (!mac.item) return null;
      mac.prompts.push('security');
      return mac.deny ? null : mac.item.password;
    },
    async remove() {
      if (mac.failRemove) return false;
      mac.removes++;
      mac.item = undefined;
      return true;
    },
    async restore(password) {
      if (mac.failRestore || mac.item) return false;
      mac.restores++;
      mac.item = { password, maker: 'security' };
      return true;
    },
  };
  return { mac, keychain };
}

/** OSCrypt's key, derived here apart from keychain.ts. */
const keyOf = (password: string) => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

/** safeStorage of one launch of a build, as Chromium does it on macOS: the
 * first use reads the item (macOS asks when another build made it) or
 * makes one with a random password, and keeps that key for the launch. */
function launchSafe(mac: ReturnType<typeof fakeMac>['mac'], build: string): SafeStorage {
  let read = false;
  let key: Buffer | undefined;
  const current = () => {
    if (read) return key;
    read = true;
    if (!mac.item) {
      if (mac.failAdd) return undefined;
      mac.item = { password: randomBytes(16).toString('base64'), maker: build };
    } else if (mac.item.maker !== build) {
      mac.prompts.push(build);
    }
    key = keyOf(mac.item.password);
    return key;
  };
  return {
    isEncryptionAvailable: () => current() !== undefined,
    encryptString(text) {
      const k = current();
      if (!k) throw new Error('Encryption is not available.');
      const c = createCipheriv('aes-128-cbc', k, IV);
      return Buffer.concat([Buffer.from('v10'), c.update(text, 'utf8'), c.final()]);
    },
    decryptString(sealed) {
      const k = current();
      if (!k || sealed.subarray(0, 3).toString() !== 'v10')
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const d = createDecipheriv('aes-128-cbc', k, IV);
      return Buffer.concat([d.update(sealed.subarray(3)), d.final()]).toString('utf8');
    },
  };
}

/** An app data directory with this instance's user data and the
 * development instance's. */
async function appData(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'keychain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const own = join(root, `${APP_SLUG}-desktop`);
  const dev = join(root, `${APP_SLUG}-desktop-dev`);
  await mkdir(own);
  await mkdir(dev);
  return { root, own, dev, record: join(root, KEYCHAIN_RECORD) };
}

type Dirs = Awaited<ReturnType<typeof appData>>;

/** One launch of the app: its safeStorage, the step and the store. */
function launch(
  dirs: Dirs,
  mac: ReturnType<typeof fakeMac>['mac'],
  keychain: Keychain,
  build: string | undefined,
  more: { random?: (n: number) => Buffer } = {},
) {
  const safe = launchSafe(mac, build ?? 'unknown');
  const prepare = keychainMigration({
    safe,
    keychain,
    identity: async () => build,
    own: join(dirs.own, UNLOCK_FILE),
    files: () => instanceFiles(dirs.root),
    record: dirs.record,
    random: more.random,
  });
  return { safe, store: unlockStore(dirs.own, safe, { prepare }) };
}

const recorded = async (dirs: Dirs) => JSON.parse(await readFile(dirs.record, 'utf8')).identity as string;

test('the same build: no migration, no prompt, the item kept', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  // The first launch makes the item and records its build.
  const made = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  assert.equal(mac.item?.maker, buildA);
  assert.equal(await recorded(dirs), buildA);
  const password = mac.item!.password;
  for (let i = 0; i < 3; i++) {
    const { store } = launch(dirs, mac, keychain, buildA);
    assert.equal(await store.available(), true);
    assert.deepEqual(await store.load(), made);
  }
  assert.deepEqual(mac.prompts, []);
  assert.equal(mac.reads, 0);
  assert.equal(mac.removes, 0);
  assert.equal(mac.item?.password, password);
});

test("a new build: the old item read once, every instance's secret sealed under a new item of this build, the old deleted, the build recorded", async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const first = launch(dirs, mac, keychain, buildA);
  const own = (await first.store.loadOrCreate())!;
  // The development instance enrolled under the same item.
  const dev = (await unlockStore(dirs.dev, first.safe).loadOrCreate())!;
  const old = mac.item!.password;
  const ownBefore = await readFile(join(dirs.own, UNLOCK_FILE), 'utf8');

  const next = launch(dirs, mac, keychain, buildB);
  assert.equal(await next.store.available(), true);
  assert.deepEqual(await next.store.load(), own);
  assert.deepEqual(mac.prompts, ['security'], 'one prompt, for the old item');
  assert.equal(mac.reads, 1);
  assert.equal(mac.removes, 1);
  assert.equal(mac.item?.maker, buildB, 'the new item is this build’s');
  assert.notEqual(mac.item?.password, old);
  assert.equal(await recorded(dirs), buildB);
  assert.notEqual(await readFile(join(dirs.own, UNLOCK_FILE), 'utf8'), ownBefore);
  // Later launches of the build read the new item without a prompt, in
  // every instance.
  for (let i = 0; i < 2; i++) {
    const again = launch(dirs, mac, keychain, buildB);
    assert.deepEqual(await again.store.load(), own);
    assert.deepEqual(await unlockStore(dirs.dev, again.safe).load(), dev);
  }
  assert.deepEqual(mac.prompts, ['security']);
  assert.equal(mac.reads, 1);
});

test('an item made before any build was recorded moves once; a build with a Team ID takes it as its own', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  await rm(dirs.record);
  assert.deepEqual(await launch(dirs, mac, keychain, buildB).store.load(), own);
  assert.deepEqual(mac.prompts, ['security']);
  assert.equal(mac.item?.maker, buildB);

  const team = 'teamid:ABCDE12345:dev.example.desktop';
  mac.item = { ...mac.item!, maker: team };
  await rm(dirs.record);
  assert.deepEqual(await launch(dirs, mac, keychain, team).store.load(), own);
  assert.equal(mac.reads, 1);
  assert.equal(await recorded(dirs), team);
});

test('no secret sealed anywhere: the old item deleted unread, without a prompt', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  assert.equal(await launch(dirs, mac, keychain, buildA).store.available(), true);
  assert.equal(mac.item?.maker, buildA);
  const next = launch(dirs, mac, keychain, buildB);
  assert.equal(await next.store.available(), true);
  assert.deepEqual(mac.prompts, []);
  assert.equal(mac.reads, 0);
  assert.equal(mac.item?.maker, buildB);
  assert.equal(await recorded(dirs), buildB);
  assert.ok(await next.store.loadOrCreate());
});

test('a file that cannot be written: the old item back with its password, the file as it was, the keys kept for the launch; the next launch moves it', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  const old = mac.item!.password;
  const file = join(dirs.own, UNLOCK_FILE);
  const before = await readFile(file, 'utf8');
  // The file's write goes through a temporary file that already exists.
  const fixed = () => Buffer.alloc(6, 1);
  await writeFile(`${file}.${fixed().toString('hex')}.tmp`, 'in the way');

  const next = launch(dirs, mac, keychain, buildB, { random: fixed });
  assert.deepEqual(await next.store.load(), own, 'this launch keeps the keys it read');
  assert.equal(await next.store.available(), true);
  assert.deepEqual(await next.store.loadOrCreate(), own);
  assert.equal(mac.item?.password, old, 'the old key is back');
  assert.equal(mac.restores, 1);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(await recorded(dirs), buildA);

  const later = launch(dirs, mac, keychain, buildB);
  assert.deepEqual(await later.store.load(), own);
  assert.equal(mac.item?.maker, buildB);
  assert.equal(await recorded(dirs), buildB);
  assert.equal(mac.reads, 2);
});

test('a new item that cannot be made, or safeStorage that read the old key first: the old item back, nothing written; the latter recorded', async (t) => {
  for (const how of ['refused', 'cached'] as const) {
    const dirs = await appData(t);
    const { mac, keychain } = fakeMac();
    const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
    const old = mac.item!.password;
    const before = await readFile(join(dirs.own, UNLOCK_FILE), 'utf8');
    const next = launch(dirs, mac, keychain, buildB);
    if (how === 'refused') mac.failAdd = true;
    // Something used safeStorage before the step: it holds the old key.
    else assert.equal(next.safe.isEncryptionAvailable(), true);
    assert.deepEqual(await next.store.load(), own, how);
    assert.equal(mac.item?.password, old, how);
    assert.equal(await readFile(join(dirs.own, UNLOCK_FILE), 'utf8'), before, how);
    // A safeStorage that holds the old key at the step holds it at every
    // launch of the build: recorded, so that it is not asked again.
    assert.equal(await recorded(dirs), how === 'cached' ? buildB : buildA, how);
  }
});

test('the read refused: no unlock in this launch, nothing changed, safeStorage left alone; asked again at the next', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  const item = { ...mac.item! };
  const before = await readFile(join(dirs.own, UNLOCK_FILE), 'utf8');
  mac.deny = true;
  const next = launch(dirs, mac, keychain, buildB);
  assert.equal(await next.store.available(), false);
  assert.equal(await next.store.load(), null);
  assert.equal(await next.store.loadOrCreate(), null);
  assert.deepEqual(mac.prompts, ['security'], 'no second prompt of safeStorage');
  assert.deepEqual(mac.item, item);
  assert.equal(mac.removes, 0);
  assert.equal(await readFile(join(dirs.own, UNLOCK_FILE), 'utf8'), before);
  assert.equal(await recorded(dirs), buildA);
  mac.deny = false;
  assert.deepEqual(await launch(dirs, mac, keychain, buildB).store.load(), own);
  assert.equal(mac.reads, 2);
});

test('an old item that cannot be deleted stays; the launch keeps the keys it read without safeStorage', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  const item = { ...mac.item! };
  mac.failRemove = true;
  const next = launch(dirs, mac, keychain, buildB);
  assert.deepEqual(await next.store.load(), own);
  assert.deepEqual(mac.prompts, ['security']);
  assert.deepEqual(mac.item, item);
  assert.equal(await recorded(dirs), buildA);
});

test("a secret sealed under another key stays as it is; another instance's file is carried over", async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const first = launch(dirs, mac, keychain, buildA);
  await first.store.loadOrCreate();
  const dev = (await unlockStore(dirs.dev, first.safe).loadOrCreate())!;
  // This instance's file sealed under a key gone before.
  const stale = launchSafe({ ...fakeMac().mac }, buildA).encryptString(Buffer.alloc(32, 9).toString('base64url'));
  const ownFile = join(dirs.own, UNLOCK_FILE);
  const install = JSON.parse(await readFile(ownFile, 'utf8')).install as string;
  await writeFile(ownFile, JSON.stringify({ v: 1, install, secret: stale.toString('base64') }));
  const next = launch(dirs, mac, keychain, buildB);
  assert.equal(await next.store.load(), null);
  assert.deepEqual(await unlockStore(dirs.dev, next.safe).load(), dev);
  assert.equal(JSON.parse(await readFile(ownFile, 'utf8')).secret, stale.toString('base64'));
  // Enrolling again keeps the install id with a new secret.
  const again = (await next.store.loadOrCreate())!;
  assert.equal(again.install, install);
});

test('one migration at a time: a fresh lock leaves this launch without unlock and changes nothing; a stale one is taken', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  const lock = `${dirs.record}.lock`;
  await writeFile(lock, '1\n');
  const busy = launch(dirs, mac, keychain, buildB);
  assert.equal(await busy.store.available(), false);
  assert.equal(mac.reads, 0);
  assert.equal(mac.item?.maker, buildA);
  const stale = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  await utimes(lock, stale, stale);
  assert.deepEqual(await launch(dirs, mac, keychain, buildB).store.load(), own);
  assert.equal(mac.item?.maker, buildB);
  await assert.rejects(readFile(lock));
});

test('a development run records the item it makes and never moves one', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const dev = (move: boolean, build: string) => {
    const safe = launchSafe(mac, build);
    const prepare = keychainMigration({
      safe,
      keychain,
      identity: async () => build,
      own: join(dirs.dev, UNLOCK_FILE),
      files: () => instanceFiles(dirs.root),
      record: dirs.record,
      move,
    });
    return unlockStore(dirs.dev, safe, { prepare });
  };
  const made = (await dev(false, buildA).loadOrCreate())!;
  assert.equal(await recorded(dirs), buildA);
  // A packaged build moves it once; development then reads the item as
  // before (macOS asks it) and records nothing.
  assert.deepEqual(await launch(dirs, mac, keychain, buildB).store.available(), true);
  assert.equal(mac.item?.maker, buildB);
  assert.deepEqual(await dev(false, buildA).load(), made);
  assert.equal(mac.item?.maker, buildB);
  assert.equal(await recorded(dirs), buildB);
  assert.deepEqual(mac.prompts, ['security', buildA]);
});

test('an identity or an item that cannot be told: safeStorage as before', async (t) => {
  const dirs = await appData(t);
  const { mac, keychain } = fakeMac();
  const own = (await launch(dirs, mac, keychain, buildA).store.loadOrCreate())!;
  assert.deepEqual(await launch(dirs, mac, keychain, undefined).store.load(), own);
  assert.deepEqual(mac.prompts, ['unknown']);
  const unknown: Keychain = { ...keychain, exists: async () => undefined };
  assert.deepEqual(await launch(dirs, mac, unknown, buildB).store.load(), own);
  assert.deepEqual(mac.prompts, ['unknown', buildB]);
  assert.equal(mac.reads, 0);
  assert.equal(mac.item?.maker, buildA);
});

test("OSCrypt's v10 opened with the item's password; anything else is not", () => {
  // Made with Python's hashlib.pbkdf2_hmac and openssl enc -aes-128-cbc.
  const password = 'vAGhRSLkSrStPnhcOQi7zA==';
  const sealed = Buffer.from('djEwuCjXwnVbmVRiI5MiIA6P1mHjgUthe+FaJgqP6175U7BXI5UswmFF9NeHKAM2t8kE', 'base64');
  assert.ok(isV10(sealed));
  assert.equal(oscryptDecrypt(password, sealed), 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  assert.equal(oscryptDecrypt('mock_password', sealed), undefined);
  assert.equal(oscryptDecrypt(password, Buffer.concat([Buffer.from('v11'), sealed.subarray(3)])), undefined);
  assert.equal(oscryptDecrypt(password, sealed.subarray(0, sealed.length - 1)), undefined);
  assert.equal(isV10(Buffer.from('v10')), false);
  assert.equal(
    oscryptDecrypt('mock_password', Buffer.concat([Buffer.from('v10'), Buffer.from('UTK6x4YqQkaatOeZvLg81Q==', 'base64')])),
    'probe',
  );
});

test("the identity: a build's Team ID and identifier, else its cdhash", () => {
  const adhoc = [
    'Executable=/Applications/App.app/Contents/MacOS/App',
    'Identifier=dev.example.desktop',
    'Format=app bundle with Mach-O thin (arm64)',
    'CDHash=2cc11dd82a0b0b85d58d5eddadadd3690850195a',
    'Signature=adhoc',
    'TeamIdentifier=not set',
  ].join('\n');
  assert.equal(identityOf(adhoc), 'cdhash:2cc11dd82a0b0b85d58d5eddadadd3690850195a');
  assert.equal(identityOf(adhoc.replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDE12345')), 'teamid:ABCDE12345:dev.example.desktop');
  assert.equal(identityOf('Identifier=x\nCDHash=nothex'), undefined);
  assert.equal(identityOf(''), undefined);
  assert.equal(identityOf('TeamIdentifier=ABCDE12345\nIdentifier=a b'), undefined);
});

test('codesign and security: run by absolute path, the item matched by service and account, the password never in an argument', async () => {
  const calls: Array<{ file: string; args: string[]; input: string; timeoutMs: number }> = [];
  let answer: ToolResult | Error = { code: 0, stdout: '', stderr: '' };
  const run: RunTool = async (file, args, input, timeoutMs) => {
    calls.push({ file, args, input, timeoutMs });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  answer = { code: 0, stdout: '', stderr: 'Identifier=a\nCDHash=' + 'c'.repeat(40) + '\nTeamIdentifier=not set\n' };
  assert.equal(await codeIdentity(run, 4242), `cdhash:${'c'.repeat(40)}`);
  assert.deepEqual(calls.pop(), { file: CODESIGN, args: ['-d', '-vvv', '+4242'], input: '', timeoutMs: TOOL_TIMEOUT_MS });
  answer = new Error('timeout');
  assert.equal(await codeIdentity(run, 4242), undefined);

  const item = safeStorageItem('App Name');
  assert.deepEqual(item, { service: 'App Name Safe Storage', account: 'App Name Key' });
  const kc = securityKeychain(item, '/Applications/App Name.app', run);
  const match = ['-s', 'App Name Safe Storage', '-a', 'App Name Key'];
  for (const [code, want] of [
    [0, true],
    [44, false],
    [51, undefined],
  ] as const) {
    answer = { code, stdout: '', stderr: '' };
    assert.equal(await kc.exists(), want);
  }
  assert.deepEqual(calls.pop(), { file: SECURITY, args: ['find-generic-password', ...match], input: '', timeoutMs: TOOL_TIMEOUT_MS });

  answer = { code: 0, stdout: 'vAGhRSLkSrStPnhcOQi7zA==\n', stderr: '' };
  assert.equal(await kc.read(), 'vAGhRSLkSrStPnhcOQi7zA==');
  assert.deepEqual(calls.pop(), { file: SECURITY, args: ['find-generic-password', ...match, '-w'], input: '', timeoutMs: READ_TIMEOUT_MS });
  for (const a of [
    { code: 128, stdout: '', stderr: '' },
    { code: 0, stdout: 'two words\n', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    new Error('timeout'),
  ]) {
    answer = a;
    assert.equal(await kc.read(), null);
  }

  for (const [code, want] of [
    [0, true],
    [44, true],
    [1, false],
  ] as const) {
    answer = { code, stdout: '', stderr: '' };
    assert.equal(await kc.remove(), want);
  }
  assert.deepEqual(calls.pop()?.args, ['delete-generic-password', ...match]);

  calls.length = 0;
  answer = { code: 0, stdout: '', stderr: '' };
  assert.equal(await kc.restore('vAGhRSLkSrStPnhcOQi7zA=='), true);
  assert.deepEqual(calls[0], {
    file: SECURITY,
    args: ['-i'],
    input:
      'add-generic-password -s "App Name Safe Storage" -a "App Name Key" -w "vAGhRSLkSrStPnhcOQi7zA==" -T "/Applications/App Name.app"\n',
    timeoutMs: TOOL_TIMEOUT_MS,
  });
  assert.ok(calls.every((c) => !c.args.some((a) => a.includes('vAGhRSLk'))));
  calls.length = 0;
  assert.equal(await kc.restore('not "base64"'), false);
  assert.equal(await securityKeychain(item, '/Applications/A"pp.app', run).restore('vAGhRSLkSrStPnhcOQi7zA=='), false);
  assert.equal(calls.length, 0);
  answer = { code: 44, stdout: '', stderr: '' };
  assert.equal(await kc.restore('vAGhRSLkSrStPnhcOQi7zA=='), false, 'not there afterwards');
});

test("the instances' files: the app's user data directories in app data, never links or other names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'keychain-instances-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [
    `${APP_SLUG}-desktop`,
    `${APP_SLUG}-desktop-dev`,
    `${APP_SLUG}-desktop-work-2`,
    `${APP_SLUG}-desktop-Bad`,
    `${APP_SLUG}-desktopx`,
    'other',
  ])
    await mkdir(join(root, name));
  await writeFile(join(root, KEYCHAIN_RECORD), '{}');
  if (process.platform !== 'win32') await symlink(join(root, 'other'), join(root, `${APP_SLUG}-desktop-link`));
  assert.deepEqual(await instanceFiles(root), [
    join(root, `${APP_SLUG}-desktop`, UNLOCK_FILE),
    join(root, `${APP_SLUG}-desktop-dev`, UNLOCK_FILE),
    join(root, `${APP_SLUG}-desktop-work-2`, UNLOCK_FILE),
  ]);
  assert.deepEqual(await instanceFiles(join(root, 'missing')), []);
});

test('runTool: stdin in, exit status and output back; bounded by time and output; an absolute path only', async () => {
  const node = process.execPath;
  const echo = await runTool(
    node,
    ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("e"); process.exitCode = 3'],
    'in',
    10_000,
  );
  assert.deepEqual(echo, { code: 3, stdout: 'in', stderr: 'e' });
  await assert.rejects(runTool(node, ['-e', 'setTimeout(() => {}, 60_000)'], '', 200), /timeout/);
  await assert.rejects(runTool(node, ['-e', 'process.stdout.write("x".repeat(200_000))'], '', 10_000), /too much output/);
  await assert.rejects(runTool('security', [], '', 1000), /absolute/);
  // A process that cannot start rejects.
  const failing = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    return child;
  }) as unknown as Parameters<typeof runTool>[4];
  await assert.rejects(runTool('/nonexistent', [], '', 1000, failing), /ENOENT/);
});

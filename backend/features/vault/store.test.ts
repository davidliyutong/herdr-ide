import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { b64, unb64 } from './crypto.ts';
import { desktopOf, relayKey } from './desktop.ts';
import { openExport, sealExport } from './exportfile.ts';
import { checkApp, KIND_DESKTOP, KIND_WEBAUTHN, Store, type Window } from './store.ts';
import { enclaveKEK, helloKEK, helloKeyName, MAX_DESKTOP_UNLOCKS, prfKEK, type UnlockEntry } from './unlock.ts';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tw-vault-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const u = (s: string) => Buffer.from(s, 'base64url');
const testdata = join(import.meta.dir, 'testdata');
const about = JSON.parse(readFileSync(join(testdata, 'go-vault.about.json'), 'utf8'));
const FAST = { time: 1, memory: 8 << 10, threads: 1 };
const WINDOW: Window = { days: 14, autoLockMs: 3600_000 };

/** The Go store's vault (testdata), in a temporary directory, at the time
 * it was made plus ms. */
function goVault(ms = 0): Store {
  const path = join(temp(), 'vault.json');
  copyFileSync(join(testdata, 'go-vault.json'), path);
  const now = Date.parse(about.now) + ms;
  return Store.open(path, { kdf: FAST, now: () => new Date(now) });
}

describe('vectors', () => {
  const v = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/vectors/vault-unlock/kek.json'), 'utf8'));
  test('KEKs', () => {
    const e = v.enclave;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(u(e.sePriv));
    expect(ecdh.computeSecret(u(e.ephPub)).equals(u(e.z))).toBe(true);
    expect(enclaveKEK(u(e.z), u(e.shellSecret), u(e.ephPub), u(e.sePub)).equals(u(e.kek))).toBe(true);
    expect(helloKEK(u(v.hello.signature), u(v.hello.shellSecret), u(v.hello.challenge)).equals(u(v.hello.kek))).toBe(true);
    expect(prfKEK(u(v.prf.output), u(v.prf.salt)).equals(u(v.prf.kek))).toBe(true);
  });

  test('relays', () => {
    const r = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/vectors/vault-unlock/relay.json'), 'utf8'));
    expect(relayKey(r.verifyKey).equals(u(r.relayKey))).toBe(true);
    const d = desktopOf(r.verifyKey)!;
    for (const x of r.relays) {
      expect(d.relay(x.ad, u(x.relay))?.toString()).toBe(x.plaintext);
      expect(d.relay(x.ad + 'x', u(x.relay))).toBeNull();
    }
    expect(desktopOf('')).toBeUndefined();
  });
});

describe("the Go store's files", () => {
  test('the passphrase opens them: Argon2id, values, guard, exemptions', async () => {
    const s = goVault();
    expect(s.status()).toEqual({ mode: 'passphrase', locked: true, passphraseSet: '2026-11-20T10:00:00.123456789Z' });
    await expect(s.value('GITHUB_TOKEN')).rejects.toMatchObject({ code: 'vault_locked' });
    await expect(s.unlock('wrong passphrase', WINDOW)).rejects.toMatchObject({ code: 'wrong_passphrase', status: 403 });
    await s.unlock(about.passphrase, WINDOW);
    for (const [n, v] of Object.entries(about.values)) expect(await s.value(n)).toBe(v as string);
    const g = await s.guard();
    expect(g.authenticators?.map((a) => a.kind)).toEqual(['webauthn', 'desktop']);
    expect(await s.exempt('m1', 'claude')).toBe(true);
    expect(await s.exempt('m2', 'claude')).toBe(false);
    expect(s.unlockEntries().map((e) => e.kind)).toEqual(['prf', 'enclave']);
  });

  test('their unlock entries unlock: prf and enclave', async () => {
    const w = about.webauthn;
    const prf = s0();
    const e = prf.unlockEntries().find((x) => x.kind === 'prf')!;
    const win = await prf.unlockWith(e.id, prfKEK(u(w.prfOutput), u(w.prfSalt)), 14);
    expect(win).toEqual({ days: 14, autoLockMs: 30 * 60_000 });
    expect(await prf.value('GITHUB_TOKEN')).toBe('ghp_secret');
    expect((await prf.guard()).authenticators?.[0].lastUsed).toBeDefined();

    const enc = s0();
    const ee = enc.unlockEntries().find((x) => x.kind === 'enclave')!;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(u(about.enclave.sePriv));
    const z = ecdh.computeSecret(unb64(ee.enclave!.ephPub));
    await expect(enc.unlockWith(ee.id, Buffer.alloc(32, 1), 14)).rejects.toMatchObject({ code: 'vault_proof', why: 'wrap' });
    await enc.unlockWith(ee.id, enclaveKEK(z, u(about.enclave.shellSecret), unb64(ee.enclave!.ephPub), unb64(ee.enclave!.sePub)), 14);
    expect(await enc.value('OPENAI_KEY')).toBe(about.values.OPENAI_KEY);

    function s0() {
      return goVault(3600_000);
    }
  });

  test("an unlock entry opens only within the passphrase's window", async () => {
    const w = about.webauthn;
    const late = goVault(15 * 86400_000);
    const e = late.unlockEntries().find((x) => x.kind === 'prf')!;
    await expect(late.unlockWith(e.id, prfKEK(u(w.prfOutput), u(w.prfSalt)), 14)).rejects.toMatchObject({ code: 'passphrase_due' });
    expect(late.status().locked).toBe(true);
    // The setting shortens the window, never lengthens it.
    const short = goVault(3 * 86400_000);
    await expect(short.unlockWith(e.id, prfKEK(u(w.prfOutput), u(w.prfSalt)), 2)).rejects.toMatchObject({ code: 'passphrase_due' });
    const before = goVault(-1000);
    await expect(before.unlockWith(e.id, prfKEK(u(w.prfOutput), u(w.prfSalt)), 14)).rejects.toMatchObject({ code: 'passphrase_due' });
    await before.forgetPassphrase();
    expect(before.passphraseDue()).toBeNull();
  });

  test('their export files open, and ours open again', async () => {
    const b = readFileSync(join(testdata, 'go-export.json'));
    await expect(openExport(b, 'wrong passphrase!!')).rejects.toMatchObject({ code: 'file_passphrase' });
    const e = await openExport(b, about.export.passphrase);
    expect(e.variables.map((v) => [v.name, v.value, v.machines, !!v.injectOnly])).toEqual([
      ['GITHUB_TOKEN', 'ghp_secret', ['m1', 'local'], false],
      ['OPENAI_KEY', about.values.OPENAI_KEY, ['*'], true],
    ]);
    expect(e.machines[0]).toEqual({ id: 'm1', label: 'box', kind: 'ssh', target: 'u@box' });
    await expect(sealExport(e, 'too short', FAST)).rejects.toMatchObject({ code: 'weak_export_passphrase' });
    const again = await sealExport(e, 'another passphrase', FAST);
    expect((await openExport(again, 'another passphrase')).variables).toEqual(e.variables);
    // Its derivation is bound: changed, the file does not open.
    const f = JSON.parse(again.toString());
    f.kdf.time = 2;
    await expect(openExport(Buffer.from(JSON.stringify(f)), 'another passphrase')).rejects.toMatchObject({ code: 'file_passphrase' });
    f.version = 2;
    await expect(openExport(Buffer.from(JSON.stringify(f)), 'another passphrase')).rejects.toMatchObject({ code: 'file_version' });
    f.version = 1;
    f.kdf.memory = 1;
    await expect(openExport(Buffer.from(JSON.stringify(f)), 'another passphrase')).rejects.toMatchObject({ code: 'bad_file' });
    await expect(openExport(Buffer.from('{}'), 'x')).rejects.toMatchObject({ code: 'bad_file' });
  });
});

describe('the store', () => {
  const fresh = async () => {
    const path = join(temp(), 'vault.json');
    const s = Store.open(path, { kdf: FAST });
    await s.setPassphrase('correct horse', WINDOW);
    return { s, path };
  };

  test('values are bound to their name, machines and flag', async () => {
    const { s, path } = await fresh();
    await s.set('TOKEN', { value: 'v1', machines: ['m1'] });
    await s.set('OTHER', { value: 'v2' });
    const f = JSON.parse(readFileSync(path, 'utf8'));
    f.entries[0].machines.push('m2');
    [f.entries[1].value, f.entries[0].value] = [f.entries[0].value, f.entries[1].value];
    writeFileSync(path, JSON.stringify(f));
    const t = Store.open(path, { kdf: FAST });
    await t.unlock('correct horse', WINDOW);
    await expect(t.value('TOKEN')).rejects.toMatchObject({ code: 'corrupt' });
    await expect(t.value('OTHER')).rejects.toMatchObject({ code: 'corrupt' });
    // A passphrase change fails on them and leaves the vault as it was.
    await expect(t.changePassphrase('correct horse', 'new passphrase', WINDOW)).rejects.toMatchObject({ code: 'corrupt' });
    await t.lock();
    await t.unlock('correct horse', WINDOW);
  });

  test('a lock forgets the key; a new passphrase seals everything again and ends the unlock entries', async () => {
    const { s, path } = await fresh();
    await s.set('A', { value: 'a', description: 'd', injectOnly: true });
    await s.set('A', { to: 'B', machines: ['m1', 'm1'] });
    expect(s.get('B')).toMatchObject({ name: 'B', description: 'd', machines: ['m1'], injectOnly: true });
    await s.lock();
    expect(s.status().locked).toBe(true);
    await expect(s.value('B')).rejects.toMatchObject({ code: 'vault_locked' });
    await expect(s.set('B', { value: 'x' })).rejects.toMatchObject({ code: 'vault_locked' });
    await expect(s.changePassphrase('wrong one!', 'new passphrase', WINDOW)).rejects.toMatchObject({ code: 'wrong_passphrase' });
    await s.updateGuard(() => {}).catch(() => {});
    await s.unlock('correct horse', WINDOW);
    await s.updateGuard((g) => {
      g.authenticators = [
        {
          id: 'w',
          kind: 'webauthn',
          label: '',
          origin: 'http://localhost:1',
          rpId: 'localhost',
          credential: b64(Buffer.from('c')),
          created: 'x',
        },
      ];
      g.verifyEachAllow = true;
    });
    await s.addPRF('w', 'http://localhost:1', 'localhost', Buffer.from('c'), Buffer.alloc(32, 2), Buffer.alloc(32, 3), 'correct horse');
    await expect(
      s.addPRF('w', 'http://localhost:1', 'localhost', Buffer.from('c'), Buffer.alloc(32, 2), Buffer.alloc(32, 3), 'wrong passphrase'),
    ).rejects.toMatchObject({
      code: 'wrong_passphrase',
    });
    expect(s.unlockEntries()).toHaveLength(1);
    await s.changePassphrase('correct horse', 'new passphrase', WINDOW);
    expect(s.unlockEntries()).toHaveLength(0);
    expect(await s.guard()).toEqual({ verifyEachAllow: true });
    const t = Store.open(path, { kdf: FAST });
    await t.unlock('new passphrase', WINDOW);
    expect(await t.value('B')).toBe('a');
    expect(await s.value('B')).toBe('a');
  });

  test('a passphrase-made entry wraps the key the passphrase gives', async () => {
    const { s, path } = await fresh();
    await s.set('A', { value: 'a' });
    await s.updateGuard((g) => {
      g.authenticators = [
        {
          id: 'w',
          kind: 'webauthn',
          label: '',
          origin: 'http://localhost:1',
          rpId: 'localhost',
          credential: b64(Buffer.from('c')),
          created: 'x',
        },
      ];
    });
    const e = await s.addPRF(
      'w',
      'http://localhost:1',
      'localhost',
      Buffer.from('c'),
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 3),
      'correct horse',
    );
    const t = Store.open(path, { kdf: FAST });
    await t.unlockWith(e.id, prfKEK(Buffer.alloc(32, 3), Buffer.alloc(32, 2)), 14);
    expect(await t.value('A')).toBe('a');
    // An entry whose authenticator left the guard is removed at its use.
    await s.updateGuard((g) => {
      g.authenticators = [];
    });
    expect(s.unlockEntries()).toHaveLength(0);
  });

  test('removed machines leave the lists, also while locked', async () => {
    const { s, path } = await fresh();
    await s.set('A', { value: 'a', machines: ['m1', 'm2'] });
    await s.lock();
    expect(await s.forgetMachine('m1')).toEqual(['A']);
    expect(s.get('A')?.machines).toEqual(['m2']);
    expect(JSON.parse(readFileSync(path, 'utf8')).forgotten).toEqual(['m1']);
    await s.unlock('correct horse', WINDOW);
    expect(JSON.parse(readFileSync(path, 'utf8')).forgotten).toBeUndefined();
    expect(await s.value('A')).toBe('a');
  });

  test('other versions, damaged files and derivations out of bounds do not open', () => {
    const d = temp();
    const at = (content: unknown) => {
      const p = join(d, `v${Math.random()}.json`);
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
      return p;
    };
    const kdf = { salt: b64(Buffer.alloc(16)), time: 1, memory: 8192, threads: 1 };
    const check = { nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AA==' };
    expect(() => Store.open(at('{'))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => Store.open(at({ version: 2, mode: 'passphrase', kdf, check, entries: [] }))).toThrow(
      expect.objectContaining({ code: 'version' }),
    );
    expect(() => Store.open(at({ version: 3, mode: 'keychain', entries: [] }))).toThrow(expect.objectContaining({ code: 'version' }));
    expect(() => Store.open(at({ version: 3, entries: [{ name: 'A' }] }))).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => Store.open(at({ version: 3, mode: 'passphrase', kdf: { ...kdf, memory: 64 }, check }))).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    // Fields this version does not know are kept.
    const p = at({ version: 1, future: { x: 1 } });
    const s = Store.open(p);
    expect(s.status()).toEqual({ mode: '', locked: false, setup: true });
    return s.setPassphrase('correct horse', WINDOW).then(() => expect(JSON.parse(readFileSync(p, 'utf8')).future).toEqual({ x: 1 }));
  });

  test('apps that can be exempted', () => {
    expect(checkApp('claude')).toBeUndefined();
    expect(checkApp('python3.12')?.code).toBe('app_generic');
    expect(checkApp('a-very-long-name-x')?.code).toBe('app_too_long');
    expect(checkApp(' x')?.code).toBe('invalid');
  });

  // Each sealed content's additional data is one text that tells it apart:
  // a value's is the JSON of its name, machines and flag, so lists that
  // read alike when joined differ, and a machine id cannot hold a control
  // character; the guard, the check and the passphrase's window have their
  // own, so none opens in the place of another or of a value.
  test("additional data is one text per content: values, the guard, the check and the window do not open in each other's place", async () => {
    const f = await withAuthenticators();
    const { s, path } = f;
    await expect(s.set('A', { value: 'x', machines: ['a\x01b'] })).rejects.toMatchObject({ code: 'invalid' });
    await s.set('A', { value: 'x', machines: ['a,b'] });
    await expect(s.allow('A', 'a\nb')).rejects.toMatchObject({ code: 'invalid' });
    await s.set('B', { value: 'y', injectOnly: true });
    await s.updateGuard((g) => {
      g.verifyEachAllow = true;
    });
    const { e, kek } = await f.prf();
    await s.lock();

    /** A copy of the vault's file changed by edit, opened. */
    const copy = (edit: (raw: any) => void = () => {}) => {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const byName = (n: string) => raw.entries.find((x: { name: string }) => x.name === n);
      edit(Object.assign(raw, { A: byName('A'), B: byName('B') }));
      delete raw.A;
      delete raw.B;
      const p = join(temp(), 'vault.json');
      writeFileSync(p, JSON.stringify(raw));
      return Store.open(p, { kdf: FAST });
    };
    const unlocked = async (edit: (raw: any) => void) => {
      const t = copy(edit);
      await t.unlock(PASS, WINDOW);
      return t;
    };
    const corrupt = { code: 'corrupt' };

    // As it was, everything opens.
    const same = copy();
    await same.unlockWith(e.id, Buffer.from(kek), 14);
    expect([await same.value('A'), await same.value('B'), (await same.guard()).verifyEachAllow]).toEqual(['x', 'y', true]);

    // A list joined the same way, a flag dropped.
    await expect((await unlocked((r) => (r.A.machines = ['a', 'b']))).value('A')).rejects.toMatchObject(corrupt);
    await expect((await unlocked((r) => delete r.B.injectOnly)).value('B')).rejects.toMatchObject(corrupt);
    // The guard, the check and the window as a value, and a value as the guard.
    for (const from of ['guard', 'check', 'passphraseAt'])
      await expect((await unlocked((r) => (r.A.value = r[from]))).value('A')).rejects.toMatchObject(corrupt);
    await expect((await unlocked((r) => (r.guard = r.A.value))).guard()).rejects.toMatchObject(corrupt);
    await expect((await unlocked((r) => (r.guard = r.check))).guard()).rejects.toMatchObject(corrupt);
    // The window as the check tells no passphrase; the guard as the window
    // lets no authenticator unlock.
    await expect(copy((r) => (r.check = r.passphraseAt)).unlock(PASS, WINDOW)).rejects.toMatchObject({ code: 'wrong_passphrase' });
    const t = copy((r) => (r.passphraseAt = r.guard));
    await expect(t.unlockWith(e.id, Buffer.from(kek), 14)).rejects.toMatchObject({ code: 'passphrase_due' });
    expect(t.status().locked).toBe(true);
  });
});

const PASS = 'correct horse';
const INSTALL = 'install-0123456789';
const ORIGIN = 'https://localhost:8080';
const RPID = 'localhost';
const DESK = 'd1';
const WEB = 'w1';
const CRED = Buffer.from([1, 2, 3, 4]);

/** A vault with a variable and, in its guard, the desktop authenticator and
 * a WebAuthn credential, whose unlock entries it adds as the hub does
 * (the test plays the Secure Enclave, the Hello key and the credential's
 * PRF) with the KEK each would give again. */
async function withAuthenticators() {
  const path = join(temp(), 'vault.json');
  const s = Store.open(path, { kdf: FAST });
  await s.setPassphrase(PASS, WINDOW);
  await s.set('KEY', { value: 'secret' });
  await s.updateGuard((g) => {
    g.authenticators = [
      { id: DESK, kind: KIND_DESKTOP, label: 'Desktop', created: 'x' },
      {
        id: WEB,
        kind: KIND_WEBAUTHN,
        label: 'Key',
        origin: ORIGIN,
        rpId: RPID,
        credential: b64(CRED),
        publicKey: b64(Buffer.from('spki')),
        created: 'x',
      },
    ];
  });
  type Added = { e: UnlockEntry; kek: Buffer };
  const f = {
    path,
    s,
    /** Another start of the hub: the file opened again, locked. */
    reopen(): Store {
      return (f.s = Store.open(path, { kdf: FAST }));
    },
    async enclave(install = INSTALL): Promise<Added> {
      const se = createECDH('prime256v1');
      se.generateKeys();
      const shell = randomBytes(32);
      const e = await f.s.addEnclave(DESK, install, Buffer.from(`blob of ${install}`), se.getPublicKey(), shell, PASS);
      const eph = unb64(e.enclave!.ephPub);
      return { e, kek: enclaveKEK(se.computeSecret(eph), shell, eph, se.getPublicKey()) };
    },
    async hello(install = INSTALL): Promise<Added> {
      const [challenge, sig, shell] = [randomBytes(32), randomBytes(256), randomBytes(32)];
      const e = await f.s.addHello(DESK, install, helloKeyName(install), challenge, Buffer.from('rsa public key'), sig, shell, PASS);
      return { e, kek: helloKEK(sig, shell, challenge) };
    },
    async prf(): Promise<Added> {
      const [salt, out] = [randomBytes(32), randomBytes(32)];
      const e = await f.s.addPRF(WEB, ORIGIN, RPID, CRED, salt, out, PASS);
      return { e, kek: prfKEK(out, salt) };
    },
    /** An unlock with a copy of kek (the store wipes what it is given). */
    unlock: (id: string, kek: Buffer) => f.s.unlockWith(id, Buffer.from(kek), 14),
  };
  return f;
}

/** Edits the vault's file at path as a program (or another build) would. */
function editFile(path: string, fn: (raw: any) => void): void {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  fn(raw);
  writeFileSync(path, JSON.stringify(raw));
}

/** The code a call fails with (some throw before they return a promise),
 * "ok" when it does not. */
const codeOf = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('unlock entries', () => {
  test('each kind unlocks after a lock and another start', async () => {
    for (const kind of ['enclave', 'hello', 'prf'] as const) {
      const f = await withAuthenticators();
      const { e, kek } = await f[kind]();
      f.reopen();
      expect([kind, f.s.status().locked]).toEqual([kind, true]);
      await f.unlock(e.id, kek);
      expect([kind, await f.s.value('KEY')]).toEqual([kind, 'secret']);
    }
  });

  // The wrap's additional data binds every member of the entry: an entry
  // edited in any of them does not open (vault_proof), and one no longer
  // well formed, or of another kind's parameters, is dropped when the file
  // is read (unlock_stale). Either way the vault stays locked.
  test('an edited entry does not open: refused, or dropped when malformed', async () => {
    const flip = (o: Record<string, string>, k: string) => {
      const b = unb64(o[k]);
      b[b.length - 1] ^= 1;
      o[k] = b64(b);
    };
    const otherPoint = () => {
      const k = createECDH('prime256v1');
      k.generateKeys();
      return b64(k.getPublicKey());
    };
    const edits: Array<[string, 'enclave' | 'hello' | 'prf', (e: any) => void, string]> = [
      ['enclave install', 'enclave', (e) => (e.enclave.install = 'install-9999999999'), 'vault_proof'],
      ['enclave blob', 'enclave', (e) => flip(e.enclave, 'blob'), 'vault_proof'],
      ['enclave sePub', 'enclave', (e) => (e.enclave.sePub = otherPoint()), 'vault_proof'],
      ['enclave ephPub', 'enclave', (e) => (e.enclave.ephPub = otherPoint()), 'vault_proof'],
      ['enclave sePub off the curve', 'enclave', (e) => flip(e.enclave, 'sePub'), 'unlock_stale'],
      ['hello keyName', 'hello', (e) => (e.hello.keyName = 'other'), 'unlock_stale'],
      ['hello challenge', 'hello', (e) => flip(e.hello, 'challenge'), 'vault_proof'],
      ['hello publicKey', 'hello', (e) => flip(e.hello, 'publicKey'), 'vault_proof'],
      ['prf origin', 'prf', (e) => (e.prf.origin = 'https://evil.example'), 'vault_proof'],
      ['prf rpId', 'prf', (e) => (e.prf.rpId = 'evil.example'), 'vault_proof'],
      ['prf credential', 'prf', (e) => flip(e.prf, 'credential'), 'vault_proof'],
      ['prf salt', 'prf', (e) => flip(e.prf, 'salt'), 'vault_proof'],
      ['authenticator', 'prf', (e) => (e.authenticator = DESK), 'vault_proof'],
      ['kind', 'hello', (e) => (e.kind = 'enclave'), 'unlock_stale'],
      ['check', 'prf', (e) => (e.check = '0'.repeat(64)), 'unlock_stale'],
      ['wrapped', 'prf', (e) => flip(e.wrapped, 'ciphertext'), 'vault_proof'],
      ['wrapped nonce', 'enclave', (e) => flip(e.wrapped, 'nonce'), 'vault_proof'],
      ["another kind's parameters", 'prf', (e) => (e.hello = { install: INSTALL }), 'unlock_stale'],
    ];
    for (const [name, kind, edit, want] of edits) {
      const f = await withAuthenticators();
      const { e, kek } = await f[kind]();
      await f.s.lock();
      editFile(f.path, (raw) => edit(raw.unlock[0]));
      f.reopen();
      expect([name, await codeOf(f.unlock(e.id, kek)), f.s.status().locked]).toEqual([name, want, true]);
    }
  });

  // An older build keeps the members it does not know (the entries, the
  // window) as they are, so its writes leave them usable; a new passphrase
  // drops every entry, and one an older build set leaves entries of another
  // check, which are dropped when the file is read and gone at the next
  // write.
  test("an older build's write keeps the entries; a new passphrase ends them, also one an older build set", async () => {
    const f = await withAuthenticators();
    const { e, kek } = await f.prf();
    const desk = await f.enclave();
    // The older build deleted a variable and wrote the rest as it read it.
    editFile(f.path, (raw) => (raw.entries = []));
    f.reopen();
    expect(f.s.unlockEntries().map((x) => x.id)).toEqual([e.id, desk.e.id]);
    expect(f.s.passphraseDue()).not.toBeNull();
    await f.unlock(e.id, kek);
    await f.s.removeUnlock(desk.e.id);
    expect(await codeOf(f.s.removeUnlock(desk.e.id))).toBe('not_found');
    expect(await codeOf(f.s.removeUnlock('../x'))).toBe('not_found');

    const before = JSON.parse(readFileSync(f.path, 'utf8')).unlock;
    await f.s.changePassphrase(PASS, 'battery staple', WINDOW);
    expect(f.s.unlockEntries()).toEqual([]);
    expect(readFileSync(f.path, 'utf8')).not.toContain('"unlock"');
    // The older build's change: the new check, the old entries kept.
    editFile(f.path, (raw) => (raw.unlock = before));
    f.reopen();
    expect(f.s.unlockEntries()).toEqual([]);
    expect(await codeOf(f.unlock(e.id, kek))).toBe('unlock_stale');
    await f.s.unlock('battery staple', WINDOW);
    await f.s.set('NEW', { value: 'n' });
    expect(readFileSync(f.path, 'utf8')).not.toContain('"unlock"');
  });

  // Adding an entry checks its input and the guard: its authenticator must
  // be there, of the entry's kind (the credential's for prf, with its
  // origin); one entry per install of the desktop app (of either kind, a
  // new one replaces it), at most 4 installs; one per credential; nothing
  // is added while locked.
  test('entries are bounded: one per install, at most 4, one per credential; their input and authenticator are checked', async () => {
    const f = await withAuthenticators();
    const s = f.s;
    const se = createECDH('prime256v1');
    se.generateKeys();
    const pub = se.getPublicKey();
    const shell = randomBytes(32);
    const offCurve = Buffer.from(pub);
    offCurve[64] ^= 1;
    const b = Buffer.from('b');
    const r = () => randomBytes(32);
    const invalid: Record<string, () => Promise<unknown>> = {
      install: () => s.addEnclave(DESK, 'short', b, pub, shell, PASS),
      'off the curve': () => s.addEnclave(DESK, INSTALL, b, offCurve, shell, PASS),
      compressed: () => s.addEnclave(DESK, INSTALL, b, pub.subarray(0, 33), shell, PASS),
      'no blob': () => s.addEnclave(DESK, INSTALL, Buffer.alloc(0), pub, shell, PASS),
      'big blob': () => s.addEnclave(DESK, INSTALL, Buffer.alloc((4 << 10) + 1), pub, shell, PASS),
      shell: () => s.addEnclave(DESK, INSTALL, b, pub, shell.subarray(0, 31), PASS),
      keyName: () => s.addHello(DESK, INSTALL, 'other', r(), Buffer.from('k'), Buffer.from('s'), shell, PASS),
      challenge: () => s.addHello(DESK, INSTALL, helloKeyName(INSTALL), randomBytes(16), Buffer.from('k'), Buffer.from('s'), shell, PASS),
      signature: () => s.addHello(DESK, INSTALL, helloKeyName(INSTALL), r(), Buffer.from('k'), Buffer.alloc((1 << 10) + 1), shell, PASS),
      publicKey: () => s.addHello(DESK, INSTALL, helloKeyName(INSTALL), r(), Buffer.alloc(0), Buffer.from('s'), shell, PASS),
      output: () => s.addPRF(WEB, ORIGIN, RPID, CRED, r(), randomBytes(31), PASS),
      salt: () => s.addPRF(WEB, ORIGIN, RPID, CRED, randomBytes(8), r(), PASS),
      origin: () => s.addPRF(WEB, 'o'.repeat(513), RPID, CRED, r(), r(), PASS),
      rpId: () => s.addPRF(WEB, ORIGIN, 'a\nb', CRED, r(), r(), PASS),
      credential: () => s.addPRF(WEB, ORIGIN, RPID, Buffer.alloc(1024), r(), r(), PASS),
      'no authenticator': () => s.addPRF('', ORIGIN, RPID, CRED, r(), r(), PASS),
    };
    for (const [name, add] of Object.entries(invalid)) expect([name, await codeOf(add)]).toEqual([name, 'invalid']);
    const notFound: Record<string, () => Promise<unknown>> = {
      'another authenticator': () => s.addPRF('nope', ORIGIN, RPID, CRED, r(), r(), PASS),
      'the desktop one as a credential': () => s.addPRF(DESK, ORIGIN, RPID, CRED, r(), r(), PASS),
      'another credential': () => s.addPRF(WEB, ORIGIN, RPID, Buffer.from([9]), r(), r(), PASS),
      'another origin': () => s.addPRF(WEB, 'https://other', RPID, CRED, r(), r(), PASS),
      'a credential as the desktop one': () => s.addEnclave(WEB, INSTALL, b, pub, shell, PASS),
    };
    for (const [name, add] of Object.entries(notFound)) expect([name, await codeOf(add)]).toEqual([name, 'not_found']);
    expect(s.unlockEntries()).toEqual([]);

    // One per install: a new one replaces it, also of the other kind.
    const first = await f.enclave();
    const second = await f.enclave();
    expect(s.unlockEntries().map((x) => x.id)).toEqual([second.e.id]);
    expect(first.e.id).not.toBe(second.e.id);
    const hello = await f.hello();
    expect(s.unlockEntries().map((x) => x.id)).toEqual([hello.e.id]);
    // At most 4 installs; one of them is still replaced at the bound.
    for (const c of 'abc'.slice(0, MAX_DESKTOP_UNLOCKS - 1)) await f.enclave(INSTALL + c);
    expect(await codeOf(s.addEnclave(DESK, INSTALL + 'z', b, pub, shell, PASS))).toBe('invalid');
    expect(await codeOf(s.addEnclave(DESK, INSTALL, b, pub, shell, PASS))).toBe('ok');
    // One per credential.
    const p1 = await f.prf();
    const p2 = await f.prf();
    const list = s.unlockEntries();
    expect(list).toHaveLength(MAX_DESKTOP_UNLOCKS + 1);
    expect(list.some((x) => x.id === p1.e.id)).toBe(false);
    // What the store hands out are copies.
    list.at(-1)!.prf!.salt = b64(Buffer.alloc(32));
    await s.lock();
    await f.unlock(p2.e.id, p2.kek);
    expect(await codeOf(f.unlock(second.e.id, second.kek))).toBe('unlock_stale');
    // Locked, nothing is added.
    await s.lock();
    expect(await codeOf(s.addPRF(WEB, ORIGIN, RPID, CRED, r(), r(), PASS))).toBe('vault_locked');
    expect(await codeOf(f.unlock('nope', p2.kek))).toBe('unlock_stale');
  });
});

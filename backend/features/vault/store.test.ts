import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { b64, unb64 } from './crypto.ts';
import { desktopOf, relayKey } from './desktop.ts';
import { openExport, sealExport } from './exportfile.ts';
import { checkApp, Store, type Window } from './store.ts';
import { enclaveKEK, helloKEK, prfKEK } from './unlock.ts';

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
});

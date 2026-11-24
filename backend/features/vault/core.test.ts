// The feature's routes and the machines' requests: the gate (sessions,
// passphrase checks slowed down, read-only), approvals, the access log,
// proofs and unlocks by WebAuthn credentials and the desktop app, Verify
// every Allow, exemptions, the automatic lock, export and import.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createECDH, createHash, createHmac, createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { VAULT } from '#kernel/config/staged.ts';
import { agentDialer, checkGuarded, running, sleep, sshSpec, testCore, testMachines, waitFor, type TestCore } from '#kernel/testing.ts';
import { openShared } from '#shared/store/index.ts';
import { readLine, type VaultResponse } from '#shared/proto/agentproto/index.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { coreDBBeside } from './accesslog.ts';
import { relayKey } from './desktop.ts';
import { settings } from './settings.ts';
import { vaultFeature } from './core.ts';
import type { VaultOptions } from './vault.ts';

const PASS = 'correct horse';
const FAST = { time: 1, memory: 8 << 10, threads: 1 };
const ORIGIN = 'https://vault.example';
const HOST = 'vault.example';
const VERIFY_KEY = 'verify-key-of-this-launch-0123456789abcdef';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

interface V {
  t: TestCore;
  dir: string;
  token: string;
  /** A request as the page on ORIGIN sends it, with its session. */
  call(
    method: string,
    path: string,
    body?: unknown,
    o?: { desktop?: boolean; token?: string; origin?: string },
  ): Promise<{ status: number; json: any }>;
  /** A request of machine m1's MCP server, from the process chain. */
  ask(req: object, process?: Array<{ pid: number; name?: string }>): Promise<VaultResponse>;
  log(): Promise<Array<Record<string, any>>>;
}

async function vault(o: VaultOptions = {}, setup = true): Promise<V> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-vault-'));
  dirs.push(dir);
  const dial = agentDialer();
  const machines = testMachines([sshSpec('m1', 'u@box', 'box')], { dial });
  const feature = vaultFeature({ path: join(dir, 'vault.json'), store: { kdf: FAST }, approvalTimeoutMs: 2000, ...o });
  const t = testCore({ features: [feature], machines, settings: { 'plugins.vault.enabled': true }, guard: { allowedOrigins: [ORIGIN] } });
  stops.push(running(t.core));
  await waitFor('m1', () => machines.get('m1')!.ready);
  const v: V = {
    t,
    dir,
    token: '',
    async call(method, path, body, r = {}) {
      const res = await t.request(method, `/api/p/vault${path}`, {
        host: HOST,
        origin: r.origin ?? ORIGIN,
        desktop: r.desktop,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'X-Vault-Session': r.token ?? v.token },
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        // the export's file is JSON too
      }
      return { status: res.status, json };
    },
    async ask(
      req,
      process = [
        { pid: 10, name: 'vault-mcp' },
        { pid: 9, name: 'claude' },
      ],
    ) {
      const conn = await dial.agents[0].open({ op: 'vault', process } as never);
      expect(await readLine(conn.reader)).toEqual({ ok: true });
      conn.stream.write(JSON.stringify(req) + '\n');
      return readLine<VaultResponse>(conn.reader);
    },
    async log() {
      return (await v.call('GET', '/log')).json.log;
    },
  };
  if (setup) {
    const r = await v.call('POST', '/passphrase', { passphrase: PASS });
    expect(r.status).toBe(200);
    v.token = r.json.session;
  }
  return v;
}

/** The id of the first request waiting for an answer. */
async function firstRequest(v: V): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const id = (await v.call('GET', '/requests')).json.requests[0]?.id;
    if (id) return id;
    await sleep(5);
  }
  throw new Error('no request');
}

/** A WebAuthn credential (ES256) that makes the browser's answers. */
function credential(rpId = HOST, origin = ORIGIN) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(16);
  let count = 0;
  const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
  const authData = (attested: boolean) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(++count);
    const parts = [sha(rpId), Buffer.from([0x05 | (attested ? 0x40 : 0)]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(id.length);
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      );
      parts.push(Buffer.alloc(16), len, id, Buffer.from(cose));
    }
    return Buffer.concat(parts);
  };
  const client = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const u = (b: Buffer) => b.toString('base64url');
  return {
    id: u(id),
    create(challenge: string) {
      return {
        clientDataJSON: u(client('webauthn.create', challenge)),
        authenticatorData: u(authData(true)),
        publicKey: u(publicKey.export({ format: 'der', type: 'spki' })),
        alg: -7,
      };
    },
    get(challenge: string, o: { type?: string } = {}) {
      const cd = client(o.type ?? 'webauthn.get', challenge);
      const ad = authData(false);
      return {
        credential: u(id),
        clientDataJSON: u(cd),
        authenticatorData: u(ad),
        signature: u(sign('sha256', Buffer.concat([ad, sha(cd)]), privateKey)),
      };
    },
    /** Its authenticator's counter set back (a copy of it). */
    rewind: () => void (count = 0),
  };
}

describe('the gate', () => {
  test('a passphrase opens a session; the gate stands before changes, reveals and the log', async () => {
    const v = await vault({}, false);
    expect((await v.call('GET', '')).json.status).toEqual({ mode: '', locked: false, setup: true });
    expect((await v.call('POST', '/passphrase', { passphrase: 'short' })).json.error).toBe('weak_passphrase');
    const first = await v.call('POST', '/passphrase', { passphrase: PASS });
    v.token = first.json.session;
    expect(first.json.status.mode).toBe('passphrase');
    // A second "first" passphrase is refused: a change needs the old one.
    expect((await v.call('POST', '/passphrase', { passphrase: 'another one' })).json.error).toBe('has_passphrase');

    const none = { token: 'nope' };
    expect(await v.call('PUT', '/vars/TOKEN', { value: 's3cret' }, none)).toMatchObject({ status: 401, json: { error: 'vault_session' } });
    expect((await v.call('PUT', '/vars/TOKEN', { value: 's3cret', machines: ['m1'] })).json).toMatchObject({
      name: 'TOKEN',
      machines: ['m1'],
    });
    const list = await v.call('GET', '');
    expect(list.json).toMatchObject({ session: true, sessionProof: false, variables: [{ name: 'TOKEN' }] });
    expect(JSON.stringify(list.json)).not.toContain('s3cret');
    expect((await v.call('GET', '', undefined, none)).json.guard).toEqual({ authenticators: [], desktop: false, webauthn: true });
    expect((await v.call('POST', '/vars/TOKEN/reveal', undefined, none)).status).toBe(401);
    expect((await v.call('GET', '/log', undefined, none)).status).toBe(401);
    expect((await v.call('POST', '/vars/TOKEN/reveal')).json).toEqual({ value: 's3cret' });
    expect((await v.log())[0]).toMatchObject({ m: '', tool: 'reveal', names: ['TOKEN'], result: 'revealed' });

    // Locked: every session ends, nothing is revealed, the passphrase opens it.
    expect((await v.call('POST', '/lock')).json).toMatchObject({ locked: true });
    expect((await v.call('POST', '/vars/TOKEN/reveal')).json.error).toBe('vault_session');
    const s = await v.call('POST', '/session', { passphrase: PASS });
    v.token = s.json.session;
    expect((await v.call('POST', '/vars/TOKEN/reveal')).json).toEqual({ value: 's3cret' });
    expect((await v.call('DELETE', '/vars/TOKEN')).json).toEqual({ ok: true });

    // The audit names what changed, never a value or a passphrase.
    const audit = v.t.audit.text();
    expect(audit).toContain('"event":"vault.saved"');
    expect(audit).toContain('"event":"denied.vault_session"');
    expect(audit).not.toContain('s3cret');
    expect(audit).not.toContain(PASS);
  });

  test('wrong passphrases are slowed down, across pages', async () => {
    const v = await vault();
    for (let i = 0; i < 4; i++)
      expect((await v.call('POST', '/session', { passphrase: 'wrong passphrase' })).json.error).toBe('wrong_passphrase');
    const r = await v.t.request('POST', '/api/p/vault/session', { host: HOST, origin: ORIGIN, body: JSON.stringify({ passphrase: PASS }) });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([429, 'wait']);
    expect(['1', '2']).toContain(r.headers.get('Retry-After')!);
  });

  test('a lock asked for during a passphrase check comes after its session, and ends it', async () => {
    let lock: Promise<unknown> | undefined;
    let v!: V;
    v = await vault({
      keyStep: () => {
        if (v?.token) lock ??= v.call('POST', '/lock');
      },
    });
    const s = await v.call('POST', '/session', { passphrase: PASS });
    expect(s.status).toBe(200);
    await lock;
    expect((await v.call('GET', '', undefined, { token: s.json.session })).json).toMatchObject({
      session: false,
      status: { locked: true },
    });
  });

  test('routes that change state are guarded', async () => {
    const rw = await vault();
    const ro = testCore({
      features: [vaultFeature({ path: join(rw.dir, 'ro.json') })],
      readOnly: true,
      settings: { 'plugins.vault.enabled': true },
    });
    const { problems, checked } = await checkGuarded(rw.t, ro, { machine: 'm1' });
    expect(problems).toEqual([]);
    expect(checked.length).toBe(17);
  });

  test('its settings are the staged ones', () => {
    expect(JSON.stringify(settings)).toBe(JSON.stringify(VAULT));
  });
});

describe("machines' requests", () => {
  test('machines listed read at once; others ask; inject-only goes to commands only', async () => {
    const v = await vault({ changedEveryMs: 1 });
    await v.call('PUT', '/vars/GH', { value: 'ghp_x', machines: ['m1'], description: 'GitHub' });
    await v.call('PUT', '/vars/DB', { value: 'pw', machines: ['*'], injectOnly: true });
    await v.call('PUT', '/vars/ASK', { value: 'asked' });
    expect(await v.ask({ tool: 'list' })).toEqual({
      ok: true,
      variables: [
        { name: 'ASK', approval: true },
        { name: 'DB', inject_only: true },
        { name: 'GH', description: 'GitHub' },
      ],
    });
    expect(await v.ask({ tool: 'get', names: ['GH'], client: 'claude' })).toEqual({ ok: true, values: { GH: 'ghp_x' } });
    expect((await v.ask({ tool: 'get', names: ['DB'] })).code).toBe('inject_only');
    const env = await v.ask({ tool: 'env', names: ['DB', 'GH', 'GH'] });
    expect(env).toEqual({ ok: true, values: { DB: 'pw', GH: 'ghp_x' }, run: { timeout: 120, max_timeout: 600, max_output: 64 << 10 } });
    expect((await v.ask({ tool: 'get', names: ['NOPE'] })).code).toBe('not_found');

    // Asking: once, always, deny, as the user answers.
    const answer = async (a: string) => v.call('POST', `/requests/${await firstRequest(v)}`, { answer: a });
    let got = v.ask({ tool: 'get', names: ['ASK'] });
    expect((await answer('once')).json).toEqual({ ok: true });
    expect(await got).toEqual({ ok: true, values: { ASK: 'asked' } });
    got = v.ask({ tool: 'get', names: ['ASK'] });
    expect((await answer('deny')).json).toEqual({ ok: true });
    expect((await got).code).toBe('denied');
    got = v.ask({ tool: 'get', names: ['ASK'] });
    expect((await answer('always')).status).toBe(200);
    expect(await got).toEqual({ ok: true, values: { ASK: 'asked' } });
    expect((await v.call('GET', '')).json.variables.find((x: { name: string }) => x.name === 'ASK').machines).toEqual(['m1']);

    const results = (await v.log()).map((a) => a.result);
    expect(results).toEqual(['approved_always', 'denied', 'approved', 'not_found', 'allowed', 'inject_only', 'allowed', 'listed']);
    // Who asked comes from the agent's header, never from the request.
    expect((await v.log())[0].process).toEqual([
      { pid: 10, name: 'vault-mcp' },
      { pid: 9, name: 'claude' },
    ]);
  });

  test('no answer expires; a requester that leaves cancels; locked refuses', async () => {
    const v = await vault({ approvalTimeoutMs: 100 });
    await v.call('PUT', '/vars/ASK', { value: 'x' });
    expect((await v.ask({ tool: 'get', names: ['ASK'] })).code).toBe('denied');
    expect((await v.log())[0].result).toBe('expired');
    await v.call('POST', '/lock');
    expect((await v.ask({ tool: 'get', names: ['ASK'] })).code).toBe('vault_locked');
    // A list works while locked.
    expect((await v.ask({ tool: 'list' })).ok).toBe(true);
  });

  test('a release whose record cannot be written does not happen', async () => {
    const v = await vault();
    await v.call('PUT', '/vars/GH', { value: 'ghp_x', machines: ['m1'] });
    expect((await v.ask({ tool: 'get', names: ['GH'] })).ok).toBe(true);
    // A newer core migrated the log's tables: this one reads them and does
    // not write.
    const db = openShared(coreDBBeside(join(v.dir, 'vault.json')));
    db.run('UPDATE store_features SET version = 9 WHERE feature = ?', 'vault');
    db.close();
    const t = await vault({ path: join(v.dir, 'vault.json') }, false);
    v.token = (await t.call('POST', '/session', { passphrase: PASS })).json.session;
    t.token = v.token;
    expect(await t.ask({ tool: 'get', names: ['GH'] })).toMatchObject({ ok: false, code: 'log_failed' });
    expect((await t.call('POST', '/vars/GH/reveal')).json.error).toBe('log_failed');
    expect((await t.log()).map((a) => a.result).slice(0, 3)).toEqual(['log_failed', 'log_failed', 'allowed']);
  });

  test('an exempt app reads without asking while unlocked', async () => {
    const v = await vault();
    await v.call('PUT', '/vars/ASK', { value: 'x' });
    expect((await v.call('POST', '/exempt', { app: 'claude', machines: ['m1'] })).json.error).toBe('passphrase_required');
    expect((await v.call('POST', '/exempt', { app: 'bash', machines: ['m1'], passphrase: PASS })).json.error).toBe('app_generic');
    expect((await v.call('POST', '/exempt', { app: 'claude', machines: ['m1'], passphrase: PASS })).json.guard.exempt).toHaveLength(1);
    expect(await v.ask({ tool: 'get', names: ['ASK'] })).toEqual({ ok: true, values: { ASK: 'x' } });
    expect((await v.log())[0].result).toBe('exempted');
    // Another app asks; denying needs no session.
    const other = v.ask({ tool: 'get', names: ['ASK'] }, [
      { pid: 1, name: 'mcp' },
      { pid: 2, name: 'codex' },
    ]);
    expect((await v.call('POST', `/requests/${await firstRequest(v)}`, { answer: 'deny' }, { token: '' })).json).toEqual({ ok: true });
    expect((await other).code).toBe('denied');
    // A removed machine's exemptions go with it.
    v.t.core.forget('m1');
    let exempt: unknown[] = [1];
    for (let i = 0; i < 100 && exempt.length; i++) {
      await sleep(5);
      exempt = (await v.call('GET', '')).json.guard.exempt;
    }
    expect(exempt).toEqual([]);
  });
});

describe('authenticators', () => {
  test('a WebAuthn credential with PRF is added, proves, and unlocks', async () => {
    const v = await vault();
    await v.call('PUT', '/vars/A', { value: 'a' });
    const cred = credential();
    const reg = await v.call('POST', '/proof', { for: 'register' });
    expect(reg.json).toMatchObject({ rpId: HOST, credentials: [], desktop: false, ttl: 120 });
    const prf = randomBytes(32).toString('base64url');
    const add = {
      kind: 'webauthn',
      label: 'Key',
      nonce: reg.json.nonce,
      ...cred.create(reg.json.nonce),
      assertion: cred.get(reg.json.nonce),
      prf,
    };
    expect((await v.call('POST', '/authenticators', { ...add, prf: '' })).json.error).toBe('prf_required');
    // It takes the passphrase in its own request.
    expect((await v.call('POST', '/authenticators', add)).json.error).toBe('wrong_passphrase');
    const added = await v.call('POST', '/authenticators', { ...add, passphrase: PASS });
    expect(added.json.guard.authenticators).toMatchObject([{ kind: 'webauthn', label: 'Key', origin: ORIGIN, rpId: HOST, unlock: true }]);
    const prfSalt = reg.json.prfSalt;

    // A proof opens a session of the unlocked vault, marked as a proof's:
    // what guards the vault takes the passphrase.
    const p = await v.call('POST', '/proof', { for: 'session' });
    expect(p.json.credentials).toEqual([cred.id]);
    const s = await v.call('POST', '/session', { proof: { nonce: p.json.nonce, ...cred.get(p.json.nonce) } });
    expect(s.json).toMatchObject({ proof: true });
    expect((await v.call('POST', '/proof', { for: 'register' }, { token: s.json.session })).json.error).toBe('vault_passphrase');
    // A page of an origin the core does not vouch for proves nothing.
    const q = await v.call('POST', '/proof', { for: 'session' });
    expect(
      (await v.call('POST', '/session', { proof: { nonce: q.json.nonce, ...cred.get(q.json.nonce) } }, { origin: '' })).json.error,
    ).toBe('vault_proof');

    // Locked: the PRF output for its salt, with the credential's assertion.
    await v.call('POST', '/lock');
    const u = await v.call('POST', '/proof', { for: 'session' });
    expect(u.json.prf).toEqual({ [cred.id]: prfSalt });
    expect((await v.call('GET', '', undefined, { token: '' })).json.unlock.ways).toEqual(['prf']);
    // An output that opens the wrap with an assertion that does not hold:
    // the output left the authenticator.
    const bad = await v.call('POST', '/session', {
      unlock: {
        nonce: u.json.nonce,
        prf: { credential: cred.id, output: prf },
        assertion: cred.get(u.json.nonce, { type: 'webauthn.create' }),
      },
    });
    expect(bad.json.error).toBe('vault_proof');
    expect(v.t.audit.text()).toContain('"reason":"prf_signature"');
    const u2 = await v.call('POST', '/proof', { for: 'session' });
    const unlocked = await v.call('POST', '/session', {
      unlock: { nonce: u2.json.nonce, prf: { credential: cred.id, output: prf }, assertion: cred.get(u2.json.nonce) },
    });
    expect(unlocked.json).toMatchObject({ proof: true, status: { locked: false } });
    expect((await v.call('POST', '/vars/A/reveal', undefined, { token: unlocked.json.session })).json).toEqual({ value: 'a' });
    // A counter that does not grow is a copy of the authenticator.
    cred.rewind();
    const c2 = await v.call('POST', '/proof', { for: 'session' });
    expect((await v.call('POST', '/session', { proof: { nonce: c2.json.nonce, ...cred.get(c2.json.nonce) } })).json.error).toBe(
      'vault_proof',
    );

    // Removing it, in a session the passphrase opened, removes its entry.
    const id = added.json.guard.authenticators[0].id;
    expect((await v.call('DELETE', `/authenticators/${id}`, undefined, { token: unlocked.json.session })).json.error).toBe(
      'vault_passphrase',
    );
    v.token = (await v.call('POST', '/session', { passphrase: PASS })).json.session;
    expect((await v.call('DELETE', `/authenticators/${id}`)).json.guard.authenticators).toEqual([]);
    expect(v.t.audit.text()).toContain('"event":"vault.unlock_removed"');
  });

  test("the desktop app's MAC proves, and its relay enrolls and unlocks", async () => {
    const v = await vault({ verifyKey: VERIFY_KEY });
    await v.call('PUT', '/vars/A', { value: 'a' });
    const mac = (nonce: string, p: string) => createHmac('sha256', VERIFY_KEY).update(`vault-proof\n${nonce}\n${p}\n\n`).digest('hex');
    const relay = (ad: string, plain: object) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', relayKey(VERIFY_KEY), iv).setAAD(Buffer.from(ad));
      const ct = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
      return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
    };
    const kv = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/vectors/vault-unlock/kek.json'), 'utf8')).enclave;
    const desk = { desktop: true };
    const reg = await v.call('POST', '/proof', { for: 'register' }, desk);
    // What a nonce is for is the desktop shell's to read only.
    expect((await v.call('GET', `/proof/${reg.json.nonce}`)).status).toBe(404);
    expect((await v.call('GET', `/proof/${reg.json.nonce}`, undefined, desk)).json).toMatchObject({
      for: 'register',
      register: { challenge: expect.any(String) },
    });
    const enroll = relay(`vault-relay\nregister\n${reg.json.nonce}\n`, {
      kind: 'enclave',
      install: 'install-0123456789ab',
      sePub: kv.sePub,
      blob: 'YmxvYg',
      shellSecret: kv.shellSecret,
    });
    // A browser cannot bring the shell's word.
    const asBrowser = await v.call('POST', '/authenticators', {
      kind: 'desktop',
      label: 'Touch ID',
      passphrase: PASS,
      nonce: reg.json.nonce,
      mac: mac(reg.json.nonce, 'register'),
      relay: enroll,
    });
    expect(asBrowser.json.error).toBe('vault_proof');
    const reg2 = await v.call('POST', '/proof', { for: 'register' }, desk);
    const added = await v.call(
      'POST',
      '/authenticators',
      {
        kind: 'desktop',
        label: 'Touch ID',
        passphrase: PASS,
        nonce: reg2.json.nonce,
        mac: mac(reg2.json.nonce, 'register'),
        relay: relay(`vault-relay\nregister\n${reg2.json.nonce}\n`, {
          kind: 'enclave',
          install: 'install-0123456789ab',
          sePub: kv.sePub,
          blob: 'YmxvYg',
          shellSecret: kv.shellSecret,
        }),
      },
      desk,
    );
    expect(added.json.guard.authenticators).toMatchObject([{ kind: 'desktop', label: 'Touch ID', unlock: true }]);

    // A MAC of this nonce and purpose opens a session; of another, nothing.
    const p = await v.call('POST', '/proof', { for: 'session' }, desk);
    expect(p.json.desktop).toBe(true);
    expect((await v.call('POST', '/session', { proof: { nonce: p.json.nonce, mac: mac(p.json.nonce, 'answer') } }, desk)).json.error).toBe(
      'vault_proof',
    );
    const p2 = await v.call('POST', '/proof', { for: 'session' }, desk);
    expect(
      (await v.call('POST', '/session', { proof: { nonce: p2.json.nonce, mac: mac(p2.json.nonce, 'session') } }, desk)).json.proof,
    ).toBe(true);

    // Locked: the shell reads its entry and relays the ECDH secret.
    await v.call('POST', '/lock', undefined, desk);
    const u = await v.call('POST', '/proof', { for: 'session' }, desk);
    const [entry] = (await v.call('GET', `/proof/${u.json.nonce}`, undefined, desk)).json.unlock;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(kv.sePriv, 'base64url'));
    const z = ecdh.computeSecret(Buffer.from(entry.enclave.ephPub, 'base64url')).toString('base64url');
    const body = {
      unlock: {
        nonce: u.json.nonce,
        id: entry.id,
        relay: relay(`vault-relay\nsession\n${u.json.nonce}\n${entry.id}`, { z, shellSecret: kv.shellSecret }),
      },
    };
    expect((await v.call('POST', '/session', body)).json.error).toBe('vault_proof'); // not from the desktop client
    const u2 = await v.call('POST', '/proof', { for: 'session' }, desk);
    const body2 = {
      unlock: {
        nonce: u2.json.nonce,
        id: entry.id,
        relay: relay(`vault-relay\nsession\n${u2.json.nonce}\n${entry.id}`, { z, shellSecret: kv.shellSecret }),
      },
    };
    const ok = await v.call('POST', '/session', body2, desk);
    expect(ok.json).toMatchObject({ proof: true, status: { locked: false } });

    // The shell's word that its key is gone removes the entry.
    await v.call('POST', '/lock', undefined, desk);
    const u3 = await v.call('POST', '/proof', { for: 'session' }, desk);
    const gone = await v.call(
      'POST',
      '/session',
      {
        unlock: {
          nonce: u3.json.nonce,
          id: entry.id,
          relay: relay(`vault-relay\nsession\n${u3.json.nonce}\n${entry.id}`, { invalidated: true }),
        },
      },
      desk,
    );
    expect(gone.json.error).toBe('unlock_stale');
    expect(v.t.audit.text()).toContain('"reason":"invalidated"');
  });

  test('where every Allow is verified, a session lets nothing out', async () => {
    const v = await vault();
    await v.call('PUT', '/vars/A', { value: 'a' });
    expect((await v.call('POST', '/guard', { verifyEachAllow: true })).json.guard.verifyEachAllow).toBe(true);
    expect((await v.call('POST', '/vars/A/reveal')).json.error).toBe('vault_proof');
    expect((await v.call('PUT', '/vars/A', { machines: ['m1'] })).json.error).toBe('vault_proof');
    // Narrowing is no Allow.
    expect((await v.call('PUT', '/vars/A', { description: 'd' })).status).toBe(200);
    expect((await v.call('POST', '/vars/A/reveal', { passphrase: PASS })).json).toEqual({ value: 'a' });
    const got = v.ask({ tool: 'get', names: ['A'] });
    const id = await firstRequest(v);
    expect((await v.call('POST', `/requests/${id}`, { answer: 'once' })).json.error).toBe('vault_proof');
    expect((await v.call('POST', `/requests/${id}`, { answer: 'once', passphrase: PASS })).json).toEqual({ ok: true });
    expect((await got).ok).toBe(true);
    // Ending the rule takes the passphrase.
    expect((await v.call('POST', '/guard', { verifyEachAllow: false })).json.error).toBe('wrong_passphrase');
    expect((await v.call('POST', '/guard', { verifyEachAllow: false, passphrase: PASS })).json.guard.verifyEachAllow).toBe(false);
  });
});

describe('time', () => {
  test('an unused vault locks itself, ending every session', async () => {
    const v = await vault({ autoLockMs: 80, lockCheckMs: 20 });
    await v.call('PUT', '/vars/A', { value: 'a' });
    expect((await v.call('GET', '')).json.autoLock).toMatchObject({ after: 0.08, lockAt: expect.any(String) });
    await waitFor('locked', () => v.t.audit.text().includes('"reason":"idle"'), 2000);
    expect((await v.call('GET', '', undefined, { token: '' })).json.status.locked).toBe(true);
    expect((await v.call('POST', '/vars/A/reveal')).json.error).toBe('vault_session');
  });

  test('sessions count sleep (the wall clock) and never a clock set back (the monotonic one)', async () => {
    let wall = Date.parse('2026-11-20T10:00:00Z');
    let mono = 0;
    const v = await vault({ store: { kdf: FAST, now: () => new Date(wall) }, mono: () => mono });
    wall += 29 * 60_000;
    expect((await v.call('GET', '')).json.session).toBe(true);
    wall -= 3600_000; // set back: the monotonic clock still counts
    mono += 31 * 60_000;
    expect((await v.call('GET', '')).json.session).toBe(false);
  });
});

describe('export and import', () => {
  test('a file the core seals carries values to another vault, its machines mapped by target', async () => {
    const v = await vault();
    await v.call('PUT', '/vars/A', { value: 'a', machines: ['m1', 'gone'] });
    await v.call('PUT', '/vars/B', { value: 'b', injectOnly: true, machines: ['*'] });
    expect((await v.call('POST', '/export', { all: true, passphrase: PASS, filePassphrase: 'short' })).json.error).toBe(
      'weak_export_passphrase',
    );
    expect(
      (await v.call('POST', '/export', { all: true, passphrase: 'wrong passphrase', filePassphrase: 'file passphrase' })).json.error,
    ).toBe('wrong_passphrase');
    const ex = await v.call('POST', '/export', { all: true, passphrase: PASS, filePassphrase: 'file passphrase' });
    expect(ex.status).toBe(200);
    const file = JSON.stringify(ex.json);
    expect(file).not.toContain('"a"');
    expect((await v.log())[0]).toMatchObject({ tool: 'export', names: ['A', 'B'], result: 'exported' });

    const w = await vault();
    await w.call('PUT', '/vars/A', { value: 'old' });
    expect((await w.call('POST', '/import/preview', { file, passphrase: 'wrong passphrase' })).json.error).toBe('file_passphrase');
    const pre = await w.call('POST', '/import/preview', { file, passphrase: 'file passphrase' });
    expect(pre.json.variables).toEqual([
      { name: 'A', description: '', injectOnly: false, machines: ['m1'], unknown: ['gone'], exists: true },
      { name: 'B', description: '', injectOnly: true, machines: ['*'], exists: false },
    ]);
    expect(JSON.stringify(pre.json)).not.toContain('"a"');
    const taken = await w.call('POST', '/import', {
      file,
      passphrase: 'file passphrase',
      choices: [
        { i: 0, action: 'import' },
        { i: 1, action: 'import' },
      ],
    });
    expect(taken.json).toMatchObject({ error: 'exists', name: 'A' });
    const imp = await w.call('POST', '/import', {
      file,
      passphrase: 'file passphrase',
      choices: [
        { i: 0, action: 'rename', as: 'A2' },
        { i: 1, action: 'import' },
      ],
    });
    expect(imp.json).toEqual({ imported: ['A2', 'B'] });
    expect((await w.call('POST', '/vars/A2/reveal')).json).toEqual({ value: 'a' });
    expect((await w.call('POST', '/vars/A/reveal')).json).toEqual({ value: 'old' });
  });
});

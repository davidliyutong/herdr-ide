// Kimi Code's sign-in renewed as the CLI renews it, against a fake token
// endpoint: under its lock (held fresh, stale, abandoned, released by the
// CLI after it renewed), the refresh's form and headers, the rotated
// tokens written back with the file's other members and mode, refusals
// not tried again until the file changes, failures, and no token in a
// reply.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAPI, jwt, removeHomes, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import type { Account, UsageEnv } from './env.ts';
import { KIMI_CLIENT_ID, KIMI_CLI_VERSION, kimiHeaders, kimiVersion, lockKimi, rewrite } from './kimi.ts';
import { limits } from './limits.ts';

const OLD_REFRESH = 'r-old-SECRET';
const NEW_REFRESH = 'r-new-SECRET';
const kimiJWT = (tag: string) => jwt({ user_id: 'k-1', tag });

const creds = (access: string, refresh: string, expiresAt: number) => `{
  "access_token": ${JSON.stringify(access)},
  "refresh_token": ${JSON.stringify(refresh)},
  "expires_at": ${expiresAt},
  "scope": "kimi-code",
  "token_type": "Bearer",
  "expires_in": 900,
  "custom": {"keep": [1, "<&>"]}
}
`;

const apis: FakeAPI[] = [];
const holders: (() => void)[] = [];
afterEach(() => {
  for (const a of apis.splice(0)) a.stop();
  for (const h of holders.splice(0)) h();
});
afterAll(removeHomes);

/** Kimi's token and usage endpoints, and a credential file whose token
 * ended a minute ago. */
function kimiFake() {
  const api = new FakeAPI();
  apis.push(api);
  const home = tempHome();
  const e: UsageEnv = testEnv(home, { api });
  const f = {
    api,
    e,
    home,
    file: join(home, '.kimi-code/credentials/kimi-code.json'),
    lockDir: join(home, '.kimi-code/oauth/kimi-code.lock'),
    oldToken: kimiJWT('old'),
    bearers: [] as string[],
    asked: 0,
    answer: (): Response =>
      Response.json({
        access_token: kimiJWT('new'),
        refresh_token: NEW_REFRESH,
        expires_in: 900,
        scope: 'kimi-code',
        token_type: 'Bearer',
      }),
    async limits(refresh: boolean): Promise<Account> {
      const accs = await limits(e, { providers: ['kimi'], kimiRefresh: refresh });
      expect(accs).toHaveLength(1);
      const b = JSON.stringify(accs[0]);
      for (const secret of [f.oldToken, kimiJWT('new'), kimiJWT('cli'), OLD_REFRESH, NEW_REFRESH, 'SECRET'])
        expect(b).not.toContain(secret);
      return accs[0]!;
    },
    content: () => readFileSync(f.file, 'utf8'),
    /** The CLI holding its lock: its time set every 100 ms until release
     * (which removes it, as unlock does). */
    holdLock(): () => void {
      mkdirSync(f.lockDir, { recursive: true });
      const t = setInterval(() => {
        const now = new Date();
        utimesSync(f.lockDir, now, now);
      }, 100);
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        clearInterval(t);
        rmSync(f.lockDir, { recursive: true, force: true });
      };
      holders.push(release);
      return release;
    },
  };
  api.replies.set('/api/oauth/token', () => {
    f.asked++;
    return f.answer();
  });
  api.replies.set('/coding/v1/usages', (req) => {
    f.bearers.push((req.headers.get('Authorization') ?? '').replace(/^Bearer /, ''));
    return Response.json({ usage: { limit: '100', used: '10', resetTime: '2026-11-20T00:00:00Z' } });
  });
  write(f.file, creds(f.oldToken, OLD_REFRESH, testNowSec - 60));
  write(join(home, '.kimi-code/device_id'), 'dev-1234\n');
  return f;
}

describe('renewal', () => {
  test('the rotated tokens written back as the CLI writes them; its form and headers; the lock released', async () => {
    const f = kimiFake();
    chmodSync(f.file, 0o640);
    const a = await f.limits(true);
    expect(a).toMatchObject({ status: 'ok', id: 'k-1' });
    expect(a.windows).toHaveLength(1);
    expect(f.asked).toBe(1);
    const form = new URLSearchParams(f.api.bodies.get('/api/oauth/token'));
    expect([...form.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
    expect(form.get('client_id')).toBe(KIMI_CLIENT_ID);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(OLD_REFRESH);
    const h = (k: string) => f.api.header('/api/oauth/token', k);
    expect(h('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(h('Accept')).toBe('application/json');
    expect(h('User-Agent')).toBe(`kimi-code-cli/${KIMI_CLI_VERSION}`);
    expect(h('X-Msh-Platform')).toBe('kimi_code_cli');
    expect(h('X-Msh-Version')).toBe(KIMI_CLI_VERSION);
    expect(h('X-Msh-Device-Id')).toBe('dev-1234');
    for (const k of ['X-Msh-Device-Name', 'X-Msh-Device-Model', 'X-Msh-Os-Version']) expect(h(k)).not.toBe('');
    expect(f.bearers).toEqual([kimiJWT('new')]);
    expect(f.content()).toBe(`{
  "access_token": ${JSON.stringify(kimiJWT('new'))},
  "refresh_token": "${NEW_REFRESH}",
  "expires_at": ${testNowSec + 900},
  "scope": "kimi-code",
  "token_type": "Bearer",
  "expires_in": 900,
  "custom": {
    "keep": [
      1,
      "<&>"
    ]
  }
}
`);
    expect(statSync(f.file).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(f.home, '.kimi-code/credentials'))).toEqual(['kimi-code.json']);
    expect(() => statSync(f.lockDir)).toThrow();
    expect(statSync(join(f.home, '.kimi-code/oauth/kimi-code')).size).toBe(0);
    // Fresh now: used as it is.
    await f.limits(true);
    expect(f.asked).toBe(1);
  });

  test('the installed CLI’s version, as its updater recorded it', async () => {
    const home = tempHome();
    const e = testEnv(home);
    const state = join(home, '.kimi-code/updates/install.json');
    for (const [file, want] of [
      ['', KIMI_CLI_VERSION],
      [
        '{"active":null,"lastFailure":null,"lastSuccess":{"version":"2.3.1","installedAt":"2026-11-04T14:24:00Z","notifiedAt":null}}',
        '2.3.1',
      ],
      ['{"active":null,"lastFailure":null,"lastSuccess":null}', KIMI_CLI_VERSION],
      ['{"lastSuccess":{"version":"2.3.1\\r\\nX-Other: 1"}}', KIMI_CLI_VERSION],
      ['not json', KIMI_CLI_VERSION],
    ]) {
      rmSync(state, { force: true });
      if (file) write(state, file!);
      expect(await kimiVersion(e)).toBe(want!);
    }
    write(state, '{"lastSuccess":{"version":"2.3.1"}}');
    const h = await kimiHeaders(e);
    expect(h['User-Agent']).toBe('kimi-code-cli/2.3.1');
    expect(h['X-Msh-Version']).toBe('2.3.1');
  });

  test('only when needed: off, fresh, ending; never another host’s slot or without the CLI’s lock', async () => {
    const f = kimiFake();
    const before = f.content();
    expect(await f.limits(false)).toMatchObject({ status: 'stale', code: 'token_expired' });
    expect(f.asked).toBe(0);
    expect(f.content()).toBe(before);
    write(f.file, creds(f.oldToken, OLD_REFRESH, testNowSec + 600));
    expect((await f.limits(true)).status).toBe('ok');
    expect(f.asked).toBe(0);
    write(f.file, creds(f.oldToken, OLD_REFRESH, testNowSec + 30));
    expect((await f.limits(true)).status).toBe('ok');
    expect(f.asked).toBe(1);
    const expired = creds(f.oldToken, OLD_REFRESH, testNowSec - 60);
    write(f.file, expired);
    f.e.env = { KIMI_DISABLE_OAUTH_LOCK: '1' };
    expect((await f.limits(true)).code).toBe('token_expired');
    expect(f.asked).toBe(1);
    f.e.env = {};
    rmSync(f.file);
    write(join(f.home, '.kimi-code/credentials/kimi-code-env-0123456789abcdef.json'), expired);
    expect((await f.limits(true)).code).toBe('token_expired');
    expect(f.asked).toBe(1);
  });
});

describe('the CLI’s lock', () => {
  test('held by the CLI: waited for, never broken, lock_busy', async () => {
    const f = kimiFake();
    f.holdLock();
    const before = f.content();
    const start = Date.now();
    expect(await f.limits(true)).toMatchObject({ status: 'stale', code: 'lock_busy' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(f.e.t.kimiLockWaitMs - 10);
    expect(f.asked).toBe(0);
    expect(f.content()).toBe(before);
    expect(Date.now() - statSync(f.lockDir).mtimeMs).toBeLessThan(1000);
  });

  test('stale by the CLI’s rule but not abandoned: kept; abandoned: taken over and removed', async () => {
    const f = kimiFake();
    mkdirSync(f.lockDir, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    utimesSync(f.lockDir, old, old);
    expect((await f.limits(true)).code).toBe('lock_busy');
    expect(f.asked).toBe(0);
    expect(Math.abs(statSync(f.lockDir).mtimeMs - old.getTime())).toBeLessThan(2);
    const older = new Date(Date.now() - 60_000);
    utimesSync(f.lockDir, older, older);
    expect((await f.limits(true)).status).toBe('ok');
    expect(f.asked).toBe(1);
    expect(() => statSync(f.lockDir)).toThrow();
  });

  test('the CLI renews meanwhile: its tokens are used, not overwritten', async () => {
    const f = kimiFake();
    f.e.t = { ...f.e.t, kimiLockWaitMs: 30_000 };
    const release = f.holdLock();
    setTimeout(() => {
      write(f.file, creds(kimiJWT('cli'), 'r-cli-SECRET', testNowSec + 900));
      release();
    }, 300);
    expect((await f.limits(true)).status).toBe('ok');
    expect(f.asked).toBe(0);
    expect(f.bearers).toEqual([kimiJWT('cli')]);
    expect(f.content()).not.toContain(NEW_REFRESH);
  });

  test('one renewal at a time in an agent', async () => {
    const f = kimiFake();
    await Promise.all([0, 1, 2].map(() => limits(f.e, { providers: ['kimi'], kimiRefresh: true })));
    expect(f.asked).toBe(1);
  });

  test('kept fresh while held, and not removed once another took it over', async () => {
    const home = tempHome();
    const e = testEnv(home);
    e.t = { ...e.t, kimiLockUpdateMs: 50 };
    const target = join(home, 'oauth/kimi-code');
    const l = await lockKimi(e, target);
    const first = statSync(`${target}.lock`).mtimeMs;
    await Bun.sleep(300);
    expect(statSync(`${target}.lock`).mtimeMs).toBeGreaterThan(first);
    expect(await l.held()).toBe(true);
    rmdirSync(`${target}.lock`);
    mkdirSync(`${target}.lock`);
    const theirs = new Date(Date.now() - 1000);
    utimesSync(`${target}.lock`, theirs, theirs);
    await Bun.sleep(150);
    expect(await l.held()).toBe(false);
    await l.release();
    expect(Math.abs(statSync(`${target}.lock`).mtimeMs - theirs.getTime())).toBeLessThan(2);
  });
});

describe('refusals and failures', () => {
  for (const [name, answer] of [
    [
      'invalid_grant',
      () => Response.json({ error: 'invalid_grant', error_description: `refresh token ${OLD_REFRESH} revoked` }, { status: 400 }),
    ],
    ['401', () => new Response(null, { status: 401 })],
  ] as const) {
    test(`refused (${name}): unauth, not tried again until the file changes`, async () => {
      const f = kimiFake();
      f.answer = answer;
      const before = f.content();
      expect(await f.limits(true)).toMatchObject({ status: 'unauth', code: 'unauthorized', id: 'k-1' });
      expect(f.asked).toBe(1);
      expect(f.content()).toBe(before);
      expect((await f.limits(true)).status).toBe('unauth');
      expect(f.asked).toBe(1);
      // The user signed in again: tried with the new file.
      write(f.file, creds(f.oldToken, 'r-relogin-SECRET', testNowSec - 60));
      f.answer = () => Response.json({ access_token: kimiJWT('new'), refresh_token: NEW_REFRESH, expires_in: 900 });
      expect((await f.limits(true)).status).toBe('ok');
      expect(f.asked).toBe(2);
    });
  }

  for (const [name, answer, code, asked] of [
    ['a server error, retried', () => new Response(null, { status: 503 }), 'http_503', 3],
    ['another status', () => Response.json({ error: 'invalid_request' }, { status: 400 }), 'http_400', 1],
    ['no refresh token', () => Response.json({ access_token: kimiJWT('new'), expires_in: 900 }), 'bad_response', 1],
    [
      'a redirect, not followed',
      () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }),
      'http_3xx',
      1,
    ],
  ] as const) {
    test(`${name}: ${code}, nothing written, tried again at the next poll`, async () => {
      const f = kimiFake();
      f.answer = answer;
      const before = f.content();
      expect(await f.limits(true)).toMatchObject({ status: 'error', code });
      expect(f.asked).toBe(asked);
      expect(f.content()).toBe(before);
      expect(() => statSync(f.lockDir)).toThrow();
      await f.limits(true);
      expect(f.asked).toBe(2 * asked);
    });
  }

  test('no answer: network', async () => {
    const f = kimiFake();
    f.e.urls.kimiToken = 'http://127.0.0.1:1/api/oauth/token';
    expect(await f.limits(true)).toMatchObject({ status: 'error', code: 'network' });
  });
});

test('the CLI’s own file comes back byte for byte with the same answer', () => {
  const old = `{
  "access_token": "a",
  "refresh_token": "r",
  "expires_at": 1,
  "scope": "",
  "token_type": "Bearer",
  "expires_in": 900
}
`;
  const got = rewrite(old, { access: 'a2', refresh: 'r2', scope: '', tokenType: 'Bearer', expiresIn: 899.5 }, 100);
  expect(got).toBe(old.replace('"a"', '"a2"').replace('"r"', '"r2"').replace('1,', '999.5,').replace('900', '899.5'));
});

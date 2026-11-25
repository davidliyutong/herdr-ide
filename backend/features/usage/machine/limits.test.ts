// The providers against fake servers on loopback and files in a home of
// the test's own: windows, credits and balances as each answers them,
// headers, expired tokens never sent, refusals, Retry-After, redirects not
// followed, the proxy of the environment, no token in a reply, skipped
// accounts unasked.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { FakeAPI, TEST_NOW, jwt, removeHomes, script, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import { hashId, type Account, type UsageEnv } from './env.ts';
import { localPost, retryAfter } from './http.ts';
import { isDeepSeekURL, limits, parseGrokBilling, setDeepseekKey, BadKey } from './limits.ts';
import { parseKimiUsage } from './kimi.ts';

// Fake programs may start slowly on a loaded machine (a new script is
// assessed on its first run on macOS).
setDefaultTimeout(60_000);

const apis: FakeAPI[] = [];
const fakeAPI = () => {
  const a = new FakeAPI();
  apis.push(a);
  return a;
};
afterEach(() => {
  for (const a of apis.splice(0)) a.stop();
});
afterAll(removeHomes);

const one = (accs: Account[]): Account => {
  expect(accs).toHaveLength(1);
  return accs[0]!;
};

const read = (e: UsageEnv, providers: string[], o: Record<string, unknown> = {}) => limits(e, { providers, ...o });

const claudeUsageJSON = `{
  "five_hour": {"utilization": 42.5, "resets_at": "2026-11-16T15:00:00Z"},
  "seven_day": {"utilization": 61, "resets_at": "2026-11-20T00:00:00+00:00"},
  "seven_day_opus": {"utilization": 10, "resets_at": null},
  "seven_day_sonnet": null,
  "extra_usage": {"is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "utilization": 25}
}`;

describe('Claude', () => {
  test('windows, extra usage, plan and account; the token never comes back; a known account is not asked', async () => {
    const api = fakeAPI();
    api.json('/api/oauth/usage', claudeUsageJSON);
    const home = tempHome();
    const e = testEnv(home, { api });
    write(
      join(home, '.claude/.credentials.json'),
      `{"claudeAiOauth":{"accessToken":"sk-ant-oat","refreshToken":"r","expiresAt":${TEST_NOW + 3600_000},"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`,
    );
    write(join(home, '.claude.json'), '{"oauthAccount":{"accountUuid":"acc-1","emailAddress":"a@example.com"}}');
    const a = one(await read(e, ['claude']));
    expect(a).toMatchObject({ status: 'ok', id: 'acc-1', email: 'a@example.com', plan: 'Max 20x', source: 'api', asOf: testNowSec });
    expect(api.header('/api/oauth/usage', 'Authorization')).toBe('Bearer sk-ant-oat');
    expect(api.header('/api/oauth/usage', 'anthropic-beta')).toBe('oauth-2025-04-20');
    expect(a.windows).toEqual([
      { kind: 'session', usedPct: 42.5, resetsAt: Date.UTC(2026, 10, 16, 15) / 1000, windowSec: 18000 },
      { kind: 'weekly', usedPct: 61, resetsAt: Date.UTC(2026, 10, 20) / 1000, windowSec: 604800 },
      { kind: 'model', label: 'Opus', usedPct: 10, windowSec: 604800 },
      { kind: 'monthly', label: 'Extra', usedPct: 25 },
    ]);
    expect(a.credits).toEqual({ limit: 50, used: 12.5, enabled: true, unit: 'usd' });
    expect(JSON.stringify(a)).not.toContain('sk-ant');

    api.forget();
    const s = one(await read(e, ['claude'], { skip: ['claude:acc-1'] }));
    expect(s.status).toBe('skipped');
    expect(api.asked('/api/oauth/usage')).toBe(false);
  });

  test('expired: stale and not sent; 401, 429 with Retry-After, 500; missing', async () => {
    const api = fakeAPI();
    const home = tempHome();
    const e = testEnv(home, { api });
    const creds = join(home, '.claude/.credentials.json');
    write(creds, `{"claudeAiOauth":{"accessToken":"t","expiresAt":${TEST_NOW - 60_000}}}`);
    expect(one(await read(e, ['claude']))).toMatchObject({ status: 'stale', code: 'token_expired' });
    expect(api.asked('/api/oauth/usage')).toBe(false);
    write(creds, `{"claudeAiOauth":{"accessToken":"t","expiresAt":${TEST_NOW + 3600_000}}}`);
    api.status('/api/oauth/usage', 401);
    expect(one(await read(e, ['claude'])).status).toBe('unauth');
    api.status('/api/oauth/usage', 429, { 'Retry-After': '120' });
    expect(one(await read(e, ['claude']))).toMatchObject({ status: 'error', code: 'rate_limited', retryAfter: 120 });
    api.status('/api/oauth/usage', 500);
    expect(one(await read(e, ['claude'])).code).toBe('http_500');
    rmSync(creds);
    expect(one(await read(e, ['claude'])).status).toBe('missing');
  });

  test('the macOS keychain, through security(1), only when asked for and the file has none', async () => {
    const api = fakeAPI();
    api.json('/api/oauth/usage', claudeUsageJSON);
    api.json('/api/oauth/profile', '{"account":{"uuid":"acc-k","email":"k@example.com"}}');
    const home = tempHome();
    const asked = join(home, 'asked');
    const security = script(
      join(home, 'fake/security'),
      `echo "$@" >> ${asked}\n[ "$*" = "find-generic-password -s Claude Code-credentials -w" ] || exit 44\necho '{"claudeAiOauth":{"accessToken":"kc","expiresAt":${TEST_NOW + 3600_000},"subscriptionType":"pro"}}'`,
    );
    const e = testEnv(home, { api, platform: 'darwin' });
    e.programs.security = security;
    expect(one(await read(e, ['claude']))).toMatchObject({ status: 'missing' });
    expect(() => statSync(asked)).toThrow();
    const a = one(await read(e, ['claude'], { claudeKeychain: true }));
    expect(a).toMatchObject({ status: 'ok', id: 'acc-k', email: 'k@example.com', plan: 'Pro' });
    expect(api.header('/api/oauth/usage', 'Authorization')).toBe('Bearer kc');
    // No one to allow the access (ssh): as if none.
    e.programs.security = script(join(home, 'fake/refusing'), 'echo "user interaction is not allowed" >&2; exit 36');
    expect(one(await read(e, ['claude'], { claudeKeychain: true }))).toMatchObject({ status: 'missing', code: 'keychain' });
    // Not on Linux.
    expect(
      one(await read({ ...e, platform: 'linux', programs: { ...e.programs, security } }, ['claude'], { claudeKeychain: true })).status,
    ).toBe('missing');
  });
});

const codexUsageJSON = `{
  "plan_type": "pro",
  "rate_limit": {
    "allowed": true,
    "primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_at": 1795000000},
    "secondary_window": {"used_percent": 70.5, "limit_window_seconds": 604800, "reset_after_seconds": 3600}
  },
  "credits": {"has_credits": true, "unlimited": false, "balance": "37.5"},
  "additional_rate_limits": [
    {"limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {"primary_window": {"used_percent": 3, "limit_window_seconds": 18000, "reset_at": 1795000100}}}
  ]
}`;

function codexAuth(home: string, exp: number) {
  const id = jwt({ email: 'c@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } });
  write(
    join(home, 'auth.json'),
    `{"OPENAI_API_KEY":null,"tokens":{"id_token":"${id}","access_token":"${jwt({ exp })}","refresh_token":"r","account_id":"org-acc"}}`,
  );
}

const codexRollout = `{"timestamp":"2026-11-15T10:00:00.000Z","type":"session_meta","payload":{"cwd":"/home/u/proj-a"}}
{"timestamp":"2026-11-15T10:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":20,"window_minutes":300,"resets_in_seconds":600},"secondary":{"used_percent":50,"window_minutes":10080,"resets_at":1795100000}}}}
`;

describe('Codex', () => {
  test('windows, the account header, credits', async () => {
    const api = fakeAPI();
    api.json('/backend-api/wham/usage', codexUsageJSON);
    const home = tempHome();
    codexAuth(join(home, '.codex'), testNowSec + 3600);
    const a = one(await read(testEnv(home, { api }), ['codex']));
    expect(a).toMatchObject({ status: 'ok', id: 'org-acc', email: 'c@example.com', plan: 'Pro' });
    expect(api.header('/backend-api/wham/usage', 'ChatGPT-Account-Id')).toBe('org-acc');
    expect(a.windows).toEqual([
      { kind: 'session', usedPct: 12, resetsAt: 1795000000, windowSec: 18000 },
      { kind: 'weekly', usedPct: 70.5, resetsAt: testNowSec + 3600, windowSec: 604800 },
      { kind: 'model', label: 'GPT-5.3-Codex-Spark', usedPct: 3, resetsAt: 1795000100, windowSec: 18000 },
    ]);
    expect(a.credits).toEqual({ balance: 37.5, enabled: true, unit: 'credits' });
  });

  test('without an answer, or with an expired token, the newest log’s rate limits; another home without credentials is left out', async () => {
    const home = tempHome();
    const codex = join(home, '.codex');
    write(join(codex, 'sessions/2026/11/15/rollout-a.jsonl'), codexRollout);
    codexAuth(codex, testNowSec + 3600);
    const e = testEnv(home);
    const a = one(await read(e, ['codex']));
    const logTime = Date.UTC(2026, 10, 15, 10, 0, 1) / 1000;
    expect(a).toMatchObject({ status: 'stale', code: 'from_log', source: 'log', id: 'org-acc', asOf: logTime });
    expect(a.windows).toEqual([
      { kind: 'session', usedPct: 20, resetsAt: logTime + 600, windowSec: 18000 },
      { kind: 'weekly', usedPct: 50, resetsAt: 1795100000, windowSec: 604800 },
    ]);
    codexAuth(codex, testNowSec - 3600);
    const x = one(await read(e, ['codex']));
    expect(x).toMatchObject({ status: 'stale', code: 'token_expired', plan: 'Plus' });
    expect(x.windows).toHaveLength(2);
    expect(await read(e, ['codex'], { codexHomes: ['~/other-codex'] })).toHaveLength(1);
  });

  test('the newest log is read once while it does not change', async () => {
    const home = tempHome();
    const log = join(home, '.codex/sessions/2026/11/15/rollout-a.jsonl');
    write(log, codexRollout);
    const t = new Date(TEST_NOW);
    utimesSync(log, t, t);
    const e = testEnv(home);
    expect(one(await read(e, ['codex'])).windows?.[0]?.usedPct).toBe(20);
    // The same size and time: what it said before.
    write(log, codexRollout.replace('"used_percent":20', '"used_percent":30'));
    utimesSync(log, t, t);
    expect(one(await read(e, ['codex'])).windows?.[0]?.usedPct).toBe(20);
    appendFileSync(log, '\n');
    expect(one(await read(e, ['codex'])).windows?.[0]?.usedPct).toBe(30);
  });
});

describe('Grok', () => {
  test('credits by their period, products, plan; an entry without a key lends nothing to the next', async () => {
    const api = fakeAPI();
    api.json(
      '/v1/billing',
      `{"config":{"creditUsagePercent":33.3,"currentPeriod":{"start":"2026-11-14T02:17:00Z","end":"2026-11-21T02:17:00Z"},
        "onDemandUsed":{"val":"3"},"onDemandCap":{"val":10},"productUsage":[{"product":"grok-code","usagePercent":12}]}}`,
    );
    api.json('/v1/settings', '{"subscription_tier_display":"SuperGrok Heavy"}');
    const home = tempHome();
    const e = testEnv(home, { api });
    write(
      join(home, '.grok/auth.json'),
      `{"https://other.example::x": {"key": "other", "email": "o@example.com"},
        "https://auth.x.ai::grok-cli": {"key": "xai-key", "expires_at": "2027-01-01T00:00:00Z", "email": "g@example.com", "user_id": "u-9"}}`,
    );
    const a = one(await read(e, ['grok']));
    expect(a).toMatchObject({ status: 'ok', id: 'u-9', plan: 'SuperGrok Heavy' });
    expect(api.header('/v1/billing', 'Authorization')).toBe('Bearer xai-key');
    expect(api.header('/v1/billing', 'X-XAI-Token-Auth')).toBe('xai-grok-cli');
    const end = Date.UTC(2026, 10, 21, 2, 17) / 1000;
    expect(a.windows).toEqual([
      { kind: 'weekly', usedPct: 33.3, resetsAt: end, windowSec: 7 * 86400 },
      { kind: 'model', label: 'grok-code', usedPct: 12, resetsAt: end, windowSec: 7 * 86400 },
    ]);
    expect(a.credits).toEqual({ used: 3, limit: 10, unit: 'credits' });
    write(
      join(home, '.grok/auth.json'),
      `{"https://auth.x.ai::old": {"expires_at": "2020-01-01T00:00:00Z", "email": "old@example.com", "user_id": "u-old"},
        "https://other.example::x": {"key": "other-key"}}`,
    );
    const b = one(await read(e, ['grok']));
    expect(b.status).toBe('ok');
    expect(b.id).toBeUndefined();
    expect(b.email).toBeUndefined();
  });

  test('the percentage from on-demand use; the window’s kind by its period', () => {
    const b: Account = { provider: 'grok', status: '' };
    parseGrokBilling(b, { config: { onDemandUsed: { val: 5 }, onDemandCap: { val: 20 } } });
    expect(b.windows).toEqual([{ kind: 'weekly', usedPct: 25 }]);
    for (const [start, end, kind] of [
      ['2026-11-14T00:00:00Z', '2026-11-21T00:00:00Z', 'weekly'],
      ['2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 'monthly'],
      ['2026-11-16T10:00:00Z', '2026-11-16T15:00:00Z', 'session'],
      ['', '', 'weekly'],
    ]) {
      const c: Account = { provider: 'grok', status: '' };
      parseGrokBilling(c, { config: { creditUsagePercent: 10, currentPeriod: { start, end } } });
      expect(c.windows?.map((w) => w.kind)).toEqual([kind!]);
    }
  });
});

describe('Kimi Code', () => {
  test('numbers in strings; an expired token is stale', async () => {
    const api = fakeAPI();
    api.json(
      '/coding/v1/usages',
      `{"usage":{"limit":"1000","used":"250","remaining":"750","resetTime":"2026-11-20T00:00:00Z"},
        "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"40","resetTime":"2026-11-16T14:00:00Z"}}]}`,
    );
    const home = tempHome();
    const e = testEnv(home, { api });
    const file = join(home, '.kimi-code/credentials/kimi-code.json');
    write(file, `{"access_token":"${jwt({ user_id: 'k-1' })}","expires_at":${testNowSec + 3600}}`);
    const a = one(await read(e, ['kimi']));
    expect(a).toMatchObject({ status: 'ok', id: 'k-1' });
    expect(a.windows).toEqual([
      { kind: 'session', usedPct: 60, resetsAt: Date.UTC(2026, 10, 16, 14) / 1000, windowSec: 18000 },
      { kind: 'weekly', usedPct: 25, resetsAt: Date.UTC(2026, 10, 20) / 1000, windowSec: 604800 },
    ]);
    write(file, '{"access_token":"x","expires_at":1}');
    expect(one(await read(e, ['kimi'])).status).toBe('stale');
  });

  test('Kimi Code 2.2.0’s usages and booster wallet', async () => {
    const api = fakeAPI();
    api.json(
      '/coding/v1/usages',
      `{"usages":{
          "limit_5h":{"used_ratio":0.42,"reset_time":"2026-11-16T15:00:00Z"},
          "limit_7d":{"used_ratio":"0.1","reset_time":"2026-11-20T00:00:00Z"},
          "limit_month_total":{"used_ratio":0.6,"reset_time":"2026-12-01T00:00:00Z"},
          "limit_month_code":{"used_ratio":0.25,"reset_time":"2026-12-01T00:00:00Z"},
          "limit_unknown":{"used_ratio":0.9}},
        "boosterWallet":{"balance":{"type":"BOOSTER","amount":"5000000000","amountLeft":1234000000},
          "monthlyChargeLimitEnabled":true,"monthlyChargeLimit":{"priceInCents":5000,"currency":"CNY"},"monthlyUsed":{"priceInCents":"300","currency":"CNY"}}}`,
    );
    const home = tempHome();
    write(
      join(home, '.kimi-code/credentials/kimi-code.json'),
      `{"access_token":"${jwt({ user_id: 'k-1' })}","expires_at":${testNowSec + 3600}}`,
    );
    const a = one(await read(testEnv(home, { api }), ['kimi']));
    const month = Date.UTC(2026, 11, 1) / 1000;
    expect(a.windows).toEqual([
      { kind: 'session', usedPct: 42, resetsAt: Date.UTC(2026, 10, 16, 15) / 1000, windowSec: 18000 },
      { kind: 'weekly', usedPct: 10, resetsAt: Date.UTC(2026, 10, 20) / 1000, windowSec: 604800 },
      { kind: 'monthly', usedPct: 60, resetsAt: month, windowSec: 30 * 86400 },
      { kind: 'monthly', label: 'Code', usedPct: 25, resetsAt: month, windowSec: 30 * 86400 },
    ]);
    expect(a.credits).toEqual({ balance: 12.34, enabled: true, unit: 'cny', used: 3, limit: 50 });
  });

  test('either shape, the richer counting; wallets', () => {
    const older = `"usage":{"limit":"100","used":"30","resetTime":"2026-11-20T00:00:00Z"},
      "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"40"}}]`;
    const newer2 = '"usages":{"limit_5h":{"used_ratio":0.5},"limit_7d":{"used_ratio":0.3}}';
    const newer4 =
      '"usages":{"limit_5h":{"used_ratio":0.5},"limit_7d":{"used_ratio":0.3},"limit_month_total":{"used_ratio":0.2},"limit_month_code":{"used_ratio":0.1}}';
    const newer1 = '"usages":{"limit_7d":{"used_ratio":0.3}}';
    for (const [body, kinds] of [
      [`{${older}}`, ['session', 'weekly']],
      [`{${older},${newer4}}`, ['session', 'weekly', 'monthly', 'monthly']],
      [`{${older},${newer1}}`, ['session', 'weekly']],
      [`{${older},${newer2}}`, ['session', 'weekly']],
      ['{"usages":{},"limits":[]}', []],
    ] as const) {
      const a: Account = { provider: 'kimi', status: '' };
      parseKimiUsage(a, JSON.parse(body));
      expect(a.windows?.map((w) => w.kind) ?? []).toEqual([...kinds]);
      if (body.includes(newer2)) expect(a.windows?.[1]?.usedPct).toBe(30);
    }
    for (const [wallet, want] of [
      ['null', undefined],
      ['{"balance":{"type":"GIFT","amount":100}}', undefined],
      ['{"balance":{"type":"BOOSTER","amount":0}}', undefined],
      [
        '{"balance":{"type":"BOOSTER","amount":1000000,"amountLeft":400000},"monthlyChargeLimitEnabled":false,"monthlyChargeLimit":{"priceInCents":900}}',
        { balance: 0.01, enabled: true, unit: 'usd' },
      ],
    ] as const) {
      const a: Account = { provider: 'kimi', status: '' };
      parseKimiUsage(a, JSON.parse(`{"boosterWallet":${wallet}}`));
      expect(a.credits).toEqual(want);
    }
  });

  test('an account without an id the core holds back is not asked', async () => {
    const api = fakeAPI();
    const home = tempHome();
    write(join(home, '.kimi-code/credentials/kimi-code.json'), '{"access_token":"opaque"}');
    expect(one(await read(testEnv(home, { api }), ['kimi'], { skipLocal: ['kimi'] })).status).toBe('skipped');
    expect(api.asked('/coding/v1/usages')).toBe(false);
  });
});

describe('DeepSeek', () => {
  test('the key file first, then the environment’s, then Claude Code’s for DeepSeek; the key never comes back', async () => {
    const api = fakeAPI();
    api.json(
      '/user/balance',
      '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}',
    );
    const home = tempHome();
    const e = testEnv(home, { api });
    expect(one(await read(e, ['deepseek'])).status).toBe('missing');
    write(
      join(home, '.claude/settings.json'),
      '{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-claude-ds"}}',
    );
    const a = one(await read(e, ['deepseek']));
    expect(a).toMatchObject({ status: 'ok', id: hashId('sk-claude-ds'), available: true });
    expect(api.header('/user/balance', 'Authorization')).toBe('Bearer sk-claude-ds');
    expect(a.balances).toEqual([{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }]);
    expect(JSON.stringify(a)).not.toContain('sk-claude-ds');
    await read({ ...e, env: { DEEPSEEK_API_KEY: 'sk-env' } }, ['deepseek']);
    expect(api.header('/user/balance', 'Authorization')).toBe('Bearer sk-env');
    rmSync(join(home, '.claude/settings.json'));
    await setDeepseekKey(e.base, 'sk-file');
    expect(statSync(join(e.base, 'usage/deepseek.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(e.base, 'usage')).mode & 0o777).toBe(0o700);
    await read({ ...e, env: { DEEPSEEK_API_KEY: 'sk-env' } }, ['deepseek']);
    expect(api.header('/user/balance', 'Authorization')).toBe('Bearer sk-file');
    await expect(setDeepseekKey(e.base, 'bad key\n')).rejects.toBeInstanceOf(BadKey);
    await setDeepseekKey(e.base, '');
    expect(() => statSync(join(e.base, 'usage/deepseek.key'))).toThrow();
  });

  test('a gateway with deepseek in its name never gets the token', async () => {
    const api = fakeAPI();
    api.json('/user/balance', '{"is_available":true}');
    const home = tempHome();
    const e = testEnv(home, { api });
    for (const u of [
      'https://deepseek.evil.example/anthropic',
      'https://api.deepseek.com.evil.example',
      'http://api.deepseek.com/anthropic',
      'https://notdeepseek.com/x',
      'https://user@evil.example@api.deepseek.com',
    ]) {
      write(join(home, '.claude/settings.json'), `{"env":{"ANTHROPIC_BASE_URL":"${u}","ANTHROPIC_AUTH_TOKEN":"sk-gateway"}}`);
      expect(one(await read(e, ['deepseek'])).status).toBe('missing');
    }
    expect(api.asked('/user/balance')).toBe(false);
    for (const u of ['https://api.deepseek.com/anthropic', 'https://API.DeepSeek.com.', 'https://eu.api.deepseek.com'])
      expect(isDeepSeekURL(u)).toBe(true);
  });
});

describe('requests', () => {
  test('a redirect is not followed: credentials reach the fixed host only', async () => {
    const target = fakeAPI();
    target.json('/steal', '{}');
    const api = fakeAPI();
    api.replies.set('/user/balance', () => new Response(null, { status: 302, headers: { Location: `${target.url}/steal` } }));
    const home = tempHome();
    const a = one(await read({ ...testEnv(home, { api }), env: { DEEPSEEK_API_KEY: 'sk-redirect' } }, ['deepseek']));
    expect(a).toMatchObject({ status: 'error', code: 'http_302' });
    expect(target.asked('/steal')).toBe(false);
  });

  test('Retry-After: seconds or a date, 60 s when it says nothing, at most a day', () => {
    const now = Date.UTC(2026, 0, 1);
    for (const [h, want] of [
      ['30', 30],
      ['', 60],
      ['junk', 60],
      ['999999', 86400],
      [new Date(now + 90_000).toUTCString(), 90],
    ] as const)
      expect(retryAfter(h, now)).toBe(want);
  });

  test('the requests go through the proxy of the environment, unless NO_PROXY names the host', async () => {
    const seen: string[] = [];
    const proxy = net.createServer((c) => {
      c.once('data', (d) => {
        seen.push(d.toString().split('\r\n')[0]!);
        c.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{"is_available":true,"balance_infos":[]}',
        );
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const was = { http: process.env.HTTP_PROXY, no: process.env.NO_PROXY };
    process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    try {
      const home = tempHome();
      const e = { ...testEnv(home), env: { DEEPSEEK_API_KEY: 'sk-proxied' } };
      e.urls.deepseekBalance = 'http://api.deepseek.invalid/user/balance';
      expect(one(await read(e, ['deepseek'])).status).toBe('ok');
      expect(seen).toEqual(['GET http://api.deepseek.invalid/user/balance HTTP/1.1']);
      process.env.NO_PROXY = 'api.deepseek.invalid';
      expect(one(await read(e, ['deepseek'])).code).toBe('network');
      expect(seen).toHaveLength(1);
    } finally {
      for (const [k, v] of [
        ['HTTP_PROXY', was.http],
        ['NO_PROXY', was.no],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      proxy.close();
    }
  });

  test('the language server’s client reaches 127.0.0.1 only, through no proxy', async () => {
    const api = fakeAPI();
    api.json('/x', '{"local":true}');
    const was = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    try {
      expect(await localPost(api.port, 'http', '/x', {}, '{}', 2000)).toEqual({ local: true });
      await expect(localPost(api.port, 'https', '/x', {}, '{}', 2000)).rejects.toMatchObject({ code: 'network' });
    } finally {
      if (was === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = was;
    }
  });

  test('OpenCode has no account; a provider not asked for is not read', async () => {
    const home = tempHome();
    expect(await read(testEnv(home), ['opencode'])).toEqual([]);
    const all = await limits(testEnv(home), {});
    expect(all.map((a) => a.provider)).toEqual(['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek']);
    expect(all.every((a) => a.status === 'missing')).toBe(true);
  });
});

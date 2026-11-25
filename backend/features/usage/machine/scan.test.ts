// The cost of the CLIs' logs: Claude Code's, Codex's (both formats),
// Grok's (and its legacy log), Kimi Code's; dedupe, pricing tiers and the
// user's prices, days in the user's zone, the quarters of an hour; the
// cache in the machine's database (read on, written seldom, kept when a
// scan is cut short, retention, another agent's save, a newer version,
// per host, the Go agent's entries) and the ETag.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { MACHINE_DB, hostFile, openShared } from '#shared/store/index.ts';
import { removeHomes, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import { CACHE_VERSION, cacheDB, entryJSON, loadCache, saveCache } from './cache.ts';
import type { UsageEnv } from './env.ts';
import { hashKey, kimiModelName, rec, type Entry } from './parsers.ts';
import { modelPricing, pricingWith, tierCost, tierOf, validPrices } from './pricing.ts';
import { CostScanner, dedupe, type CostOptions, type CostReport } from './scan.ts';

afterAll(removeHomes);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const claudeLog1 = `{"type":"user","timestamp":"2026-11-15T09:00:00Z","message":{"role":"user","content":"hi"}}
{"timestamp":"2026-11-15T09:00:01Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":100}}}
{"timestamp":"2026-11-15T09:00:02Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":500}}}
{"timestamp":"2026-11-15T09:00:03Z","requestId":"req-x","message":{"role":"assistant","model":"<synthetic>","id":"msg-x","usage":{"input_tokens":5,"output_tokens":5}}}
`;
// The same response again in a forked session.
const claudeLog2 = `{"timestamp":"2026-11-15T09:00:02Z","requestId":"req-1","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-opus-4-6-20260101","id":"msg-1","usage":{"input_tokens":1000,"cache_read_input_tokens":2000,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":400}}}
`;
const codexNew = `{"timestamp":"2026-11-15T10:00:00Z","type":"session_meta","payload":{"cwd":"/work/beta"}}
{"timestamp":"2026-11-15T10:00:00Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.5","cwd":"/work/beta"}}
{"timestamp":"2026-11-15T10:00:05Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r1","usage":{"input_tokens":300000,"cached_input_tokens":100000,"output_tokens":1000,"reasoning_output_tokens":200}}}
{"timestamp":"2026-11-15T10:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300000},"last_token_usage":{"input_tokens":300000,"cached_input_tokens":100000,"output_tokens":1000}}}}
`;
const codexLegacy = `{"timestamp":"2026-11-14T10:00:00Z","type":"turn_context","payload":{"model":"gpt-5.3-codex","cwd":"/work/gamma"}}
{"timestamp":"2026-11-14T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250},"last_token_usage":{"input_tokens":150,"cached_input_tokens":50,"output_tokens":20}}}}
`;
const grokUpdates =
  '{"method":"session/update","params":{"_meta":{"agentTimestampMs":1794744000000},"update":{"sessionUpdate":"turn_completed","usage":{"modelUsage":{"grok-4.6-0709":{"modelCalls":2,"inputTokens":500000,"cachedReadTokens":100000,"cacheCreationTokens":0,"outputTokens":1000,"reasoningTokens":300}}}}}}\n';
const grokEvents = '{"type":"turn_started","session_id":"s1","model_id":"grok-4.6"}\n';
const grokUnified = `{"ts":"2026-11-15T11:00:00Z","msg":"shell.turn.inference_done","sid":"s1","ctx":{"prompt_tokens":1000,"cached_prompt_tokens":200,"completion_tokens":50,"reasoning_tokens":10}}
{"ts":"2026-11-15T11:00:01Z","msg":"shell.turn.inference_retry","sid":"s1"}
`;

function fixtures(home: string) {
  write(join(home, '.claude/projects/-home-u-alpha/s1.jsonl'), claudeLog1);
  write(join(home, '.claude/projects/-home-u-alpha/sub/fork.jsonl'), claudeLog2);
  write(join(home, '.codex/sessions/2026/11/15/rollout-new.jsonl'), codexNew);
  write(join(home, '.codex/archived_sessions/rollout-old.jsonl'), codexLegacy);
  write(join(home, '.grok/sessions/%2Fwork%2Fdelta/abc/updates.jsonl'), grokUpdates);
  write(join(home, '.grok/sessions/%2Fwork%2Fdelta/abc/events.jsonl'), grokEvents);
  write(join(home, '.grok/logs/unified.jsonl.1.gz'), gzipSync(grokUnified));
}

type Row = NonNullable<CostReport['rows']>[number];

/** The rows by provider|model|project, the days summed. */
function rowsBy(rep: CostReport): Record<string, Row & { cost: number; output: number; requests: number }> {
  const out: Record<string, Row & { cost: number; output: number; requests: number }> = {};
  for (const r of rep.rows ?? []) {
    const k = `${r.provider}|${r.model}|${r.project ?? ''}`;
    const prev = out[k];
    out[k] = prev
      ? { ...prev, cost: prev.cost + r.cost!, output: prev.output + r.output!, requests: prev.requests + r.requests! }
      : (r as Row & { cost: number; output: number; requests: number });
  }
  return out;
}

const since = testNowSec - 30 * 86400;

function setup(o: { fixtures?: boolean } = {}) {
  const home = tempHome();
  if (o.fixtures !== false) fixtures(home);
  const e = testEnv(home);
  const s = new CostScanner(e.base);
  return { home, e, s, cost: (x: Partial<CostOptions> = {}, env: UsageEnv = e) => s.scan(env, { since, ...x }) };
}

/** Sets the time the cache below base was last saved (ms). */
function setSaved(base: string, ms: number) {
  const db = openShared(cacheDB(base));
  try {
    db.run('UPDATE usage_cost_state SET saved = ? WHERE id = 1', BigInt(Math.round(ms)) * 1_000_000n);
  } finally {
    db.close();
  }
}
const aged = (base: string) => setSaved(base, Date.now() - 6 * 60_000);
const savedAt = (base: string) => {
  const db = openShared(cacheDB(base));
  try {
    return Number(db.get<{ ms: number }>('SELECT saved / 1000000 AS ms FROM usage_cost_state WHERE id = 1')!.ms);
  } finally {
    db.close();
  }
};

let lastTime = 0;
/** Appends to a log and moves its time on. */
function appendTo(f: string, text: string) {
  appendFileSync(f, text);
  lastTime = Math.max(lastTime + 1000, Date.now() + 60_000);
  const later = new Date(lastTime);
  utimesSync(f, later, later);
}

describe('the logs', () => {
  test('each CLI’s records, priced; dedupe; days in the user’s zone; since', async () => {
    const { cost } = setup();
    const rep = await cost();
    const rows = rowsBy(rep);
    // Claude: one response (the most output of its copies), 5 m and 1 h
    // cache writes at their own prices, the synthetic message left out.
    const c = rows['claude|claude-opus-4-6|alpha']!;
    expect([c.requests, c.output, c.cacheWrite]).toEqual([1, 500, 300]);
    expect(near(c.cost, (1000 * 5 + 2000 * 0.5 + 100 * 6.25 + 200 * 10 + 500 * 25) / 1e6)).toBe(true);
    // Codex, new format: the long-context tier; the token_count after it
    // is a replay.
    const x = rows['codex|gpt-5.5|beta']!;
    expect([x.requests, x.input, x.cached]).toEqual([1, 200000, 100000]);
    expect(near(x.cost, (200000 * 10 + 100000 * 1 + 1000 * 45) / 1e6)).toBe(true);
    // Codex, legacy: a total that does not move is a replay.
    const l = rows['codex|gpt-5.3-codex|gamma']!;
    expect(l.requests).toBe(2);
    expect(near(l.cost, (100 * 1.75 + 10 * 14) / 1e6 + (100 * 1.75 + 50 * 0.175 + 20 * 14) / 1e6)).toBe(true);
    // Grok: the tier by the turn's average prompt (250k: the long one).
    const g = rows['grok|grok-4.6|delta']!;
    expect(g.requests).toBe(2);
    expect(near(g.cost, (400000 * 4 + 100000 * 1 + 1000 * 12) / 1e6)).toBe(true);
    // Legacy Grok: the model from the session's events, retries counted.
    const lg = rows['grok|grok-4.6|']!;
    expect(lg.requests).toBe(1);
    expect(near(lg.cost, (800 * 2 + 200 * 0.5 + 50 * 6) / 1e6)).toBe(true);
    expect(rep.retries).toBe(1);
    expect(rep.files).toBe(6);
    expect(rep.unpriced).toBeUndefined();
    const tz = await cost({ tzOffset: 15 * 60, providers: ['claude'] });
    expect(tz.rows?.map((r) => r.day)).toEqual(['2026-11-16']);
    const day = Date.UTC(2026, 10, 15) / 1000;
    expect((await cost({ since: day, providers: ['codex'] })).rows?.map((r) => r.model)).toEqual(['gpt-5.5']);
  });

  test('the quarters of an hour from recentSince, whatever since leaves out; none unless asked', async () => {
    const { cost } = setup();
    const day = Date.UTC(2026, 10, 15) / 1000;
    const rep = await cost({ since: day + 86400, recentSince: day, providers: ['claude', 'codex'] });
    expect(rep.rows).toEqual([]);
    const claude = (1000 * 5 + 2000 * 0.5 + 100 * 6.25 + 200 * 10 + 500 * 25) / 1e6;
    const codex = (200000 * 10 + 100000 * 1 + 1000 * 45) / 1e6;
    expect(rep.recent).toHaveLength(2);
    expect(rep.recent![0]).toMatchObject({
      at: day + 9 * 3600,
      provider: 'claude',
      tokens: 1000 + 2000 + 300 + 500,
      requests: 1,
      priced: true,
    });
    expect(rep.recent![1]).toMatchObject({
      at: day + 10 * 3600,
      provider: 'codex',
      tokens: 200000 + 100000 + 1000,
      requests: 1,
      priced: true,
    });
    expect(near(rep.recent![0]!.cost!, claude) && near(rep.recent![1]!.cost!, codex)).toBe(true);
    const plain = await cost({ since: day });
    expect(plain.recent).toBeUndefined();
    expect(plain.etag).not.toBe(rep.etag);
  });

  test('Kimi Code’s wire logs: models named as the table, projects from the session or the workspace, a line once it ends', async () => {
    const { home, e, cost } = setup({ fixtures: false });
    const s1 = join(home, '.kimi-code/sessions/wd_alpha_a1b2c3d4e5f6/session_1');
    write(join(s1, 'state.json'), '{"id":"session_1","version":2,"cwd":"/work/alpha-repo"}');
    write(
      join(s1, 'agents/main/wire.jsonl'),
      '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":2000,"output":500,"inputCacheRead":10000,"inputCacheCreation":0}}}\n' +
        '{"type":"usage.record","agentId":"main","model":"kimi-code/k3.1-pro","usage":{"inputOther":2000,"output":500,"inputCacheRead":10000,"inputCacheCreation":100},"usageScope":"turn","time":1794736800000}\n' +
        '{"type":"usage.record","agentId":"main","model":"kimi-code/k3-256k","usage":{"inputOther":3000,"output":200,"inputCacheRead":5000,"inputCacheCreation":0},"usageScope":"session","time":1794736900000}\n' +
        '{"type":"usage.record","agentId":"main","model":"kimi-code/k3","usage":{"inputOther":0,"output":0,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737000000}\n',
    );
    write(
      join(s1, 'agents/agent-0/wire.jsonl'),
      '{"type":"usage.record","agentId":"agent-0","model":"kimi-code/k3.1-pro","usage":{"inputOther":1000,"output":300,"inputCacheRead":4000,"inputCacheCreation":0},"usageScope":"turn","time":1794737100000}\n',
    );
    const s2 = join(home, '.kimi-code/sessions/wd_beta_0123456789ab/session_2');
    write(join(s2, 'state.json'), '{"workDir":"/work/beta-app"}');
    write(
      join(s2, 'agents/main/wire.jsonl'),
      '{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":5000,"output":400,"inputCacheRead":20000,"inputCacheCreation":0},"usageScope":"turn","time":1794650400000}\n' +
        '{"type":"usage.record","model":"kimi-code/custom-preview","usage":{"inputOther":1000,"output":100,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794650500000}\n',
    );
    write(
      join(home, '.kimi-code/sessions/wd_fallback-proj_deadbeefcafe/session_3/agents/main/wire.jsonl'),
      '{"type":"usage.record","model":"kimi-code/k3.1-pro-highspeed","usage":{"inputOther":1000,"output":250,"inputCacheRead":5000,"inputCacheCreation":0},"usageScope":"turn","time":1794737200000}\n',
    );
    const rep = await cost({ providers: ['kimi'] });
    expect(rep.failed).toBeUndefined();
    expect(rep.files).toBe(4);
    const rows = rowsBy(rep);
    const pro = rows['kimi|kimi-k3.1-pro|alpha-repo']!;
    expect(pro).toMatchObject({ day: '2026-11-15', requests: 2, input: 3000, cached: 14000, cacheWrite: 100, output: 800, priced: true });
    expect(near(pro.cost, (3000 * 2 + 14000 * 0.2 + 100 * 2 + 800 * 10) / 1e6)).toBe(true);
    expect(near(rows['kimi|kimi-k3|alpha-repo']!.cost, (3000 * 3 + 5000 * 0.3 + 200 * 15) / 1e6)).toBe(true);
    const kfc = rows['kimi|kimi-for-coding|beta-app']!;
    expect(kfc.day).toBe('2026-11-14');
    expect(near(kfc.cost, (5000 * 0.95 + 20000 * 0.19 + 400 * 4) / 1e6)).toBe(true);
    expect(rows['kimi|custom-preview|beta-app']).toMatchObject({ requests: 1, input: 1000, output: 100, priced: false, cost: 0 });
    expect(rep.unpriced).toEqual(['kimi/custom-preview']);
    expect(near(rows['kimi|kimi-k3.1-pro-highspeed|fallback-proj']!.cost, (1000 * 4 + 5000 * 0.2 + 250 * 20) / 1e6)).toBe(true);
    const wire = join(s1, 'agents/main/wire.jsonl');
    appendTo(
      wire,
      '{"type":"usage.record","agentId":"main","model":"kimi-code/k3.1-pro","usage":{"inputOther":500,"output":100,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737300000}',
    );
    expect(rowsBy(await cost({ providers: ['kimi'] }))['kimi|kimi-k3.1-pro|alpha-repo']!.requests).toBe(2);
    appendTo(wire, '\n');
    expect(rowsBy(await cost({ providers: ['kimi'] }))['kimi|kimi-k3.1-pro|alpha-repo']).toMatchObject({ requests: 3, output: 900 });
    const alt = join(home, 'alt-kimi');
    write(
      join(alt, 'sessions/wd_alt_001122334455/session_x/agents/main/wire.jsonl'),
      '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":100,"output":50,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1794737400000}\n',
    );
    const r = await cost({ providers: ['kimi'] }, { ...e, env: { KIMI_CODE_HOME: alt } });
    expect(r.rows?.map((x) => [x.project, x.model])).toEqual([['alt', 'kimi-k3']]);
  });

  test('Kimi Code’s model names', () => {
    for (const [i, o] of Object.entries({
      'kimi-code/k3': 'kimi-k3',
      'kimi-code/k3-256k': 'kimi-k3-256k',
      'kimi-code/k3.1-pro': 'kimi-k3.1-pro',
      'kimi-code/kimi-for-coding': 'kimi-for-coding',
      'moonshot/kimi-k2.7-code': 'kimi-k2.7-code',
      'k2.6': 'kimi-k2.6',
      '': 'unknown',
    }))
      expect(kimiModelName(i)).toBe(o);
  });

  test('keys as the Go agent makes them; dedupe keeps the most output where the key first was', () => {
    expect(hashKey('claude', 'req-1', 'msg-1')).toBe('2oodgyzlk62tm');
    expect(hashKey('codex', 'r1')).toBe('2env2n646189v');
    expect(hashKey('codex-tc', '/home/ü/x.jsonl', '2026-11-14T10:00:01Z', '{"input_tokens":100}')).toBe('2611vl8wlju7o');
    const rs = dedupe([rec({ k: 'a', o: 1 }), rec({ t: 1 }), rec({ k: 'a', o: 5 }), rec({ k: 'b', o: 2 }), rec({ k: 'a', o: 3 })]);
    expect(rs.map((r) => [r.k, r.o])).toEqual([
      ['a', 5],
      ['', 0],
      ['b', 2],
    ]);
  });
});

describe('prices', () => {
  test('the longest prefix, tiers, cache-write defaults, the hours', () => {
    expect(modelPricing('claude', 'claude-opus-4-5-20251101').key).toBe('claude-opus-4-5');
    expect(modelPricing('claude', 'claude-opus-4-1').key).toBe('claude-opus-4');
    expect(modelPricing('codex', 'o3').price).toBeUndefined();
    const gpt = modelPricing('codex', 'gpt-5.5').price!;
    expect(gpt.tiers.indexOf(tierOf(gpt, 272000))).toBe(0);
    expect(gpt.tiers.indexOf(tierOf(gpt, 272001))).toBe(1);
    const fable = modelPricing('claude', 'claude-fable-5-2');
    expect(fable.key).toBe('claude-fable-5-2');
    expect(near(tierCost(fable.price!.tiers[0]!, 1e6, 1e6, 1e6, 1e6, 1e6), 8 + 0.2 + 10 + 16 + 40)).toBe(true);
    expect(near(tierCost(modelPricing('claude', 'claude-sonnet-5-5').price!.tiers[0]!, 0, 1e6, 0, 0, 0), 0.1)).toBe(true);
    const haiku = modelPricing('claude', 'claude-haiku-5-5').price!;
    expect(near(tierCost(tierOf(haiku, 100000), 1e6, 1e6, 0, 0, 1e6), 0.1 + 0.01 + 0.5)).toBe(true);
    expect(near(tierCost(tierOf(haiku, 100001), 1e6, 1e6, 0, 0, 1e6), 0.5 + 0.05 + 2.5)).toBe(true);
    expect(near(tierCost(tierOf(modelPricing('grok', 'grok-4.6').price!, 10), 0, 0, 1e6, 1e6, 0), 2 + 4)).toBe(true);
  });

  test('the user’s prices: a model the table does not know, the same name replaces, the longest prefix wins; the scan applies them', async () => {
    const own = {
      'grok-5': { inputMax: null, input: 3, cached: 0.75, output: 9 },
      'claude-opus-4-6': { inputMax: null, input: 1, cached: 0.1, output: 2, cacheWrite: 1.5 },
      'claude-opus': { inputMax: null, input: 100, cached: 100, output: 100 },
    };
    expect(pricingWith('grok', 'grok-4.7-fast').key).toBe('grok-4.7');
    expect(pricingWith('grok', 'grok-5-mini', own)).toMatchObject({ key: 'grok-5', price: { tiers: [{ output: 9 }] } });
    expect(pricingWith('claude', 'claude-opus-4-6-20260101', own)).toMatchObject({
      key: 'claude-opus-4-6',
      price: { tiers: [{ input: 1 }] },
    });
    expect(pricingWith('claude', 'claude-opus-4-5', own)).toMatchObject({ key: 'claude-opus-4-5', price: { tiers: [{ input: 5 }] } });
    expect(pricingWith('claude', 'claude-opus-x', own).key).toBe('claude-opus');
    const { cost } = setup();
    const rep = await cost({ providers: ['codex'], prices: { 'gpt-5.3-codex': { inputMax: null, input: 1, cached: 0.1, output: 10 } } });
    expect(near(rowsBy(rep)['codex|gpt-5.3-codex|gamma']!.cost, (100 * 1 + 10 * 10) / 1e6 + (100 * 1 + 50 * 0.1 + 20 * 10) / 1e6)).toBe(
      true,
    );
  });

  test('only prices usage.prices can hold', () => {
    const t = (x: Record<string, unknown>) => ({ inputMax: null, input: 1, cached: 0, output: 1, ...x });
    expect(validPrices({ 'grok-5': t({}) })).toBe(true);
    expect(validPrices(undefined)).toBe(true);
    expect(validPrices(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, t({})])))).toBe(false);
    for (const bad of [
      { '': t({}) },
      { 'grok-5': t({ input: -1 }) },
      { 'grok-5': t({ cacheWrite: 20000 }) },
      { '-x': t({}) },
      { 'grok-5': t({ input: NaN }) },
    ])
      expect(validPrices(bad as never)).toBe(false);
  });
});

describe('the cache', () => {
  test('in the machine database of this host; unchanged logs not read again, grown ones read on, gone ones removed', async () => {
    const { home, e, cost } = setup();
    await cost();
    const db = hostFile(e.base, MACHINE_DB);
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(existsSync(join(e.base, MACHINE_DB))).toBe(false);
    // An unchanged file is not read again: the cache's records count.
    const { files } = await loadCache(e.base);
    const old = join(home, '.codex/archived_sessions/rollout-old.jsonl');
    files.get(old)!.records[0]!.o = 999;
    saveCache(e.base, files, [old], [], Date.now());
    expect(rowsBy(await cost({ providers: ['codex'] }))['codex|gpt-5.3-codex|gamma']!.output).toBe(999 + 20);
    // A Claude log that grew is read on.
    const f = join(home, '.claude/projects/-home-u-alpha/s1.jsonl');
    appendTo(
      f,
      '{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-2","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-2","usage":{"input_tokens":10,"output_tokens":20}}}\n',
    );
    const rows = rowsBy(await cost({ providers: ['claude'] }));
    expect([rows['claude|claude-haiku-4-5|alpha']?.requests, rows['claude|claude-opus-4-6|alpha']?.requests]).toEqual([1, 1]);
    // A log gone leaves the cache (written once it is old enough).
    rmSync(f);
    aged(e.base);
    await cost({ providers: ['claude'] });
    expect((await loadCache(e.base)).files.has(f)).toBe(false);
  });

  test('logs and records past the retention leave it', async () => {
    const home = tempHome();
    const e = { ...testEnv(home), now: () => Date.now() };
    const old = new Date(Date.now() - 100 * 86400_000);
    const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');
    const f = join(home, '.claude/projects/p/old.jsonl');
    write(f, claudeLog2.replace('2026-11-15T09:00:02Z', iso(old)));
    utimesSync(f, old, old);
    write(
      join(home, '.claude/projects/p/new.jsonl'),
      claudeLog2.replace('2026-11-15T09:00:02Z', iso(old)) +
        claudeLog2.replace('2026-11-15T09:00:02Z', iso(new Date())).replace('req-1', 'req-9'),
    );
    const s = new CostScanner(e.base);
    const rep = await s.scan(e, { since: 0 });
    expect(rep.rows?.map((r) => r.requests)).toEqual([1]);
    expect(rep.since).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 90 * 86400 - 60);
    const { files } = await loadCache(e.base);
    expect(files.has(f)).toBe(false);
    expect(files.get(join(home, '.claude/projects/p/new.jsonl'))!.records).toHaveLength(1);
  });

  test('a scan cut short keeps what it read; the next goes on', async () => {
    const { e, s } = setup();
    const ac = new AbortController();
    let checks = 0;
    // The scan stops at its third look at its signal.
    const signal = new Proxy(ac.signal, {
      get(t, k) {
        if (k === 'throwIfAborted')
          return () => {
            if (++checks > 2) throw new Error('cut short');
          };
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await expect(s.scan({ ...e, signal }, { since })).rejects.toThrow('cut short');
    expect((await loadCache(e.base)).files.size).toBeGreaterThanOrEqual(1);
    const rep = await s.scan(e, { since });
    expect(rep.files).toBe(6);
  });

  test('one record per response; a cache of another version is not read', async () => {
    const { home, e, cost } = setup();
    await cost({ providers: ['claude'] });
    const f = join(home, '.claude/projects/-home-u-alpha/s1.jsonl');
    const { files } = await loadCache(e.base);
    expect(files.get(f)!.records.map((r) => r.o)).toEqual([500]);
    const db = openShared(cacheDB(e.base));
    db.run('UPDATE usage_cost_state SET version = ?', CACHE_VERSION - 1);
    db.close();
    expect((await loadCache(e.base)).files.size).toBe(0);
  });

  test('read on: Codex’s rollouts with the turn’s model, Grok’s updates; a line once it ends; a rewritten log from its start', async () => {
    const { home, e, cost } = setup();
    await cost();
    const rollout = join(home, '.codex/sessions/2026/11/15/rollout-new.jsonl');
    const updates = join(home, '.grok/sessions/%2Fwork%2Fdelta/abc/updates.jsonl');
    // Mark what was read: a record read again would lose the mark.
    const { files } = await loadCache(e.base);
    files.get(rollout)!.records[0]!.o = 7777;
    files.get(updates)!.records[0]!.o = 8888;
    saveCache(e.base, files, [rollout, updates], [], Date.now());
    appendTo(
      rollout,
      '{"timestamp":"2026-11-15T10:01:00Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r2","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":10}}}\n',
    );
    appendTo(updates, grokUpdates);
    let rows = rowsBy(await cost());
    expect(rows['codex|gpt-5.5|beta']).toMatchObject({ output: 7777 + 10, requests: 2 });
    expect(rows['grok|grok-4.6|delta']).toMatchObject({ output: 8888 + 1000, requests: 4 });
    aged(e.base);
    appendTo(
      rollout,
      '{"timestamp":"2026-11-15T10:02:00Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r3","usage":{"input_tokens":1000,"output_tokens":5}}}',
    );
    expect(rowsBy(await cost({ providers: ['codex'] }))['codex|gpt-5.5|beta']!.requests).toBe(2);
    aged(e.base);
    appendTo(rollout, '\n');
    expect(rowsBy(await cost({ providers: ['codex'] }))['codex|gpt-5.5|beta']).toMatchObject({ requests: 3, output: 7777 + 10 + 5 });
    aged(e.base);
    write(rollout, ' '.repeat(10) + codexNew + ' '.repeat(4000) + '\n');
    appendTo(rollout, '');
    rows = rowsBy(await cost({ providers: ['codex'] }));
    expect(rows['codex|gpt-5.5|beta']).toMatchObject({ output: 1000, requests: 1 });
  });

  test('written seldom: not for one line while its last save is recent; the next scan reads on from the same offsets', async () => {
    const { home, e, cost } = setup();
    await cost();
    const recent = Date.now() - 60_000;
    setSaved(e.base, recent);
    const f = join(home, '.claude/projects/-home-u-alpha/s1.jsonl');
    appendTo(
      f,
      '{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-2","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-2","usage":{"input_tokens":10,"output_tokens":20}}}\n',
    );
    expect(rowsBy(await cost())['claude|claude-haiku-4-5|alpha']!.requests).toBe(1);
    expect(Math.abs(savedAt(e.base) - recent)).toBeLessThan(1);
    expect(rowsBy(await cost())['claude|claude-haiku-4-5|alpha']!.requests).toBe(1);
    aged(e.base);
    await cost();
    expect(Date.now() - savedAt(e.base)).toBeLessThan(60_000);
    expect((await loadCache(e.base)).files.get(f)!.records).toHaveLength(2);
  });

  test('ETag: unchanged answers notModified without rows; prices and a new line change it', async () => {
    const { home, e, cost } = setup();
    const first = await cost({ providers: ['claude'] });
    expect(first.etag).toBeTruthy();
    expect(first.notModified).toBeUndefined();
    expect(first.rows?.length).toBeGreaterThan(0);
    const nm = await cost({ providers: ['claude'], ifNoneMatch: first.etag! });
    expect(nm).toEqual({ since, rows: null, files: 0, etag: first.etag, notModified: true });
    const priced = await cost({
      providers: ['claude'],
      ifNoneMatch: first.etag!,
      prices: { 'claude-sonnet-4-6': { inputMax: null, input: 9, cached: 1, output: 20 } },
    });
    expect(priced.notModified).toBeUndefined();
    expect(priced.etag).not.toBe(first.etag);
    setSaved(e.base, Date.now() - 60_000);
    appendTo(
      join(home, '.claude/projects/-home-u-alpha/s1.jsonl'),
      '{"timestamp":"2026-11-15T09:10:00Z","requestId":"req-9","cwd":"/home/u/alpha","message":{"role":"assistant","model":"claude-haiku-4-5","id":"msg-9","usage":{"input_tokens":10,"output_tokens":20}}}\n',
    );
    const updated = await cost({ providers: ['claude'], ifNoneMatch: first.etag! });
    expect(updated.notModified).toBeUndefined();
    expect(rowsBy(updated)['claude|claude-haiku-4-5|alpha']!.requests).toBe(1);
    expect((await cost({ providers: ['claude'], ifNoneMatch: updated.etag! })).notModified).toBe(true);
    // Another agent's report never matches.
    const other = new CostScanner(e.base);
    expect((await other.scan(e, { since, providers: ['claude'], ifNoneMatch: updated.etag! })).notModified).toBeUndefined();
  });

  test('another agent of the instance saved: read again; tables of a newer version are read, not written', async () => {
    const { home, e, cost } = setup();
    await cost();
    // Another agent's save: an entry of a log this one does not have.
    const other = new Map<string, Entry>([
      ['/a', { kind: 'claude', size: 1, mtime: 1, off: 0, records: [rec({ k: 'x', t: testNowSec, m: 'claude-opus-4-6', i: 10, n: 1 })] }],
    ]);
    saveCache(e.base, other, ['/a'], [], Date.now());
    expect((await loadCache(e.base)).files.size).toBe(7 + 1);
    // Read again, the log not seen leaves it at the next save.
    expect((await cost()).files).toBe(6);
    aged(e.base);
    await cost();
    expect((await loadCache(e.base)).files.has('/a')).toBe(false);
    const db = openShared(cacheDB(e.base));
    db.run("UPDATE store_features SET version = version + 1 WHERE feature = 'usage'");
    db.close();
    expect((await loadCache(e.base)).files.size).toBe(7);
    expect(saveCache(e.base, new Map(), [], ['/x'], Date.now())).toBe(false);
    rmSync(join(home, '.claude/projects/-home-u-alpha/s1.jsonl'));
    aged(e.base);
    expect((await cost()).files).toBe(5);
    expect((await loadCache(e.base)).files.has(join(home, '.claude/projects/-home-u-alpha/s1.jsonl'))).toBe(true);
  });

  test('entries as the Go agent writes them: empty members left out, read back', async () => {
    const e: Entry = {
      kind: 'codex',
      size: 10,
      mtime: 1732512345123456800,
      off: 10,
      records: [rec({ k: 'a', t: 5, m: 'gpt', i: 3, n: 1 })],
      codex: { model: 'gpt', total: 0 },
    };
    expect(entryJSON(e)).toBe(
      '{"kind":"codex","size":10,"mtime":1732512345123456800,"off":10,"records":[{"k":"a","t":5,"m":"gpt","i":3,"n":1}],"codex":{"model":"gpt","total":0}}',
    );
    const home = tempHome();
    const base = join(home, '.app');
    saveCache(base, new Map([['/p', e]]), ['/p'], [], Date.now());
    // A Go agent's entry (its JSON) is read as it is.
    const db = openShared(cacheDB(base));
    db.run(
      'INSERT INTO usage_cost_files (path, sum, entry) VALUES (?, ?, ?)',
      '/go',
      new Uint8Array(32),
      Buffer.from(
        '{"kind":"claude","size":7,"mtime":1732512345123456789,"off":7,"records":[{"k":"q","t":9,"m":"m","o":4,"e":true,"p":0.5}]}',
      ),
    );
    db.close();
    const { files } = await loadCache(base);
    expect(files.get('/p')).toEqual(e);
    expect(files.get('/go')).toEqual({
      kind: 'claude',
      size: 7,
      mtime: 1732512345123456789,
      off: 7,
      records: [rec({ k: 'q', t: 9, m: 'm', o: 4, e: true, p: 0.5 })],
    });
  });

  test('a cache no scan saved for the retention goes at housekeeping', async () => {
    const { e, s, cost } = setup();
    await cost();
    s.housekeep(Date.now());
    expect((await loadCache(e.base)).files.size).toBe(7);
    s.housekeep(Date.now() + 91 * 86400_000);
    expect((await loadCache(e.base)).files.size).toBe(0);
  });
});

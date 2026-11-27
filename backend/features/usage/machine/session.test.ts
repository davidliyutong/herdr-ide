// One session's usage: the same numbers as the spend counts for its
// transcripts, each response once across them, the latest request's model
// and context (not a subagent's, not a made-up message), no content in the
// answer, the cost cache's and the last read's records used, bounds, two
// reads at once, and the read ending with its request.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeHomes, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import type { UsageEnv } from './env.ts';
import { openRegular } from './logs.ts';
import { contextWindow, modelPricing, tierCost, tierOf, type Tier } from './pricing.ts';
import { CostScanner, type CostReport } from './scan.ts';
import {
  SESSION_LIMITS,
  SessionReader,
  cutModel,
  locateClaudeByCwd,
  locateCodexByCwd,
  locateGrokSession,
  locateKimiSession,
  readAntigravitySessionUsage,
  readOpenCodeSessionUsage,
  type SessionLimits,
  type SessionUsage,
  type Transcript,
} from './session.ts';
import { Resolver } from '#machine/agents/sessions.ts';

afterAll(removeHomes);

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const MARKER = 'MARKER-5f1c-SECRET';

/** An assistant line as Claude Code 2.1.330 writes it: one content block
 * of a response. */
const claudeAssistant = (id: string, sec: number, model: string, usage: string, block: string, sidechain: boolean) =>
  `{"parentUuid":"8490b89a","isSidechain":${sidechain},"message":{"model":${JSON.stringify(model)},"id":${JSON.stringify(id)},"type":"message","role":"assistant","content":[${block}],"stop_reason":"tool_use","usage":${usage}},"type":"assistant","uuid":"54b56f9f-${sec}","timestamp":"2026-11-21T19:42:${String(sec % 60).padStart(2, '0')}.031Z","cwd":"/home/dev/project","sessionId":"e6cdc860-1055-488f-9ed2-8b8019061bb9","version":"2.1.330"}\n`;

const usages = [
  ['msg_1', 2, 22324, 31717, 571, 402, 3],
  ['msg_2', 2, 701, 54041, 172, 0, 2],
  ['msg_3', 2, 203, 54742, 190, 0, 2],
] as const;

/** A transcript in the shapes of Claude Code 2.1.330's, every text the
 * marker: responses logged block by block, their cache writes of an hour. */
function claude2130(): string {
  const blocks = [
    `{"type":"thinking","thinking":"","signature":"${MARKER}"}`,
    `{"type":"text","text":"${MARKER} I will write it."}`,
    `{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"/home/dev/${MARKER}.txt","content":"${MARKER}"}}`,
  ];
  let s = `{"type":"user","message":{"role":"user","content":"${MARKER} write a file"},"timestamp":"2026-11-21T19:42:41.240Z"}\n`;
  s += `{"type":"attachment","attachment":{"type":"skill_listing","content":"${MARKER}${' skill'.repeat(20000)}"},"timestamp":"2026-11-21T19:42:41.300Z"}\n`;
  let sec = 44;
  for (const [id, input, cw, cr, out, think, lines] of usages) {
    const u = `{"input_tokens":${input},"cache_creation_input_tokens":${cw},"cache_read_input_tokens":${cr},"output_tokens":${out},"output_tokens_details":{"thinking_tokens":${think}},"cache_creation":{"ephemeral_1h_input_tokens":${cw},"ephemeral_5m_input_tokens":0}}`;
    for (let j = 0; j < lines; j++) s += claudeAssistant(id, sec++, 'claude-haiku-5-5', u, blocks[(3 - lines + j) % 3]!, false);
    s += `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"${MARKER}"}]},"toolUseResult":{"content":"${MARKER}"}}\n`;
  }
  return s + `{"type":"last-prompt","lastPrompt":"${MARKER}"}\n`;
}

/** A rollout in the shapes of Codex 0.170.0's: two responses, their token
 * counts (replays), the model's context window. */
const codex0170 = `{"timestamp":"2026-11-21T19:43:47.797Z","ordinal":0,"type":"session_meta","payload":{"id":"01a1","cwd":"/home/dev/project","base_instructions":{"text":"${MARKER}"}}}
{"timestamp":"2026-11-21T19:44:01.088Z","ordinal":9,"type":"turn_context","payload":{"turn_id":"t1","cwd":"/home/dev/project","model":"gpt-6.1-sol"}}
{"timestamp":"2026-11-21T19:44:03.027Z","ordinal":13,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","content":[{"type":"Text","text":"${MARKER}"}]}}}
{"timestamp":"2026-11-21T19:44:03.431Z","ordinal":16,"type":"token_usage_record","payload":{"turn_id":"t1","response_id":"resp_1","usage":{"input_tokens":26763,"cached_input_tokens":13312,"cache_write_input_tokens":0,"output_tokens":46,"reasoning_output_tokens":0}}}
{"timestamp":"2026-11-21T19:44:04.504Z","ordinal":19,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26763},"last_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"output_tokens":46},"model_context_window":828400},"rate_limits":{"primary":{"used_percent":49.0}}}}
{"timestamp":"2026-11-21T19:44:07.894Z","ordinal":24,"type":"token_usage_record","payload":{"turn_id":"t1","response_id":"resp_2","usage":{"input_tokens":26834,"cached_input_tokens":26624,"cache_write_input_tokens":0,"output_tokens":107,"reasoning_output_tokens":84}}}
{"timestamp":"2026-11-21T19:44:07.896Z","ordinal":25,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":53597},"last_token_usage":{"input_tokens":26834,"cached_input_tokens":26624,"output_tokens":107},"model_context_window":828400}}}
{"timestamp":"2026-11-21T19:44:07.920Z","ordinal":26,"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":50.0}}}}
`;

const codexLegacy = `{"timestamp":"2026-11-14T10:00:00Z","type":"turn_context","payload":{"model":"gpt-5.3-codex","cwd":"/work/gamma"}}
{"timestamp":"2026-11-14T10:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}
{"timestamp":"2026-11-14T10:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250},"last_token_usage":{"input_tokens":150,"cached_input_tokens":50,"output_tokens":20}}}}
`;

/** The transcripts at paths, each opened by its name as a regular file. */
const byName = (...paths: string[]): Transcript[] => paths.map((p) => ({ path: p, open: () => openRegular(p) }));

function setup(l: Partial<SessionLimits> = {}) {
  const home = tempHome();
  const e = testEnv(home);
  const scanner = new CostScanner(e.base);
  const reader = new SessionReader(scanner, { ...SESSION_LIMITS, ...l });
  return {
    home,
    e,
    scanner,
    reader,
    cost: (provider: string, files: Transcript[], own?: Record<string, Tier>, env: UsageEnv = e) => reader.cost(env, provider, files, own),
  };
}

/** A report's rows as one session's numbers. */
function totals(rep: CostReport) {
  const u = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, cost: 0, priced: true };
  for (const r of rep.rows ?? []) {
    u.input += r.input!;
    u.cached += r.cached!;
    u.cacheWrite += r.cacheWrite!;
    u.output += r.output!;
    u.reasoning += r.reasoning ?? 0;
    u.requests += r.requests!;
    u.cost += r.cost!;
    u.priced &&= !!r.priced;
  }
  return u;
}

const same = (u: SessionUsage, t: ReturnType<typeof totals>) =>
  u.input === t.input &&
  u.cached === t.cached &&
  u.cacheWrite === t.cacheWrite &&
  u.output === t.output &&
  (u.reasoning ?? 0) === t.reasoning &&
  u.requests === t.requests &&
  u.priced === t.priced &&
  near(u.cost!, t.cost);

describe('one session', () => {
  const own: Record<string, Tier> = {
    'gpt-6.1-sol': { inputMax: null, input: 3, cached: 0.3, output: 20 },
    'gpt-5.3-codex': { inputMax: null, input: 2, cached: 0.2, output: 9 },
    'claude-haiku-5-5': { inputMax: null, input: 0.5, cached: 0.05, output: 4 },
    'claude-zeta': { inputMax: null, input: 7, cached: 0.7, output: 35 },
  };
  for (const [name, provider, rel, log] of [
    ['claude 2.1.330', 'claude', '.claude/projects/-home-dev-project/e6cdc860.jsonl', claude2130()],
    ['codex 0.170.0', 'codex', '.codex/sessions/2026/11/21/rollout-x.jsonl', codex0170],
    ['codex legacy', 'codex', '.codex/sessions/2026/11/14/rollout-old.jsonl', codexLegacy],
    ['claude without a price', 'claude', '.claude/projects/p/s.jsonl', claude2130().replaceAll('claude-haiku-5-5', 'claude-zeta-1')],
  ] as const) {
    for (const prices of [undefined, own]) {
      test(`the spend’s numbers: ${name}, ${prices ? 'the user’s prices' : 'the table’s'}`, async () => {
        const { home, e, scanner, reader, cost } = setup();
        const p = join(home, rel);
        write(p, log);
        const u1 = await cost(provider, byName(p), prices);
        const want = totals(await scanner.scan(e, { since: 0, providers: [provider], prices }));
        expect(want.requests).toBeGreaterThan(0);
        expect(same(u1, want)).toBe(true);
        // From the cost cache now, read by a reader that kept nothing.
        const u2 = await new SessionReader(scanner).cost(e, provider, byName(p), prices);
        expect(same(u2, want)).toBe(true);
        expect([u2.model, u2.contextUsed]).toEqual([u1.model, u1.contextUsed]);
        void reader;
      });
    }
  }

  test('Claude Code’s blocks one response; its context; Codex’s replays; its window', async () => {
    const { home, cost } = setup();
    const cp = join(home, 'c.jsonl');
    write(cp, claude2130());
    const u = await cost('claude', byName(cp));
    const price = modelPricing('claude', 'claude-haiku-5-5').price!;
    const cached = 31717 + 54041 + 54742;
    const cw = 22324 + 701 + 203;
    expect(u).toMatchObject({
      model: 'claude-haiku-5-5',
      input: 6,
      cached,
      cacheWrite: cw,
      output: 571 + 172 + 190,
      reasoning: 402,
      requests: 3,
      priced: true,
      contextUsed: 2 + 54742 + 203,
    });
    expect(near(u.cost!, tierCost(price.tiers[0]!, 6, cached, 0, cw, 571 + 172 + 190))).toBe(true);
    const xp = join(home, 'x.jsonl');
    write(xp, codex0170);
    const x = await cost('codex', byName(xp));
    expect(x).toMatchObject({
      model: 'gpt-6.1-sol',
      input: 26763 - 13312 + (26834 - 26624),
      cached: 13312 + 26624,
      output: 153,
      reasoning: 84,
      requests: 2,
      contextUsed: 26834,
      contextSize: 828400,
    });
    const gp = modelPricing('codex', 'gpt-6.1-sol').price!;
    expect(
      near(
        x.cost!,
        tierCost(tierOf(gp, 26763), 26763 - 13312, 13312, 0, 0, 46) + tierCost(tierOf(gp, 26834), 26834 - 26624, 26624, 0, 0, 107),
      ),
    ).toBe(true);
  });

  test('no content in the answer: numbers and a model', async () => {
    const { home, cost } = setup();
    const cp = join(home, 'c.jsonl');
    write(cp, claude2130());
    const sub = join(home, 'c/subagents/agent-1.jsonl');
    write(sub, claude2130());
    const xp = join(home, 'x.jsonl');
    write(xp, codex0170);
    for (const [provider, paths] of [
      ['claude', [cp, sub]],
      ['codex', [xp]],
    ] as const) {
      const u = await cost(provider, byName(...paths));
      expect(u.requests).toBeGreaterThan(0);
      const b = JSON.stringify(u);
      expect(b).not.toContain(MARKER);
      expect(b).not.toContain('project');
      expect(
        Object.keys(u).every((k) =>
          [
            'model',
            'input',
            'cached',
            'cacheWrite',
            'output',
            'reasoning',
            'requests',
            'cost',
            'priced',
            'contextUsed',
            'contextSize',
          ].includes(k),
        ),
      ).toBe(true);
    }
  });

  test('a response in several transcripts counts once, with the most output', async () => {
    const { home, cost } = setup();
    const usage = (o: number) => `{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0,"output_tokens":${o}}`;
    const block = `{"type":"text","text":"${MARKER}"}`;
    const mp = join(home, '.claude/projects/p/s.jsonl');
    write(
      mp,
      claudeAssistant('msg_A', 1, 'claude-opus-5-5', usage(5), block, false) +
        claudeAssistant('msg_A', 2, 'claude-opus-5-5', usage(50), block, false) +
        claudeAssistant('msg_A', 3, 'claude-opus-5-5', usage(30), block, false) +
        claudeAssistant('msg_B', 4, 'claude-opus-5-5', usage(7), block, false),
    );
    const sub = join(home, '.claude/projects/p/s/subagents/agent-a.jsonl');
    write(sub, claudeAssistant('msg_A', 5, 'claude-opus-5-5', usage(60), block, true));
    expect(await cost('claude', byName(mp, sub))).toMatchObject({ requests: 2, output: 60 + 7, input: 20, cached: 2000 });
  });

  test('subagents counted, one gone left out; the context is the main chain’s', async () => {
    const { home, cost } = setup();
    const block = `{"type":"text","text":"${MARKER}"}`;
    const u1 = '{"input_tokens":100,"cache_read_input_tokens":2000,"cache_creation_input_tokens":300,"output_tokens":40}';
    const u2 = '{"input_tokens":5,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0,"output_tokens":9}';
    const mp = join(home, '.claude/projects/p/s.jsonl');
    write(
      mp,
      claudeAssistant('msg_1', 1, 'claude-opus-5-5', u1, block, false) +
        claudeAssistant('msg_2', 2, 'claude-opus-5-5', u2, block, false) +
        claudeAssistant('msg_3', 3, 'claude-haiku-5-5', u1, block, true) +
        claudeAssistant('msg_4', 4, '<synthetic>', '{"input_tokens":0,"output_tokens":0}', block, false),
    );
    const sub = join(home, '.claude/projects/p/s/subagents/agent-a.jsonl');
    write(sub, claudeAssistant('msg_5', 9, 'claude-haiku-5-5', u1, block, true));
    const gone = join(home, '.claude/projects/p/s/subagents/agent-gone.jsonl');
    const u = await cost('claude', byName(mp, sub, gone));
    expect(u).toMatchObject({
      requests: 4,
      input: 305,
      output: 129,
      cached: 10000,
      cacheWrite: 900,
      model: 'claude-opus-5-5',
      contextUsed: 4005,
    });
    expect((await cost('claude', byName(mp))).requests).toBe(3);
  });

  test('the context: a legacy rollout’s last count; no request yet; Claude’s past a long tail', async () => {
    const { home, cost } = setup();
    const xp = join(home, 'old.jsonl');
    write(xp, codexLegacy);
    expect(await cost('codex', byName(xp))).toMatchObject({ model: 'gpt-5.3-codex', requests: 2, contextUsed: 150 });
    const np = join(home, 'new.jsonl');
    write(
      np,
      '{"timestamp":"2026-11-16T10:00:00Z","type":"session_meta","payload":{"cwd":"/w"}}\n{"timestamp":"2026-11-16T10:00:01Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-6.1-sol","cwd":"/w"}}\n',
    );
    const n = await cost('codex', byName(np));
    expect(n).toMatchObject({ model: 'gpt-6.1-sol', requests: 0, priced: true });
    expect(n.contextUsed).toBeUndefined();
    const cp = join(home, 'c.jsonl');
    const tail = `{"type":"attachment","attachment":{"content":"${'x'.repeat(300 << 10)}"}}\n`;
    write(
      cp,
      claudeAssistant(
        'msg_1',
        1,
        'claude-opus-5-5',
        '{"input_tokens":3,"cache_read_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":0},"cache_creation_input_tokens":100,"output_tokens":1}',
        '{"type":"text","text":"x"}',
        false,
      ) + tail.repeat(4),
    );
    expect(await cost('claude', byName(cp))).toMatchObject({ contextUsed: 123, model: 'claude-opus-5-5' });
  });

  test('read on when it grew; the last read used while it is unchanged', async () => {
    const { home, cost } = setup();
    const cp = join(home, 's.jsonl');
    const line = (id: string, sec: number, out: number) =>
      claudeAssistant(
        id,
        sec,
        'claude-opus-5-5',
        `{"input_tokens":1,"cache_read_input_tokens":10,"output_tokens":${out}}`,
        '{"type":"text","text":"x"}',
        false,
      );
    write(cp, line('m1', 1, 5));
    expect((await cost('claude', byName(cp))).requests).toBe(1);
    appendFileSync(cp, line('m2', 2, 7));
    const t = new Date(Date.now() + 60_000);
    utimesSync(cp, t, t);
    expect(await cost('claude', byName(cp))).toMatchObject({ requests: 2, output: 12 });
    // The same size and time: the last read, not the file.
    writeFileSync(cp, ' '.repeat(statSync(cp).size));
    utimesSync(cp, t, t);
    expect(await cost('claude', byName(cp))).toMatchObject({ requests: 2, output: 12 });
  });

  test('records past the retention leave the numbers', async () => {
    const { home, cost } = setup();
    const cp = join(home, 's.jsonl');
    write(cp, claude2130().replaceAll('2026-11-21T', '2025-01-21T'));
    expect((await cost('claude', byName(cp))).requests).toBe(0);
  });
});

describe('bounds and errors', () => {
  test('a transcript too large, a session of too many records: too_large; no transcript: not found', async () => {
    const big = setup({ maxFileBytes: 1000 });
    const cp = join(big.home, 'c.jsonl');
    write(cp, claude2130());
    await expect(big.cost('claude', byName(cp))).rejects.toMatchObject({ code: 'too_large' });
    const many = setup({ maxRecords: 2 });
    write(join(many.home, 'c.jsonl'), claude2130());
    await expect(many.cost('claude', byName(join(many.home, 'c.jsonl')))).rejects.toMatchObject({ code: 'too_large' });
    await expect(many.cost('claude', byName(join(many.home, 'none.jsonl')))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(many.cost('claude', [])).rejects.toMatchObject({ code: 'not_found' });
    await expect(many.cost('gemini', byName(cp))).rejects.toMatchObject({ code: 'bad_params' });
  });

  test('Grok, Kimi, OpenCode (with subagent), and Antigravity session usage', async () => {
    const { home, e, reader, cost } = setup();
    const sid = 'e6cdc860-1055-488f-9ed2-8b8019061bb9';
    const cwd = '/work/demo';
    // Grok
    write(
      join(home, '.grok/sessions', encodeURIComponent(cwd), sid, 'updates.jsonl'),
      JSON.stringify({
        method: 'session/update',
        params: {
          _meta: { agentTimestampMs: (testNowSec - 60) * 1000 },
          update: {
            sessionUpdate: 'turn_completed',
            usage: { modelUsage: { 'grok-4.6-0709': { modelCalls: 2, inputTokens: 6000, cachedReadTokens: 1000, outputTokens: 200 } } },
          },
        },
      }) + '\n',
    );
    const grokFiles = await locateGrokSession(e, '', cwd);
    expect(await cost('grok', grokFiles)).toMatchObject({
      model: 'grok-4.6-0709',
      input: 5000,
      cached: 1000,
      output: 200,
      requests: 2,
      contextUsed: 3000,
    });
    // Kimi with main + subagent
    write(join(home, '.kimi-code/sessions/ws/session_' + sid, 'state.json'), JSON.stringify({ cwd }));
    write(
      join(home, '.kimi-code/sessions/ws/session_' + sid, 'agents/main/wire.jsonl'),
      JSON.stringify({
        type: 'usage.record',
        time: testNowSec - 30,
        model: 'kimi-code/k2.5',
        usage: { inputOther: 800, inputCacheRead: 200, inputCacheCreation: 0, output: 60 },
      }) + '\n',
    );
    write(
      join(home, '.kimi-code/sessions/ws/session_' + sid, 'agents/sub1/wire.jsonl'),
      JSON.stringify({
        type: 'usage.record',
        time: testNowSec - 20,
        model: 'kimi-code/k2.5',
        usage: { inputOther: 400, inputCacheRead: 100, inputCacheCreation: 0, output: 30 },
      }) + '\n',
    );
    const kimiFiles = await locateKimiSession(e, '', cwd);
    expect(await cost('kimi', kimiFiles)).toMatchObject({
      model: 'kimi-k2.5',
      input: 1200,
      cached: 300,
      output: 90,
      requests: 2,
      contextUsed: 1000,
    });
    // OpenCode with child subagent session
    const ocPath = join(home, '.local/share/opencode/opencode.db');
    write(ocPath, '');
    const oc = new DatabaseSync(ocPath);
    oc.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, time_created integer, time_updated integer)');
    oc.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');
    oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('ses_parent1', null, cwd, (testNowSec - 100) * 1000, testNowSec * 1000);
    oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'ses_child1',
      'ses_parent1',
      cwd,
      (testNowSec - 50) * 1000,
      testNowSec * 1000,
    );
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      'ses_parent1',
      (testNowSec - 40) * 1000,
      (testNowSec - 40) * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: (testNowSec - 40) * 1000 },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.2,
        tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 100, write: 0 } },
      }),
    );
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm2',
      'ses_child1',
      (testNowSec - 20) * 1000,
      (testNowSec - 20) * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: (testNowSec - 20) * 1000 },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.1,
        tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 50, write: 0 } },
      }),
    );
    oc.close();
    const ocUsage = await readOpenCodeSessionUsage(e, reader, { session: 'ses_parent1', cwd: '' });
    expect(ocUsage).toMatchObject({
      model: 'deepseek-v4-flash',
      input: 700,
      cached: 150,
      output: 70,
      requests: 2,
      contextUsed: 600,
      priced: true,
    });
    expect(near(ocUsage.cost!, 0.3)).toBe(true);
    // Antigravity conversation database located by workspace cwd
    const varint = (v: number): number[] => {
      const out: number[] = [];
      for (;;) {
        const b = v % 128;
        v = Math.floor(v / 128);
        if (v) out.push(b | 0x80);
        else return [...out, b];
      }
    };
    const field = (num: number, wt: 0 | 2, val: number | Uint8Array | string): Uint8Array => {
      const tag = varint(num * 8 + wt);
      if (wt === 0) return Uint8Array.from([...tag, ...varint(val as number)]);
      const b = typeof val === 'string' ? Buffer.from(val) : (val as Uint8Array);
      return Uint8Array.from([...tag, ...varint(b.length), ...b]);
    };
    const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
    const agPath = join(home, '.gemini/antigravity/conversations', `${sid}.db`);
    write(agPath, '');
    const ag = new DatabaseSync(agPath);
    ag.exec(`
      CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
      CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx));
      CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    `);
    ag.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
      cat(field(1, 2, field(1, 2, `file://${cwd}`)), field(2, 2, cat(field(1, 0, testNowSec - 60))), field(7, 2, `file://${cwd}`)),
    );
    const f4 = cat(field(2, 0, 1000), field(3, 0, 80), field(5, 0, 400));
    const gen = cat(field(1, 2, cat(field(4, 2, f4), field(19, 2, 'claude-opus-4-6'))));
    ag.prepare('INSERT INTO gen_metadata VALUES (1, ?, ?)').run(gen, gen.length);
    ag.close();
    const agUsage = await readAntigravitySessionUsage(e, reader, { session: '', cwd });
    expect(agUsage).toMatchObject({
      model: 'claude-opus-4-6',
      input: 1000,
      cached: 400,
      output: 80,
      requests: 1,
      contextUsed: 1400,
      priced: true,
    });
  });

  test('SQLite-backed session reads share SessionReader’s parallel slot bound', async () => {
    const { home, e, scanner } = setup();
    const p = join(home, 's.jsonl');
    write(p, claude2130());
    const ocPath = join(home, '.local/share/opencode/opencode.db');
    write(ocPath, '');
    const oc = new DatabaseSync(ocPath);
    oc.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, time_created integer, time_updated integer)');
    oc.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');
    oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      'ses_slot01',
      null,
      '/work/slot',
      (testNowSec - 20) * 1000,
      testNowSec * 1000,
    );
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      'ses_slot01',
      (testNowSec - 10) * 1000,
      (testNowSec - 10) * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: (testNowSec - 10) * 1000 },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.05,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    oc.close();

    const reader = new SessionReader(scanner, { ...SESSION_LIMITS, parallel: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = reader.cost(e, 'claude', [{ path: p, open: async () => (await gate, openRegular(p)) }], undefined);
    let dbSettled = false;
    const queued = readOpenCodeSessionUsage(e, reader, { session: 'ses_slot01', cwd: '' }).then((u) => {
      dbSettled = true;
      return u;
    });
    // Aborted DB read waiting for slot fails without running or stealing the slot.
    const ac = new AbortController();
    const aborted = readOpenCodeSessionUsage({ ...e, signal: ac.signal }, reader, { session: 'ses_slot01', cwd: '' });
    await Bun.sleep(30);
    expect(dbSettled).toBe(false);
    ac.abort(new Error('cancelled while queued'));
    await expect(aborted).rejects.toThrow('cancelled while queued');
    expect(dbSettled).toBe(false);
    release();
    await held;
    expect(await queued).toMatchObject({ model: 'deepseek-v4-flash', requests: 1 });
    expect(dbSettled).toBe(true);
  });

  test('the reads kept are bounded', async () => {
    const { home, reader, cost } = setup({ memoFiles: 2 });
    for (let i = 0; i < 4; i++) {
      const p = join(home, `s${i}.jsonl`);
      write(p, claude2130());
      await cost('claude', byName(p));
    }
    expect(reader.kept).toBe(2);
  });

  test('a model’s name cut at a character', () => {
    expect(cutModel('m'.repeat(200))).toHaveLength(128);
    const cut = cutModel('m'.repeat(127) + 'é' + 'x');
    expect(cut).toBe('m'.repeat(127));
    expect(cutModel('short')).toBe('short');
  });

  test('a cancelled waiting read passes the slot to the next request', async () => {
    const { home, e, scanner } = setup();
    const p = join(home, 's.jsonl');
    write(p, claude2130());
    const reader = new SessionReader(scanner, { ...SESSION_LIMITS, parallel: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const active = reader.cost(e, 'claude', [{ path: p, open: async () => (await gate, openRegular(p)) }], undefined);
    const ac = new AbortController();
    const cancelled = reader.cost({ ...e, signal: ac.signal }, 'claude', byName(p), undefined);
    const next = reader.cost(e, 'claude', byName(p), undefined);
    ac.abort(new Error('the hub stopped waiting'));
    await expect(cancelled).rejects.toThrow('the hub stopped waiting');
    release();
    expect(await next).toEqual(await active);
  });

  test('two reads at once; the others wait their turn; a read ends with its request', async () => {
    const { home, e, cost } = setup();
    const p = join(home, 's.jsonl');
    write(p, claude2130());
    let open = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const slow: Transcript[] = [
      {
        path: p,
        open: async () => {
          open++;
          most = Math.max(most, open);
          await new Promise<void>((r) => releases.push(r));
          open--;
          return openRegular(p);
        },
      },
    ];
    const runs = [cost('claude', slow), cost('claude', slow), cost('claude', slow)];
    while (releases.length < 2) await Bun.sleep(5);
    await Bun.sleep(50);
    expect(most).toBe(2);
    while (releases.length) {
      releases.shift()!();
      await Bun.sleep(20);
    }
    await Promise.all(runs);
    expect(most).toBe(2);
    const ac = new AbortController();
    ac.abort(new Error('the hub stopped waiting'));
    await expect(cost('claude', byName(p), undefined, { ...e, signal: ac.signal })).rejects.toThrow('the hub stopped waiting');
  });

  test('pricing table provides contextWindow for all supported providers', () => {
    expect(contextWindow('claude', 'claude-opus-5-5')).toBe(1000000);
    expect(contextWindow('claude', 'claude-opus-4-5')).toBe(200000);
    expect(contextWindow('claude', 'claude-haiku-5-5')).toBe(200000);
    expect(contextWindow('antigravity', 'gemini-4-neon')).toBe(1048576);
    expect(contextWindow('antigravity', 'gemini-3.8-flash')).toBe(1048576);
    expect(contextWindow('grok', 'grok-4.6-0709')).toBe(256000);
    expect(contextWindow('kimi', 'kimi-k3.1-pro')).toBe(262144);
    expect(contextWindow('codex', 'gpt-6.1-sol')).toBe(1000000);
  });

  test('Antigravity conversation_summaries.db locates CLI conversations with empty trajectory_metadata_blob and supports resumed sinceMs fallback', async () => {
    const { home, e, reader } = setup();
    const sid = 'a1cdc860-1055-488f-9ed2-8b8019061bb9';
    const cwd = '/work/cli-proj';
    const varint = (v: number): number[] => {
      const out: number[] = [];
      for (;;) {
        const b = v % 128;
        v = Math.floor(v / 128);
        if (v) out.push(b | 0x80);
        else return [...out, b];
      }
    };
    const field = (num: number, wt: 0 | 2, val: number | Uint8Array | string): Uint8Array => {
      const tag = varint(num * 8 + wt);
      if (wt === 0) return Uint8Array.from([...tag, ...varint(val as number)]);
      const b = typeof val === 'string' ? Buffer.from(val) : (val as Uint8Array);
      return Uint8Array.from([...tag, ...varint(b.length), ...b]);
    };
    const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
    // Conversation DB with EMPTY trajectory_metadata_blob (like real agy CLI DBs).
    const agPath = join(home, '.gemini/antigravity-cli/conversations', `${sid}.db`);
    write(agPath, '');
    const ag = new DatabaseSync(agPath);
    ag.exec(`
      CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
      CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx));
      CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    `);
    const f4 = cat(field(2, 0, 20000), field(3, 0, 500), field(5, 0, 100000));
    const gen = cat(field(1, 2, cat(field(4, 2, f4), field(19, 2, 'gemini-4-neon'))));
    ag.prepare('INSERT INTO gen_metadata VALUES (1, ?, ?)').run(gen, gen.length);
    ag.close();
    const oldTime = new Date((testNowSec - 3600) * 1000);
    utimesSync(agPath, oldTime, oldTime);

    // conversation_summaries.db provides workspace_uris for the CLI conversation.
    const sumPath = join(home, '.gemini/antigravity-cli/conversation_summaries.db');
    write(sumPath, '');
    const sum = new DatabaseSync(sumPath);
    sum.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        workspace_uris text NOT NULL,
        parent_conversation_id text NOT NULL DEFAULT '',
        nesting_depth integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT '',
        not_fully_idle numeric NOT NULL DEFAULT 0,
        killed numeric NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL
      )
    `);
    sum
      .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sid, JSON.stringify([`file://${cwd}`]), '', 0, 'CASCADE_RUN_STATUS_IDLE', 0, 0, oldTime.toISOString().replace('T', ' '));
    sum.close();

    // Even when sinceMs is AFTER the conversation's mtime (resumed session before first new write),
    // two-pass fallback finds the conversation and reports 1M contextSize from pricing.json.
    const usage = await readAntigravitySessionUsage(e, reader, {
      session: '',
      cwd,
      sinceMs: testNowSec * 1000,
    });
    expect(usage).toMatchObject({
      model: 'gemini-4-neon',
      input: 20000,
      cached: 100000,
      output: 500,
      contextUsed: 120000,
      contextSize: 1048576,
      requests: 1,
      priced: true,
    });
  });

  test('two-pass sinceMs fallback locates resumed Claude, Codex, Grok, Kimi and OpenCode sessions by cwd', async () => {
    const { home, e, reader, cost } = setup();
    const sid = 'b2cdc860-1055-488f-9ed2-8b8019061bb9';
    const cwd = '/work/resumed';
    const oldSec = testNowSec - 7200;
    const oldDate = new Date(oldSec * 1000);
    const futureSinceMs = (testNowSec + 60) * 1000;
    const r = new Resolver({ home, now: e.now });

    // Claude by cwd
    const claudePath = join(home, '.claude/projects/-work-resumed', `${sid}.jsonl`);
    write(
      claudePath,
      JSON.stringify({
        type: 'assistant',
        timestamp: oldDate.toISOString(),
        cwd,
        message: {
          role: 'assistant',
          id: 'm1',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 50, cache_read_input_tokens: 950, output_tokens: 20 },
        },
      }) + '\n',
    );
    utimesSync(claudePath, oldDate, oldDate);
    const cFiles = await locateClaudeByCwd(e, r, cwd, futureSinceMs);
    expect(await cost('claude', cFiles)).toMatchObject({ model: 'claude-opus-5-5', contextUsed: 1000, contextSize: 1000000 });

    // Codex by cwd
    const dayDir = oldDate.toISOString().slice(0, 10).replaceAll('-', '/');
    const codexPath = join(home, '.codex/sessions', dayDir, `rollout-2026-11-16T00-00-00-${sid}.jsonl`);
    write(
      codexPath,
      JSON.stringify({
        timestamp: oldDate.toISOString(),
        type: 'session_meta',
        payload: { id: sid, cwd, timestamp: oldDate.toISOString() },
      }) +
        '\n' +
        JSON.stringify({ timestamp: oldDate.toISOString(), type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6.1-sol', cwd } }) +
        '\n' +
        JSON.stringify({
          timestamp: oldDate.toISOString(),
          type: 'token_usage_record',
          payload: { turn_id: 't1', response_id: 'r1', usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 30 } },
        }) +
        '\n',
    );
    utimesSync(codexPath, oldDate, oldDate);
    const xFiles = await locateCodexByCwd(e, r, cwd, futureSinceMs, undefined);
    expect(await cost('codex', xFiles)).toMatchObject({ model: 'gpt-6.1-sol', contextSize: 1000000, requests: 1 });

    // Grok by cwd
    const grokPath = join(home, '.grok/sessions', encodeURIComponent(cwd), sid, 'updates.jsonl');
    write(
      grokPath,
      JSON.stringify({
        method: 'session/update',
        params: {
          _meta: { agentTimestampMs: oldSec * 1000 },
          update: {
            sessionUpdate: 'turn_completed',
            usage: { modelUsage: { 'grok-4.6-0709': { modelCalls: 1, inputTokens: 1000, cachedReadTokens: 200, outputTokens: 50 } } },
          },
        },
      }) + '\n',
    );
    utimesSync(grokPath, oldDate, oldDate);
    expect(await cost('grok', await locateGrokSession(e, '', cwd, futureSinceMs))).toMatchObject({
      model: 'grok-4.6-0709',
      contextUsed: 1000,
      contextSize: 256000,
    });

    // Kimi by cwd
    write(join(home, '.kimi-code/sessions/ws', `session_${sid}`, 'state.json'), JSON.stringify({ cwd }));
    const kimiPath = join(home, '.kimi-code/sessions/ws', `session_${sid}`, 'wire.jsonl');
    write(
      kimiPath,
      JSON.stringify({
        type: 'usage.record',
        time: oldSec,
        model: 'kimi-code/k3.1-pro',
        usage: { inputOther: 500, inputCacheRead: 500, inputCacheCreation: 0, output: 40 },
      }) + '\n',
    );
    utimesSync(kimiPath, oldDate, oldDate);
    expect(await cost('kimi', await locateKimiSession(e, '', cwd, futureSinceMs))).toMatchObject({
      model: 'kimi-k3.1-pro',
      contextUsed: 1000,
      contextSize: 262144,
    });

    // OpenCode by cwd
    const ocPath = join(home, '.local/share/opencode/opencode.db');
    write(ocPath, '');
    const oc = new DatabaseSync(ocPath);
    oc.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, time_created integer, time_updated integer)');
    oc.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');
    oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('ses_old1', null, cwd, oldSec * 1000, oldSec * 1000);
    oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm1',
      'ses_old1',
      oldSec * 1000,
      oldSec * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: oldSec * 1000 },
        modelID: 'claude-opus-5-5',
        providerID: 'anthropic',
        cost: 0,
        tokens: { input: 300, output: 20, reasoning: 0, cache: { read: 700, write: 0 } },
      }),
    );
    oc.close();
    expect(await readOpenCodeSessionUsage(e, reader, { session: '', cwd, sinceMs: futureSinceMs })).toMatchObject({
      model: 'claude-opus-5-5',
      contextUsed: 1000,
      contextSize: 1000000,
    });
  });

  test('OpenCode SQL directory filter finds sessions older than the 64 globally newest and memoizes unchanged DBs', async () => {
    const { home, e, reader } = setup();
    const targetCwd = '/work/target-proj';
    const ocPath = join(home, '.local/share/opencode/opencode.db');
    write(ocPath, '');
    const oc = new DatabaseSync(ocPath);
    oc.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text, time_created integer, time_updated integer)');
    oc.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text)');
    const insertSess = oc.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)');
    const insertMsg = oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
    // Target project session is older than 80 newer sessions in other directories.
    insertSess.run('ses_target', null, targetCwd, (testNowSec - 500) * 1000, (testNowSec - 500) * 1000);
    insertMsg.run(
      'm_target',
      'ses_target',
      (testNowSec - 500) * 1000,
      (testNowSec - 500) * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: (testNowSec - 500) * 1000 },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.15,
        tokens: { input: 300, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    for (let i = 0; i < 80; i++) {
      insertSess.run(`ses_other_${i}`, null, `/work/other-${i}`, (testNowSec - 100 + i) * 1000, (testNowSec - 100 + i) * 1000);
    }
    oc.close();

    const u1 = await readOpenCodeSessionUsage(e, reader, { session: '', cwd: targetCwd });
    expect(u1).toMatchObject({ model: 'deepseek-v4-flash', input: 300, requests: 1 });
    expect(reader.dbReads).toBe(1);

    // Unchanged DB hits stamp memo with zero additional SQLite reads.
    const u2 = await readOpenCodeSessionUsage(e, reader, { session: '', cwd: targetCwd });
    expect(u2).toEqual(u1);
    expect(reader.dbReads).toBe(1);

    // Modifying the DB updates its stamp and triggers a fresh read.
    const oc2 = new DatabaseSync(ocPath);
    oc2.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      'm_target2',
      'ses_target',
      (testNowSec - 10) * 1000,
      (testNowSec - 10) * 1000,
      JSON.stringify({
        role: 'assistant',
        time: { created: (testNowSec - 10) * 1000 },
        modelID: 'deepseek-v4-flash',
        providerID: 'deepseek',
        cost: 0.25,
        tokens: { input: 400, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    oc2.close();
    const bump = new Date(Date.now() + 60_000);
    utimesSync(ocPath, bump, bump);
    const u3 = await readOpenCodeSessionUsage(e, reader, { session: '', cwd: targetCwd });
    expect(u3).toMatchObject({ input: 700, requests: 2 });
    expect(reader.dbReads).toBe(2);
    reader.close();
  });

  test('Antigravity session reads memoize unchanged DBs and locateKimiSession respects the global session scan cap', async () => {
    const { home, e, reader } = setup();
    const sid = 'c3cdc860-1055-488f-9ed2-8b8019061bb9';
    const cwd = '/work/ag-memo';
    const varint = (v: number): number[] => {
      const out: number[] = [];
      for (;;) {
        const b = v % 128;
        v = Math.floor(v / 128);
        if (v) out.push(b | 0x80);
        else return [...out, b];
      }
    };
    const field = (num: number, wt: 0 | 2, val: number | Uint8Array | string): Uint8Array => {
      const tag = varint(num * 8 + wt);
      if (wt === 0) return Uint8Array.from([...tag, ...varint(val as number)]);
      const b = typeof val === 'string' ? Buffer.from(val) : (val as Uint8Array);
      return Uint8Array.from([...tag, ...varint(b.length), ...b]);
    };
    const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
    const agPath = join(home, '.gemini/antigravity/conversations', `${sid}.db`);
    write(agPath, '');
    const ag = new DatabaseSync(agPath);
    ag.exec(`
      CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
      CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx));
      CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
    `);
    ag.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
      cat(field(1, 2, field(1, 2, `file://${cwd}`)), field(2, 2, cat(field(1, 0, testNowSec - 30))), field(7, 2, `file://${cwd}`)),
    );
    const f4 = cat(field(2, 0, 500), field(3, 0, 50), field(5, 0, 200));
    const gen = cat(field(1, 2, cat(field(4, 2, f4), field(19, 2, 'claude-opus-4-6'))));
    ag.prepare('INSERT INTO gen_metadata VALUES (1, ?, ?)').run(gen, gen.length);
    ag.close();

    const r1 = await readAntigravitySessionUsage(e, reader, { session: '', cwd });
    expect(r1).toMatchObject({ input: 500, output: 50, requests: 1 });
    expect(reader.dbReads).toBe(1);
    const r2 = await readAntigravitySessionUsage(e, reader, { session: '', cwd });
    expect(r2).toEqual(r1);
    expect(reader.dbReads).toBe(1);
    reader.close();

    // Kimi global scan budget caps total session directories inspected across workspaces.
    for (let w = 0; w < 5; w++) {
      for (let s = 0; s < 4; s++) {
        const dir = join(home, '.kimi-code/sessions', `ws-${w}`, `session_${s}`);
        write(join(dir, 'state.json'), JSON.stringify({ cwd: '/work/never-matches' }));
        write(join(dir, 'wire.jsonl'), '\n');
      }
    }
    await expect(locateKimiSession(e, '', '/work/target-kimi', undefined, 6)).rejects.toMatchObject({ code: 'not_found' });
  });
});

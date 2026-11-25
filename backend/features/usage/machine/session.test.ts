// One session's usage: the same numbers as the spend counts for its
// transcripts, each response once across them, the latest request's model
// and context (not a subagent's, not a made-up message), no content in the
// answer, the cost cache's and the last read's records used, bounds, two
// reads at once, and the read ending with its request.
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { removeHomes, tempHome, testEnv, write } from '../testdata/machine.ts';
import type { UsageEnv } from './env.ts';
import { openRegular } from './logs.ts';
import { modelPricing, tierCost, tierOf, type Tier } from './pricing.ts';
import { CostScanner, type CostReport } from './scan.ts';
import { SESSION_LIMITS, SessionReader, cutModel, type SessionLimits, type SessionUsage, type Transcript } from './session.ts';

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
    await expect(many.cost('grok', byName(cp))).rejects.toMatchObject({ code: 'bad_params' });
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
});

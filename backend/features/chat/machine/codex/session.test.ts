// The Codex adapter's session against scripts of the fake app-server: its
// requests answered or refused by method, lines passed over, the
// app-server's end, a graceful close, queues, plans, configuration, sign-in,
// threads another Codex has open, sessions and history, and what its
// process group left running.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { extended } from '#shared/testdata/extended.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME } from '#shared/lib/brand.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, type Event } from '#shared/proto/chatproto/index.ts';
import { OPTION_ALLOW_ONCE, OPTION_REJECT_ONCE } from '../adapter.ts';
import { MAX_LINE } from '#shared/proto/chatproto/index.ts';
import { codexAdapter } from './adapter.ts';
import { Models, Opt, policy } from './config.ts';
import { RpcError } from './rpc.ts';
import { MAX_TRACKED, callError, type CodexSession } from './session.ts';
import {
  FakeRun,
  HANDSHAKE,
  Script,
  TEST_TIMING,
  TestSink,
  agentMessage,
  fixture,
  invalid,
  policyProblems,
  resultOf,
  tempDir,
  turnEnds,
  type Msg,
} from './testing.ts';

setDefaultTimeout(30_000);

const PATIENCE = 10_000;
const THREAD = Script.THREAD;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const adapter = () => codexAdapter({ timing: TEST_TIMING });

async function start(f: FakeRun, options: chat.Options = {}, resume = ''): Promise<{ s: CodexSession; k: TestSink }> {
  const k = new TestSink();
  const s = (await adapter().start(f.params(tempDir(), options, resume), k, AbortSignal.timeout(PATIENCE))) as CodexSession;
  cleanups.push(() => s.close(AbortSignal.timeout(5000)));
  return { s, k };
}

const text = (s: string): unknown[] => [{ type: 'text', text: s }];

async function prompt(s: CodexSession, msg: string, body: string, delivery?: chat.Delivery): Promise<void> {
  await s.prompt(
    {
      content: text(body),
      message: msg,
      clientId: 'c-' + msg,
      recorded: !s.busy,
      ...(delivery ? { delivery } : {}),
    },
    AbortSignal.timeout(PATIENCE),
  );
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChatProtoError) return e.code;
    throw e;
  }
  return 'none';
}

const inProgress = (id: string) => ({ turn: { id, status: 'inProgress', items: [] } });

/** The session's state the tests look at. */
const state = (s: CodexSession) => s as unknown as { turn: string; pending: Map<string, unknown>; ask: unknown };

describe('the app-server and its requests', () => {
  test('its requests are told by their method: one with the id of a call that waits is no answer; those not served are answered, never dropped', async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    // Our ids: initialize 1, model/list 2, account/read 3, thread/start 4,
    // turn/start 5.
    sc.ask(5, 'item/commandExecution/requestApproval', {
      threadId: THREAD,
      itemId: 'exec-1',
      command: "/bin/zsh -lc 'touch x'",
      cwd: '/work',
    });
    sc.ask(7, 'item/tool/call', { threadId: THREAD, tool: 'x' });
    sc.ask(8, 'attestation/generate', {});
    sc.ask('s-9', 'some/futureRequest', {});
    sc.ask(10, 'mcpServer/elicitation/request', { threadId: THREAD });
    sc.ask(11, 'item/permissions/requestApproval', { threadId: THREAD });
    sc.ask(12, 'account/chatgptAuthTokens/refresh', { reason: 'unauthorized' });
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.turnCompleted('t1', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    k.permAns = [{ option: OPTION_ALLOW_ONCE }];
    await prompt(s, 'm1', 'touch it');
    await k.wait("the turn's end", turnEnds(1));
    expect(f.requests(1, 'turn/start').length).toBe(1);
    const r = f.replies(1);
    const answer = (id: string) => JSON.stringify(r.get(id));
    expect(answer('5')).toContain('"decision":"accept"');
    expect(answer('7')).toContain('"success":false');
    expect(answer('8')).toContain('"code":-32601');
    expect(answer('"s-9"')).toContain('"code":-32601');
    expect(answer('10')).toContain('"action":"decline"');
    expect(answer('11')).toContain('"permissions":{}');
    expect(answer('12')).toContain('"code":-32601');
    expect(k.perms.map((p) => p.kind)).toEqual([chat.PermissionKind.Command]);
    // The refusals are what the schema's answers allow.
    for (const [id, method] of [
      ['7', 'item/tool/call'],
      ['10', 'mcpServer/elicitation/request'],
      ['11', 'item/permissions/requestApproval'],
    ] as const)
      expect(invalid(resultOf('ServerRequest', method), r.get(id)!.result)).toBe('');
  });

  test('a permission the app-server settled on its own is not answered; a turn\'s cancel answers the one that waits "cancel"', async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.line({ dir: 'in', msg: { id: 0, method: 'item/fileChange/requestApproval', params: { threadId: THREAD, itemId: 'p1' } } });
    sc.notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
    sc.ask(1, 'item/tool/requestUserInput', {
      threadId: THREAD,
      itemId: 'q1',
      questions: [
        { id: 'a', header: 'A', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'x', description: '' }] },
      ],
    });
    sc.reply(sc.request('turn/interrupt'), {});
    sc.turnCompleted('t1', 'interrupted');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'go');
    await k.wait('both asked', (k) => k.perms.length === 1 && k.questions.length === 1);
    // The resolved permission's wait ends.
    const deadline = Date.now() + 5000;
    while (state(s).pending.size !== 1 && Date.now() < deadline) await Bun.sleep(10);
    await s.cancel(AbortSignal.timeout(5000));
    await k.wait("the turn's end", turnEnds(1));
    const r = f.replies(1);
    expect(r.has('0')).toBe(false);
    expect(JSON.stringify(r.get('1'))).toContain('"answers":{}');
    const last = k.events.at(-1)!;
    expect([last.t, last.stopReason]).toEqual([chat.EventType.Turn, 'cancelled']);
  });

  test('lines that are no JSON-RPC message, one longer than the most, and unknown notifications and items are passed over; the turn goes on', async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.raw('{not json');
    sc.raw('[1,2,3]');
    sc.raw('{"id":99,"result":{}}');
    sc.line({ dir: 'in', big: MAX_LINE + 10 });
    sc.notify('vendor/somethingNew', { x: 1 });
    sc.item(false, { type: 'someNewItem', id: 'n1' });
    sc.item(false, agentMessage('msg1', 'still here'));
    sc.turnCompleted('t1', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'go');
    await k.wait("the turn's end", turnEnds(1));
    expect(k.events.length).toBe(3);
    expect(JSON.stringify(k.events[1]!.update)).toContain('still here');
    const c = s.conn!;
    expect([c.malformed, c.oversized, c.strayReplies, c.unknownCount()]).toEqual([2, 1, 1, 2]);
  });

  // An app-server that starts tool calls and subagents it never completes
  // grows no map without end: the oldest go beyond MAX_TRACKED.
  test('the tool calls that never complete and the subagents it tells of are bounded', async () => {
    const n = 5000;
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    for (let i = 0; i < n; i++) {
      sc.item(true, {
        type: 'commandExecution',
        id: `c${i}`,
        command: 'sleep 1',
        cwd: '/work',
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        commandActions: [],
      });
      sc.item(true, { type: 'subAgentActivity', id: `a${i}`, kind: 'started', agentThreadId: `th${i}`, agentPath: 'helper' });
    }
    sc.item(false, agentMessage('last', 'all told'));
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'go');
    await k.wait('the last message', (k) => k.events.some((e) => JSON.stringify(e.update ?? '').includes('all told')), 30_000);
    const st = s as unknown as { items: Map<string, unknown>; children: Map<string, unknown> };
    expect(st.items.size).toBeLessThanOrEqual(MAX_TRACKED);
    expect(st.children.size).toBeLessThanOrEqual(MAX_TRACKED);
    // The newest are kept.
    expect(st.items.has(`c${n - 1}`)).toBe(true);
    expect(st.items.has('c0')).toBe(false);
    expect(st.children.has(`th${n - 1}`)).toBe(true);
  });

  test('an app-server that ends in a turn ends the session with an error, and the turn with it', async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.line({ dir: 'in', exit: 3 });
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'go');
    const err = await s.done;
    expect(err?.code).toBe(chat.Code.Ended);
    expect(err?.message).toBe('the app-server ended: exit status 3');
    const last = k.events.at(-1)!;
    expect([last.t, last.state, last.error?.code]).toEqual([chat.EventType.Turn, chat.TurnState.Error, chat.Code.Ended]);
    expect(await codeOf(s.prompt({ content: text('x'), message: '', clientId: '', recorded: true }, AbortSignal.timeout(1000)))).toBe(
      chat.Code.Ended,
    );
  });

  for (const tc of [
    { mode: '', want: ['eof'], min: 0 },
    { mode: 'ignore-eof', want: ['eof', 'term'], min: TEST_TIMING.grace },
    { mode: 'ignore-eof,ignore-term', want: ['eof', 'term'], min: TEST_TIMING.grace + TEST_TIMING.term },
  ]) {
    extended(
      `close ends the app-server gracefully: its input first, SIGTERM after the grace, SIGKILL after more (${tc.mode || 'exits'})`,
      async () => {
        const sc = new Script();
        sc.begin();
        const f = new FakeRun(tc.mode, HANDSHAKE, sc.file());
        const { s } = await start(f);
        const began = Date.now();
        await s.close(AbortSignal.timeout(10_000));
        let settled = false;
        void s.done.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(true);
        expect(await s.done).toBeUndefined();
        expect(f.events(1)).toEqual(tc.want);
        expect(Date.now() - began).toBeGreaterThanOrEqual(tc.min);
      },
    );
  }

  extended('what the app-server left running in its group ends with it: after a close and after its own exit', async () => {
    for (const crash of [false, true]) {
      const sc = new Script();
      sc.begin();
      if (crash) {
        sc.line({ dir: 'in', sleep: 1000 });
        sc.line({ dir: 'in', exit: 3 });
      }
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const pidFile = join(tempDir(), 'child');
      f.env = { ...f.env, FAKE_CHILD: pidFile };
      const { s } = await start(f);
      let pid = 0;
      for (const deadline = Date.now() + PATIENCE; pid === 0; await Bun.sleep(10)) {
        if (Date.now() > deadline) throw new Error('the leftover did not start');
        try {
          pid = Number(readFileSync(pidFile, 'utf8'));
        } catch {
          // not yet
        }
      }
      cleanups.push(async () => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      });
      if (!crash) await s.close(AbortSignal.timeout(PATIENCE));
      await s.done;
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + TEST_TIMING.grace + 2 * TEST_TIMING.term + 5000;
      while (alive()) {
        if (Date.now() > deadline) throw new Error(`the app-server's leftover still runs (${crash ? 'crash' : 'close'})`);
        await Bun.sleep(20);
      }
    }
  });
});

describe('prompts, queues and plans', () => {
  test('a message sent while a compaction runs waits for its end; one withdrawn never goes; the others start the next turn, told taken', async () => {
    const sc = new Script();
    sc.begin();
    sc.reply(sc.request('thread/compact/start'), {});
    sc.turnStarted('t1');
    sc.item(true, { type: 'contextCompaction', id: 'c1' });
    sc.line({ dir: 'in', sleep: 500 });
    sc.item(false, { type: 'contextCompaction', id: 'c1' });
    sc.turnCompleted('t1', 'completed');
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t2'));
    sc.turnStarted('t2');
    sc.turnCompleted('t2', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await s.compact(AbortSignal.timeout(5000));
    await k.wait("the compaction's start", (k) => k.count((ev) => ev.t === chat.EventType.Notice) === 1);
    await prompt(s, 'm1', 'one');
    await prompt(s, 'm2', 'two');
    await s.cancelQueued('m1');
    expect(await codeOf(s.cancelQueued('m1'))).toBe(chat.Code.NotFound);
    expect(f.requests(1, 'turn/steer').length).toBe(0);
    await k.wait("the next turn's end", turnEnds(2));
    expect(k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`)).toEqual([
      'queued:m1',
      'queued:m2',
      'cancelled:m1',
      'taken:m2',
    ]);
    const ts = f.requests(1, 'turn/start');
    expect(ts.length).toBe(1);
    expect(ts[0]!.clientUserMessageId).toBe('m2');
  });

  test('a plan refused keeps planning; a prompt while a plan waits for its approval ends it and starts the next turn with the message', async () => {
    const plan = (sc: Script, turn: string) => {
      const id = sc.request('turn/start');
      sc.reply(id, inProgress(turn));
      sc.turnStarted(turn);
      sc.item(false, { type: 'plan', id: 'plan-' + turn, text: '# Plan ' + turn });
      sc.turnCompleted(turn, 'completed');
    };
    const sc = new Script();
    sc.begin();
    plan(sc, 't1');
    plan(sc, 't2');
    plan(sc, 't3');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f, { mode: chat.Mode.Plan });
    k.permAns = [{ option: OPTION_REJECT_ONCE }];
    await prompt(s, 'm1', 'plan');
    await k.wait("the refused plan's end", turnEnds(1));
    // The approval is asked after the turn's end; once refused, nothing
    // waits.
    await k.wait('the refusal', (k) => k.perms.length === 1 && state(s).ask === null);
    await prompt(s, 'm2', 'plan again');
    await k.wait("the second plan's approval", (k) => k.perms.length === 2);
    k.permAns = [{ option: OPTION_REJECT_ONCE }];
    await prompt(s, 'm3', 'change it');
    await k.wait("the third turn's end", turnEnds(3));
    expect(s.st.mode).toBe(chat.Mode.Plan);
    for (const p of f.requests(1, 'turn/start')) expect((p.collaborationMode as Msg).mode).toBe('plan');
    const got = k.events.flatMap((ev): string[] => {
      if (ev.t === chat.EventType.Turn) return [`${ev.state}:${ev.item}`];
      if (ev.t === chat.EventType.Queued || ev.t === chat.EventType.User) return [`${ev.t}:${ev.message ?? ''}${ev.state ?? ''}`];
      return [];
    });
    expect(got.slice(0, 7)).toEqual(['start:t1', 'end:t1', 'start:t2', 'end:t2', 'queued:m3queued', 'queued:m3taken', 'start:t3']);
  });

  test("the host's view of the turn is a moment behind: a prompt it did not record that finds the turn ended starts the next after its user event; one it recorded is not told again", async () => {
    const sc = new Script();
    sc.begin();
    for (const id of ['t1', 't2']) {
      const turn = sc.request('turn/start');
      sc.reply(turn, inProgress(id));
      sc.turnStarted(id);
      sc.turnCompleted(id, 'completed');
    }
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    const send = (msg: string, recorded: boolean) =>
      s.prompt({ content: text(msg), message: msg, clientId: 'c-' + msg, recorded }, AbortSignal.timeout(PATIENCE));
    await send('one', true);
    // The turn ends between the host's look and the prompt.
    await k.wait("the first turn's end", turnEnds(1));
    await send('two', false);
    await k.wait("the second turn's end", turnEnds(2));
    const got = k.events.flatMap((ev): string[] => {
      if (ev.t === chat.EventType.Turn) return [`${ev.state}:${ev.item}`];
      if (ev.t === chat.EventType.User || ev.t === chat.EventType.Queued) return [`${ev.t}:${ev.clientId}${ev.state ?? ''}`];
      return [];
    });
    expect(got).toEqual(['start:t1', 'end:t1', 'user:c-two', 'start:t2', 'end:t2']);
    expect(k.events.find((ev) => ev.t === chat.EventType.User)!.content).toEqual(text('two'));
    const ts = f.requests(1, 'turn/start');
    expect(ts.length).toBe(2);
    expect(ts[1]!.clientUserMessageId).toBe('two');
  });

  test("a question without options takes the user's own words; the answers go back by the questions' ids", async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.ask(6, 'item/tool/requestUserInput', {
      threadId: THREAD,
      turnId: 't1',
      itemId: 'q-1',
      questions: [
        { id: 'name', header: 'Name', question: 'What is it called?', isOther: false, isSecret: false, options: null },
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'red', description: '' }],
        },
      ],
    });
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.turnCompleted('t1', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    k.questAns = [{ answers: { name: ['Widget'], color: ['red'], other: ['dropped'] } }];
    await prompt(s, 'm1', 'ask me');
    await k.wait("the turn's end", turnEnds(1));
    expect(k.questions.length).toBe(1);
    const qs = k.questions[0]!.questions;
    expect(qs.map((q) => !!q.allowOther)).toEqual([true, false]);
    const answer = f.replies(1).get('6')!.result;
    expect(answer).toEqual({ answers: { name: { answers: ['Widget'] }, color: { answers: ['red'] } } });
    expect(invalid(resultOf('ServerRequest', 'item/tool/requestUserInput'), answer)).toBe('');
  });

  test("a message this session told (queued and taken) whose turn does not start ends in an error the log keeps: after a plan that waited, after a steer the turn's end beat", async () => {
    const turnStates = (k: TestSink) =>
      k.events.flatMap((ev): string[] =>
        ev.t === chat.EventType.Turn ? [ev.state!] : ev.t === chat.EventType.Queued ? [`${ev.state}:${ev.message}`] : [],
      );
    {
      const sc = new Script();
      sc.begin();
      const id = sc.request('turn/start');
      sc.reply(id, inProgress('t1'));
      sc.turnStarted('t1');
      sc.item(false, { type: 'plan', id: 'plan-t1', text: '# Plan' });
      sc.turnCompleted('t1', 'completed');
      sc.fail(sc.request('turn/start'), 'the model is overloaded');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f, { mode: chat.Mode.Plan });
      await prompt(s, 'm1', 'plan');
      await k.wait("the plan's approval", (k) => k.perms.length === 1);
      // The host saw the approval wait: the message is not recorded.
      expect(
        await codeOf(s.prompt({ content: text('change it'), message: 'm2', clientId: 'c-m2', recorded: false }, AbortSignal.timeout(5000))),
      ).toBe(chat.Code.Failed);
      expect(turnStates(k)).toEqual(['start', 'end', 'queued:m2', 'taken:m2', 'error']);
    }
    {
      const sc = new Script();
      sc.begin();
      const id = sc.request('turn/start');
      sc.reply(id, inProgress('t1'));
      sc.turnStarted('t1');
      sc.fail(sc.request('turn/steer'), 'no active turn to steer');
      sc.fail(sc.request('turn/start'), 'the model is overloaded');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await prompt(s, 'm1', 'go');
      await k.wait("the turn's start", (k) => state(s).turn === 't1' && k.count((ev) => ev.t === chat.EventType.Turn) === 1);
      expect(
        await codeOf(
          s.prompt(
            { content: text('more'), message: 'm2', clientId: 'c-m2', recorded: false, delivery: chat.Delivery.Steer },
            AbortSignal.timeout(5000),
          ),
        ),
      ).toBe(chat.Code.Failed);
      expect(turnStates(k)).toEqual(['start', 'queued:m2', 'taken:m2', 'error']);
    }
  });

  test('every message told queued is told taken or cancelled in the end: steered into a turn the app-server ends in, or one whose turn was to start after the end', async () => {
    const queued = (k: TestSink) => k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`);
    {
      const sc = new Script();
      sc.begin();
      const id = sc.request('turn/start');
      sc.reply(id, inProgress('t1'));
      sc.turnStarted('t1');
      sc.reply(sc.request('turn/steer'), { turnId: 't1' });
      sc.line({ dir: 'in', sleep: 100 });
      sc.line({ dir: 'in', exit: 3 });
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await prompt(s, 'm1', 'go');
      await k.wait("the turn's start", () => state(s).turn === 't1');
      await prompt(s, 'm2', 'more', chat.Delivery.Steer);
      await s.done;
      expect(queued(k)).toEqual(['queued:m2', 'taken:m2']);
    }
    {
      const sc = new Script();
      sc.begin();
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await s.close(AbortSignal.timeout(PATIENCE));
      await s.sendQueued([{ content: text('late'), message: 'm3', clientId: 'c-m3' }]);
      expect(queued(k)).toEqual(['cancelled:m3']);
    }
  });
});

describe('configuration, sign-in and threads', () => {
  test('options and setConfig take only what Codex offers', async () => {
    const sc = new Script();
    sc.begin();
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f, { model: 'no-such-model', effort: 'ultra', mode: 'yolo' });
    expect(s.st).toEqual({ model: 'gpt-6-luna', effort: 'low', mode: chat.Mode.Default });
    for (const [id, v] of [
      [Opt.Model, 'nope'],
      [Opt.Effort, 'ultra'],
      [Opt.Mode, 'yolo'],
      ['other', 'x'],
    ])
      expect(await codeOf(s.setConfig(id!, v!))).toBe(chat.Code.BadRequest);
    await s.setConfig(Opt.Model, 'gpt-6.2-sol');
    await s.setConfig(Opt.Effort, 'ultra');
    // A model without the effort falls back to its own default.
    await s.setConfig(Opt.Model, 'gpt-6-luna');
    expect(s.st.effort).toBe('medium');
    await s.setConfig(Opt.Mode, chat.Mode.Full);
    expect(k.chat.config!.at(-1)!.currentValue).toBe(chat.Mode.Full);
    const full = policy(chat.Mode.Full, '/w');
    expect([full.approval, full.sandbox.type]).toEqual(['never', 'dangerFullAccess']);
  });

  test('the mode option marks full access, which the host gates', () => {
    const cfg = new Models().configOptions({ model: '', effort: '', mode: chat.Mode.Default });
    const mode = cfg.at(-1)!;
    expect(mode.category).toBe(chat.Category.Mode);
    for (const v of mode.options!) expect(!!v.full).toBe(v.value === chat.Mode.Full);
  });

  test('Codex without a sign-in it needs is not started', async () => {
    const sc = new Script();
    sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
    sc.reply(sc.request('account/read'), { account: null, requiresOpenaiAuth: true });
    const f = new FakeRun('', HANDSHAKE, sc.file());
    expect(await codeOf(adapter().start(f.params(tempDir()), new TestSink(), AbortSignal.timeout(PATIENCE)))).toBe(chat.Code.AuthRequired);
    expect(f.requests(1, 'thread/start').length).toBe(0);
  });

  test("a thread another Codex has open (a terminal's) is not taken up: the app-server's refusal is in_terminal", async () => {
    const sc = new Script();
    sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
    sc.reply(sc.request('account/read'), { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
    sc.fail(sc.request('thread/resume'), `thread ${THREAD} already has an active writer`);
    const f = new FakeRun('', HANDSHAKE, sc.file());
    expect(await codeOf(adapter().start(f.params(tempDir(), {}, THREAD), new TestSink(), AbortSignal.timeout(PATIENCE)))).toBe(
      chat.Code.InTerminal,
    );
    for (const m of ['thread x already has a live local writer', 'thread x already has an active writer'])
      expect(callError(new RpcError(-32600, m)).code).toBe(chat.Code.InTerminal);
  });

  test("sessions lists a directory's threads through an app-server started for the question, which ends gracefully", async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('13-resume.2.jsonl'));
    const cwd = tempDir();
    const { sessions, next } = await adapter().sessions(
      { kind: 'codex', argv: f.argv, env: f.env, cwd, procs: f.procs, logger: f.log.logger, cursor: '' },
      AbortSignal.timeout(PATIENCE),
    );
    expect(sessions[0]).toMatchObject({ sessionId: '00000000-0000-7000-8000-000000000006', title: 'Reply with the word hi.' });
    expect(Date.parse(sessions[0]!.updatedAt!) / 1000).toBe(1795347638);
    expect(next).toBe('');
    const l = f.requests(1, 'thread/list');
    expect(l.length).toBe(1);
    expect(l[0]!.cwd).toBe(cwd);
    expect(f.events(1)).toEqual(['eof']);
  });

  test("sessions ask a running chat's app-server rather than start one", async () => {
    const sc = new Script();
    sc.begin();
    sc.reply(sc.request('thread/list'), { data: [{ id: THREAD, preview: 'first\nsecond', cwd: '/w', updatedAt: 1 }], nextCursor: null });
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const a = adapter();
    const s = await a.start(f.params(tempDir()), new TestSink(), AbortSignal.timeout(PATIENCE));
    cleanups.push(() => s.close(AbortSignal.timeout(5000)));
    // No program to start: the running app-server answers.
    const list = await a.sessions(
      { kind: 'codex', argv: ['/nonexistent'], env: {}, cwd: '/w', procs: f.procs, logger: f.log.logger, cursor: '' },
      AbortSignal.timeout(PATIENCE),
    );
    expect(list.sessions).toEqual([{ sessionId: THREAD, cwd: '/w', title: 'first', updatedAt: '1970-01-01T00:00:01Z' }]);
    expect(f.started()).toBe(1);
  });
});

describe('history', () => {
  const turnItems = (n: number) => {
    const id = (s: string) => s + n;
    return [
      { type: 'userMessage', id: id('u'), content: [{ type: 'text', text: id('hello '), text_elements: [] }] },
      { type: 'reasoning', id: id('r'), summary: ['thinking'], content: [] },
      {
        type: 'commandExecution',
        id: id('c'),
        command: "/bin/zsh -lc 'ls'",
        cwd: '/work',
        status: 'completed',
        aggregatedOutput: 'a\n',
        exitCode: 0,
        commandActions: [],
      },
      { type: 'agentMessage', id: id('m'), text: id('done '), phase: 'final_answer' },
    ];
  };
  const turnOf = (n: number, status: string) => ({
    id: 'turn' + n,
    status,
    items: turnItems(n),
    itemsView: 'full',
    startedAt: 1795347000 + n,
    completedAt: 1795347010 + n,
  });
  const run = async (sc: Script, after = '') => {
    const f = new FakeRun('', '', sc.file());
    const evs: Event[] = [];
    await adapter().history(
      { kind: 'codex', argv: f.argv, env: f.env, cwd: '/work', procs: f.procs, logger: f.log.logger, sessionId: THREAD, after },
      (ev) => evs.push(ev),
      AbortSignal.timeout(PATIENCE),
    );
    return { f, evs };
  };

  test("a thread's turns, every item, oldest first, after the thread's name", async () => {
    const sc = new Script();
    sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
    // The thread's name, not its preview.
    sc.reply(sc.request('thread/list'), {
      data: [{ id: THREAD, name: '  Named thread\nmore', preview: 'hello 1', cwd: '/work' }],
      nextCursor: null,
    });
    // Oldest first: two pages.
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(1, 'completed'), turnOf(2, 'interrupted')], nextCursor: 'cursor-2' });
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(3, 'failed'), turnOf(4, 'inProgress')], nextCursor: null });
    const { f, evs } = await run(sc);
    for (const ev of evs) expect([ev.live, ev.seq]).toEqual([undefined, undefined]);
    expect(evs[0]).toEqual({ t: chat.EventType.Info, chat: { title: 'Named thread' } as chat.Chat });
    expect(evs.map((ev) => `${ev.t}:${ev.state ?? ''}${ev.stopReason ?? ''}:${ev.item ?? ''}`)).toEqual([
      'info::',
      'turn:start:turn1',
      'user::u1',
      'update::r1',
      'update::c1',
      'update::m1',
      'turn:endend_turn:turn1',
      'turn:start:turn2',
      'user::u2',
      'update::r2',
      'update::c2',
      'update::m2',
      'turn:endcancelled:turn2',
      'turn:start:turn3',
      'user::u3',
      'update::r3',
      'update::c3',
      'update::m3',
      'turn:error:turn3',
    ]);
    // A turn's times are its own.
    expect(evs[1]!.at).toBe(new Date(1795347001 * 1000).toISOString().replace('.000', ''));
    const tl = f.requests(1, 'thread/turns/list');
    expect(tl.length).toBe(2);
    expect([tl[0]!.itemsView, tl[0]!.sortDirection, tl[1]!.cursor, tl[0]!.threadId]).toEqual(['full', 'asc', 'cursor-2', THREAD]);
    const l = f.requests(1, 'thread/list');
    expect(l).toEqual([{ includedThreadIds: [THREAD], limit: 1 }]);
  });

  test('a thread without a name, or whose name cannot be read, has no info', async () => {
    for (const list of [
      (sc: Script) => sc.reply(sc.request('thread/list'), { data: [{ id: THREAD, preview: 'hello 1' }] }),
      (sc: Script) => sc.fail(sc.request('thread/list'), 'no'),
    ]) {
      const sc = new Script();
      sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
      list(sc);
      sc.reply(sc.request('thread/turns/list'), { data: [turnOf(1, 'completed')], nextCursor: null });
      const { evs } = await run(sc);
      expect(evs[0]!.t).toBe(chat.EventType.Turn);
      expect(evs.some((ev) => ev.t === chat.EventType.Info)).toBe(false);
    }
  });

  test('after an item or a turn: the turns read newest first until it, only what came after it', async () => {
    const since = async (after: string) => {
      const sc = new Script();
      sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
      sc.reply(sc.request('thread/turns/list'), { data: [turnOf(4, 'inProgress'), turnOf(3, 'completed')], nextCursor: 'c' });
      sc.reply(sc.request('thread/turns/list'), { data: [turnOf(2, 'completed'), turnOf(1, 'completed')], nextCursor: null });
      const { f, evs } = await run(sc, after);
      expect(f.requests(1, 'thread/turns/list')[0]!.sortDirection).toBe('desc');
      // A catch-up does not read the name.
      expect(f.requests(1, 'thread/list').length).toBe(0);
      return evs.map((ev) => `${ev.t}:${ev.item ?? ''}`);
    };
    expect(await since('c2')).toEqual([
      'update:m2',
      'turn:turn2',
      'turn:turn3',
      'user:u3',
      'update:r3',
      'update:c3',
      'update:m3',
      'turn:turn3',
    ]);
    expect(await since('turn2')).toEqual(['turn:turn3', 'user:u3', 'update:r3', 'update:c3', 'update:m3', 'turn:turn3']);
    expect(await since('nowhere')).toEqual([]);
  });

  test('catch-up reuses page cursors and emits each newer turn in order', async () => {
    const sc = new Script();
    sc.reply(sc.request('initialize'), { userAgent: 'x/1' });
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(3, 'completed')], nextCursor: 'middle' });
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(2, 'completed')], nextCursor: 'anchor' });
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(1, 'completed')], nextCursor: null });
    sc.reply(sc.request('thread/turns/list'), { data: [turnOf(2, 'completed')], nextCursor: 'anchor' });
    const { f, evs } = await run(sc, 'turn1');
    expect(f.requests(1, 'thread/turns/list').map((p) => p.cursor)).toEqual([undefined, 'middle', 'anchor', 'middle']);
    expect(evs.filter((e) => e.t === chat.EventType.User).map((e) => e.item)).toEqual(['u2', 'u3']);
  });
});

describe('async questions, models, FIFO queue/steer/interrupt, fork/rewind, and background tasks', () => {
  test('non-blocking item/tool/requestUserInput forwards async, autoResolutionMs and item, and survives turn completion', async () => {
    const sc = new Script();
    sc.begin();
    const turn = sc.request('turn/start');
    sc.reply(turn, inProgress('t1'));
    sc.turnStarted('t1');
    sc.line({
      dir: 'in',
      msg: {
        id: 77,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: THREAD,
          turnId: 't1',
          itemId: 'q-async-1',
          isBlocking: false,
          autoResolutionMs: 30_000,
          questions: [
            {
              id: 'env',
              header: 'Environment',
              question: 'Target environment?',
              isOther: true,
              isSecret: false,
              options: [{ label: 'staging', description: '' }],
            },
          ],
        },
      },
    });
    sc.turnCompleted('t1', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    let resolveQ!: (a: { answers: Record<string, string[]> }) => void;
    const origQuestion = k.question.bind(k);
    k.question = async (r, sig) => {
      k.questions.push(r);
      return await new Promise((resolve) => {
        resolveQ = resolve;
        sig.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
      });
    };
    await prompt(s, 'm1', 'deploy');
    await k.wait("the turn's end and async question", (sink) => turnEnds(1)(sink) && sink.questions.length === 1);
    expect(k.questions[0]!.async).toBe(true);
    expect(k.questions[0]!.autoResolutionMs).toBe(30_000);
    expect(k.questions[0]!.item).toBe('q-async-1');
    // Still open after turn completed; user answers now.
    resolveQ({ answers: { env: ['staging'] } });
    await k.wait('reply sent', () => f.replies(1).has('77'));
    expect(f.replies(1).get('77')!.result).toEqual({ answers: { env: { answers: ['staging'] } } });
    k.question = origQuestion;
  });

  test('agentMessage with async questions launches non-blocking question card, sends answer turn, and is superseded by manual prompt', async () => {
    // 1. User answers async question -> dispatched as a new turn.
    {
      const sc = new Script();
      sc.begin();
      const t1 = sc.request('turn/start');
      sc.reply(t1, inProgress('t1'));
      sc.turnStarted('t1');
      sc.item(false, {
        type: 'agentMessage',
        id: 'am-1',
        text: 'Which DB should we use?',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Database', options: ['SQLite', 'Postgres'] }],
      });
      sc.turnCompleted('t1', 'completed');
      const t2 = sc.request('turn/start');
      sc.reply(t2, inProgress('t2'));
      sc.turnStarted('t2');
      sc.turnCompleted('t2', 'completed');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      k.questAns = [{ answers: { q1: ['Postgres'] } }];
      await prompt(s, 'm1', 'start');
      await k.wait('second turn from async answer', turnEnds(2));
      expect(k.questions.length).toBe(1);
      expect(k.questions[0]!.async).toBe(true);
      expect(k.questions[0]!.item).toBe('am-1');
      expect(k.questions[0]!.questions[0]!.allowOther).toBe(true);
      const starts = f.requests(1, 'turn/start');
      expect(starts.length).toBe(2);
      expect(starts[1]!.input).toEqual([{ type: 'text', text: 'Database: Postgres', text_elements: [] }]);
      expect(policyProblems(f)).toEqual([]);
    }
    // 2. Manual prompt supersedes open async question without blocking.
    {
      const sc = new Script();
      sc.begin();
      const t1 = sc.request('turn/start');
      sc.reply(t1, inProgress('t1'));
      sc.turnStarted('t1');
      sc.item(false, {
        type: 'agentMessage',
        id: 'am-2',
        text: 'Follow up?',
        delivery: 'async',
        questions: [{ title: 'Continue?', options: ['Yes', 'No'] }],
      });
      sc.turnCompleted('t1', 'completed');
      const t2 = sc.request('turn/start');
      sc.reply(t2, inProgress('t2'));
      sc.turnStarted('t2');
      sc.turnCompleted('t2', 'completed');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      let abortReason: unknown = 'not-aborted';
      const origQ = k.question.bind(k);
      k.question = async (r, sig) => {
        sig.addEventListener('abort', () => (abortReason = sig.reason), { once: true });
        return origQ(r, sig);
      };
      await prompt(s, 'm1', 'start');
      await k.wait('async question asked', (sink) => turnEnds(1)(sink) && sink.questions.length === 1);
      // Async question does NOT make the session busy.
      expect(s.busy).toBe(false);
      await prompt(s, 'm2', 'manual override');
      await k.wait('second turn completed', turnEnds(2));
      expect(abortReason).toBe(chat.By.Superseded);
      const starts = f.requests(1, 'turn/start');
      expect(starts[1]!.input).toEqual([{ type: 'text', text: 'manual override', text_elements: [] }]);
    }
  });

  test('models() lists models via probe when idle and reuses live app-server while updating live session models', async () => {
    // 1. Standalone probe when no session is running.
    {
      const sc = new Script();
      sc.reply(sc.request('initialize'), { userAgent: 'codex/0.171.0' });
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const ms = await adapter().models!(
        {
          kind: 'codex',
          argv: f.argv,
          env: f.env,
          cwd: tempDir(),
          procs: f.procs,
          logger: f.log.logger,
          client: { name: NAME, version: '1.0' },
        },
        AbortSignal.timeout(PATIENCE),
      );
      expect(ms.length).toBeGreaterThan(0);
      expect(ms.find((m) => m.value === 'gpt-6-luna')).toMatchObject({
        value: 'gpt-6-luna',
        name: 'GPT-6-Luna',
        defaultEffort: 'medium',
        images: true,
      });
      expect(f.events(1)).toEqual(['eof']);
    }
    // 2. Reuses live app-server and updates live session models so setConfig accepts newly refreshed model.
    {
      const sc = new Script();
      sc.reply(sc.request('initialize'), { userAgent: 'codex/0.171.0 (test)' });
      sc.reply(sc.request('model/list'), {
        data: [
          {
            id: 'gpt-6-luna',
            model: 'gpt-6-luna',
            displayName: 'GPT-6-Luna',
            hidden: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }],
            inputModalities: ['text', 'image'],
          },
        ],
        nextCursor: null,
      });
      sc.reply(sc.request('thread/start'), { thread: { id: Script.THREAD }, model: 'gpt-6-luna', reasoningEffort: 'low' });
      sc.reply(sc.request('model/list'), {
        data: [
          {
            id: 'gpt-7-fresh',
            model: 'gpt-7-fresh',
            displayName: 'GPT-7 Fresh',
            description: 'Freshly added model',
            hidden: false,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }],
            inputModalities: ['text'],
          },
        ],
        nextCursor: null,
      });
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const a = adapter();
      const k = new TestSink();
      const s = (await a.start(f.params(tempDir()), k, AbortSignal.timeout(PATIENCE))) as CodexSession;
      cleanups.push(() => s.close(AbortSignal.timeout(5000)));
      const ms = await a.models!(
        {
          kind: 'codex',
          argv: ['/nonexistent'],
          env: {},
          cwd: tempDir(),
          procs: f.procs,
          logger: f.log.logger,
          client: { name: NAME, version: '1.0' },
        },
        AbortSignal.timeout(PATIENCE),
      );
      expect(f.started()).toBe(1);
      expect(ms).toEqual([
        {
          value: 'gpt-7-fresh',
          name: 'GPT-7 Fresh',
          description: 'Freshly added model',
          efforts: ['high'],
          defaultEffort: 'high',
          images: false,
        },
      ]);
      await s.setConfig(Opt.Model, 'gpt-7-fresh');
      expect(s.st.model).toBe('gpt-7-fresh');
      expect(s.st.effort).toBe('high');
    }
  });

  test('default prompts queue FIFO one-by-one, support per-message withdrawal, and never auto-steer', async () => {
    const sc = new Script();
    sc.begin();
    const t1 = sc.request('turn/start');
    sc.reply(t1, inProgress('t1'));
    sc.turnStarted('t1');
    sc.line({ dir: 'in', sleep: 250 });
    sc.turnCompleted('t1', 'completed');
    const t2 = sc.request('turn/start');
    sc.reply(t2, inProgress('t2'));
    sc.turnStarted('t2');
    sc.line({ dir: 'in', sleep: 150 });
    sc.turnCompleted('t2', 'completed');
    const t3 = sc.request('turn/start');
    sc.reply(t3, inProgress('t3'));
    sc.turnStarted('t3');
    sc.turnCompleted('t3', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'first');
    await k.wait('t1 started', () => state(s).turn === 't1');
    await prompt(s, 'm2', 'second');
    await prompt(s, 'm3', 'withdrawn');
    await prompt(s, 'm4', 'fourth');
    // Withdraw m3 before t1 finishes.
    await s.cancelQueued('m3');
    expect(f.requests(1, 'turn/steer').length).toBe(0);
    // Wait for t2 to start; m4 should STILL be queued (not concatenated into t2!).
    await k.wait('t2 started', () => state(s).turn === 't2');
    expect(k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`)).toEqual([
      'queued:m2',
      'queued:m3',
      'queued:m4',
      'cancelled:m3',
      'taken:m2',
    ]);
    await k.wait('t3 completed', turnEnds(3));
    const starts = f.requests(1, 'turn/start');
    expect(starts.map((x) => x.clientUserMessageId)).toEqual(['m1', 'm2', 'm4']);
    expect(f.requests(1, 'turn/steer').length).toBe(0);
  });

  test('steerQueued promotes a queued message via turn/steer; delivery interrupt & cancel(keepQueue) preserve unrelated queued items', async () => {
    // 1. steerQueued(..., 'steer')
    {
      const sc = new Script();
      sc.begin();
      const t1 = sc.request('turn/start');
      sc.reply(t1, inProgress('t1'));
      sc.turnStarted('t1');
      sc.reply(sc.request('turn/steer'), { turnId: 't1' });
      sc.item(false, { type: 'userMessage', id: 'u2', clientId: 'm2', content: [{ type: 'text', text: 'steer me', text_elements: [] }] });
      sc.turnCompleted('t1', 'completed');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await prompt(s, 'm1', 'first');
      await k.wait('t1 started', () => state(s).turn === 't1');
      await prompt(s, 'm2', 'steer me');
      await s.steerQueued('m2', chat.Delivery.Steer, AbortSignal.timeout(5000));
      await k.wait('t1 completed', turnEnds(1));
      expect(f.requests(1, 'turn/steer').length).toBe(1);
      expect(f.requests(1, 'turn/steer')[0]!.clientUserMessageId).toBe('m2');
      // Only one queued:m2 event (no duplicate on promotion), followed by taken:m2.
      expect(k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`)).toEqual([
        'queued:m2',
        'taken:m2',
      ]);
      expect(await codeOf(s.steerQueued('missing', chat.Delivery.Steer, AbortSignal.timeout(5000)))).toBe(chat.Code.NotFound);
    }
    // 2. delivery: 'interrupt' interrupts t1, runs interrupting message first, then drains preserved queued item.
    {
      const sc = new Script();
      sc.begin();
      const t1 = sc.request('turn/start');
      sc.reply(t1, inProgress('t1'));
      sc.turnStarted('t1');
      sc.reply(sc.request('turn/interrupt'), {});
      sc.turnCompleted('t1', 'interrupted');
      const t2 = sc.request('turn/start');
      sc.reply(t2, inProgress('t2'));
      sc.turnStarted('t2');
      sc.turnCompleted('t2', 'completed');
      const t3 = sc.request('turn/start');
      sc.reply(t3, inProgress('t3'));
      sc.turnStarted('t3');
      sc.turnCompleted('t3', 'completed');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await prompt(s, 'm1', 'slow');
      await k.wait('t1 started', () => state(s).turn === 't1');
      await prompt(s, 'm2', 'queued-first');
      await prompt(s, 'm3', 'urgent-interrupt', chat.Delivery.Interrupt);
      await k.wait('all 3 turns settled', turnEnds(3));
      expect(f.requests(1, 'turn/interrupt').length).toBe(1);
      expect(f.requests(1, 'turn/start').map((x) => x.clientUserMessageId)).toEqual(['m1', 'm3', 'm2']);
    }
    // 3. cancel(signal, { keepQueue: true }) preserves queued messages until next prompt.
    {
      const sc = new Script();
      sc.begin();
      const t1 = sc.request('turn/start');
      sc.reply(t1, inProgress('t1'));
      sc.turnStarted('t1');
      sc.reply(sc.request('turn/interrupt'), {});
      sc.turnCompleted('t1', 'interrupted');
      const t2 = sc.request('turn/start');
      sc.reply(t2, inProgress('t2'));
      sc.turnStarted('t2');
      sc.turnCompleted('t2', 'completed');
      const t3 = sc.request('turn/start');
      sc.reply(t3, inProgress('t3'));
      sc.turnStarted('t3');
      sc.turnCompleted('t3', 'completed');
      const f = new FakeRun('', HANDSHAKE, sc.file());
      const { s, k } = await start(f);
      await prompt(s, 'm1', 'slow');
      await k.wait('t1 started', () => state(s).turn === 't1');
      await prompt(s, 'm2', 'kept-in-queue');
      await s.cancel(AbortSignal.timeout(5000), { keepQueue: true });
      await k.wait('t1 interrupted', turnEnds(1));
      // m2 is NOT cancelled and NOT prematurely drained before m3 starts.
      expect(k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`)).toEqual(['queued:m2']);
      await prompt(s, 'm3', 'replacement');
      await k.wait('m3 and kept m2 completed', turnEnds(3));
      expect(f.requests(1, 'turn/start').map((x) => x.clientUserMessageId)).toEqual(['m1', 'm3', 'm2']);
    }
  });

  test('adapter.fork calls thread/fork read-only and session.rewind calls thread/revert', async () => {
    const sc = new Script();
    sc.begin();
    sc.reply(sc.request('thread/fork'), { thread: { id: '00000000-0000-7000-8000-0000000000bb' } });
    sc.reply(sc.request('thread/revert'), { thread: { id: THREAD } });
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const a = adapter();
    const k = new TestSink();
    const cwd = tempDir();
    const s = (await a.start(f.params(cwd), k, AbortSignal.timeout(PATIENCE))) as CodexSession;
    cleanups.push(() => s.close(AbortSignal.timeout(5000)));
    const forked = await a.fork!(
      {
        kind: 'codex',
        argv: f.argv,
        env: f.env,
        cwd,
        procs: f.procs,
        logger: f.log.logger,
        sessionId: THREAD,
        beforeTurnId: 'turn-2',
        client: { name: NAME, version: '1.0' },
      },
      AbortSignal.timeout(PATIENCE),
    );
    expect(forked).toEqual({ sessionId: '00000000-0000-7000-8000-0000000000bb' });
    const fp = f.requests(1, 'thread/fork')[0]!;
    expect(fp).toMatchObject({
      threadId: THREAD,
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      excludeTurns: true,
      beforeTurnId: 'turn-2',
    });

    expect(await codeOf(s.rewind({}, AbortSignal.timeout(5000)))).toBe(chat.Code.BadRequest);
    const rev = await s.rewind({ beforeTurnId: 'turn-2' }, AbortSignal.timeout(5000));
    expect(rev).toEqual({ sessionId: THREAD });
    expect(f.requests(1, 'thread/revert')).toEqual([{ threadId: THREAD, beforeTurnId: 'turn-2' }]);
    expect(policyProblems(f)).toEqual([]);
  });

  test('rewind cancels open async requestUserInput entries in pending and supersedes active asyncAsk', async () => {
    const sc = new Script();
    sc.begin();
    const t1 = sc.request('turn/start');
    sc.reply(t1, inProgress('t1'));
    sc.turnStarted('t1');
    sc.line({
      dir: 'in',
      msg: {
        id: 88,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: THREAD,
          turnId: 't1',
          itemId: 'q-async-rewind',
          isBlocking: false,
          questions: [{ id: 'pick', header: 'Pick', question: 'Which option?', isOther: true, isSecret: false, options: null }],
        },
      },
    });
    sc.item(false, {
      type: 'agentMessage',
      id: 'am-rewind',
      text: 'Also follow up?',
      delivery: 'async',
      questions: [{ title: 'Follow up', options: ['A', 'B'] }],
    });
    sc.turnCompleted('t1', 'completed');
    sc.reply(sc.request('thread/revert'), { thread: { id: THREAD } });
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    const aborted: Array<{ item?: string; reason: unknown }> = [];
    const origQ = k.question.bind(k);
    k.question = async (r, sig) => {
      sig.addEventListener('abort', () => aborted.push({ item: r.item, reason: sig.reason }), { once: true });
      return origQ(r, sig);
    };
    await prompt(s, 'm1', 'start');
    await k.wait('both async questions open after turn end', (sink) => turnEnds(1)(sink) && sink.questions.length === 2);
    expect(state(s).pending.size).toBe(1);
    await s.rewind({ beforeTurnId: 't1' }, AbortSignal.timeout(5000));
    expect(state(s).pending.size).toBe(0);
    await k.wait('cancelled reply sent for async requestUserInput', () => f.replies(1).has('88'));
    expect(f.replies(1).get('88')!.result).toEqual({ answers: {} });
    expect(aborted.find((a) => a.item === 'q-async-rewind')).toBeDefined();
    expect(aborted.find((a) => a.item === 'am-rewind')?.reason).toBe(chat.By.Superseded);
    expect(policyProblems(f)).toEqual([]);
  });

  test('background terminals and subagents populate Chat.tasks and stopTask terminates each', async () => {
    const sc = new Script();
    sc.begin();
    const t1 = sc.request('turn/start');
    sc.reply(t1, inProgress('t1'));
    sc.turnStarted('t1');
    sc.item(true, {
      type: 'commandExecution',
      id: 'exec-bg-1',
      command: "/bin/zsh -lc 'python3 -m http.server'",
      cwd: '/work',
      processId: 'pty-99',
      source: 'unifiedExecStartup',
      status: 'inProgress',
      commandActions: [],
    });
    sc.reply(sc.request('thread/backgroundTerminals/list'), {
      data: [
        {
          command: "/bin/zsh -lc 'python3 -m http.server'",
          cwd: '/work',
          itemId: 'exec-bg-1',
          processId: 'pty-99',
          osPid: 4242,
        },
      ],
      nextCursor: null,
    });
    sc.item(true, {
      type: 'subAgentActivity',
      id: 'sa-1',
      kind: 'started',
      agentThreadId: 'th-sub-1',
      agentPath: '/root/worker',
      model: 'gpt-6-luna',
    });
    sc.notify('turn/started', { threadId: 'th-sub-1', turn: { id: 'sub-turn-1', status: 'inProgress', items: [] } });
    sc.reply(sc.request('thread/backgroundTerminals/terminate'), { terminated: true });
    sc.reply(sc.request('thread/backgroundTerminals/list'), { data: [], nextCursor: null });
    sc.reply(sc.request('turn/interrupt'), {});
    sc.item(false, {
      type: 'subAgentActivity',
      id: 'sa-1-end',
      kind: 'interrupted',
      agentThreadId: 'th-sub-1',
      agentPath: '/root/worker',
    });
    sc.turnCompleted('t1', 'completed');
    const f = new FakeRun('', HANDSHAKE, sc.file());
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'run server and worker');
    await k.wait('both tasks published', (sink) => (sink.chat.tasks?.length ?? 0) === 2 && sink.chat.tasks!.every((t) => t.stoppable));
    expect(k.chat.tasks).toMatchObject([
      {
        id: 'pty-99',
        kind: chat.TaskKind.Shell,
        status: chat.TaskStatus.Running,
        description: 'python3 -m http.server',
        command: 'python3 -m http.server',
        toolCallId: 'exec-bg-1',
        pid: 4242,
        backgrounded: true,
        stoppable: true,
      },
      {
        id: 'th-sub-1',
        kind: chat.TaskKind.Subagent,
        status: chat.TaskStatus.Running,
        description: '/root/worker',
        agentType: '/root/worker',
        toolCallId: 'sa-1',
        backgrounded: true,
        stoppable: true,
      },
    ]);
    expect(typeof k.chat.tasks![1]!.startedAt).toBe('string');
    // Stop background terminal -> thread/backgroundTerminals/terminate.
    await s.stopTask('pty-99', AbortSignal.timeout(5000));
    expect(f.requests(1, 'thread/backgroundTerminals/terminate')).toEqual([{ threadId: THREAD, processId: 'pty-99' }]);
    // Stop subagent -> turn/interrupt on child thread.
    await s.stopTask('th-sub-1', AbortSignal.timeout(5000));
    expect(f.requests(1, 'turn/interrupt')).toEqual([{ threadId: 'th-sub-1', turnId: 'sub-turn-1' }]);
    await k.wait('turn ended and tasks cleared', (sink) => turnEnds(1)(sink) && sink.chat.tasks === undefined);
    expect(await codeOf(s.stopTask('unknown-task', AbortSignal.timeout(5000)))).toBe(chat.Code.NotFound);
    expect(policyProblems(f)).toEqual([]);
  });
});

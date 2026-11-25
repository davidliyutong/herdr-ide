// The Codex adapter's session against scripts of the fake app-server: its
// requests answered or refused by method, lines passed over, the
// app-server's end, a graceful close, queues, plans, configuration, sign-in,
// threads another Codex has open, sessions and history, and what its
// process group left running.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { extended } from '#shared/testdata/extended.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function prompt(s: CodexSession, msg: string, body: string): Promise<void> {
  await s.prompt({ content: text(body), message: msg, clientId: 'c-' + msg, recorded: !s.busy }, AbortSignal.timeout(PATIENCE));
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
    extended(`close ends the app-server gracefully: its input first, SIGTERM after the grace, SIGKILL after more (${tc.mode || 'exits'})`, async () => {
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
    });
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
        await codeOf(s.prompt({ content: text('more'), message: 'm2', clientId: 'c-m2', recorded: false }, AbortSignal.timeout(5000))),
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
      await prompt(s, 'm2', 'more');
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
});

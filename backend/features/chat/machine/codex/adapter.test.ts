// The Codex adapter against a fake app-server replaying the recordings of
// spec/vectors/chat/codex (testdata/fakeappserver.ts), driven as the host
// drives it: the events compared with the golden files of the same
// recordings (testdata/golden); what the adapter asked checked
// against the policies it keeps and the pinned schema.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noticeMethod, Notice } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError } from '#shared/proto/chatproto/index.ts';
import { NAME, SLUG } from '#shared/lib/brand.ts';
import { OPTION_ALLOW_ONCE, OPTION_ALLOW_SESSION, OPTION_REJECT_ONCE, planOption } from '../adapter.ts';
import { codexAdapter } from './adapter.ts';
import type { CodexSession } from './session.ts';
import {
  FakeRun,
  GOLDEN,
  HANDSHAKE,
  TEST_TIMING,
  TestSink,
  canonical,
  edited,
  fixture,
  goldenLines,
  goldens,
  invalid,
  policyProblems,
  records,
  resultOf,
  tempDir,
  turnEnds,
  type Msg,
} from './testing.ts';

setDefaultTimeout(30_000);

const PATIENCE = 10_000;

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

/** Sends a message as the host does: recorded when it sees no turn run and
 * nothing wait. */
async function prompt(s: CodexSession, msg: string, body: string | unknown[], delivery?: chat.Delivery): Promise<void> {
  await s.prompt(
    {
      content: typeof body === 'string' ? text(body) : body,
      message: msg,
      clientId: 'c-' + msg,
      recorded: !s.busy,
      ...(delivery ? { delivery } : {}),
    },
    AbortSignal.timeout(PATIENCE),
  );
}

/** Compares the events and the chat with the golden file. */
function compareGolden(name: string, k: TestSink): void {
  const got = records(k);
  if (process.env.UPDATE_TESTDATA === '1') {
    const path = join(GOLDEN, name + '.golden');
    const prevRaw = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    const merged = got.map((line, i) => {
      const old = prevRaw[i];
      if (old !== undefined && canonical(JSON.parse(old)) === line) return old;
      return line;
    });
    writeFileSync(path, merged.join('\n') + '\n');
    return;
  }
  const want = goldenLines(name);
  expect(want.length).toBeGreaterThan(2);
  expect(got.length).toBe(want.length);
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) expect({ line: i + 1, got: got[i] }).toEqual({ line: i + 1, got: want[i] });
  }
}

const compared = new Set<string>();
function checked(name: string, k: TestSink, f: FakeRun): void {
  compareGolden(name, k);
  compared.add(name);
  expect(policyProblems(f)).toEqual([]);
}

/** The decisions the client answered approvals with. */
function decisions(f: FakeRun, n: number): string[] {
  const out: string[] = [];
  for (const m of f.received(n)) {
    const r = m.result as Msg | undefined;
    if (m.method === undefined && r && typeof r.decision === 'string') out.push(r.decision);
  }
  return out;
}

describe('the recordings through the Codex adapter', () => {
  for (const name of ['03-thread-text', '04b-reasoning', '13-resume.1']) {
    test(`a text turn: ${name}`, async () => {
      const f = new FakeRun('', HANDSHAKE, fixture(name + '.jsonl'));
      const { s, k } = await start(f, { model: 'gpt-6-luna', effort: 'low' });
      await prompt(s, 'm1', 'hello');
      await k.wait("the turn's end", turnEnds(1));
      checked(name, k, f);
    });
  }

  test('commands the read-only sandbox refuses', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('05a-command-sandboxed.jsonl'));
    const { s, k } = await start(f);
    for (const [i, msg] of ['m1', 'm2', 'm3', 'm4'].entries()) {
      await prompt(s, msg, 'run it');
      await k.wait("the turn's end", turnEnds(i + 1));
    }
    checked('05a-command-sandboxed', k, f);
  });

  test('approvals: accepted, declined, accepted for the session, as the recording answered them', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('05b-command-approval.jsonl'));
    const { s, k } = await start(f);
    k.permAns = [{ option: OPTION_ALLOW_ONCE }, { option: OPTION_REJECT_ONCE }, { option: OPTION_ALLOW_SESSION }];
    for (const [i, msg] of ['m1', 'm2', 'm3', 'm4'].entries()) {
      await prompt(s, msg, 'run it');
      await k.wait("the turn's end", turnEnds(i + 1));
    }
    expect(decisions(f, 1)).toEqual(['accept', 'decline', 'acceptForSession']);
    for (const d of ['accept', 'decline', 'acceptForSession'])
      expect(invalid(resultOf('ServerRequest', 'item/commandExecution/requestApproval'), { decision: d })).toBe('');
    expect(k.perms.length).toBe(3);
    expect(k.perms[0]!.kind).toBe(chat.PermissionKind.Command);
    expect(k.perms[0]!.options.length).toBe(3);
    const tc = k.perms[0]!.toolCall as Msg;
    expect([tc.title, tc.kind, tc.toolCallId !== '']).toEqual(['echo hi > hi.txt', 'execute', true]);
    const input = tc.rawInput as Msg;
    expect(input.reason).toBeDefined();
    expect(input.command).toBe('echo hi > hi.txt');
    // The default mode asks: under on-request and read-only the model
    // refused to write instead of asking.
    for (const ts of f.requests(1, 'turn/start')) {
      expect(ts.approvalPolicy).toBe('untrusted');
      expect((ts.sandboxPolicy as Msg).type).toBe('workspaceWrite');
    }
    checked('05b-command-approval', k, f);
  });

  test('file changes: applied under acceptEdits, asked for under read-only', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('06-file-change.jsonl'));
    const { s, k } = await start(f, { mode: chat.Mode.AcceptEdits });
    k.permAns = [{ option: OPTION_ALLOW_ONCE }];
    await prompt(s, 'm1', 'create it');
    await k.wait("the turn's end", turnEnds(1));
    await prompt(s, 'm2', 'change it');
    await k.wait("the turn's end", turnEnds(2));
    expect(k.perms.map((p) => p.kind)).toEqual([chat.PermissionKind.File]);
    const tc = k.perms[0]!.toolCall as Msg;
    expect(tc.kind).toBe('edit');
    expect((tc.content as unknown[]).length).toBe(1);
    expect((f.requests(1, 'turn/start')[0]!.sandboxPolicy as Msg).type).toBe('workspaceWrite');
    checked('06-file-change', k, f);
  });

  test('plan mode: the question answered, the plan approved after its turn, carried out in the next in the mode chosen', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('07-plan-and-question.jsonl'));
    const { s, k } = await start(f, { model: 'gpt-6-luna', effort: 'low', mode: chat.Mode.Plan });
    k.questAns = [{ answers: { greeting: ['Hello (Recommended)'] } }];
    k.permAns = [{ option: planOption(chat.Mode.AcceptEdits) }];
    await prompt(s, 'm1', 'plan it');
    await k.wait("the implementation's end", turnEnds(2));
    expect(k.questions.length).toBe(1);
    expect(k.questions[0]!.questions.length).toBe(1);
    expect(k.questions[0]!.questions[0]!.allowOther).toBe(true);
    expect(k.perms.map((p) => p.kind)).toEqual([chat.PermissionKind.Plan]);
    const ts = f.requests(1, 'turn/start');
    expect(ts.length).toBe(2);
    expect((ts[0]!.collaborationMode as Msg).mode).toBe('plan');
    expect((ts[1]!.collaborationMode as Msg).mode).toBe('default');
    expect((ts[1]!.sandboxPolicy as Msg).type).toBe('workspaceWrite');
    const answers = f.received(1).filter((m) => m.method === undefined && (m.result as Msg | undefined)?.answers !== undefined);
    expect(answers.length).toBe(1);
    expect(invalid(resultOf('ServerRequest', 'item/tool/requestUserInput'), answers[0]!.result)).toBe('');
    checked('07-plan-and-question', k, f);
  });

  test('an interrupt whose command still runs: the turn ends cancelled, the app-server is ended gracefully and started again on the thread', async () => {
    // The second process resumes the thread of the first.
    const f = new FakeRun(
      '',
      HANDSHAKE,
      fixture('09-interrupt.jsonl'),
      edited('13-resume.2.jsonl', undefined, '00000000-0000-7000-8000-000000000006', '00000000-0000-7000-8000-000000000001'),
    );
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'count');
    await k.wait('the command', (k) => k.count((ev) => ev.t === chat.EventType.Update && !ev.live && !!ev.item && !ev.parent) > 0);
    await s.cancel(AbortSignal.timeout(5000));
    await k.wait(
      'the restart',
      (k) => k.count((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Restarted)) === 1,
    );
    expect(f.started()).toBe(2);
    expect(f.events(1)[0]).toBe('eof');
    const rs = f.requests(2, 'thread/resume');
    expect(rs.length).toBe(1);
    expect([rs[0]!.threadId, rs[0]!.excludeTurns]).toEqual([s.id, true]);
    expect(f.requests(1, 'turn/interrupt').length).toBe(1);
    // The session goes on on the new process.
    await prompt(s, 'm2', 'again');
    await k.wait("the next turn's end", turnEnds(2));
    checked('09-interrupt', k, f);
  });

  test('a message sent while a turn runs is steered into it: queued, then taken with its user message', async () => {
    // The recording's client steered twice more (with a wrong turn, and
    // after the turn): what followed those belongs to the first steer.
    const f = new FakeRun(
      '',
      HANDSHAKE,
      edited('10-steer.jsonl', (method, n) => method === 'turn/steer' && n > 0),
    );
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'sleep');
    await k.wait('the command', (k) => k.count((ev) => ev.t === chat.EventType.Update && !!ev.item) === 1);
    await prompt(s, 'm2', 'Also end your answer with the word banana.', chat.Delivery.Steer);
    await k.wait("the turn's end", turnEnds(1));
    const st = f.requests(1, 'turn/steer');
    expect(st.length).toBe(1);
    expect(st[0]!.expectedTurnId).toBeDefined();
    expect(st[0]!.clientUserMessageId).toBe('m2');
    expect(k.events.filter((ev) => ev.t === chat.EventType.Queued).map((ev) => `${ev.state}:${ev.message}`)).toEqual([
      'queued:m2',
      'taken:m2',
    ]);
    checked('10-steer', k, f);
  });

  test('/compact compacts in a turn of its own', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('11-compact.jsonl'));
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'think');
    await k.wait("the turn's end", turnEnds(1));
    // The slash command compacts.
    await prompt(s, 'm2', ' /compact ');
    await k.wait("the compaction's end", turnEnds(2));
    expect(f.requests(1, 'thread/compact/start').length).toBe(1);
    checked('11-compact', k, f);
  });

  test('images go as data URLs', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('12-images.jsonl'));
    const { s, k } = await start(f);
    const img = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
    for (const [i, msg] of ['m1', 'm2'].entries()) {
      await s.prompt(
        { content: [img, { type: 'text', text: 'What color?' }], message: msg, clientId: '', recorded: !s.busy },
        AbortSignal.timeout(PATIENCE),
      );
      await k.wait("the turn's end", turnEnds(i + 1));
    }
    for (const p of f.requests(1, 'turn/start'))
      expect((p.input as Msg[])[0]).toEqual({ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' });
    checked('12-images', k, f);
  });

  test('a resumed thread: thread/resume read-only without its turns, then a turn', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('13-resume.2.jsonl'));
    const { s, k } = await start(f, { model: 'gpt-6-luna' }, '00000000-0000-7000-8000-000000000006');
    expect(s.id).toBe('00000000-0000-7000-8000-000000000006');
    expect(f.requests(1, 'thread/start').length).toBe(0);
    expect(f.requests(1, 'thread/resume').length).toBe(1);
    await prompt(s, 'm1', 'again');
    await k.wait("the turn's end", turnEnds(1));
    checked('13-resume.2', k, f);
  });

  test("a subagent: its tool call, and its thread's events under it", async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('14-subagent.jsonl'));
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'spawn');
    await k.wait("the turn's end", turnEnds(1));
    let spawn = '';
    let children = 0;
    for (const ev of k.events) {
      const u = ev.update as Msg | undefined;
      if (ev.t === chat.EventType.Update && !ev.parent && u?.kind === 'think' && u.title === '/root/run_echo') spawn = ev.item!;
      if (ev.parent) {
        expect(ev.parent).toBe(spawn);
        children++;
      }
      // A subagent's turn is not the chat's.
      if (ev.t === chat.EventType.Turn && ev.item) expect(ev.item).toBe('00000000-0000-7000-8000-000000000002');
    }
    expect(spawn).not.toBe('');
    expect(children).toBeGreaterThan(0);
    // A subagent's usage is not the chat's.
    expect([k.chat.usage?.used, k.chat.usage?.size]).toEqual([19789, 828400]);
    checked('14-subagent', k, f);
  });

  test('errors: a thread Codex has no rollout of is not found; a start Codex refuses fails with its message', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('15-errors.1.jsonl'));
    const k = new TestSink();
    const p = f.params(tempDir());
    p.resume = '00000000-0000-7000-8000-000000000001';
    const codeOf = async (x: Promise<unknown>) => {
      try {
        await x;
      } catch (e) {
        return e instanceof ChatProtoError ? e.code : String(e);
      }
      return 'none';
    };
    expect(await codeOf(adapter().start(p, k, AbortSignal.timeout(PATIENCE)))).toBe(chat.Code.NotFound);
    const f2 = new FakeRun('', HANDSHAKE, fixture('15-errors.2.jsonl'));
    expect(await codeOf(adapter().start(f2.params(tempDir()), k, AbortSignal.timeout(PATIENCE)))).toBe(chat.Code.Failed);
    // Both ended their app-server gracefully.
    for (const x of [f, f2]) expect(x.events(1)).toContain('eof');
    expect(k.events).toEqual([]);
  });

  test('retried errors are notices; a turn that never ends is cancelled when the chat closes', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('16-trust-write-isolated-home.jsonl'));
    const { s, k } = await start(f);
    await prompt(s, 'm1', 'hi');
    await k.wait('the retries', (k) => k.count((ev) => ev.t === chat.EventType.Notice) === 3);
    await s.close(AbortSignal.timeout(5000));
    expect(await s.done).toBeUndefined();
    checked('16-trust-write-isolated-home', k, f);
  });

  test('the handshake: the client named, experimental API on, attestation refused; models, efforts and modes as configuration options', async () => {
    const f = new FakeRun('', HANDSHAKE, fixture('03-thread-text.jsonl'));
    const { k } = await start(f, { model: 'gpt-6-luna', effort: 'high', mode: chat.Mode.Full });
    const init = f.requests(1, 'initialize');
    expect(init.length).toBe(1);
    expect(init[0]).toEqual({
      clientInfo: { name: SLUG, title: NAME, version: '1.2.3' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(f.received(1)[1]).toEqual({ method: 'initialized' });
    expect([k.chat.sessionId, k.chat.agentVersion]).toEqual(['00000000-0000-7000-8000-000000000001', '0.171.0']);
    const cur = Object.fromEntries((k.chat.config ?? []).map((o) => [o.id, o.currentValue]));
    expect(cur).toEqual({ model: 'gpt-6-luna', thought_level: 'high', mode: chat.Mode.Full });
    const c = k.chat.capabilities;
    expect([c.images, c.model, c.effort, c.cancelQueued, c.steer, c.stopTask, c.fork, c.rewind, c.rewindFiles]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(policyProblems(f)).toEqual([]);
  });

  test('every golden file is compared', () => {
    // The replays above run in this file's order; this one runs last.
    expect([...compared].sort()).toEqual(goldens().sort());
  });
});

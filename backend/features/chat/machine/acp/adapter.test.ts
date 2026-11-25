// The ACP adapter against a fake agent that replays the recordings of
// spec/vectors/chat/acp (testdata/fakeagent.ts), its records compared with
// the golden files of the same scenarios (testdata/golden).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError } from '#shared/proto/chatproto/index.ts';
import { noticeMethod, Notice } from '#shared/proto/agentproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import type { Adapter, PromptParams, Session } from '../adapter.ts';
import { acpAdapter } from './adapter.ts';
import type { AcpSession } from './session.ts';
import { optionByID, optionOf } from './state.ts';
import {
  Host,
  answers,
  edit,
  fakeParams,
  from,
  goGolden,
  logs,
  msgLine,
  promptOf,
  recording,
  tempDir,
  without,
  type Step,
} from './testing.ts';

const PATIENCE = 10_000;
const timing = { initialize: PATIENCE, session: PATIENCE, load: PATIENCE, call: PATIENCE, grace: 2000, term: 2000, drain: 1000 };
const SID = 'session_00000000-0000-4000-8000-000000000001';

const never = () => new AbortController().signal;
const turnOver = (ev: chat.Event) => ev.t === chat.EventType.Turn && (ev.state === chat.TurnState.End || ev.state === chat.TurnState.Error);
const turnState = (state: string) => (ev: chat.Event) => ev.t === chat.EventType.Turn && ev.state === state;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A test's fake agent, the adapter and the recording host. */
class Harness {
  readonly dir = tempDir();
  readonly host = new Host(this.dir);
  readonly procs = new AgentProcesses();
  readonly log = logs();
  a: Adapter;

  constructor(t: Partial<typeof timing> = {}) {
    this.a = acpAdapter({ timing: { ...timing, ...t }, itemPrefix: () => 'x' });
  }

  rec(agent: string, name: string): Step[] {
    return recording(agent, name, this.dir);
  }

  params(steps: Step[], env: Record<string, string> = {}) {
    this.host.answers = answers(steps);
    return fakeParams(this.dir, steps, this.procs, this.log.logger, env);
  }

  async start(p: ReturnType<Harness['params']>): Promise<AcpSession> {
    const s = (await this.a.start(p, this.host, AbortSignal.timeout(PATIENCE))) as AcpSession;
    cleanups.push(() => s.close(AbortSignal.timeout(PATIENCE)));
    return s;
  }

  /** Sends a prompt and waits for its turn's end. */
  async turn(s: AcpSession, content: unknown[]): Promise<chat.Event> {
    await s.prompt(prompt(s, content, 'm', 'c'));
    return this.host.await("the turn's end", turnOver);
  }

  async close(s: Session): Promise<void> {
    await s.close(AbortSignal.timeout(PATIENCE));
    expect(await s.done).toBeUndefined();
  }

  golden(name: string): void {
    const got = this.host.lines();
    const want = goGolden(name);
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) expect({ line: i + 1, got: got[i] }).toEqual({ line: i + 1, got: want[i] });
    }
  }
}

/** Whether a prompt to s now is one the host records: no turn runs and
 * nothing waits for one. */
function recorded(s: AcpSession): boolean {
  const x = s as unknown as { turn: unknown; queue: unknown[] };
  return x.turn === null && x.queue.length === 0;
}

const prompt = (s: AcpSession, content: unknown[], message = '', clientId = ''): PromptParams => ({
  content,
  message,
  clientId,
  recorded: recorded(s),
});

async function rejects(p: Promise<unknown>): Promise<chat.ChatError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChatProtoError) return e.error;
    throw e;
  }
  throw new Error('no error');
}

/** Fails for a permission that offers to allow or reject for good; the
 * number of permissions. */
function checkOptions(h: Host): number {
  let n = 0;
  for (const r of h.recs) {
    const p = r.permission as { Options: chat.PermissionOption[] } | undefined;
    if (!p) continue;
    n++;
    for (const o of p.Options) expect([chat.OptionKind.AllowOnce, chat.OptionKind.RejectOnce] as string[]).toContain(o.kind);
  }
  return n;
}

const pgidOf = (pid: number): number =>
  Number(
    readFileSync(`/proc/${pid}/stat`, 'utf8')
      .slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2)
      .split(' ')[2],
  );

describe('the ACP adapter', () => {
  test('a Kimi Code session: text, a file written and a command run with permissions, the mode set, a turn cancelled, an image', async () => {
    const h = new Harness();
    const turns: Record<string, Step[]> = {};
    let steps: Step[] = [];
    for (const n of ['01-initialize', '02-session-new', '03-prompt-hi', '04-permission-write', '05-execute-permission']) {
      turns[n] = h.rec('kimi', n);
      steps = steps.concat(turns[n]!);
    }
    // The mode through its configuration option (the recording also has
    // session/set_mode, which a session with the option does not send).
    steps = steps.concat(from(h.rec('kimi', '06-set-mode-and-config-option'), 'session/set_config_option'));
    for (const n of ['07-cancel', '08-image']) {
      turns[n] = h.rec('kimi', n);
      steps = steps.concat(turns[n]!);
    }
    const s = await h.start(h.params(steps));
    expect(s.id).toBe(SID);
    // A process group of its own.
    if (process.platform === 'linux') expect(pgidOf(s.pid)).toBe(s.pid);
    for (const n of ['03-prompt-hi', '04-permission-write', '05-execute-permission']) {
      const ev = await h.turn(s, promptOf(turns[n]!));
      expect([n, ev.state, ev.stopReason]).toEqual([n, chat.TurnState.End, 'end_turn']);
    }
    for (const v of ['plan', 'default']) await s.setConfig('mode', v, never());
    await s.prompt(prompt(s, promptOf(turns['07-cancel']!)));
    await h.host.await("the turn's start", turnState(chat.TurnState.Start));
    await s.cancel();
    expect((await h.host.await("the cancelled turn's end", turnOver)).stopReason).toBe('cancelled');
    await h.turn(s, promptOf(turns['08-image']!));
    await h.close(s);
    expect(checkOptions(h.host)).toBe(2);
    expect(h.host.lines().length).toBe(305);
    h.golden('kimi-session');
  });

  test("a Grok session told not to approve everything: permissions, the effort set, a turn cancelled, an image; its cost and context from the answers' _meta", async () => {
    const h = new Harness();
    const turns: Record<string, Step[]> = {};
    let steps: Step[] = [];
    for (const n of [
      '01-initialize',
      '02-session-new-yolo-off',
      '04-permission-write',
      '05c-execute-permission',
      '06-set-config-option-effort',
      '07-cancel',
      '08b-image-32px',
    ]) {
      turns[n] = h.rec('grok', n);
      steps = steps.concat(turns[n]!);
    }
    const p = h.params(steps);
    p.newSessionMeta = { yoloMode: false }; // the fake checks session/new's params
    const s = await h.start(p);
    for (const n of ['04-permission-write', '05c-execute-permission'])
      expect((await h.turn(s, promptOf(turns[n]!))).stopReason).toBe('end_turn');
    for (const v of ['low', 'high']) await s.setConfig('reasoning_effort', v, never());
    await s.prompt(prompt(s, promptOf(turns['07-cancel']!)));
    await h.host.await("the turn's start", turnState(chat.TurnState.Start));
    await s.cancel();
    expect((await h.host.await("the cancelled turn's end", turnOver)).stopReason).toBe('cancelled');
    await h.turn(s, promptOf(turns['08b-image-32px']!));
    await h.close(s);
    expect(checkOptions(h.host)).toBe(2);
    // The turns' costUsdTicks, 10^10 to the dollar; the context of the last
    // turn's last model call, of the model's window.
    const ticks = 201116800 + 200668000 + 167055600;
    const c = h.host.chat;
    expect(c.usage?.cost?.currency).toBe('USD');
    expect(Math.abs(c.usage!.cost!.amount - ticks / 1e10)).toBeLessThan(1e-12);
    expect([c.usage?.used, c.usage?.size]).toEqual([25008, 256000]);
    expect(c.capabilities).toEqual({
      images: true,
      compact: false,
      queue: true,
      plan: false,
      questions: false,
      effort: true,
      model: true,
      cancelQueued: true,
    });
    expect(c.agentVersion).toBeTruthy();
    h.golden('grok-session');
  });

  test("a session taken up by session/load (an agent without session/resume): its replay is dropped, the chat's log has it", async () => {
    const h = new Harness();
    const steps = without(h.rec('kimi', '09-list-load'), 'session/list');
    edit(steps, (m) => {
      const res = m.result as Record<string, Record<string, Record<string, unknown>>> | undefined;
      if (!res?.agentCapabilities) return false;
      delete res.agentCapabilities.sessionCapabilities!.resume;
      return true;
    });
    const after = h.rec('kimi', '09b-prompt-after-load');
    const p = h.params(steps.concat(after));
    p.resume = SID;
    const s = await h.start(p);
    await h.turn(s, promptOf(after));
    await h.close(s);
    h.golden('kimi-load');
  });

  for (const [agent, id] of [
    ['kimi', SID],
    ['grok', '00000000-0000-4000-8000-000000000003'],
  ] as const) {
    test(`a ${agent} session taken up by session/resume, which replays nothing`, async () => {
      const h = new Harness();
      const p = h.params(h.rec(agent, '10-resume'));
      p.resume = id;
      const s = await h.start(p);
      expect(s.id).toBe(id);
      await h.close(s);
      h.golden(`${agent}-resume`);
    });
  }

  for (const [agent, id, title] of [
    ['kimi', SID, 'Reply with the word hi'],
    ['grok', '00000000-0000-4000-8000-000000000007', 'Create hello.txt containing hi'],
  ] as const) {
    test(`a ${agent} import: the title the agent lists the session with, then the replay as stored events, turn by turn; again from where the first ended`, async () => {
      const h = new Harness();
      const listed = h.rec(agent, '09-list-load');
      const steps = without(listed, 'session/list');
      const hp = (steps: Step[], after = '') => ({ ...h.params(steps), sessionId: id, after, kind: agent });
      const all: chat.Event[] = [];
      await h.a.history(
        hp(listed),
        (ev) => {
          all.push(ev);
          h.host.event(ev);
        },
        never(),
      );
      h.golden(`${agent}-history`);
      // Every event is stored; the import starts with its notice and the
      // session's title.
      for (const ev of all) expect(ev.live || ev.seq).toBeFalsy();
      expect(all.filter((ev) => ev.t === chat.EventType.User).length).toBeGreaterThanOrEqual(3);
      expect([all[0]!.t, all[0]!.method]).toEqual([chat.EventType.Notice, noticeMethod(Notice.Imported)]);
      expect([all[1]!.t, all[1]!.chat?.title]).toEqual([chat.EventType.Info, title]);
      all.splice(1, 1);

      // From the last item of the second turn on: the turns after it.
      let second = -1;
      let third = -1;
      let n = 0;
      for (let i = 0; i < all.length; i++) {
        const ev = all[i]!;
        if (ev.t === chat.EventType.User && ++n === 3) {
          third = i;
          break;
        }
        if (n === 2 && ev.item) second = i;
      }
      const want = JSON.stringify(all.slice(third));
      let rest: chat.Event[] = [];
      await h.a.history(hp(steps, all[second]!.item), (ev) => rest.push(ev), never());
      expect(JSON.stringify(rest)).toBe(want);

      // A tool call's item is its id, as in a chat's live events: an earlier
      // item of the same turn gives the same.
      n = 0;
      let tool = '';
      for (const ev of all) {
        if (ev.t === chat.EventType.User) n++;
        if (n === 2 && ev.item && !ev.item.startsWith('h-')) {
          tool = ev.item;
          break;
        }
      }
      expect(tool).not.toBe('');
      rest = [];
      await h.a.history(hp(steps, tool), (ev) => rest.push(ev), never());
      expect(JSON.stringify(rest)).toBe(want);

      // An item the replay does not have: nothing.
      rest = [];
      await h.a.history(hp(steps, 'x-m-404'), (ev) => rest.push(ev), never());
      expect(rest).toEqual([]);
    });
  }

  for (const [agent, want] of [
    ['kimi', [`${SID} Reply with the word hi`, 'session_00000000-0000-4000-8000-000000000002 ']],
    [
      'grok',
      [
        '00000000-0000-4000-8000-000000000003 Image Color Query Without Attached File',
        '00000000-0000-4000-8000-000000000004 Run printf hi redirect to out.txt',
        '00000000-0000-4000-8000-000000000005 Create subdirectory with mkdir -p',
        '00000000-0000-4000-8000-000000000006 Create hello.txt and run echo hi',
        '00000000-0000-4000-8000-000000000007 Create hello.txt containing hi',
        '00000000-0000-4000-8000-000000000008 ',
      ],
    ],
  ] as const) {
    test(`${agent}: sessions lists the agent's sessions of a directory, the most recent first`, async () => {
      const h = new Harness();
      const steps = h.rec(agent, '09-list-load');
      const list = from(steps, 'session/load');
      const p = h.params(steps.slice(0, steps.length - list.length));
      const { sessions, next } = await h.a.sessions({ ...p, cursor: '' }, never());
      expect(next).toBe('');
      expect(sessions.map((s) => `${s.sessionId} ${s.title ?? ''}`)).toEqual([...want]);
      for (let i = 0; i < sessions.length; i++) {
        expect(sessions[i]!.cwd).toBe(h.dir);
        expect(sessions[i]!.updatedAt).toBeTruthy();
        if (i > 0) expect(Date.parse(sessions[i]!.updatedAt!)).toBeLessThanOrEqual(Date.parse(sessions[i - 1]!.updatedAt!));
      }
    });
  }

  test('requests the client does not serve are answered "method not found", never left waiting; vendor notifications, unknown updates and stray answers are passed over', async () => {
    const h = new Harness();
    const hi = h.rec('kimi', '03-prompt-hi');
    const sid = `"sessionId":"${SID}"`;
    // During a turn, after the prompt.
    const steps = h
      .rec('kimi', '01-initialize')
      .concat(h.rec('kimi', '02-session-new'), [hi[0]!])
      .concat([
        msgLine('in', `{"jsonrpc":"2.0","id":7,"method":"fs/write_text_file","params":{${sid},"path":"/etc/x","content":"y"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":"t-8","method":"terminal/create","params":{${sid},"command":"sh"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":"t-8","error":{"code":-32601,"message":"Method not found"}}`),
        msgLine('in', `{"jsonrpc":"2.0","method":"_x.ai/sessions/changed","params":{"upserted":[]}}`),
        msgLine('in', `{"jsonrpc":"2.0","method":"session/update","params":{${sid},"update":{"sessionUpdate":"brand_new_kind","x":1}}}`),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"another","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"not ours"}}}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{${sid},"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"an echo"}}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":9,"method":"_vendor/ask","params":{}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"Method not found"}}`),
        { dir: 'raw', msg: { jsonrpc: '2.0', id: 4242, result: {} } },
      ])
      .concat(hi.slice(1));
    const s = await h.start(h.params(steps));
    expect((await h.turn(s, promptOf(hi))).state).toBe(chat.TurnState.End);
    await h.close(s);
    expect(s.conn.vendor).toBe(1);
    const text = JSON.stringify(h.host.recs);
    for (const x of ['not ours', 'an echo', 'brand_new_kind']) expect(text).not.toContain(x);
    const log = h.log.lines.join('\n');
    expect(log).toContain('passed over update brand_new_kind');
    expect(log).toContain('passed over request fs/write_text_file');
    expect(log).toContain('an answer to a call this client did not make');
  });

  test("a prompt while a turn runs waits for the turn's end, then is sent as the next turn; one withdrawn before is not", async () => {
    const h = new Harness();
    const write = h.rec('kimi', '04-permission-write');
    const hi = h.rec('kimi', '03-prompt-hi');
    const s = await h.start(h.params(h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'), write, hi)));
    const errs: Array<chat.ChatError | null> = [];
    const tryIt = async (p: Promise<unknown>) => {
      try {
        await p;
        errs.push(null);
      } catch (e) {
        errs.push((e as ChatProtoError).error);
      }
    };
    let asked: Promise<void> | undefined;
    h.host.asked = () => {
      asked = (async () => {
        await tryIt(s.prompt(prompt(s, promptOf(hi), 'q1', 'c1')));
        await tryIt(s.prompt(prompt(s, [{ type: 'text', text: 'never mind' }], 'q2', 'c2')));
        await tryIt(s.cancelQueued('q2'));
        await tryIt(s.cancelQueued('q2'));
      })();
    };
    await h.turn(s, promptOf(write));
    const taken = await h.host.await(
      'the queued message taken',
      (ev) => ev.t === chat.EventType.Queued && ev.state === chat.QueuedState.Taken,
    );
    expect([taken.message, taken.clientId]).toEqual(['q1', 'c1']);
    await h.host.await("the queued message's turn", turnState(chat.TurnState.Start));
    await h.host.await("the queued message's turn's end", turnOver);
    await asked;
    await h.close(s);
    expect(errs.slice(0, 3)).toEqual([null, null, null]);
    expect(errs[3]?.code).toBe(chat.Code.NotFound);
    h.golden('kimi-queue');
  });

  test('cancel during a permission: the agent is told, the permission is answered cancelled, the queued message is withdrawn', async () => {
    const h = new Harness();
    const run = h.rec('kimi', '05-execute-permission');
    const upTo: Step[] = [];
    for (const st of run) {
      upTo.push(st);
      if (st.msg?.method === 'session/request_permission') break;
    }
    const steps = h
      .rec('kimi', '01-initialize')
      .concat(h.rec('kimi', '02-session-new'), upTo)
      .concat([
        msgLine('out', `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"${SID}"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"cancelled"}}}`),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${SID}","update":{"sessionUpdate":"tool_call_update","toolCallId":"2:tool_fake0002","status":"failed"}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":5,"result":{"stopReason":"cancelled"}}`),
      ]);
    const s = await h.start(h.params(steps));
    await s.prompt(prompt(s, promptOf(run)));
    await h.host.permissionAfter(0);
    await s.prompt(prompt(s, promptOf(run), 'q1'));
    await s.cancel();
    expect((await h.host.await("the turn's end", turnOver)).stopReason).toBe('cancelled');
    await h.close(s);
    h.golden('kimi-cancel-permission');
  });

  test('an agent that exits during a turn: the turn ends with an error, the session with the exit and the end of its standard error', async () => {
    const h = new Harness();
    const hi = h.rec('kimi', '03-prompt-hi');
    const steps = h
      .rec('kimi', '01-initialize')
      .concat(h.rec('kimi', '02-session-new'), hi.slice(0, 5))
      .concat([{ dir: 'exit', code: 2, stderr: 'panic: boom\n' }]);
    const s = await h.start(h.params(steps));
    await h.turn(s, promptOf(hi));
    const e = await s.done;
    expect(e?.code).toBe(chat.Code.Ended);
    expect(e?.message).toContain('exit status 2');
    expect(e?.stderr).toBe('panic: boom\n');
    expect((await rejects(s.prompt(prompt(s, promptOf(hi))))).code).toBe(chat.Code.Ended);
    h.golden('kimi-exit');
  });

  const init = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"x","version":"1"}}}`;
  const initOK = `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}`;
  for (const tt of [
    {
      name: 'auth',
      steps: (d: string) => [
        msgLine('out', init),
        msgLine('in', initOK),
        msgLine('out', `{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"${d}","mcpServers":[]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}`),
      ],
      resume: '',
      code: chat.Code.AuthRequired,
    },
    {
      name: 'version',
      steps: () => [msgLine('out', init), msgLine('in', `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}`)],
      resume: '',
      code: chat.Code.Protocol,
    },
    {
      name: 'exit',
      steps: () => [msgLine('out', init), { dir: 'exit', code: 1, stderr: 'no configuration\n' }],
      resume: '',
      code: chat.Code.StartFailed,
      stderr: 'no configuration\n',
    },
    { name: 'no resume', steps: () => [msgLine('out', init), msgLine('in', initOK)], resume: 's1', code: chat.Code.Unsupported },
    {
      // The protocol's "not there" for a session to take up.
      name: 'unknown session',
      steps: (d: string) => [
        msgLine('out', init),
        msgLine('in', `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"s1","cwd":"${d}","mcpServers":[]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found","data":{"uri":"s1"}}}`),
      ],
      resume: 's1',
      code: chat.Code.NotFound,
    },
  ] as Array<{ name: string; steps: (d: string) => Step[]; resume: string; code: string; stderr?: string }>) {
    test(`an agent that does not get to a session: ${tt.name}`, async () => {
      const h = new Harness();
      const p = h.params(tt.steps(h.dir));
      p.resume = tt.resume;
      const e = await rejects(h.a.start(p, h.host, AbortSignal.timeout(PATIENCE)));
      expect([e.code, e.stderr]).toEqual([tt.code, tt.stderr]);
      if (tt.name === 'exit') expect(e.message).toContain('the agent exited before its session existed');
    });
  }

  test('a start that takes too long, or is called off', async () => {
    const h = new Harness();
    const slow = [msgLine('out', init)];
    const e = await rejects(h.a.start(h.params(slow), h.host, AbortSignal.timeout(200)));
    expect([e.code, e.message]).toEqual([chat.Code.StartFailed, 'the agent did not start in time']);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect((await rejects(h.a.start(h.params(slow), h.host, ac.signal))).code).toBe(chat.Code.Ended);
  });

  test('a command that is no absolute path is refused', async () => {
    const h = new Harness();
    const p = h.params([]);
    p.argv = ['kimi', 'acp'];
    expect((await rejects(h.a.start(p, h.host, never()))).code).toBe(chat.Code.BadRequest);
  });

  test("what a chat starts with: the mode of the host's settings, the agent's value of it; a model the agent does not offer is left", async () => {
    const h = new Harness();
    const six = from(h.rec('kimi', '06-set-mode-and-config-option'), 'session/set_config_option');
    const p = h.params(h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'), six.slice(0, 4))); // mode plan
    p.options = { model: 'no-such-model', mode: chat.Mode.Plan, effort: 'max' };
    const s = await h.start(p);
    await h.close(s);
    expect(optionOf(h.host.chat.config ?? [], chat.Category.Mode)?.currentValue).toBe('plan');
    expect(optionOf(h.host.chat.config ?? [], chat.Category.Model)?.currentValue).toBe('kimi-code/k3.1-pro');
    expect(h.log.lines.join('\n')).toContain('no model "no-such-model" to start with');
  });

  test("an agent's session modes without a configuration option of category mode: an option of the chat's own, set by session/set_mode", async () => {
    const h = new Harness();
    const steps = h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'));
    edit(steps, (m) => {
      const res = m.result as Record<string, unknown[]> | undefined;
      if (!res?.configOptions) return false;
      res.configOptions = res.configOptions.slice(0, 2); // model and thinking
      return true;
    });
    const sid = `"sessionId":"${SID}"`;
    steps.push(
      msgLine('out', `{"jsonrpc":"2.0","id":3,"method":"session/set_mode","params":{${sid},"modeId":"plan"}}`),
      msgLine(
        'in',
        `{"jsonrpc":"2.0","method":"session/update","params":{${sid},"update":{"sessionUpdate":"current_mode_update","currentModeId":"yolo"}}}`,
      ),
      msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{}}`),
    );
    const s = await h.start(h.params(steps));
    const o = optionByID(h.host.chat.config ?? [], 'mode');
    expect([o?.category, o?.currentValue, o?.options?.length]).toEqual([chat.Category.Mode, 'default', 4]);
    expect((await rejects(s.setConfig('mode', 'nope', never()))).code).toBe(chat.Code.BadRequest);
    expect((await rejects(s.setConfig('nope', 'plan', never()))).code).toBe(chat.Code.BadRequest);
    await s.setConfig('mode', 'plan', never());
    await h.close(s);
    // The agent's notification came before its answer; the answer sets what
    // was asked.
    expect(optionByID(h.host.chat.config ?? [], 'mode')?.currentValue).toBe('plan');
  });

  test('content the agent does not take is refused before it is sent', async () => {
    const h = new Harness();
    const steps = h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'));
    edit(steps, (m) => {
      const res = m.result as Record<string, Record<string, unknown>> | undefined;
      if (!res?.agentCapabilities) return false;
      res.agentCapabilities.promptCapabilities = {};
      return true;
    });
    const s = await h.start(h.params(steps));
    for (const [content, code] of [
      [{ type: 'image', mimeType: 'image/png', data: 'AA==' }, chat.Code.Unsupported],
      [{ type: 'resource', resource: { uri: 'file:///x', text: '' } }, chat.Code.Unsupported],
      [{ type: 'video' }, chat.Code.BadRequest],
      ['text', chat.Code.BadRequest],
    ] as const) {
      expect([content, (await rejects(s.prompt(prompt(s, [content])))).code]).toEqual([content, code]);
    }
    expect((await rejects(s.prompt(prompt(s, [])))).code).toBe(chat.Code.BadRequest);
    expect((await rejects(s.compact())).code).toBe(chat.Code.Unsupported);
    expect(h.host.chat.capabilities.images).toBe(false);
    await h.close(s);
  });

  test('close closes the input of an agent that ends with it', async () => {
    const h = new Harness();
    const s = await h.start(h.params(h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'))));
    const began = Date.now();
    await h.close(s);
    expect(Date.now() - began).toBeLessThan(1000);
    expect(s.proc.status()).toBe('exit status 0');
  });

  test('close: an agent that stays gets SIGTERM, then SIGKILL; what it started in its group goes with it', async () => {
    const h = new Harness({ grace: 100, term: 200 });
    const pidfile = join(tempDir(), 'pid');
    const steps = h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'), [{ dir: 'child' }, { dir: 'stubborn' }]);
    const s = await h.start(h.params(steps, { ACP_FAKE_PIDFILE: pidfile }));
    let child = 0;
    for (let i = 0; i < 500 && !child; i++) {
      if (existsSync(pidfile)) child = Number(readFileSync(pidfile, 'utf8')) || 0;
      if (!child) await Bun.sleep(10);
    }
    expect(child).toBeGreaterThan(0);
    await h.close(s);
    expect(s.proc.status()).toBe('signal: SIGKILL');
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 500 && alive(); i++) await Bun.sleep(10);
    expect(alive()).toBe(false);
  });

  test("the host's view of the turn is a moment behind: a prompt it did not record that finds the turn ended starts the next one after its user event; a recorded one is not told again", async () => {
    const h = new Harness();
    const hi = h.rec('kimi', '03-prompt-hi');
    const s = await h.start(h.params(h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'), hi, hi)));
    const send = (clientId: string, recorded: boolean) => s.prompt({ content: promptOf(hi), message: 'm-' + clientId, clientId, recorded });
    await send('c1', true);
    await h.host.await("the first turn's end", turnOver);
    // The turn ends between the host's look and the prompt.
    await send('c2', false);
    const first = await h.host.await("the prompt's user event", (ev) => ev.t === chat.EventType.User || ev.t === chat.EventType.Turn);
    expect([first.t, first.clientId, first.content?.length]).toEqual([chat.EventType.User, 'c2', promptOf(hi).length]);
    await h.host.await("the second turn's start", turnState(chat.TurnState.Start));
    await h.host.await("the second turn's end", turnOver);
    await h.close(s);
    expect(h.host.events.filter((ev) => ev.t === chat.EventType.User).length).toBe(1);
  });

  test("the host has a tool call's stored event before the permission asked for it", async () => {
    const h = new Harness();
    const write = h.rec('kimi', '04-permission-write');
    const s = await h.start(h.params(h.rec('kimi', '01-initialize').concat(h.rec('kimi', '02-session-new'), write)));
    let before = 0;
    h.host.asked = (r) => {
      const id = (r.toolCall as { toolCallId: string }).toolCallId;
      before = h.host.events.filter((ev) => ev.item === id && !ev.live).length;
    };
    await h.turn(s, promptOf(write));
    expect(before).toBeGreaterThan(0);
    await h.close(s);
  });
});

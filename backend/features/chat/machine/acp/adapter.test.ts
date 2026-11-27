// The ACP adapter against a fake agent that replays the recordings of
// spec/vectors/chat/acp (testdata/fakeagent.ts), its records compared with
// the golden files of the same scenarios (testdata/golden).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  golden,
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
    const want = golden(name);
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
      compact: true,
      queue: true,
      plan: false,
      questions: false,
      effort: true,
      model: true,
      cancelQueued: true,
      steer: false,
      stopTask: false,
      fork: false,
      rewind: false,
      rewindFiles: false,
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

  test('Antigravity (agy) ACP: config options, dynamic thought_level, auto marked full, 1M context, /compact, and session/close', async () => {
    const h = new Harness();
    const steps = h.rec('agy', '01-initialize').concat(h.rec('agy', '02-session-new'), h.rec('agy', '03-prompt-and-config'));
    const p = h.params(steps);
    p.kind = 'agy';
    const s = await h.start(p);
    expect(s.id).toBe('00000000-0000-4000-8000-0000000000a1');
    // agy emits available_commands_update and usage_update right after session/new returns.
    for (let i = 0; i < 200 && (!h.host.chat.capabilities.compact || h.host.chat.usage?.size !== 1048576); i++) {
      await Bun.sleep(5);
    }
    const c = h.host.chat;
    expect(c.agentVersion).toBe('1.5.18');
    expect(c.capabilities).toEqual({
      images: true,
      compact: true,
      queue: true,
      plan: false,
      questions: false,
      effort: true,
      model: true,
      cancelQueued: true,
      steer: false,
      stopTask: false,
      fork: false,
      rewind: false,
      rewindFiles: false,
    });
    const modeOpt = optionOf(c.config ?? [], chat.Category.Mode)!;
    expect(modeOpt.options?.find((o) => o.value === 'auto')?.full).toBe(true);
    for (const safe of ['default', 'accept-edits', 'plan']) {
      expect(modeOpt.options?.find((o) => o.value === safe)?.full).toBeUndefined();
    }
    expect([c.usage?.used, c.usage?.size]).toEqual([0, 1048576]);

    // Turn 1: prompt + thought + reply + usage update.
    expect((await h.turn(s, [{ type: 'text', text: 'Reply with hi' }])).stopReason).toBe('end_turn');
    expect([h.host.chat.usage?.used, h.host.chat.usage?.size]).toEqual([12400, 1048576]);

    // Switching model dynamically updates thought_level options.
    await s.setConfig('model', 'claude-opus-5-5', never());
    expect(optionOf(h.host.chat.config ?? [], chat.Category.Model)?.currentValue).toBe('claude-opus-5-5');
    expect(optionOf(h.host.chat.config ?? [], chat.Category.ThoughtLevel)?.options?.map((o) => o.value)).toEqual(['low', 'medium', 'high']);

    // Manual /compact with custom instructions emits Notice.Command, Compacting, Compacted and runs a turn.
    await s.compact(never(), 'keep decisions');
    expect((await h.host.await("compact turn's end", turnOver)).stopReason).toBe('end_turn');
    expect(h.host.events.some((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Command))).toBe(true);
    expect(h.host.events.some((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Compacting))).toBe(true);
    expect(h.host.events.some((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Compacted))).toBe(true);
    expect(h.host.chat.usage?.used).toBe(4200);
    expect(h.host.chat.usage?.stale).toBeUndefined();

    // Graceful close calls session/close (checked strictly by fakeagent script).
    await h.close(s);
  });

  test('ACP /compact resets usage to 0 (stale) when agent omits post-compact usage or reports a summarization spike, and preserves size', async () => {
    const h = new Harness();
    const sid = '00000000-0000-4000-8000-0000000000a1';
    const steps = h
      .rec('agy', '01-initialize')
      .concat(h.rec('agy', '02-session-new'))
      .concat([
        // Turn 1: establishes 12400 / 1048576 usage.
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"hello"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"usage_update","used":12400,"size":1048576}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`),
        // Turn 2 (/compact): emits a summarization spike >= 12400 (must be ignored) and no smaller post-compact update.
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"/compact"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"usage_update","used":15000,"size":1048576}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}`),
        // Turn 3 (normal turn): reports fresh smaller usage omitting size -> preserves 1048576 and clears stale.
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":5,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"next"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"usage_update","used":3100}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":6,"method":"session/close","params":{"sessionId":"${sid}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":6,"result":{}}`),
      ]);
    const p = h.params(steps);
    p.kind = 'agy';
    const s = await h.start(p);
    for (let i = 0; i < 200 && (!h.host.chat.capabilities.compact || h.host.chat.usage?.size !== 1048576); i++) {
      await Bun.sleep(5);
    }

    await h.turn(s, [{ type: 'text', text: 'hello' }]);
    expect(h.host.chat.usage).toMatchObject({ used: 12400, size: 1048576 });

    await s.compact(never());
    expect((await h.host.await("compact turn's end", turnOver)).stopReason).toBe('end_turn');
    expect(h.host.chat.usage).toMatchObject({ used: 0, size: 1048576, stale: true });
    expect(h.host.events.some((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Compacting))).toBe(true);
    expect(h.host.events.some((ev) => ev.t === chat.EventType.Notice && ev.method === noticeMethod(Notice.Compacted))).toBe(true);

    // Next normal turn clears stale and preserves 1M window even when size is omitted.
    await h.turn(s, [{ type: 'text', text: 'next' }]);
    expect(h.host.chat.usage).toMatchObject({ used: 3100, size: 1048576 });
    expect(h.host.chat.usage?.stale).toBeUndefined();

    await h.close(s);
  });

  test('Antigravity (agy) session/list filters out sessions from other workspaces', async () => {
    const h = new Harness();
    const steps = h.rec('agy', '01-initialize').concat(h.rec('agy', '04-list'));
    const { sessions, next } = await h.a.sessions({ ...h.params(steps), kind: 'agy', cursor: '' }, never());
    expect(next).toBe('');
    expect(sessions.map((s) => `${s.sessionId} ${s.title}`)).toEqual([
      '00000000-0000-4000-8000-0000000000a1 Work session newer',
      '00000000-0000-4000-8000-0000000000a3 Work session older',
    ]);
  });

  test('Antigravity (agy) ACP invoke_subagent normalizes call, streams child transcript under parent, and clears tasks', async () => {
    const h = new Harness();
    const parentSid = '00000000-0000-4000-8000-0000000000a1';
    const childSid = '00000000-0000-4000-8000-0000000000b2';
    const agyDir = join(h.dir, '.gemini', 'antigravity-cli');
    const parentLog = join(agyDir, 'brain', parentSid, '.system_generated', 'logs', 'transcript.jsonl');
    const childLog = join(agyDir, 'brain', childSid, '.system_generated', 'logs', 'transcript.jsonl');
    const steps = h
      .rec('agy', '01-initialize')
      .concat(h.rec('agy', '02-session-new'))
      .concat([
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"${parentSid}","prompt":[{"type":"text","text":"run ls in subagent"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${parentSid}","update":{"sessionUpdate":"tool_call","toolCallId":"call_sub_1","name":"invoke_subagent","kind":"other","title":"Run invoke_subagent","status":"in_progress","rawInput":{"TypeName":"self","Role":"Shell Runner","Prompt":"Run ls"}}}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${parentSid}","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_sub_1","name":"invoke_subagent","kind":"other","title":"Run invoke_subagent","status":"completed","rawInput":{"TypeName":"self","Role":"Shell Runner","Prompt":"Run ls"}}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"${parentSid}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":4,"result":{}}`),
      ]);
    const p = h.params(steps);
    p.kind = 'agy';
    p.env = { ...p.env, HOME: h.dir };
    const s = await h.start(p);

    // Pre-create parent and child transcript files after session opens so onTurnEnd drains them cleanly.
    mkdirSync(join(agyDir, 'brain', parentSid, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(agyDir, 'brain', childSid, '.system_generated', 'logs'), { recursive: true });
    writeFileSync(
      parentLog,
      [
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          content: `Created the following subagent:\n{"conversationId":"${childSid}","logAbsoluteUri":"file://${childLog}"}`,
        }),
        JSON.stringify({
          step_index: 4,
          type: 'SYSTEM_MESSAGE',
          content: `[Message] sender=${childSid} content=README.md`,
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      childLog,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          thinking: 'Listing files.',
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"' } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          content: 'Command exited with code 0.\n\nCommand output:\nREADME.md\n',
        }),
      ].join('\n') + '\n',
    );

    expect((await h.turn(s, [{ type: 'text', text: 'run ls in subagent' }])).stopReason).toBe('end_turn');
    const nested = h.host.events.filter((ev) => ev.parent === 'call_sub_1');
    expect(nested.some((ev) => (ev.update as Record<string, unknown>).kind === 'execute')).toBe(true);
    expect(nested.some((ev) => (ev.update as Record<string, unknown>).sessionUpdate === 'agent_thought_chunk')).toBe(true);
    const parentDone = h.host.events.filter((ev) => !ev.parent && ev.item === 'call_sub_1').at(-1)!.update as Record<string, unknown>;
    expect(parentDone.kind).toBe('think');
    expect(parentDone.title).toBe('Shell Runner');
    expect(parentDone.status).toBe('completed');
    expect(h.host.chat.tasks).toBeUndefined();
    await h.close(s);
  });

  test('models() probes ACP models from configOptions and closes cleanly; enriches Grok efforts', async () => {
    const h = new Harness();
    const agySteps = h
      .rec('agy', '01-initialize')
      .concat(h.rec('agy', '02-session-new').slice(0, 2))
      .concat([
        msgLine('out', `{"jsonrpc":"2.0","id":3,"method":"session/close","params":{"sessionId":"00000000-0000-4000-8000-0000000000a1"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{}}`),
      ]);
    const agyModels = await h.a.models!({ ...h.params(agySteps), kind: 'agy' }, never());
    expect(agyModels).toEqual([
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon', images: true },
      { value: 'claude-opus-5-5', name: 'Claude Opus 5.5', images: true },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', images: true },
    ]);

    const h2 = new Harness();
    const grokSteps = h2.rec('grok', '01-initialize').concat(h2.rec('grok', '02-session-new-yolo-off'));
    // Strip _meta from session/new expectation since models() sends empty mcpServers without newSessionMeta.
    edit(grokSteps, (m) => {
      if (m.method !== 'session/new') return false;
      delete (m.params as Record<string, unknown>)._meta;
      return true;
    });
    const grokModels = await h2.a.models!({ ...h2.params(grokSteps), kind: 'grok' }, never());
    expect(grokModels.length).toBeGreaterThan(0);
    expect(grokModels[0]?.images).toBe(true);
  });

  test('session/resume -32603 hinting session/load falls back to session/load; missing session maps to not_found', async () => {
    const h = new Harness();
    const sid = '00000000-0000-4000-8000-0000000000a9';
    const fallbackSteps = h
      .rec('agy', '01-initialize')
      .concat([
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":2,"method":"session/resume","params":{"sessionId":"${sid}","cwd":"${h.dir}","mcpServers":[]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Failed to read session ${sid}; retry, or load it with session/load"}}`,
        ),
        msgLine('out', `{"jsonrpc":"2.0","id":3,"method":"session/load","params":{"sessionId":"${sid}","cwd":"${h.dir}","mcpServers":[]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{}}`),
      ]);
    const p = h.params(fallbackSteps);
    p.resume = sid;
    const s = await h.start(p);
    expect(s.id).toBe(sid);
    await h.close(s);

    const h2 = new Harness();
    const missingSteps = h2
      .rec('agy', '01-initialize')
      .concat([
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":2,"method":"session/resume","params":{"sessionId":"${sid}","cwd":"${h2.dir}","mcpServers":[]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Failed to read session ${sid}; retry, or load it with session/load"}}`,
        ),
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/load","params":{"sessionId":"${sid}","cwd":"${h2.dir}","mcpServers":[]}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Failed to read session ${sid}"}}`),
      ]);
    const p2 = h2.params(missingSteps);
    p2.resume = sid;
    expect((await rejects(h2.a.start(p2, h2.host, AbortSignal.timeout(PATIENCE)))).code).toBe(chat.Code.NotFound);
  });

  test('fork() calls session/fork when advertised and rejects unsupported otherwise', async () => {
    const h = new Harness();
    const forkedId = 'session_00000000-0000-4000-8000-000000000099';
    const forkSteps = h
      .rec('kimi', '01-initialize')
      .concat([
        msgLine('out', `{"jsonrpc":"2.0","id":2,"method":"session/fork","params":{"sessionId":"${SID}","cwd":"${h.dir}","mcpServers":[]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"${forkedId}"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":3,"method":"session/close","params":{"sessionId":"${forkedId}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{}}`),
      ]);
    expect(await h.a.fork!({ ...h.params(forkSteps), sessionId: SID }, never())).toEqual({ sessionId: forkedId });

    const h2 = new Harness();
    const noFork = h2.rec('agy', '01-initialize');
    expect((await rejects(h2.a.fork!({ ...h2.params(noFork), sessionId: SID }, never()))).code).toBe(chat.Code.Unsupported);

    // Partial forks must throw Unsupported without spawning an agent so the
    // host falls back to a consistent context-seeded fork.
    const h3 = new Harness();
    const base = { ...h3.params([]), sessionId: SID };
    for (const partial of [{ partial: true }, { upToMessageId: 'u1' }, { beforeTurnId: 't2' }, { lastTurnId: 't1' }]) {
      expect((await rejects(h3.a.fork!({ ...base, ...partial }, never()))).code).toBe(chat.Code.Unsupported);
    }
  });

  test('delivery interrupt cancels only the active turn and preserves unrelated queued messages; steer is unsupported', async () => {
    const h = new Harness();
    const run = h.rec('kimi', '05-execute-permission');
    const upTo: Step[] = [];
    for (const st of run) {
      upTo.push(st);
      if (st.msg?.method === 'session/request_permission') break;
    }
    const sid = `"sessionId":"${SID}"`;
    const steps = h
      .rec('kimi', '01-initialize')
      .concat(h.rec('kimi', '02-session-new'), upTo)
      .concat([
        msgLine('out', `{"jsonrpc":"2.0","method":"session/cancel","params":{${sid}}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"cancelled"}}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":5,"result":{"stopReason":"cancelled"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":6,"method":"session/prompt","params":{${sid},"prompt":[{"type":"text","text":"urgent"}]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}`),
        msgLine('out', `{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{${sid},"prompt":[{"type":"text","text":"later"}]}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}`),
      ]);
    const s = await h.start(h.params(steps));
    await s.prompt(prompt(s, promptOf(run)));
    await h.host.permissionAfter(0);
    await s.prompt(prompt(s, [{ type: 'text', text: 'later' }], 'q1', 'c1'));
    expect(
      (await rejects(s.prompt({ ...prompt(s, [{ type: 'text', text: 'nope' }], 'q-steer'), delivery: chat.Delivery.Steer }))).code,
    ).toBe(chat.Code.Unsupported);
    expect((await rejects(s.steerQueued('q1', 'steer', never()))).code).toBe(chat.Code.Unsupported);
    await s.prompt({ ...prompt(s, [{ type: 'text', text: 'urgent' }], 'q-int', 'c-int'), delivery: chat.Delivery.Interrupt });
    expect((await h.host.await('cancelled active turn', turnOver)).stopReason).toBe('cancelled');
    const taken1 = await h.host.await(
      'interrupt prompt taken first',
      (ev) => ev.t === chat.EventType.Queued && ev.state === chat.QueuedState.Taken,
    );
    expect(taken1.message).toBe('q-int');
    expect((await h.host.await('interrupt turn end', turnOver)).stopReason).toBe('end_turn');
    const taken2 = await h.host.await(
      'unrelated queued prompt preserved',
      (ev) => ev.t === chat.EventType.Queued && ev.state === chat.QueuedState.Taken,
    );
    expect(taken2.message).toBe('q1');
    expect((await h.host.await('queued turn end', turnOver)).stopReason).toBe('end_turn');
    await h.close(s);
  });

  test('an ACP agent without native modes (Grok) gets client-enforced permission modes via allow_once', async () => {
    const h = new Harness();
    const write = h.rec('grok', '04-permission-write');
    const exec = h.rec('grok', '05c-execute-permission');
    const steps = h.rec('grok', '01-initialize').concat(h.rec('grok', '02-session-new-yolo-off'), write, exec);
    const p = h.params(steps);
    p.newSessionMeta = { yoloMode: false };
    p.options = { mode: chat.Mode.AcceptEdits };
    // Only the execute turn should reach the host; file write is auto-approved.
    h.host.answers = ['allow-once'];
    const s = await h.start(p);

    const modeOpt = optionOf(h.host.chat.config ?? [], chat.Category.Mode)!;
    expect(modeOpt.id).toBe('mode');
    expect(modeOpt.currentValue).toBe(chat.Mode.AcceptEdits);
    expect(modeOpt.options).toEqual([
      { value: chat.Mode.Default, name: 'Default' },
      { value: chat.Mode.AcceptEdits, name: 'Accept Edits' },
      { value: chat.Mode.Full, name: 'Full Access', full: true },
    ]);
    expect((await rejects(s.setConfig('mode', 'bogus', never()))).code).toBe(chat.Code.BadRequest);

    expect((await h.turn(s, promptOf(write))).stopReason).toBe('end_turn');
    expect(h.host.perms).toHaveLength(0);
    expect((await h.turn(s, promptOf(exec))).stopReason).toBe('end_turn');
    expect(h.host.perms).toHaveLength(1);
    expect(h.host.perms[0]?.kind).toBe(chat.PermissionKind.Command);
    await h.close(s);

    // Switching to full access locally auto-approves both writes and commands without any RPC.
    const h2 = new Harness();
    const write2 = h2.rec('grok', '04-permission-write');
    const exec2 = h2.rec('grok', '05c-execute-permission');
    const steps2 = h2.rec('grok', '01-initialize').concat(h2.rec('grok', '02-session-new-yolo-off'), write2, exec2);
    const p2 = h2.params(steps2);
    p2.newSessionMeta = { yoloMode: false };
    h2.host.answers = [];
    const s2 = await h2.start(p2);
    expect(optionOf(h2.host.chat.config ?? [], chat.Category.Mode)?.currentValue).toBe(chat.Mode.Default);
    await s2.setConfig('mode', chat.Mode.Full, never());
    expect(optionOf(h2.host.chat.config ?? [], chat.Category.Mode)?.currentValue).toBe(chat.Mode.Full);
    expect((await h2.turn(s2, promptOf(write2))).stopReason).toBe('end_turn');
    expect((await h2.turn(s2, promptOf(exec2))).stopReason).toBe('end_turn');
    expect(h2.host.perms).toHaveLength(0);
    await h2.close(s2);

    // Starting directly in Mode.Full initializes clientMode before takeConfig (no default flash)
    // and auto-approves Grok tool permissions whose kind comes from _meta["x.ai/tool"].kind = "write".
    const h3 = new Harness();
    const sid = '00000000-0000-4000-8000-000000000001';
    const steps3 = h3
      .rec('grok', '01-initialize')
      .concat(h3.rec('grok', '02-session-new-yolo-off'))
      .concat([
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"write file"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","id":10,"method":"session/request_permission","params":{"sessionId":"${sid}","toolCall":{"toolCallId":"tc-w","title":"write","_meta":{"x.ai/tool":{"kind":"write"}}},"options":[{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"reject-once","name":"No","kind":"reject_once"}]}}`,
        ),
        msgLine('out', '{"jsonrpc":"2.0","id":10,"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}'),
        msgLine('in', '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'),
        msgLine('out', `{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"${sid}"}}`),
        msgLine('in', '{"jsonrpc":"2.0","id":4,"result":{}}'),
      ]);
    const p3 = h3.params(steps3);
    p3.newSessionMeta = { yoloMode: false };
    p3.options = { mode: chat.Mode.AcceptEdits };
    h3.host.answers = [];
    const seenModes: string[] = [];
    const origUpdate = h3.host.update.bind(h3.host);
    h3.host.update = (fn) => {
      origUpdate(fn);
      const mv = optionOf(h3.host.chat.config ?? [], chat.Category.Mode)?.currentValue;
      if (mv) seenModes.push(mv);
    };
    const s3 = await h3.start(p3);
    expect(seenModes).toEqual([chat.Mode.AcceptEdits]);
    expect((await h3.turn(s3, [{ type: 'text', text: 'write file' }])).stopReason).toBe('end_turn');
    expect(h3.host.perms).toHaveLength(0);
    await h3.close(s3);
  });

  test('Antigravity (agy) maps host Mode.Full to ACP mode "auto" on start when allowFull is enabled', async () => {
    const h = new Harness();
    const sid = '00000000-0000-4000-8000-0000000000a1';
    const autoCfg =
      '[{"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"auto","options":[{"value":"default","name":"Review"},{"value":"accept-edits","name":"Accept Edits"},{"value":"auto","name":"Auto"},{"value":"plan","name":"Plan"}]}]';
    const steps = h
      .rec('agy', '01-initialize')
      .concat(h.rec('agy', '02-session-new'))
      .concat([
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"configId":"mode","sessionId":"${sid}","value":"auto"}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{"configOptions":${autoCfg}}}`),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"current_mode_update","currentModeId":"auto"}}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"config_option_update","configOptions":${autoCfg}}}}`,
        ),
        msgLine('out', `{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"${sid}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":4,"result":{}}`),
      ]);
    const p = h.params(steps);
    p.kind = 'agy';
    p.options = { mode: chat.Mode.Full };
    p.settings = { ...p.settings, allowFull: true };
    const s = await h.start(p);
    const mode = optionOf(h.host.chat.config ?? [], chat.Category.Mode);
    expect(mode?.currentValue).toBe('auto');
    expect(mode?.options?.find((v) => v.value === 'auto')?.full).toBe(true);
    expect(mode?.options?.find((v) => v.value === 'accept-edits')?.full).toBeUndefined();
    await h.close(s);
  });

  test('prompt handoffContext goes on wire only (clean User/Queued), queued /compact invalidates usage, and models() updates live sessions', async () => {
    const h = new Harness();
    const sid = '00000000-0000-4000-8000-0000000000a1';
    const steps = h
      .rec('agy', '01-initialize')
      .concat(h.rec('agy', '02-session-new'))
      .concat([
        // Turn 1: wire prompt carries handoffContext before user text.
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"<handoff_context>\\nprior context\\n</handoff_context>"},{"type":"text","text":"continue work"}]}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sid}","update":{"sessionUpdate":"usage_update","used":9000,"size":1048576}}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`),
        // Turn 2: queued /compact triggered after Turn 1 finishes while queued.
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"${sid}","prompt":[{"type":"text","text":"/compact"}]}}`,
        ),
        msgLine('in', `{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}`),
        // setConfig for a model discovered by adapter.models() refresh!
        msgLine(
          'out',
          `{"jsonrpc":"2.0","id":5,"method":"session/set_config_option","params":{"configId":"model","sessionId":"${sid}","value":"gemini-5-preview"}}`,
        ),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","id":5,"result":{"configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gemini-5-preview","options":[{"value":"gemini-5-preview","name":"Gemini 5 Preview"}]}]}}`,
        ),
        msgLine('out', `{"jsonrpc":"2.0","id":6,"method":"session/close","params":{"sessionId":"${sid}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":6,"result":{}}`),
      ]);
    const p = h.params(steps);
    p.kind = 'agy';
    const s = await h.start(p);

    // Send prompt with handoffContext (recorded: false so adapter emits EventType.User) AND queue /compact behind it.
    await s.prompt({
      content: [{ type: 'text', text: 'continue work' }],
      handoffContext: '<handoff_context>\nprior context\n</handoff_context>',
      message: 'm1',
      clientId: 'c1',
      recorded: false,
    });
    await s.prompt({
      content: [{ type: 'text', text: '/compact' }],
      message: 'm2',
      clientId: 'c2',
      recorded: false,
    });
    expect((await h.host.await('turn 1 end', turnOver)).stopReason).toBe('end_turn');
    expect((await h.host.await('queued /compact end', turnOver)).stopReason).toBe('end_turn');

    // Stored User event MUST NOT contain handoffContext.
    const userEv = h.host.events.find((e) => e.t === chat.EventType.User);
    expect(userEv?.content).toEqual([{ type: 'text', text: 'continue work' }]);
    // Queued /compact emitted Notice.Compacting and marked usage stale.
    expect(h.host.events.some((e) => e.t === chat.EventType.Notice && e.method === noticeMethod(Notice.Compacting))).toBe(true);
    expect(h.host.chat.usage).toMatchObject({ used: 0, size: 1048576, stale: true });

    // Before models() refresh, setting an unknown model fails with BadRequest.
    expect((await rejects(s.setConfig('model', 'gemini-5-preview', never()))).code).toBe(chat.Code.BadRequest);

    // Probe models() returning gemini-5-preview: propagates to live Agy session automatically!
    const probeSteps = h
      .rec('agy', '01-initialize')
      .concat([
        msgLine('out', `{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"${h.dir}","mcpServers":[]}}`),
        msgLine(
          'in',
          `{"jsonrpc":"2.0","id":2,"result":{"sessionId":"${sid}","configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"gemini-5-preview","options":[{"value":"gemini-5-preview","name":"Gemini 5 Preview"}]}]}}`,
        ),
        msgLine('out', `{"jsonrpc":"2.0","id":3,"method":"session/close","params":{"sessionId":"${sid}"}}`),
        msgLine('in', `{"jsonrpc":"2.0","id":3,"result":{}}`),
      ]);
    const refreshed = await h.a.models!({ ...h.params(probeSteps), kind: 'agy' }, never());
    expect(refreshed.map((m) => m.value)).toEqual(['gemini-5-preview']);

    // Live session now accepts gemini-5-preview via setConfig!
    await s.setConfig('model', 'gemini-5-preview', never());
    expect(optionOf(h.host.chat.config ?? [], chat.Category.Model)?.currentValue).toBe('gemini-5-preview');
    await h.close(s);
  });
});

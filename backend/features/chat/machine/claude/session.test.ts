// The Claude Code session against the fake program (testdata/fakeclaude.ts)
// playing scripts made here: the program's end, what is passed over, the
// timeouts, the start's options and refusals, full access by a restart,
// the end of the program and its group, its requests, prompts the host
// recorded or not, trust, and sessions another Claude Code runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { extended } from '#shared/testdata/extended.ts';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeEscape } from '#machine/agents/sessions.ts';
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ChatProtoError, Code, EventType, TurnState } from '#shared/proto/chatproto/index.ts';
import type { StartParams } from '../adapter.ts';
import { claudeAdapter } from './adapter.ts';
import { OPTION_EFFORT, OPTION_MODE, OPTION_MODEL } from './config.ts';
import { SDK_VERSION } from './sdk.ts';
import { CLAUDE_TIMING, type ClaudeSession, type ClaudeTiming } from './session.ts';
import { FakeRun, TEST_SESSION, canned, devSdk, isolateHome, tempDir, type Msg, type Script, type ScriptLine } from './testing.ts';

isolateHome();

const inL = (msg: Msg): ScriptLine => ({ dir: 'in', msg });
const outL = (msg: Msg): ScriptLine => ({ dir: 'out', msg });

/** A start: the adapter's initialize and its answer. */
const initLines = (resp: unknown = canned().initialize): ScriptLine[] => [
  inL({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } }),
  outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_init', response: resp } }),
];
const userIn = (text: string) => inL({ type: 'user', uuid: 'u-' + text, message: { role: 'user', content: text } });
const stateOut = (state: string) => outL({ type: 'system', subtype: 'session_state_changed', state });
const textOut = (id: string, text: string) =>
  outL({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const resultOut = () =>
  outL({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', total_cost_usd: 0.5, terminal_reason: 'completed' });
const text = (t: string) => [{ type: 'text', text: t }];
const sig = (ms = 20_000) => AbortSignal.timeout(ms);

const runs: FakeRun[] = [];
const sessions: ClaudeSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close(sig(10_000));
  for (const r of runs.splice(0)) r.close();
});

/** A script with the canned answers. */
const script = (lines: ScriptLine[], o: Partial<Script> = {}): Script => {
  const cans = canned();
  delete cans.initialize;
  return { lines, canned: cans, ...o };
};

interface StartOpts {
  silent?: string[];
  full?: Script;
  timing?: Partial<ClaudeTiming>;
  edit?: (p: StartParams, r: FakeRun) => void;
}

/** Starts a session with the fake playing lines. */
async function start(lines: ScriptLine[], o: StartOpts = {}): Promise<{ r: FakeRun; s?: ClaudeSession; err?: ChatProtoError }> {
  const r = new FakeRun(script(lines, { silent: o.silent }), o.full);
  runs.push(r);
  const p = r.params();
  o.edit?.(p, r);
  try {
    const s = (await claudeAdapter({ sdk: devSdk, timing: { titles: [], ...o.timing } }).start(p, r.host, sig(30_000))) as ClaudeSession;
    sessions.push(s);
    return { r, s };
  } catch (e) {
    return { r, err: e as ChatProtoError };
  }
}

async function started(lines: ScriptLine[], o: StartOpts = {}): Promise<{ r: FakeRun; s: ClaudeSession }> {
  const { r, s, err } = await start(lines, o);
  if (!s) throw new Error(`start: ${err?.message}\n${r.log()}`);
  return { r, s };
}

const codeOf = (e: unknown): string => (e instanceof ChatProtoError ? e.code : `not a ChatProtoError: ${String(e)}`);

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('it did not fail');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gonePid(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, 'SIGKILL');
      throw new Error(`process ${pid} is still there`);
    }
    await Bun.sleep(10);
  }
}

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(what)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

const config = (r: FakeRun): Record<string, string> => Object.fromEntries((r.host.chat.config ?? []).map((c) => [c.id, c.currentValue]));

/** The fake's runs' pids and those of the processes they left. */
function pids(r: FakeRun): { runs: number[]; children: number[] } {
  const recs = r.records();
  return { runs: recs.filter((x) => x.pid).map((x) => Number(x.pid)), children: recs.filter((x) => x.child).map((x) => Number(x.child)) };
}

async function waitRuns(r: FakeRun, n: number): Promise<number[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { runs } = pids(r);
    if (runs.length >= n) return runs;
    if (Date.now() > deadline) throw new Error(`${runs.length} runs, not ${n}; the log:\n${r.log()}`);
    await Bun.sleep(5);
  }
}

describe('the program', () => {
  test('ending in a turn fails the turn and ends the session with the end of its standard error', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('go'),
      stateOut('running'),
      outL({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }),
      outL({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }),
      outL({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } } }),
      { dir: 'exit', code: 1, text: 'boom: the API went away\n' },
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('go'), message: '', clientId: 'c1', recorded: true }, sig());
    const err = await within(s.done, 20_000, 'the session did not end');
    expect(err?.code).toBe(Code.Ended);
    expect(err?.stderr).toContain('boom');
    expect(err?.message).toContain('exit status 1');
    const turns = r.eventsOf(EventType.Turn);
    expect(turns.map((t) => t.state)).toEqual([TurnState.Start, TurnState.Error]);
    expect(turns[1]!.error?.code).toBe(Code.Ended);
    expect(turns[1]!.error?.stderr).toContain('boom');
    const ups = r.eventsOf(EventType.Update);
    expect(ups).toHaveLength(1);
    expect(ups[0]!.live).toBe(true);
    expect(ups[0]!.item).toBe('msg_1/0');
    expect(codeOf(await rejects(s.prompt({ content: text('again'), message: '', clientId: '', recorded: true }, sig())))).toBe(Code.Ended);
    expect(s.pid).toBe(0);
  }, 30_000);

  test('lines longer than chatproto.MAX_LINE, frames and messages of kinds not known are passed over; the session goes on', async () => {
    const { r, s } = await started([
      ...initLines(),
      { dir: 'raw', text: 'not json' },
      { dir: 'raw', text: '[1,2]' },
      { dir: 'big', n: chat.MAX_LINE + 10 },
      outL({ type: 'keep_alive' }),
      outL({ type: 'novel_frame' }),
      outL({ type: 'system', subtype: 'novel_system' }),
      userIn('go'),
      stateOut('running'),
      textOut('msg_1', 'done'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 8);
    await s.prompt({ content: text('go'), message: '', clientId: '', recorded: true }, sig());
    await r.until(s, -1);
    // The long line, the frame and the system message (the SDK passes over
    // what is no JSON object, and keep_alive).
    expect(s.unknown).toBe(3);
    const turns = r.eventsOf(EventType.Turn);
    expect(turns.map((t) => [t.state, t.stopReason])).toEqual([
      [TurnState.Start, undefined],
      [TurnState.End, 'end_turn'],
    ]);
    const ups = r.eventsOf(EventType.Update);
    expect(ups.map((u) => [u.item, u.live])).toEqual([['msg_1/0', undefined]]);
    expect(s.pid).toBeGreaterThan(0);
  }, 30_000);

  extended(
    'a control request without an answer fails after its timeout; initialize without one fails the start',
    async () => {
      const { s } = await started(initLines(), { silent: ['set_model'], timing: { request: 300 } });
      const t0 = Date.now();
      expect(codeOf(await rejects(s.setConfig(OPTION_MODEL, 'haiku', sig())))).toBe(Code.Failed);
      expect(Date.now() - t0).toBeLessThan(5000);

      const { err } = await start([], { silent: ['initialize'], timing: { initialize: 300 } });
      expect(err?.code).toBe(Code.StartFailed);
      expect(err?.message).toContain('initialize');
    },
    30_000,
  );

  test('the start refuses what is no session it can run, before running anything, and a model initialize does not list', async () => {
    const edits: Record<string, (p: StartParams) => void> = {
      'relative program': (p) => (p.argv = ['claude']),
      'no program': (p) => (p.argv = []),
      'relative directory': (p) => (p.cwd = 'work'),
      'no session': (p) => (p.sessionId = ''),
      'bad session': (p) => (p.sessionId = '--resume'),
      'bad mode': (p) => (p.options.mode = 'yolo'),
      'bad model': (p) => (p.options.model = '--dangerously-skip-permissions'),
      'bad effort': (p) => (p.options.effort = 'ultra'),
    };
    for (const [name, edit] of Object.entries(edits)) {
      const { r, err } = await start([], { edit });
      expect(`${name}: ${err?.code}`).toBe(`${name}: ${Code.BadRequest}`);
      expect(r.log().trim()).toBe('');
    }
    const { err } = await start(initLines(), { edit: (p) => (p.options.model = 'claude-nonesuch-1') });
    expect(err?.code).toBe(Code.BadRequest);
  }, 30_000);

  test("the chat's options at the start: an alias pinned to its model, an effort; the configuration and capabilities", async () => {
    // The program started in acceptEdits says so.
    const init = { ...(canned().initialize as Msg), current_permission_mode: 'acceptEdits' };
    const { r, s } = await started(initLines(init), {
      edit: (p) => (p.options = { model: 'sonnet', effort: 'low', mode: chat.Mode.AcceptEdits }),
    });
    await r.until(s, -1);
    await Bun.sleep(50);
    const argv = r.argvs()[0]!;
    expect(argv).toContain('--model=sonnet');
    expect(argv).toContain('--permission-mode=acceptEdits');
    const wrote = r.wrote().map((w) => JSON.stringify(w.request ?? {}));
    expect(wrote).toContain(JSON.stringify({ subtype: 'set_model', model: 'claude-sonnet-5-5' }));
    expect(wrote).toContain(JSON.stringify({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }));
    expect(config(r)).toEqual({ [OPTION_MODE]: chat.Mode.AcceptEdits, [OPTION_MODEL]: 'sonnet', [OPTION_EFFORT]: 'low' });
    expect(r.host.chat.capabilities).toEqual({
      images: true,
      compact: true,
      queue: true,
      plan: true,
      questions: true,
      effort: true,
      model: true,
      cancelQueued: true,
    });
    expect(r.host.chat.sessionId).toBe(TEST_SESSION);
    expect(r.host.chat.agentVersion).toBe('2.1.330');
    expect(r.host.chat.commands?.length).toBeGreaterThan(0);
    expect(r.host.chat.usage?.size).toBe(1_000_000);
    // Options of the chat only.
    expect(codeOf(await rejects(s.setConfig(OPTION_EFFORT, 'ultra', sig())))).toBe(Code.BadRequest);
    expect(codeOf(await rejects(s.setConfig(OPTION_MODEL, 'claude-sonnet-5-5', sig())))).toBe(Code.BadRequest);
    expect(codeOf(await rejects(s.setConfig('temperature', '1', sig())))).toBe(Code.BadRequest);
    // A model without effort levels drops the effort to its default.
    await s.setConfig(OPTION_MODEL, 'claude-haiku-4-5-20251001', sig());
    expect(r.host.chat.config?.some((c) => c.id === OPTION_EFFORT)).toBe(false);
    expect(r.host.chat.capabilities.effort).toBe(false);
    expect(r.wrote().map((w) => JSON.stringify(w.request ?? {}))).toContain(
      JSON.stringify({ subtype: 'apply_flag_settings', settings: { effortLevel: null } }),
    );
  }, 30_000);

  // The SDK drops DEBUG only when DEBUG_CLAUDE_AGENT_SDK is not set, and
  // sets DEBUG=1 for the program when it is: the adapter hands it neither.
  test('the program runs without DEBUG, whatever the host has', async () => {
    const { r, s } = await started(initLines(), {
      edit: (p) => Object.assign(p.env, { DEBUG: '*', DEBUG_CLAUDE_AGENT_SDK: '1' }),
    });
    await r.until(s, -1);
    const env = r.records()[0]!.env as Record<string, string>;
    expect(env).not.toHaveProperty('DEBUG');
    expect(env).not.toHaveProperty('DEBUG_CLAUDE_AGENT_SDK');
    expect(env.KEEP_ME).toBe('1');
  }, 30_000);

  test("the host's own environment keeps what the SDK sets in it for the program", async () => {
    const before = process.env.CLAUDE_AGENT_SDK_VERSION;
    const { r, s } = await started(initLines());
    await r.until(s, -1);
    expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBe(before);
    expect((r.records()[0]!.env as Record<string, string>).CLAUDE_AGENT_SDK_VERSION).toBe(SDK_VERSION);
  }, 30_000);

  test('the mode option marks full access', async () => {
    const { r, s } = await started(initLines());
    await r.until(s, -1);
    let found = false;
    for (const o of r.host.chat.config ?? [])
      for (const v of o.options ?? []) {
        expect(`${o.id} ${v.value} ${!!v.full}`).toBe(`${o.id} ${v.value} ${o.id === OPTION_MODE && v.value === chat.Mode.Full}`);
        found ||= !!v.full;
      }
    expect(found).toBe(true);
  }, 30_000);
});

describe('full access', () => {
  for (const resumed of [false, true])
    test(`a ${resumed ? 'resumed' : 'new'} chat goes into it before its first turn, ${resumed ? 'resuming its session' : 'its session not resumed'}`, async () => {
      const { r, s } = await started(initLines(), {
        full: script(initLines(), { noConversation: !resumed }),
        edit: (p) => {
          if (resumed) p.resume = TEST_SESSION;
        },
      });
      await r.until(s, -1);
      await s.setConfig(OPTION_MODEL, 'sonnet', sig());
      await s.setConfig(OPTION_EFFORT, 'low', sig());
      const pid = s.pid;
      await s.setConfig(OPTION_MODE, chat.Mode.Full, sig());
      expect(s.id).toBe(TEST_SESSION);
      expect(s.pid).toBeGreaterThan(0);
      expect(s.pid).not.toBe(pid);
      const argvs = r.argvs();
      expect(argvs).toHaveLength(2);
      expect(argvs[1]).toContain((resumed ? '--resume=' : '--session-id=') + TEST_SESSION);
      expect(argvs[1]).not.toContain(resumed ? '--session-id=' : '--resume=');
      expect(config(r)).toEqual({ [OPTION_MODE]: chat.Mode.Full, [OPTION_MODEL]: 'sonnet', [OPTION_EFFORT]: 'low' });
    }, 30_000);

  test('starts the program again with its session resumed, permissions skippable; refused while a turn runs', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('go'),
      stateOut('running'),
      textOut('msg_1', 'ok'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    const pid = s.pid;
    await s.prompt({ content: text('go'), message: '', clientId: '', recorded: true }, sig());
    expect(codeOf(await rejects(s.setConfig(OPTION_MODE, chat.Mode.Full, sig())))).toBe(Code.Busy);
    await r.until(s, -1);
    await s.setConfig(OPTION_MODE, chat.Mode.Full, sig());
    expect(s.pid).toBeGreaterThan(0);
    expect(s.pid).not.toBe(pid);
    const argvs = r.argvs();
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).not.toContain('dangerously');
    expect(argvs[1]).toContain(`--resume=${TEST_SESSION}`);
    expect(argvs[1]).toContain('--permission-mode=bypassPermissions');
    expect(argvs[1]).toContain('--allow-dangerously-skip-permissions');
    const notices = r.eventsOf(EventType.Notice);
    expect(notices).toEqual([{ t: EventType.Notice, method: noticeMethod(Notice.Restarted), params: { mode: chat.Mode.Full } }]);
    expect(config(r)[OPTION_MODE]).toBe(chat.Mode.Full);
    for (const m of [chat.Mode.Default, chat.Mode.Full]) {
      await s.setConfig(OPTION_MODE, m, sig());
      expect(config(r)[OPTION_MODE]).toBe(m);
    }
    expect(r.argvs()).toHaveLength(2);
  }, 30_000);

  test('close while the restart waits for initialize calls the restart off', async () => {
    const { r, s } = await started(initLines(), { full: script([], { silent: ['initialize'] }) });
    await r.until(s, -1);
    const set = s.setConfig(OPTION_MODE, chat.Mode.Full, sig()).then(
      () => null,
      (e: unknown) => e,
    );
    const runs = await waitRuns(r, 2);
    await s.close(sig(5000));
    expect(await within(set, 5000, 'the restart did not end')).not.toBeNull();
    expect(await within(s.done, 1000, 'the session did not end')).toBeUndefined();
    await gonePid(runs[1]!);
  }, 30_000);

  test('close while the restarted program is set up ends it and the session', async () => {
    const { r, s } = await started(initLines(), { full: script(initLines(), { silent: ['get_context_usage'] }) });
    await r.until(s, -1);
    const set = s.setConfig(OPTION_MODE, chat.Mode.Full, sig()).then(
      () => null,
      (e: unknown) => e,
    );
    const runs = await waitRuns(r, 2);
    // The new program answered initialize; its get_context_usage waits.
    const deadline = Date.now() + 10_000;
    while (
      r
        .wrote()
        .slice(3)
        .every((w) => (w.request as Msg | undefined)?.subtype !== 'get_context_usage')
    ) {
      if (Date.now() > deadline) throw new Error(r.log());
      await Bun.sleep(5);
    }
    await s.close(sig(5000));
    expect(codeOf(await within(set, 5000, 'the restart did not end'))).toBe(Code.Ended);
    expect(await within(s.done, 1000, 'the session did not end')).toBeUndefined();
    expect(s.pid).toBe(0);
    await gonePid(runs[1]!);
  }, 30_000);
});

describe('the end', () => {
  test("a program that exits leaves a process in its group that ignores SIGTERM: the group is swept, the session ends with the program's error", async () => {
    const { r, s } = await started([...initLines(), { dir: 'spawn', text: 'stubborn' }, { dir: 'exit', code: 2, text: 'boom\n' }], {
      timing: { grace: 5000, term: 300 },
    });
    const t0 = Date.now();
    const err = await within(s.done, 5000, `the session did not end; the log:\n${r.log()}`);
    expect(Date.now() - t0).toBeLessThan(4000);
    const { children } = pids(r);
    expect(children).toHaveLength(1);
    await gonePid(children[0]!);
    expect(err?.code).toBe(Code.Ended);
    expect(err?.message).toContain('exit status 2');
    expect(err?.stderr).toContain('boom');
  }, 30_000);

  test('close ends a program whose group holds on: what it left goes once it exits, without the grace', async () => {
    const { r, s } = await started([...initLines(), { dir: 'spawn', text: 'stubborn' }], { timing: { grace: 5000, term: 300 } });
    await r.until(s, -1);
    const t0 = Date.now();
    await s.close(sig(10_000));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await s.done).toBeUndefined();
    const { children } = pids(r);
    expect(children).toHaveLength(1);
    await gonePid(children[0]!);
  }, 30_000);

  test('close closes the input, then the group gets SIGTERM after the grace', async () => {
    const usage = canned().get_context_usage;
    const { s } = await started(
      [
        ...initLines(),
        inL({ type: 'control_request', request_id: 'req_g', request: { subtype: 'get_context_usage', detail: 'summary' } }),
        outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_g', response: usage } }),
        { dir: 'sleep', n: 60_000 },
      ],
      { timing: { grace: 200, term: 200 } },
    );
    const t0 = Date.now();
    await s.close(sig(10_000));
    const d = Date.now() - t0;
    expect(d).toBeGreaterThanOrEqual(190);
    expect(d).toBeLessThan(5000);
    expect(await s.done).toBeUndefined();
  }, 30_000);

  extended(
    'a run whose program exited tells no process while its group is being ended',
    async () => {
      const { r, s } = await started([...initLines(), { dir: 'spawn', text: 'stubborn' }, userIn('go'), { dir: 'exit', code: 1 }], {
        timing: { grace: 5000, term: 2000 },
      });
      await r.until(s, 3);
      const pid = pids(r).runs[0]!;
      expect(s.pid).toBe(pid);
      await s.prompt({ content: text('go'), message: '', clientId: '', recorded: true }, sig());
      const deadline = Date.now() + 5000;
      while (s.pid !== 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(s.pid).toBe(0);
      let done = false;
      void s.done.then(() => (done = true));
      await Bun.sleep(50);
      expect(done).toBe(false);
      await within(s.done, 10_000, 'the session did not end');
    },
    30_000,
  );
});

describe('requests', () => {
  test("the program's requests the adapter does not serve are answered: an elicitation declined, others refused; a cancelled one ends its question", async () => {
    const { r, s } = await started([
      ...initLines(),
      outL({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'elicitation', mcp_server_name: 'x', message: 'token?' } }),
      inL({ type: 'control_response', response: { subtype: 'success', request_id: 'cli-1', response: { action: 'decline' } } }),
      outL({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'hook_callback', callback_id: 'h' } }),
      outL({ type: 'control_request', request_id: 'cli-4', request: { subtype: 'novel_request' } }),
      outL({
        type: 'control_request',
        request_id: 'cli-3',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_x', input: { command: 'rm -rf /' } },
      }),
      { dir: 'sleep', n: 200 },
      outL({ type: 'control_cancel_request', request_id: 'cli-3' }),
      { dir: 'sleep', n: 200 },
    ]);
    await r.until(s, -1);
    await Bun.sleep(200);
    await s.close(sig());
    const answers = r
      .wrote()
      .filter((w) => w.type === 'control_response')
      .map((w) => w.response as Msg);
    const byId = new Map(answers.map((a) => [String(a.request_id), a]));
    expect(byId.get('cli-2')?.subtype).toBe('error');
    expect(byId.get('cli-4')).toEqual({
      subtype: 'error',
      request_id: 'cli-4',
      error: 'Unsupported control request subtype: novel_request',
    });
    // The SDK answers the request the program cancelled, which it passes
    // over; the user was asked, and the question ended with the cancel.
    expect((byId.get('cli-3')?.response as Msg | undefined)?.behavior ?? 'deny').toBe('deny');
    expect(r.host.perms).toHaveLength(1);
    expect(r.host.perms[0]!.kind).toBe(chat.PermissionKind.Command);
  }, 30_000);

  test('a prompt the host did not record that finds the turn ended starts the next with its user event; one it recorded that finds a turn running is queued', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('one'),
      stateOut('running'),
      textOut('msg_1', 'first'),
      resultOut(),
      stateOut('idle'),
      userIn('two'),
      stateOut('running'),
      userIn('three'),
      textOut('msg_2', 'second'),
      resultOut(),
      stateOut('idle'),
    ]);
    const prompt = (t: string, recorded: boolean) => s.prompt({ content: text(t), message: 'm-' + t, clientId: 'c-' + t, recorded }, sig());
    await r.until(s, 2);
    await prompt('one', true);
    // The turn ends between the host's look and the prompt.
    await r.until(s, 7);
    await prompt('two', false);
    await r.until(s, 9);
    await prompt('three', true);
    await r.until(s, -1);
    const got = r.host.events.flatMap((ev) =>
      ev.t === EventType.User
        ? ['user:' + ev.clientId]
        : ev.t === EventType.Queued
          ? [`queued:${ev.state}:${ev.clientId}`]
          : ev.t === EventType.Turn
            ? ['turn:' + ev.state]
            : [],
    );
    expect(got.join(' ')).toBe('turn:start turn:end user:c-two turn:start queued:queued:c-three turn:end');
  }, 30_000);

  extended(
    'completed turns release prompt slots even without command_lifecycle',
    async () => {
      const prompts = Array.from({ length: 17 }, (_, i) => `prompt ${i}`);
      const { r, s } = await started([
        ...initLines(),
        ...prompts.flatMap((p, i) => [userIn(p), stateOut('running'), textOut(`msg_${i}`, p), resultOut(), stateOut('idle')]),
      ]);
      for (const [i, prompt] of prompts.entries()) {
        await r.until(s, 2 + i * 5);
        await s.prompt({ content: text(prompt), message: `m-${i}`, clientId: `c-${i}`, recorded: true }, sig());
      }
      await r.until(s, -1);
      expect(r.eventsOf(EventType.Turn).filter((e) => e.state === 'end')).toHaveLength(prompts.length);
    },
    30_000,
  );
});

describe('trust', () => {
  test('in a folder nobody trusted the program starts without the project settings, which a notice tells once; a folder the host or Claude Code trusts starts with them', async () => {
    const notices = (r: FakeRun) => r.eventsOf(EventType.Notice).filter((e) => e.method === noticeMethod(Notice.UntrustedFolder));
    const { r, s } = await started(initLines(), { edit: (p) => (p.trusted = false) });
    await r.until(s, -1);
    await s.setConfig(OPTION_MODE, chat.Mode.Full, sig());
    const a = r.argvs();
    expect(a).toHaveLength(2);
    for (const x of a) expect(x).toContain(' --setting-sources=user ');
    expect(notices(r).map((n) => n.params)).toEqual([{ cwd: r.dir }]);

    const edits: Record<string, (p: StartParams, r: FakeRun) => void> = {
      "the host's": (p) => (p.trusted = true),
      "Claude Code's": (p, run) => {
        p.trusted = false;
        const cfg = join(run.home, 'cfg');
        mkdirSync(cfg, { recursive: true });
        writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { [dirname(p.cwd)]: { hasTrustDialogAccepted: true } } }));
        p.env.CLAUDE_CONFIG_DIR = cfg;
      },
    };
    for (const [name, edit] of Object.entries(edits)) {
      const { r, s } = await started(initLines(), { edit });
      await r.until(s, -1);
      expect(`${name}: ${r.argvs().join('|')}`).toContain(' --setting-sources=user,project,local ');
      expect(notices(r)).toEqual([]);
    }
  }, 30_000);
});

describe('another Claude Code', () => {
  test('a session another Claude Code runs is not taken up; the adapter passes over its own programs', async () => {
    const home = tempDir('ct');
    const env = { HOME: home };
    const id = '22222222-2222-4222-8222-222222222222';
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const startedAt = Date.now();
    try {
      await new Promise((r) => child.once('spawn', r));
      const dir = join(home, '.claude', 'sessions');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id, cwd: '/w', startedAt }), {
        mode: 0o600,
      });
      const a = claudeAdapter({ sdk: devSdk });
      const hp = { kind: 'claude', argv: [], env, cwd: home, procs: null as never, logger: () => {}, sessionId: id, after: '' };
      expect((await a.inTerminal!(hp, sig()))?.code).toBe(Code.InTerminal);
      expect(await a.inTerminal!({ ...hp, sessionId: '33333333-3333-4333-8333-333333333333' }, sig())).toBeNull();
      const r = new FakeRun(script([]));
      runs.push(r);
      const p = { ...r.params(), resume: id, sessionId: '', env: { ...r.params().env, HOME: home } };
      expect(codeOf(await rejects(a.start(p, r.host, sig())))).toBe(Code.InTerminal);
      expect(r.log().trim()).toBe('');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);

  test("the adapter's own program's record is no other Claude Code's", async () => {
    const a = claudeAdapter({ sdk: devSdk, timing: { titles: [] } });
    const r = new FakeRun(script(initLines()));
    runs.push(r);
    const p = r.params();
    const s = (await a.start(p, r.host, sig())) as ClaudeSession;
    sessions.push(s);
    await r.until(s, -1);
    const dir = join(r.home, '.claude', 'sessions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${s.pid}.json`), JSON.stringify({ pid: s.pid, sessionId: TEST_SESSION, cwd: r.dir, startedAt: Date.now() }), {
      mode: 0o600,
    });
    expect(
      await a.inTerminal!(
        { kind: 'claude', argv: [], env: p.env, cwd: r.dir, procs: p.procs, logger: () => {}, sessionId: TEST_SESSION, after: '' },
        sig(),
      ),
    ).toBeNull();
  }, 30_000);
});

test("the session's title, its transcript's, is the chat's once a turn ended", async () => {
  const { r, s } = await started(
    [...initLines(), userIn('go'), stateOut('running'), textOut('msg_1', 'ok'), resultOut(), stateOut('idle')],
    {
      timing: { titles: [0] },
    },
  );
  const dir = join(r.home, '.claude', 'projects', claudeEscape(r.dir));
  mkdirSync(dir, { recursive: true });
  const line = (v: unknown) => JSON.stringify(v) + '\n';
  const transcript =
    line({ type: 'user', cwd: r.dir, timestamp: '2026-11-22T10:00:00Z', message: { role: 'user', content: 'go' } }) +
    line({ type: 'ai-title', aiTitle: 'Made by Claude' });
  writeFileSync(join(dir, `${TEST_SESSION}.jsonl`), transcript, { mode: 0o600 });
  await r.until(s, 2);
  await s.readTitle();
  expect(r.host.chat.title).toBe('Made by Claude');
  writeFileSync(join(dir, `${TEST_SESSION}.jsonl`), transcript + line({ type: 'custom-title', customTitle: 'Mine' }), { mode: 0o600 });
  await s.prompt({ content: text('go'), message: '', clientId: '', recorded: true }, sig());
  await r.until(s, -1);
  const deadline = Date.now() + 10_000;
  while (r.host.chat.title !== 'Mine' && Date.now() < deadline) await Bun.sleep(5);
  expect(r.host.chat.title).toBe('Mine');
}, 30_000);

test('the default timing', () => {
  expect(CLAUDE_TIMING).toEqual({ initialize: 60_000, request: 30_000, grace: 2000, term: 5000, drain: 1000, titles: [0, 5000] });
});

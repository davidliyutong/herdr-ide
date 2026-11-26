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
import { SLUG } from '#shared/lib/brand.ts';
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
  inL({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize', perTaskStopAffordance: true } }),
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
  rewind?: Script;
  fresh?: Script;
  timing?: Partial<ClaudeTiming>;
  edit?: (p: StartParams, r: FakeRun) => void;
}

/** Starts a session with the fake playing lines. */
async function start(lines: ScriptLine[], o: StartOpts = {}): Promise<{ r: FakeRun; s?: ClaudeSession; err?: ChatProtoError }> {
  const r = new FakeRun(script(lines, { silent: o.silent }), o.full, { rewind: o.rewind, fresh: o.fresh });
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
      steer: true,
      stopTask: true,
      fork: true,
      rewind: true,
      rewindFiles: true,
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
    const prompt = (t: string, recorded: boolean, delivery?: chat.Delivery) =>
      s.prompt({ content: text(t), message: 'm-' + t, clientId: 'c-' + t, recorded, ...(delivery ? { delivery } : {}) }, sig());
    await r.until(s, 2);
    await prompt('one', true);
    // The turn ends between the host's look and the prompt.
    await r.until(s, 7);
    await prompt('two', false);
    await r.until(s, 9);
    await prompt('three', true, chat.Delivery.Steer);
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

describe('models refresh (#3)', () => {
  test('models() probes a short-lived process when no live session exists and stops it cleanly', async () => {
    const r = new FakeRun(script(initLines()));
    runs.push(r);
    const p = r.params();
    const a = claudeAdapter({ sdk: devSdk, timing: { titles: [] } });
    const list = await a.models!(
      { kind: 'claude', argv: p.argv, env: p.env, cwd: p.cwd, procs: p.procs, logger: () => {}, client: p.client },
      sig(),
    );
    expect(list.length).toBeGreaterThan(0);
    const opus = list.find((m) => m.value === 'opus');
    expect(opus?.name).toBe('Opus 5.5');
    expect(opus?.images).toBe(true);
    expect(opus?.efforts).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus?.defaultEffort).toBe('default');
    const haiku45 = list.find((m) => m.value === 'claude-haiku-4-5-20251001');
    expect(haiku45?.efforts).toBeUndefined();
    expect(r.argvs()[0]).toContain('--no-session-persistence');
    const probePid = pids(r).runs[0]!;
    await gonePid(probePid);
  }, 30_000);

  test('models() reuses a live session when one is running without spawning another process', async () => {
    const a = claudeAdapter({ sdk: devSdk, timing: { titles: [] } });
    const r = new FakeRun(script(initLines()));
    runs.push(r);
    const p = r.params();
    const s = (await a.start(p, r.host, sig(30_000))) as ClaudeSession;
    sessions.push(s);
    await r.until(s, -1);
    const list = await a.models!(
      { kind: 'claude', argv: p.argv, env: p.env, cwd: p.cwd, procs: p.procs, logger: () => {}, client: p.client },
      sig(),
    );
    expect(list.some((m) => m.value === 'sonnet')).toBe(true);
    expect(r.argvs()).toHaveLength(1);
  }, 30_000);
});

describe('FIFO queue, withdraw, steer & interrupt (#4)', () => {
  test('default Delivery.Queue holds messages in adapter pendingQueue, withdraws cleanly by id, and drains one per turn FIFO', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('turn1'),
      stateOut('running'),
      // Wait for a marker control request after queuing & withdrawing before ending turn 1.
      inL({ type: 'control_request', request_id: 'req_m', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }),
      outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_m', response: { mode: 'acceptEdits' } } }),
      textOut('msg_1', 'r1'),
      resultOut(),
      // Stale idle from turn 1 arrives right after result — must NOT prematurely close drained turn 2!
      stateOut('idle'),
      userIn('turn2'),
      stateOut('running'),
      textOut('msg_2', 'r2'),
      resultOut(),
      stateOut('idle'),
      userIn('turn4'),
      stateOut('running'),
      textOut('msg_3', 'r4'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('turn1'), message: 'm1', clientId: 'c1', recorded: true }, sig());
    await r.until(s, 4);
    // Queue three messages with default delivery (queue): NONE should be written to stdin yet!
    await s.prompt({ content: text('turn2'), message: 'm2', clientId: 'c2', recorded: false }, sig());
    await s.prompt({ content: text('turn3-drop'), message: 'm3', clientId: 'c3', recorded: false }, sig());
    await s.prompt({ content: text('turn4'), message: 'm4', clientId: 'c4', recorded: false }, sig());
    // Withdraw middle item m3 — never touches stdin or cancel_async_message!
    await s.cancelQueued('m3', sig());
    expect(codeOf(await rejects(s.cancelQueued('m3', sig())))).toBe(Code.NotFound);
    // Verify only turn1 was written to stdin so far.
    const writtenBefore = r.wrote().filter((w) => w.type === 'user');
    expect(writtenBefore).toHaveLength(1);
    expect(r.wrote().some((w) => (w.request as Msg | undefined)?.subtype === 'cancel_async_message')).toBe(false);
    // Trigger turn 1 end -> auto-drains turn2, then turn4 one at a time.
    await s.setConfig(OPTION_MODE, chat.Mode.AcceptEdits, sig());
    await r.until(s, -1);

    const queued = r.eventsOf(EventType.Queued).map((e) => `${e.message}:${e.state}`);
    expect(queued).toEqual(['m2:queued', 'm3:queued', 'm4:queued', 'm3:cancelled', 'm2:taken', 'm4:taken']);
    const turns = r.eventsOf(EventType.Turn).map((e) => e.state);
    expect(turns).toEqual([TurnState.Start, TurnState.End, TurnState.Start, TurnState.End, TurnState.Start, TurnState.End]);
    // Queued(taken) must precede Turn(start) for drained turns and carry transcript uuid in item & entryUuid.
    const seq = r.host.events
      .filter((e) => e.t === EventType.Turn || (e.t === EventType.Queued && e.state === chat.QueuedState.Taken))
      .map((e) => (e.t === EventType.Turn ? `turn:${e.state}` : `taken:${e.message}`));
    expect(seq).toEqual(['turn:start', 'turn:end', 'taken:m2', 'turn:start', 'turn:end', 'taken:m4', 'turn:start', 'turn:end']);
    const takenEvs = r.eventsOf(EventType.Queued).filter((e) => e.state === chat.QueuedState.Taken);
    for (const te of takenEvs) {
      expect(te.item).toMatch(/^[0-9a-f-]{36}$/);
      expect(te.entryUuid).toBe(te.item);
    }
  }, 30_000);

  test('steerQueued promotes a queued message mid-turn (steer) or via interrupt preserving remaining queue', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('first'),
      stateOut('running'),
      // First promoted via steer -> written immediately mid-turn!
      userIn('steered'),
      outL({ type: 'command_lifecycle', command_uuid: 'u-steered', state: 'started' }),
      // Next promoted via interrupt -> sends interrupt, ends turn 1, runs urgent, then drains leftover!
      inL({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } }),
      outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_int', response: { still_queued: [] } } }),
      outL({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming' }),
      stateOut('idle'),
      userIn('urgent'),
      stateOut('running'),
      textOut('msg_u', 'ok-u'),
      resultOut(),
      stateOut('idle'),
      userIn('later'),
      stateOut('running'),
      textOut('msg_l', 'ok-l'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('first'), message: 'm1', clientId: 'c1', recorded: true }, sig());
    await r.until(s, 4);
    await s.prompt({ content: text('steered'), message: 'm2', clientId: 'c2', recorded: false }, sig());
    await s.prompt({ content: text('urgent'), message: 'm3', clientId: 'c3', recorded: false }, sig());
    await s.prompt({ content: text('later'), message: 'm4', clientId: 'c4', recorded: false }, sig());
    // Promote m2 as mid-turn steer.
    await s.steerQueued('m2', 'steer', sig());
    await r.until(s, 6);
    // Promote m3 as interrupt — must keep m4 queued and drain m4 after m3 finishes!
    await s.steerQueued('m3', 'interrupt', sig());
    await r.until(s, -1);

    const queued = r.eventsOf(EventType.Queued).map((e) => `${e.message}:${e.state}`);
    expect(queued).toEqual(['m2:queued', 'm3:queued', 'm4:queued', 'm2:taken', 'm3:taken', 'm4:taken']);
    const turns = r.eventsOf(EventType.Turn).map((e) => `${e.state}:${e.stopReason ?? ''}`);
    expect(turns).toEqual(['start:', 'end:cancelled', 'start:', 'end:end_turn', 'start:', 'end:end_turn']);
  }, 30_000);

  test('Delivery.Interrupt interrupts active turn without dropping unrelated pendingQueue messages', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('base'),
      stateOut('running'),
      inL({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } }),
      outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_int', response: { still_queued: [] } } }),
      outL({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming' }),
      stateOut('idle'),
      userIn('now'),
      stateOut('running'),
      textOut('msg_n', 'ok-now'),
      resultOut(),
      stateOut('idle'),
      userIn('kept'),
      stateOut('running'),
      textOut('msg_k', 'ok-kept'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('base'), message: 'm1', clientId: 'c1', recorded: true }, sig());
    await r.until(s, 4);
    await s.prompt({ content: text('kept'), message: 'm2', clientId: 'c2', recorded: false }, sig());
    await s.prompt({ content: text('now'), message: 'm3', clientId: 'c3', recorded: false, delivery: chat.Delivery.Interrupt }, sig());
    await r.until(s, -1);

    const queued = r.eventsOf(EventType.Queued).map((e) => `${e.message}:${e.state}`);
    expect(queued).toEqual(['m2:queued', 'm2:taken']);
    const users = r.eventsOf(EventType.User).map((e) => e.clientId);
    expect(users).toEqual(['c3']);
  }, 30_000);

  test('cancel() withdraws pendingQueue by default, while cancel(sig, { keepQueue: true }) preserves it', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('base'),
      stateOut('running'),
      inL({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } }),
      outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_int', response: { still_queued: [] } } }),
      outL({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming' }),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('base'), message: 'm1', clientId: 'c1', recorded: true }, sig());
    await r.until(s, 4);
    await s.prompt({ content: text('dropped'), message: 'm2', clientId: 'c2', recorded: false }, sig());
    await s.cancel(sig());
    await r.until(s, -1);
    const queued = r.eventsOf(EventType.Queued).map((e) => `${e.message}:${e.state}`);
    expect(queued).toEqual(['m2:queued', 'm2:cancelled']);
  }, 30_000);
});

describe('fork, rewind & uuid propagation (#6)', () => {
  test('PromptParams.uuid is sent as SDKUserMessage.uuid and stamped on emitted User events', async () => {
    const u1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const u2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { r, s } = await started([
      ...initLines(),
      userIn('first'),
      stateOut('running'),
      textOut('msg_1', 'r1'),
      resultOut(),
      stateOut('idle'),
      userIn('second'),
      stateOut('running'),
      textOut('msg_2', 'r2'),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('first'), message: 'm1', clientId: 'c1', recorded: true, uuid: u1 }, sig());
    await r.until(s, 7);
    await s.prompt({ content: text('second'), message: 'm2', clientId: 'c2', recorded: false, uuid: u2 }, sig());
    await r.until(s, -1);
    const sentUsers = r.wrote().filter((w) => w.type === 'user');
    expect(sentUsers.map((w) => w.uuid)).toEqual([u1, u2]);
    const userEvs = r.eventsOf(EventType.User);
    expect(userEvs).toHaveLength(1);
    expect(userEvs[0]!.item).toBe(u2);
    expect(userEvs[0]!.entryUuid).toBe(u2);
  }, 30_000);

  test('records transcript entryUuid on main-thread assistant/tool_result/compact events, omits subagent sidechain uuids, and stamps queued-taken turns', async () => {
    const u1 = '11111111-1111-4111-8111-111111111101';
    const a1 = '11111111-1111-4111-8111-111111111102';
    const subA = '11111111-1111-4111-8111-111111111103';
    const tr1 = '11111111-1111-4111-8111-111111111104';
    const a2 = '11111111-1111-4111-8111-111111111105';
    const u2 = '11111111-1111-4111-8111-111111111106';
    const a3 = '11111111-1111-4111-8111-111111111107';
    const { r, s } = await started(
      [
        ...initLines(),
        userIn('one'),
        stateOut('running'),
        // Main-thread tool_use assistant entry
        outL({
          type: 'assistant',
          uuid: a1,
          parent_tool_use_id: null,
          message: {
            id: 'msg_01main',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01main', name: 'Agent', input: { description: 'sub', prompt: 'hi' } }],
          },
        }),
        // Subagent sidechain assistant entry: must NOT stamp entryUuid!
        outL({
          type: 'assistant',
          uuid: subA,
          parent_tool_use_id: 'toolu_01main',
          message: { id: 'msg_01sub', role: 'assistant', content: [{ type: 'text', text: 'sub work' }] },
        }),
        // Main-thread user tool_result entry
        outL({
          type: 'user',
          uuid: tr1,
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01main', content: 'done', is_error: false }] },
        }),
        // Main-thread final assistant entry
        outL({
          type: 'assistant',
          uuid: a2,
          parent_tool_use_id: null,
          message: { id: 'msg_02main', role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
        }),
        resultOut(),
        stateOut('idle'),
        userIn('two'),
        stateOut('running'),
        outL({
          type: 'assistant',
          uuid: a3,
          parent_tool_use_id: null,
          message: { id: 'msg_03main', role: 'assistant', content: [{ type: 'text', text: 'reply two' }] },
        }),
        resultOut(),
        stateOut('idle'),
      ],
      { rewind: script(initLines()) },
    );
    await r.until(s, 2);
    await s.prompt({ content: text('one'), message: 'm1', clientId: 'c1', recorded: true, uuid: u1 }, sig());
    // Queue turn 2 with explicit uuid u2 while turn 1 runs!
    await s.prompt({ content: text('two'), message: 'm2', clientId: 'c2', recorded: false, uuid: u2 }, sig());
    await r.until(s, -1);

    const mainToolCall = r.host.events.find(
      (e) => e.t === EventType.Update && e.item === 'toolu_01main' && (e.update as Msg).sessionUpdate === 'tool_call',
    );
    expect(mainToolCall?.entryUuid).toBe(a1);
    const subUpdate = r.host.events.find((e) => e.t === EventType.Update && e.parent === 'toolu_01main');
    expect(subUpdate).toBeDefined();
    expect(subUpdate?.entryUuid).toBeUndefined();
    const mainToolRes = r.host.events.find(
      (e) => e.t === EventType.Update && e.item === 'toolu_01main' && (e.update as Msg).sessionUpdate === 'tool_call_update',
    );
    expect(mainToolRes?.entryUuid).toBe(tr1);
    const reply1 = r.host.events.find((e) => e.t === EventType.Update && e.item === 'msg_02main/0');
    expect(reply1?.entryUuid).toBe(a2);
    const taken2 = r.host.events.find((e) => e.t === EventType.Queued && e.state === chat.QueuedState.Taken && e.message === 'm2');
    expect(taken2?.item).toBe(u2);
    expect(taken2?.entryUuid).toBe(u2);

    // Rewind to before queued turn 2 using the real transcript entryUuids (never msg_.../toolu_...)!
    await s.rewind({ userMessageId: taken2!.entryUuid, resumeBeforeId: reply1!.entryUuid, restoreFiles: true }, sig());
    expect(
      r.wrote().some((w) => (w.request as Msg | undefined)?.subtype === 'rewind_files' && (w.request as Msg).user_message_id === u2),
    ).toBe(true);
    expect(r.argvs()[1]).toContain(`--resume-session-at=${a2}`);
    expect(r.argvs()[1]).not.toContain('msg_02main');
  }, 30_000);

  test('adapter.fork() forks a Claude transcript on disk (full and sliced upToMessageId) and maps missing session to not_found', async () => {
    const home = tempDir('cfork');
    const work = tempDir('cwork');
    const proj = join(home, '.claude', 'projects', claudeEscape(work));
    mkdirSync(proj, { recursive: true });
    const srcId = '44444444-4444-4444-8444-444444444444';
    const u1 = '10000000-0000-4000-8000-000000000001';
    const a1 = '10000000-0000-4000-8000-000000000002';
    const u2 = '10000000-0000-4000-8000-000000000003';
    const a2 = '10000000-0000-4000-8000-000000000004';
    const lines = [
      {
        type: 'user',
        uuid: u1,
        parentUuid: null,
        sessionId: srcId,
        cwd: work,
        timestamp: '2026-11-22T10:00:00Z',
        message: { role: 'user', content: 'turn one' },
      },
      {
        type: 'assistant',
        uuid: a1,
        parentUuid: u1,
        sessionId: srcId,
        cwd: work,
        timestamp: '2026-11-22T10:00:01Z',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
      },
      {
        type: 'user',
        uuid: u2,
        parentUuid: a1,
        sessionId: srcId,
        cwd: work,
        timestamp: '2026-11-22T10:00:02Z',
        message: { role: 'user', content: 'turn two' },
      },
      {
        type: 'assistant',
        uuid: a2,
        parentUuid: u2,
        sessionId: srcId,
        cwd: work,
        timestamp: '2026-11-22T10:00:03Z',
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'reply two' }] },
      },
    ];
    writeFileSync(join(proj, `${srcId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });

    const a = claudeAdapter({ sdk: devSdk });
    const base = {
      kind: 'claude',
      argv: [],
      env: { HOME: home },
      cwd: work,
      procs: null as never,
      logger: () => {},
      client: { name: 'test', version: '0' },
    };

    // Full fork
    const full = await a.fork!({ ...base, sessionId: srcId, title: 'My Fork' }, sig());
    expect(full.sessionId).not.toBe(srcId);
    const fullText = await Bun.file(join(proj, `${full.sessionId}.jsonl`)).text();
    expect(fullText).toContain('turn one');
    expect(fullText).toContain('turn two');
    expect(fullText).toContain('My Fork');

    // Sliced fork up to a1
    const sliced = await a.fork!({ ...base, sessionId: srcId, upToMessageId: a1 }, sig());
    expect(sliced.sessionId).not.toBe(srcId);
    const slicedText = await Bun.file(join(proj, `${sliced.sessionId}.jsonl`)).text();
    expect(slicedText).toContain('turn one');
    expect(slicedText).toContain('reply one');
    expect(slicedText).not.toContain('turn two');

    // Missing session -> NotFound
    expect(codeOf(await rejects(a.fork!({ ...base, sessionId: '55555555-5555-4555-8555-555555555555' }, sig())))).toBe(Code.NotFound);
  }, 30_000);

  test('session.rewind() calls rewindFiles when restoreFiles is true and restarts with --resume-session-at; turn-1 rewind creates a fresh session', async () => {
    const u1 = '10000000-0000-4000-8000-000000000001';
    const a1 = '10000000-0000-4000-8000-000000000002';
    const u2 = '10000000-0000-4000-8000-000000000003';
    const { r, s } = await started(
      [...initLines(), userIn('one'), stateOut('running'), textOut('msg_1', 'ok'), resultOut(), stateOut('idle')],
      {
        rewind: script(initLines()),
        fresh: script(initLines()),
      },
    );
    await r.until(s, 2);
    await s.prompt({ content: text('one'), message: 'm1', clientId: 'c1', recorded: true, uuid: u1 }, sig());
    // Refused while a turn runs.
    expect(codeOf(await rejects(s.rewind({ userMessageId: u2, resumeBeforeId: a1 }, sig())))).toBe(Code.Busy);
    await r.until(s, -1);

    // Rewind to a1 with restoreFiles: true
    const rw1 = await s.rewind({ userMessageId: u2, resumeBeforeId: a1, restoreFiles: true }, sig());
    expect(rw1.sessionId).toBeUndefined();
    expect(s.id).toBe(TEST_SESSION);
    expect(
      r.wrote().some((w) => (w.request as Msg | undefined)?.subtype === 'rewind_files' && (w.request as Msg).user_message_id === u2),
    ).toBe(true);
    const argvsAfterRewind = r.argvs();
    expect(argvsAfterRewind).toHaveLength(2);
    expect(argvsAfterRewind[1]).toContain(`--resume=${TEST_SESSION}`);
    expect(argvsAfterRewind[1]).toContain(`--resume-session-at=${a1}`);

    // Rewind turn 1 (no resumeBeforeId) -> fresh session id!
    const rw2 = await s.rewind({ userMessageId: u1 }, sig());
    expect(rw2.sessionId).toBeTruthy();
    expect(rw2.sessionId).not.toBe(TEST_SESSION);
    expect(s.id).toBe(rw2.sessionId!);
    const argvsAfterFresh = r.argvs();
    expect(argvsAfterFresh).toHaveLength(3);
    expect(argvsAfterFresh[2]).toContain(`--session-id=${rw2.sessionId}`);
    expect(argvsAfterFresh[2]).not.toContain('--resume=');
  }, 30_000);
});

describe('manual compact instructions (#9)', () => {
  test('compact() sends /compact <instructions> when instructions are given', async () => {
    const { r, s } = await started([
      ...initLines(),
      inL({ type: 'user', uuid: 'u-cmp', message: { role: 'user', content: [{ type: 'text', text: '/compact focus on auth' }] } }),
      stateOut('running'),
      outL({ type: 'system', subtype: 'status', status: 'compacting' }),
      outL({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 50000, post_tokens: 12000 } }),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.compact(sig(), '  focus on auth  ');
    await r.until(s, -1);
    const notices = r.eventsOf(EventType.Notice);
    expect(notices[0]).toEqual({
      t: EventType.Notice,
      method: noticeMethod(Notice.Command),
      params: { name: '/compact', instructions: 'focus on auth' },
    });
    expect(notices.some((n) => n.method === noticeMethod(Notice.Compacted))).toBe(true);
  }, 30_000);
});

describe('background tasks, subagents & stopTask (#10)', () => {
  test('tracks background_tasks_changed, task_started without tool_use_id, task_updated is_backgrounded/error, cancelled on stopped, and stopTask()', async () => {
    const { r, s } = await started([
      ...initLines(),
      userIn('run bg'),
      stateOut('running'),
      // Background task joins via background_tasks_changed (with an ambient task that must be hidden from chat.tasks)
      outL({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'bg-shell-1', run_id: 'r1', task_type: 'local_bash', description: 'npm run dev' },
          { task_id: 'bg-amb-1', task_type: 'monitor', description: 'watcher', ambient: true },
        ],
      }),
      // Foreground task_started with tool_use_id, then moved to background via task_updated
      outL({
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-1',
        tool_use_id: 'toolu_a1',
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: 'Scan repo',
        is_backgrounded: false,
      }),
      outL({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent-1',
        patch: { is_backgrounded: true, description: 'Scanning files' },
      }),
      // Wait for stop_task control request on bg-shell-1
      inL({ type: 'control_request', request_id: 'req_stop', request: { subtype: 'stop_task', task_id: 'bg-shell-1' } }),
      outL({ type: 'control_response', response: { subtype: 'success', request_id: 'req_stop', response: {} } }),
      outL({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'bg-shell-1',
        tool_use_id: 'toolu_sh1',
        status: 'stopped',
        summary: 'Stopped by user',
      }),
      outL({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'agent-1', task_type: 'local_agent', subagent_type: 'Explore', description: 'Scanning files' }],
      }),
      // Finish agent-1 with killed status -> mapped to cancelled, tasks cleared
      outL({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-1',
        tool_use_id: 'toolu_a1',
        status: 'killed',
        summary: 'Killed',
      }),
      outL({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }),
      resultOut(),
      stateOut('idle'),
    ]);
    await r.until(s, 2);
    await s.prompt({ content: text('run bg'), message: 'm1', clientId: 'c1', recorded: true }, sig());
    await r.until(s, 7);

    // Both bg-shell-1 and agent-1 are live in chat.tasks; ambient task is excluded!
    expect(
      r.host.chat.tasks?.map((t) => ({
        id: t.id,
        kind: t.kind,
        bg: t.backgrounded,
        agentType: t.agentType,
        desc: t.description,
        stoppable: t.stoppable,
      })),
    ).toEqual([
      { id: 'bg-shell-1', kind: chat.TaskKind.Shell, bg: true, agentType: undefined, desc: 'npm run dev', stoppable: true },
      { id: 'agent-1', kind: chat.TaskKind.Subagent, bg: true, agentType: 'Explore', desc: 'Scanning files', stoppable: true },
    ]);

    // Stop bg-shell-1 via stopTask()
    await s.stopTask('bg-shell-1', sig());
    await r.until(s, -1);

    // After all tasks complete/stop, chat.tasks is cleared.
    expect(r.host.chat.tasks).toBeUndefined();

    // Verify tool_call_update statuses for stopped/killed map to 'cancelled' and include taskId/backgrounded meta.
    const updates = r.eventsOf(EventType.Update).map((e) => e.update as Msg);
    const bgUpdate = updates.find(
      (u) =>
        u.toolCallId === 'toolu_a1' &&
        (u._meta as Msg | undefined)?.[SLUG] &&
        ((u._meta as Msg)[SLUG] as Msg).task &&
        (((u._meta as Msg)[SLUG] as Msg).task as Msg).backgrounded === true,
    );
    expect(bgUpdate).toBeDefined();
    const shStopped = updates.find((u) => u.toolCallId === 'toolu_sh1' && u.status === 'cancelled');
    expect(shStopped).toBeDefined();
    const agKilled = updates.find((u) => u.toolCallId === 'toolu_a1' && u.status === 'cancelled');
    expect(agKilled).toBeDefined();
  }, 30_000);
});

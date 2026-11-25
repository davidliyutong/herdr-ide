// The Claude Code adapter's test harness: scripts of the fake program
// (testdata/fakeclaude.ts) made of the recordings in
// spec/vectors/chat/claude, a host (a Sink) that records what it gets as the
// Go adapter's tests record it and answers as the recordings did, and the
// comparison with the Go adapter's golden files of the same recordings
// (internal/chatadapter/claude/testdata). Nothing here reads a home
// directory but the temporary ones it makes.
import { afterAll, beforeAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as chat from '#shared/proto/chatproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import { planOption, OPTION_ALLOW_ONCE, OPTION_ALLOW_SESSION, OPTION_REJECT_ONCE } from '../adapter.ts';
import type { PermissionAnswer, PermissionRequest, QuestionAnswer, QuestionRequest, Session, Sink, StartParams } from '../adapter.ts';
import { claudeAdapter, type ClaudeAdapterOptions } from './adapter.ts';
import type { SdkModule, SdkSource } from './load.ts';
import { chatMode, OPTION_EFFORT, OPTION_MODE, OPTION_MODEL } from './config.ts';
import type { ClaudeSession } from './session.ts';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
export const VECTORS = join(REPO, 'spec', 'vectors', 'chat', 'claude');
/** The Go adapter's golden files of the same scenarios. */
export const GO_GOLDEN = join(REPO, 'internal', 'chatadapter', 'claude', 'testdata');
const FAKE = join(import.meta.dir, 'testdata', 'fakeclaude.ts');

/** The Agent SDK of the development dependency, as the tests load it (the
 * product loads the one a machine installed: load.ts). */
export const devSdk: SdkSource = { load: () => import('@anthropic-ai/claude-agent-sdk') as Promise<SdkModule> };

/** The session id the replays run with. */
export const TEST_SESSION = '11111111-1111-4111-8111-111111111111';

export type Msg = Record<string, unknown>;

/** A line of a recording. */
export interface FixtureLine {
  dir: string;
  msg: Msg;
}

/** A line of the fake's script (testdata/fakeclaude.ts). */
export interface ScriptLine {
  dir: string;
  msg?: Msg;
  text?: string;
  n?: number;
  code?: number;
}

export interface Script {
  lines: ScriptLine[];
  noConversation?: boolean;
  canned?: Record<string, unknown>;
  silent?: string[];
}

/** A temporary directory without links in its path, short (unix socket
 * paths are short on macOS). */
export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Gives the test process a temporary home while a test file runs: the SDK
 * runs in it, and nothing of it may read the user's own ~/.claude. */
export function isolateHome(): void {
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  beforeAll(() => {
    const home = tempDir('chome');
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}

export function fixture(name: string): FixtureLine[] {
  return readFileSync(join(VECTORS, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FixtureLine);
}

/** A control request's id, subtype and body; empty for another line. */
function request(m: Msg): { id: string; subtype: string; req: Msg } {
  if (m.type !== 'control_request') return { id: '', subtype: '', req: {} };
  const req = (m.request ?? {}) as Msg;
  return { id: String(m.request_id), subtype: String(req.subtype ?? ''), req };
}

/** The answers the fake gives to the adapter's own requests: initialize as
 * the recording of a start, get_context_usage as one of the recorded
 * answers. */
export function canned(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [file, sub] of [
    ['claude-01-initialize.jsonl', 'initialize'],
    ['claude-06-controls.jsonl', 'get_context_usage'],
  ] as const) {
    let id = '';
    for (const l of fixture(file)) {
      const r = request(l.msg);
      if (r.subtype === sub && l.dir === 'in' && id === '') id = r.id;
      const resp = l.msg.response as Msg | undefined;
      if (l.msg.type === 'control_response' && id !== '' && resp?.request_id === id) {
        out[sub] = resp.response;
        break;
      }
    }
    if (!(sub in out)) throw new Error(`no answer to ${sub} in ${file}`);
  }
  return out;
}

/** The canned models' values and the ids they resolve to. */
export function models(): Map<string, string> {
  const init = canned().initialize as { models: Array<{ value: string; resolvedModel?: string }> };
  return new Map(init.models.map((m) => [m.value, m.resolvedModel ?? '']));
}

const clone = <T>(v: T): T => structuredClone(v);

/** A recording as the fake's script: the adapter's own get_context_usage
 * and list_models requests (and their answers) left to the canned answers;
 * an answer to a request the program cancelled left out; a start without
 * one gets initialize; a set_model names the model the alias resolves to
 * (the adapter pins it); an "always allow" sends only the addRules
 * suggestions. */
export function prepare(lines: FixtureLine[]): ScriptLine[] {
  const ms = models();
  const drop = new Set<string>();
  const cancelled = new Set<string>();
  let hasInit = false;
  for (const l of lines) {
    const r = request(l.msg);
    if (l.dir === 'in' && (r.subtype === 'get_context_usage' || r.subtype === 'list_models')) drop.add(r.id);
    else if (r.subtype === 'initialize') hasInit = true;
  }
  const out: ScriptLine[] = [];
  if (!hasInit)
    out.push(
      { dir: 'in', msg: { type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } } },
      {
        dir: 'out',
        msg: { type: 'control_response', response: { subtype: 'success', request_id: 'req_init', response: canned().initialize } },
      },
    );
  for (const l of lines) {
    const m = clone(l.msg);
    if (drop.has(request(m).id)) continue;
    const resp = m.response as Msg | undefined;
    if (m.type === 'control_response' && resp && drop.has(String(resp.request_id))) continue;
    if (m.type === 'control_cancel_request') cancelled.add(String(m.request_id));
    if (l.dir === 'in' && m.type === 'control_response' && resp) {
      if (cancelled.has(String(resp.request_id))) continue;
      const b = resp.response as Msg | undefined;
      if (b && Array.isArray(b.updatedPermissions))
        b.updatedPermissions = b.updatedPermissions.filter((p) => (p as Msg).type === 'addRules');
    }
    const req = m.request as Msg | undefined;
    if (m.type === 'control_request' && req?.subtype === 'set_model') {
      const r = ms.get(String(req.model));
      if (r) req.model = r;
    }
    out.push({ dir: l.dir, msg: m });
  }
  return out;
}

/** Go's zero chat, which the Go tests' sink updates. */
const zeroChat = (): chat.Chat => ({
  id: '',
  kind: '',
  title: '',
  cwd: '',
  sessionId: '',
  state: '',
  status: '',
  created: '0001-01-01T00:00:00Z',
  updated: '0001-01-01T00:00:00Z',
  seq: 0,
  seen: 0,
  capabilities: {
    images: false,
    compact: false,
    queue: false,
    plan: false,
    questions: false,
    effort: false,
    model: false,
    cancelQueued: false,
  },
});

const toolCallId = (c: unknown): string => String((c as Msg | undefined)?.toolCallId ?? '');

/** A Sink that records what a session reports, and answers its permissions
 * and questions as the recording did (by the tool call they are about); one
 * the recording did not answer waits until it is cancelled. */
export class Host implements Sink {
  readonly events: chat.Event[] = [];
  /** The mode option's values, as each change states them. */
  readonly modes: string[] = [];
  readonly perms: PermissionRequest[] = [];
  readonly questions: QuestionRequest[] = [];
  chat = zeroChat();
  readonly permAns = new Map<string, PermissionAnswer>();
  readonly questAns = new Map<string, QuestionAnswer>();

  event(ev: chat.Event): void {
    this.events.push(ev);
  }

  update(fn: (c: chat.Chat) => void): void {
    fn(this.chat);
    for (const o of this.chat.config ?? [])
      if (o.id === OPTION_MODE && this.modes[this.modes.length - 1] !== o.currentValue) this.modes.push(o.currentValue);
  }

  private wait<T>(a: T | undefined, signal: AbortSignal, cancelled: T): Promise<T> {
    if (a) return Promise.resolve(a);
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(cancelled);
      signal.addEventListener('abort', () => resolve(cancelled), { once: true });
    });
  }

  permission(r: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    this.perms.push(r);
    return this.wait(this.permAns.get(toolCallId(r.toolCall)), signal, { cancelled: true });
  }

  question(r: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> {
    this.questions.push(r);
    return this.wait(this.questAns.get(toolCallId(r.toolCall)), signal, { cancelled: true });
  }

  /** The answers of the recording's to the program's can_use_tool
   * requests. */
  answersOf(lines: FixtureLine[]): void {
    const asked = new Map<string, { tool: string; use: string; input: Msg }>();
    for (const l of lines) {
      const m = l.msg;
      // Answered after the program cancelled it: never, by the user.
      if (m.type === 'control_cancel_request') asked.delete(String(m.request_id));
      const r = request(m);
      if (l.dir === 'out' && r.subtype === 'can_use_tool')
        asked.set(r.id, { tool: String(r.req.tool_name), use: String(r.req.tool_use_id), input: (r.req.input ?? {}) as Msg });
      const resp = m.response as Msg | undefined;
      if (l.dir !== 'in' || m.type !== 'control_response' || !resp) continue;
      const q = asked.get(String(resp.request_id));
      if (!q) continue;
      const b = (resp.response ?? {}) as Msg;
      const allowed = b.behavior === 'allow';
      if (q.tool === 'AskUserQuestion') {
        if (!allowed) {
          this.questAns.set(q.use, { cancelled: true });
          continue;
        }
        const given = (((b.updatedInput ?? {}) as Msg).answers ?? {}) as Msg;
        const answers: Record<string, string[]> = {};
        (q.input.questions as Msg[]).forEach((x, i) => {
          const a = given[String(x.question)];
          if (a !== undefined) answers[String(i)] = [String(a)];
        });
        this.questAns.set(q.use, { answers });
      } else if (q.tool === 'ExitPlanMode') {
        this.permAns.set(q.use, { option: allowed ? planOption(chat.Mode.Default) : OPTION_REJECT_ONCE });
      } else {
        const option = allowed && b.updatedPermissions ? OPTION_ALLOW_SESSION : allowed ? OPTION_ALLOW_ONCE : OPTION_REJECT_ONCE;
        this.permAns.set(q.use, { option });
      }
    }
  }
}

/** Where the fake reports: its signals, as they come. */
export class FakeRun {
  readonly dir: string;
  readonly home: string;
  readonly host = new Host();
  readonly procs = new AgentProcesses();
  readonly logPath: string;
  private readonly signals: Array<{ at: number; written: number }> = [];
  private wake: (() => void) | null = null;
  private readonly server: Server;
  private readonly full: boolean;

  constructor(sc: Script, full?: Script) {
    this.full = !!full;
    this.dir = tempDir('cf');
    this.home = tempDir('ch');
    mkdirSync(join(this.home, '.claude'), { recursive: true });
    writeFileSync(join(this.dir, 'script.json'), JSON.stringify(sc), { mode: 0o600 });
    if (full) writeFileSync(join(this.dir, 'full.json'), JSON.stringify(full), { mode: 0o600 });
    this.logPath = join(this.dir, 'log.jsonl');
    writeFileSync(this.logPath, '', { mode: 0o600 });
    this.server = createServer((c) => {
      let buf = '';
      c.on('data', (b) => {
        buf += b.toString();
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          this.signals.push(JSON.parse(buf.slice(0, nl)) as { at: number; written: number });
          buf = buf.slice(nl + 1);
          this.wake?.();
        }
      });
      c.on('error', () => {});
    });
    this.server.listen(join(this.dir, 's'));
  }

  close(): void {
    this.server.close();
    this.procs.signal('SIGKILL');
  }

  /** The start params of a session with the fake. */
  params(): StartParams {
    return {
      kind: 'claude',
      argv: [process.execPath, FAKE],
      env: {
        HOME: this.home,
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '--inspect',
        KEEP_ME: '1',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        FAKE_CLAUDE_SCRIPT: join(this.dir, 'script.json'),
        ...(this.full ? { FAKE_CLAUDE_FULL_SCRIPT: join(this.dir, 'full.json') } : {}),
        FAKE_CLAUDE_SOCK: join(this.dir, 's'),
        FAKE_CLAUDE_LOG: this.logPath,
      },
      cwd: this.dir,
      procs: this.procs,
      logger: () => {},
      resume: '',
      sessionId: TEST_SESSION,
      options: { mode: chat.Mode.Default },
      // The recordings ran in a folder the user trusted.
      trusted: true,
      client: { name: 'test', version: '0' },
      settings: chat.defaultHostSettings(),
    };
  }

  /** The fake's next signal. */
  async signal(ms = 20_000): Promise<{ at: number; written: number }> {
    const deadline = Date.now() + ms;
    while (this.signals.length === 0) {
      if (Date.now() > deadline) throw new Error(`no signal from the fake; its log:\n${this.log()}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
      this.wake = null;
    }
    return this.signals.shift()!;
  }

  /** Waits for the signal of the script's line at, and for the session to
   * have taken what came before it. */
  async until(s: Session, at: number): Promise<void> {
    for (;;) {
      const sig = await this.signal();
      await settle(s, sig.written);
      if (sig.at === at) return;
    }
  }

  log(): string {
    return readFileSync(this.logPath, 'utf8');
  }

  /** The fake's log. */
  records(): Msg[] {
    return this.log()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Msg);
  }

  /** The command lines of the fake's runs. */
  argvs(): string[] {
    return this.records()
      .filter((r) => r.argv)
      .map((r) => (r.argv as string[]).join(' '));
  }

  /** What the adapter wrote, as the fake got it. */
  wrote(): Msg[] {
    return this.records()
      .filter((r) => r.got)
      .map((r) => r.got as Msg);
  }

  mismatches(): string[] {
    return this.records()
      .filter((r) => r.mismatch)
      .map((r) => String(r.mismatch));
  }

  eventsOf(t: string): chat.Event[] {
    return this.host.events.filter((e) => e.t === t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until s took n lines of the fake's output, and what the SDK made of
 * them reached the session. */
export async function settle(s: Session, n: number): Promise<void> {
  const cs = s as ClaudeSession;
  const deadline = Date.now() + 20_000;
  while (cs.linesRead < n) {
    if (Date.now() > deadline) throw new Error(`the session read ${cs.linesRead} lines, not ${n}`);
    await sleep(2);
  }
  await sleep(20);
}

/** Waits until no control request of s's waits for its answer. */
export async function quiet(s: Session): Promise<void> {
  const cs = s as ClaudeSession;
  const deadline = Date.now() + 20_000;
  while (cs.calls > 0) {
    if (Date.now() > deadline) throw new Error(`${cs.calls} requests wait`);
    await sleep(2);
  }
}

/** A recorded user message's content as a prompt's ACP blocks. */
export function acpContent(c: unknown): unknown[] {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return (c as Msg[]).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') {
      const src = b.source as Msg;
      return { type: 'image', mimeType: src.media_type, data: src.data };
    }
    throw new Error(`a block of type ${String(b.type)}`);
  });
}

const signal = () => AbortSignal.timeout(30_000);

/** Does what the recording's "in" line is the adapter's for: a prompt (the
 * user's message, /compact), a cancel, a configuration; nothing for what
 * the adapter sends on its own. */
export async function act(s: Session, l: ScriptLine, uuids: Map<string, string>): Promise<void> {
  const m = l.msg ?? {};
  const cs = s as ClaudeSession;
  if (m.type === 'user') {
    const msg = m.message as Msg;
    if (msg.content === '/compact') return s.compact(signal());
    const id = String(uuids.size + 1);
    uuids.set(String(m.uuid), 'm' + id);
    // The host records a prompt it sees start a turn.
    return s.prompt({ content: acpContent(msg.content), message: 'm' + id, clientId: 'c' + id, recorded: !cs.turnRuns }, signal());
  }
  if (m.type !== 'control_request') return;
  const req = m.request as Msg;
  switch (req.subtype) {
    case 'interrupt':
      return s.cancel(signal());
    case 'set_model':
      for (const [v, r] of models())
        if ((r === req.model && !['default', 'opus', 'fable', 'sonnet'].includes(v)) || v === req.model)
          return s.setConfig(OPTION_MODEL, v, signal());
      return;
    case 'set_permission_mode':
      return s.setConfig(OPTION_MODE, chatMode(req.mode), signal());
    case 'apply_flag_settings':
      return s.setConfig(OPTION_EFFORT, String((req.settings as Msg).effortLevel), signal());
    case 'cancel_async_message':
      return s.cancelQueued(uuids.get(String(req.message_uuid)) ?? '', signal());
  }
}

/** Runs a recording through the adapter and the fake, and returns what the
 * host got. */
export async function replay(
  name: string,
  edit?: (p: StartParams) => void,
  o?: Partial<ClaudeAdapterOptions>,
): Promise<{ r: FakeRun; s: Session }> {
  const lines = fixture(name);
  const cans = canned();
  delete cans.initialize;
  const sc: Script = { lines: prepare(lines), canned: cans };
  const r = new FakeRun(sc);
  r.host.answersOf(lines);
  const p = r.params();
  edit?.(p);
  const s = await claudeAdapter({ sdk: devSdk, timing: { titles: [] }, ...o }).start(p, r.host, AbortSignal.timeout(60_000));
  const uuids = new Map<string, string>();
  for (;;) {
    const sig = await r.signal();
    await settle(s, sig.written);
    if (sig.at < 0) break;
    await act(s, sc.lines[sig.at]!, uuids);
  }
  // The answer to the last get_context_usage.
  await quiet(s);
  await s.close(AbortSignal.timeout(20_000));
  return { r, s };
}

/** What the host got, as the Go golden files have it: the events without
 * their times, the permissions and questions in Go's member names, the
 * chat with its first three commands. */
export function goldenOf(r: FakeRun): { events: unknown[]; permissions: unknown[]; questions: unknown[]; chat: unknown } {
  const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const events = r.host.events.map((e) => {
    const { at: _, ...rest } = e;
    return json(rest);
  });
  const c = json(r.host.chat);
  if (c.commands) c.commands = c.commands.slice(0, 3);
  return {
    events,
    permissions: r.host.perms.map((p) => json({ Kind: p.kind, ToolCall: p.toolCall, Options: p.options, Parent: p.parent })),
    questions: r.host.questions.map((q) => json({ Questions: q.questions, ToolCall: q.toolCall, Parent: q.parent })),
    chat: c,
  };
}

/** The Go adapter's golden file of a recording, the parts compared. */
export function goGolden(name: string): { events: unknown[]; permissions: unknown[]; questions: unknown[]; chat: unknown; err?: string } {
  const g = JSON.parse(readFileSync(join(GO_GOLDEN, name.replace(/\.jsonl$/, '') + '.golden.json'), 'utf8')) as Msg;
  return {
    events: (g.events as unknown[] | null) ?? [],
    permissions: (g.permissions as unknown[] | undefined) ?? [],
    questions: (g.questions as unknown[] | undefined) ?? [],
    chat: g.chat,
    ...(g.err ? { err: String(g.err) } : {}),
  };
}

// The Codex adapter's test harness.
//
// Codex's app-server schema as validators: the JSON schema Codex prints
// (spec/codex-app-server), kept verbatim, whose definitions (the top
// level's and v2's, one namespace) are made validators by zod's
// fromJSONSchema. The adapter reads Codex's messages leniently (members and
// values it does not know are passed over); these check that the
// recordings and what the adapter sends are what the pinned schema allows.
//
// The fake app-server (testdata/fakeappserver.ts) playing the recordings of
// spec/vectors/chat/codex or scripts made here, and a host (a Sink) that
// records what it gets, so that the adapter's events can be compared with
// the golden files (testdata/golden) of the same recordings.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NAME } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { defaultHostSettings, type Event } from '#shared/proto/chatproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import type { PermissionAnswer, PermissionRequest, QuestionAnswer, QuestionRequest, Sink, StartParams } from '../adapter.ts';
import type { CodexTiming } from './session.ts';

export const SPEC = join(REPO_ROOT, 'spec', 'codex-app-server');
export const SCHEMA_FILE = 'codex_app_server_protocol.schemas.json';

type Definitions = Record<string, Record<string, unknown>>;

let defs: Definitions | undefined;
const validators = new Map<string, z.ZodType>();

/** The schema's definitions in one namespace: v2's, and the top level's
 * that v2 has not (those it has are the same type), every $ref to v2's
 * made one to the namespace's (zod resolves one level of definitions). */
function definitions(): Definitions {
  if (defs) return defs;
  const root = JSON.parse(readFileSync(join(SPEC, SCHEMA_FILE), 'utf8')) as { definitions: Definitions & { v2: Definitions } };
  const flat: Definitions = { ...root.definitions.v2 };
  for (const [k, v] of Object.entries(root.definitions)) if (k !== 'v2' && !(k in flat)) flat[k] = v;
  defs = JSON.parse(JSON.stringify(flat).replaceAll('"#/definitions/v2/', '"#/definitions/')) as Definitions;
  return defs;
}

/** The validator of a definition of the schema. */
export function validator(name: string): z.ZodType {
  let v = validators.get(name);
  if (!v) {
    const d = definitions();
    if (!d[name]) throw new Error(`the schema has no ${name}`);
    v = z.fromJSONSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: d,
      ...d[name],
    } as z.core.JSONSchema.JSONSchema);
    validators.set(name, v);
  }
  return v;
}

/** Why value is not a name of the schema; "" when it is. */
export function invalid(name: string, value: unknown): string {
  const r = validator(name).safeParse(value);
  return r.success ? '' : `${name}: ${JSON.stringify(r.error.issues).slice(0, 2000)}`;
}

/** The definition of a request's params, of its answer (<Name>Response
 * beside <Name>Params) or of a notification's params, by its method: the
 * union's variant (ClientRequest, ServerRequest, ServerNotification) that
 * has it. */
export function paramsOf(union: string, method: string): string {
  type Ref = { $ref?: string; anyOf?: Ref[] };
  const u = definitions()[union] as { oneOf: Array<{ properties: { method: { enum: string[] }; params?: Ref } }> };
  const v = u.oneOf.find((x) => x.properties.method.enum[0] === method);
  if (!v) throw new Error(`${union} has no ${method}`);
  // The params, or the params or null.
  const p = v.properties.params;
  const ref = p?.$ref ?? p?.anyOf?.find((a) => a.$ref)?.$ref;
  if (!ref) throw new Error(`${union}: ${method} has no params`);
  return ref.replace('#/definitions/', '');
}

export const resultOf = (union: string, method: string): string => paramsOf(union, method).replace(/Params$/, 'Response');

// ---- the fake app-server and the recording host ----

export const VECTORS = join(REPO_ROOT, 'spec', 'vectors', 'chat', 'codex');
/** The golden files of the same recordings (testdata/golden): what the adapter makes of them. */
export const GOLDEN = join(import.meta.dir, 'testdata', 'golden');
const FAKE = join(import.meta.dir, 'testdata', 'fakeappserver.ts');

export const fixture = (name: string): string => join(VECTORS, name);
/** The recording whose answers (model/list, account/read) serve the
 * recordings that lack them. */
export const HANDSHAKE = fixture('01-handshake.jsonl');

/** The fakes' times: a fake ends at once, or never. */
export const TEST_TIMING: CodexTiming = { start: 10_000, interruptGrace: 200, usageEvery: 0, grace: 1000, term: 500, drain: 100 };

/** A temporary directory, its path without links. */
export const tempDir = (prefix = 'codex-'): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export type Msg = Record<string, unknown>;

/** Go's zero chat, which the Go tests' host updates. */
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

const abortOf = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** A Sink that records what a session reports and answers its permissions
 * and questions from queues (or waits, when a queue is empty, for its
 * signal). */
export class TestSink implements Sink {
  readonly events: Event[] = [];
  chat = zeroChat();
  readonly perms: PermissionRequest[] = [];
  readonly questions: QuestionRequest[] = [];
  permAns: PermissionAnswer[] = [];
  questAns: QuestionAnswer[] = [];
  private wake: Array<() => void> = [];

  private poke(): void {
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  event(ev: Event): void {
    this.events.push(ev);
    this.poke();
  }

  async permission(r: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    this.perms.push(r);
    const ans = this.permAns.shift();
    this.poke();
    if (ans) return ans;
    await abortOf(signal);
    return { cancelled: true };
  }

  async question(r: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> {
    this.questions.push(r);
    const ans = this.questAns.shift();
    this.poke();
    if (ans) return ans;
    await abortOf(signal);
    return { cancelled: true };
  }

  update(fn: (c: chat.Chat) => void): void {
    fn(this.chat);
    this.poke();
  }

  count(match: (ev: Event) => boolean): number {
    return this.events.filter(match).length;
  }

  /** Waits until cond holds of what the sink has. */
  async wait(what: string, cond: (k: TestSink) => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond(this)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; events:\n${dump(this.events)}`);
      await new Promise<void>((r) => {
        this.wake.push(r);
        setTimeout(r, 20);
      });
    }
  }
}

export const turnEnds =
  (n: number) =>
  (k: TestSink): boolean =>
    k.count((ev) => ev.t === chat.EventType.Turn && (ev.state === chat.TurnState.End || ev.state === chat.TurnState.Error)) >= n;

/** The events as lines, their times left out. */
export function dump(evs: Event[]): string {
  return evs.map((ev) => JSON.stringify({ ...ev, at: undefined })).join('\n');
}

/** v's JSON with its members sorted. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v !== 'object' || v === null) return JSON.stringify(v);
  return (
    '{' +
    Object.keys(v)
      .filter((k) => (v as Msg)[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical((v as Msg)[k]))
      .join(',') +
    '}'
  );
}

/** The events (their times left out) and the chat as the updates left it,
 * as the Go tests' golden lines. */
export function records(k: TestSink): string[] {
  const lines = k.events.map((ev) => {
    const e = JSON.parse(JSON.stringify(ev)) as Msg;
    delete e.at;
    return canonical(e);
  });
  lines.push(canonical({ chat: JSON.parse(JSON.stringify(k.chat)) }));
  return lines;
}

/** The golden lines of a recording, as records makes them. */
export function goldenLines(name: string): string[] {
  return readFileSync(join(GOLDEN, name + '.golden'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => canonical(JSON.parse(l)));
}

/** The golden files (testdata/golden). */
export const goldens = (): string[] =>
  readdirSync(GOLDEN)
    .filter((f) => f.endsWith('.golden'))
    .map((f) => f.slice(0, -'.golden'.length));

/** A copy of a recording without the client's requests drop tells (by
 * method and the how-manieth of it), and with the pairs of replace
 * replaced. */
export function edited(name: string, drop?: (method: string, n: number) => boolean, ...replace: string[]): string {
  let text = readFileSync(fixture(name), 'utf8');
  for (let i = 0; i + 1 < replace.length; i += 2) text = text.replaceAll(replace[i]!, replace[i + 1]!);
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    const sl = JSON.parse(l) as { dir: string; msg?: Msg };
    const w = sl.msg;
    if (sl.dir === 'out' && w && typeof w.method === 'string' && w.id !== undefined) {
      const n = seen.get(w.method) ?? 0;
      seen.set(w.method, n + 1);
      if (drop?.(w.method, n)) continue;
    }
    out.push(l);
  }
  const path = join(tempDir('codex-script-'), name);
  writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 });
  return path;
}

/** A script of the fake: what its client sends (out) and what it answers
 * and sends on its own (in). */
export class Script {
  static readonly THREAD = '00000000-0000-7000-8000-0000000000aa';
  readonly lines: string[] = [];
  private next = 0;

  line(v: Msg): void {
    this.lines.push(JSON.stringify(v));
  }

  /** A request of the client the fake answers; its id in the recording. */
  request(method: string): number {
    this.next++;
    this.line({ dir: 'out', msg: { id: this.next, method, params: {} } });
    return this.next;
  }

  reply(id: number, result: unknown): void {
    this.line({ dir: 'in', msg: { id, result } });
  }

  fail(id: number, message: string): void {
    this.line({ dir: 'in', msg: { id, error: { code: -32600, message } } });
  }

  notify(method: string, params: unknown): void {
    this.line({ dir: 'in', msg: { method, params } });
  }

  /** A request of the app-server; the fake waits for its answer. */
  ask(id: unknown, method: string, params: unknown): void {
    this.line({ dir: 'in', msg: { id, method, params } });
    this.line({ dir: 'out', msg: { id, result: {} } });
  }

  raw(l: string): void {
    this.line({ dir: 'in', raw: l });
  }

  /** The handshake and a new thread. */
  begin(): void {
    this.reply(this.request('initialize'), { userAgent: 'codex/0.171.0 (test)' });
    this.reply(this.request('thread/start'), { thread: { id: Script.THREAD }, model: 'gpt-6-luna', reasoningEffort: 'low' });
  }

  turnStarted(turn: string): void {
    this.notify('turn/started', { threadId: Script.THREAD, turn: { id: turn, status: 'inProgress', items: [] } });
  }

  turnCompleted(turn: string, status: string): void {
    this.notify('turn/completed', { threadId: Script.THREAD, turn: { id: turn, status, items: [] } });
  }

  item(started: boolean, it: Msg): void {
    this.notify(started ? 'item/started' : 'item/completed', { threadId: Script.THREAD, turnId: 't', item: it });
  }

  file(): string {
    const path = join(tempDir('codex-script-'), 'script.jsonl');
    writeFileSync(path, this.lines.join('\n') + '\n', { mode: 0o600 });
    return path;
  }
}

export const agentMessage = (id: string, text: string): Msg => ({ type: 'agentMessage', id, text, phase: 'final_answer' });

/** A logger that keeps the lines. */
export function logs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: (l) => lines.push(l), lines };
}

/** Fake app-servers playing scripts (the first process the first, and so
 * on), with fallback's answers for what they lack, and their records. */
export class FakeRun {
  readonly dir = tempDir('codex-fake-');
  readonly argv = [process.execPath, FAKE];
  env: Record<string, string>;
  readonly procs = new AgentProcesses();
  readonly log = logs();

  constructor(mode: string, fallback: string, ...scripts: string[]) {
    this.env = {
      FAKE_DIR: this.dir,
      FAKE_SCRIPTS: scripts.join(':'),
      FAKE_MODE: mode,
      HOME: tempDir('codex-home-'),
      PATH: '/usr/bin:/bin',
      ...(fallback ? { FAKE_FALLBACK: fallback } : {}),
    };
  }

  /** What the client sent the n-th process, line by line. */
  received(n: number): Msg[] {
    let text = '';
    try {
      text = readFileSync(join(this.dir, `recv-${n}.jsonl`), 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Msg];
        } catch {
          return [];
        }
      });
  }

  /** The params of the client's requests of a method to the n-th process. */
  requests(n: number, method: string): Msg[] {
    return this.received(n)
      .filter((m) => m.method === method && m.id !== undefined)
      .map((m) => (m.params ?? {}) as Msg);
  }

  /** The client's answers to the app-server's requests to the n-th
   * process, by their ids as JSON. */
  replies(n: number): Map<string, Msg> {
    const out = new Map<string, Msg>();
    for (const m of this.received(n)) if (m.method === undefined && m.id !== undefined) out.set(JSON.stringify(m.id), m);
    return out;
  }

  /** What the n-th process saw happen to it (eof, term). */
  events(n: number): string[] {
    try {
      return readFileSync(join(this.dir, `events-${n}.txt`), 'utf8')
        .split(/\s+/)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  started(): number {
    return readdirSync(this.dir).filter((f) => f.startsWith('started-')).length;
  }

  params(cwd: string, options: chat.Options = {}, resume = ''): StartParams {
    return {
      kind: 'codex',
      argv: this.argv,
      env: this.env,
      cwd,
      procs: this.procs,
      logger: this.log.logger,
      resume,
      sessionId: '',
      options,
      trusted: false,
      client: { name: NAME, version: '1.2.3' },
      settings: defaultHostSettings(),
    };
  }
}

/** What every process of f was asked against the policies the adapter
 * keeps and the pinned schema: threads only read-only and asking the
 * user, turns with their policies, model and collaboration mode, never
 * excludeTmpdirEnvVar, approvals never with an amendment; every request and
 * every answer what the schema allows. The problems found. */
export function policyProblems(f: FakeRun): string[] {
  const out: string[] = [];
  for (let n = 1; n <= f.started(); n++) {
    for (const m of ['thread/start', 'thread/resume'])
      for (const p of f.requests(n, m))
        if (p.sandbox !== 'read-only' || p.approvalPolicy !== 'on-request' || p.approvalsReviewer !== 'user')
          out.push(`process ${n}: ${m} with ${JSON.stringify(p)}`);
    for (const p of f.requests(n, 'turn/start')) {
      const sp = p.sandboxPolicy as Msg | undefined;
      if (!sp || !p.collaborationMode || !p.approvalPolicy || p.approvalsReviewer !== 'user' || !p.model)
        out.push(`process ${n}: turn/start without its policies: ${JSON.stringify(p)}`);
      if (sp?.excludeTmpdirEnvVar === true) out.push(`process ${n}: excludeTmpdirEnvVar set`);
    }
    // The app-server's requests, by their ids, from the recording the
    // process played.
    for (const m of f.received(n)) {
      if (m.method !== undefined && m.id !== undefined) {
        const why = invalid('ClientRequest', m);
        if (why) out.push(`process ${n}: ${why}`);
      } else if (m.method !== undefined) {
        const why = invalid('ClientNotification', m);
        if (why) out.push(`process ${n}: ${why}`);
      } else if (m.result !== undefined) {
        const r = m.result as Msg;
        if ('decision' in r && typeof r.decision !== 'string') out.push(`process ${n}: a decision with an amendment: ${JSON.stringify(r)}`);
      }
    }
  }
  return out;
}

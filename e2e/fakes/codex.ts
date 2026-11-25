// A Codex for the end-to-end tests: `codex app-server --listen stdio://`
// speaks Codex's app-server protocol (v2, as spec/vectors/chat/codex
// records it: JSON-RPC without the jsonrpc member) on its standard input
// and output, deterministic and offline. The tests install it as `codex`
// in a directory of the isolated instance's PATH, so the chat host runs it
// for the kind codex.
//
// What a turn does depends on the prompt's text:
//
//   - "permission <name>": a command that writes <name> in the thread's
//     directory, after item/commandExecution/requestApproval; the file is
//     written only when the user allows it.
//   - "hold": a turn that runs until turn/interrupt.
//   - anything else: "Echo #<n>: <text>", n counting the thread's turns,
//     which the thread keeps across processes (thread/resume), so a test can
//     tell a resumed thread from a new one.
//
// Threads are files below $HOME/.fakecodex; nothing else is written but
// the files the user allows. A thread started or resumed other than
// read-only and asking the user, or a turn without its policies, is what
// the chat host must never ask for: the fake writes it to
// $HOME/.fakecodex/violations, which the tests expect to be missing.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { type Json, type Message, type Obj, Requests, Signal, hasID, paramsOf, send, serve, str } from './lib';

interface Thread {
  id: string;
  cwd: string;
  preview: string;
  turns: number;
  createdAt: number;
  updatedAt: number;
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write('usage: codex app-server --listen stdio:// (a fake Codex for end-to-end tests)\n');
  process.exit(2);
}

const home = homedir();
const dir = join(home, '.fakecodex');
try {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
} catch (e) {
  process.stderr.write(`${e}\n`);
  process.exit(1);
}

const requests = new Requests(0);
/** A thread's running turn. */
const stops = new Map<string, Signal>();

const reply = (id: Json | undefined, result: unknown) => send({ id, result });
const fail = (id: Json | undefined, message: string) => send({ id, error: { code: -32600, message } });
const notify = (method: string, params: unknown) => send({ method, params });

/** Records what the chat host must never ask for. */
function violation(what: string): void {
  try {
    appendFileSync(join(dir, 'violations'), what + '\n', { mode: 0o600 });
  } catch {
    // nothing to record it in
  }
}

function newID(): string {
  const h = randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const now = () => Math.floor(Date.now() / 1000);

function load(id: string): Thread | undefined {
  if (id === '' || /[/.]/.test(id)) return undefined;
  try {
    const v = JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) as Partial<Thread>;
    if (!v || typeof v !== 'object') return undefined;
    return {
      id: typeof v.id === 'string' ? v.id : '',
      cwd: typeof v.cwd === 'string' ? v.cwd : '',
      preview: typeof v.preview === 'string' ? v.preview : '',
      turns: typeof v.turns === 'number' ? v.turns : 0,
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

function save(t: Thread): void {
  const { id, cwd, preview, turns, createdAt, updatedAt } = t;
  try {
    writeFileSync(join(dir, t.id + '.json'), JSON.stringify({ id, cwd, preview, turns, createdAt, updatedAt }), { mode: 0o600 });
  } catch {
    // unsaved
  }
}

function threadInfo(t: Thread): Obj {
  return {
    id: t.id,
    sessionId: t.id,
    preview: t.preview,
    name: null,
    cwd: t.cwd,
    ephemeral: false,
    parentThreadId: null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    cliVersion: '0.171.0',
    modelProvider: 'openai',
    source: 'vscode',
    status: { type: 'idle' },
    turns: [],
    projectId: null,
  };
}

function threadResult(t: Thread): Obj {
  return {
    thread: threadInfo(t),
    model: 'gpt-fake',
    modelProvider: 'openai',
    reasoningEffort: 'low',
    cwd: t.cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
}

/** Whether thread/start's or thread/resume's params keep the thread
 * read-only and asking the user. */
const readOnly = (p: Obj) => p.sandbox === 'read-only' && p.approvalPolicy === 'on-request' && p.approvalsReviewer === 'user';

const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

serve((m: Message) => {
  if (!m.method) {
    // A response to one of ours.
    requests.answer(m);
    return;
  }
  if (!hasID(m)) return; // a notification (initialized)
  const p = paramsOf(m);
  switch (m.method) {
    case 'initialize':
      reply(m.id, {
        userAgent: 'fakecodex/0.171.0 (e2e)',
        codexHome: join(home, '.codex'),
        platformFamily: 'unix',
        platformOs: process.platform,
      });
      break;
    case 'model/list':
      reply(m.id, {
        data: [
          {
            id: 'gpt-fake',
            model: 'gpt-fake',
            displayName: 'GPT Fake',
            description: "The end-to-end tests' model.",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'low',
            inputModalities: ['text', 'image'],
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'high', description: 'Deep' },
            ],
          },
        ],
        nextCursor: null,
      });
      break;
    case 'account/read':
      reply(m.id, { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
      break;
    case 'thread/start': {
      if (!readOnly(p)) violation('thread/start ' + JSON.stringify(m.params ?? null));
      const t: Thread = { id: newID(), cwd: str(p, 'cwd'), preview: '', turns: 0, createdAt: now(), updatedAt: 0 };
      t.updatedAt = t.createdAt;
      save(t);
      reply(m.id, threadResult(t));
      break;
    }
    case 'thread/resume': {
      if (!readOnly(p)) violation('thread/resume ' + JSON.stringify(m.params ?? null));
      const t = load(str(p, 'threadId'));
      if (!t) {
        fail(m.id, 'no rollout found for thread id ' + str(p, 'threadId'));
        return;
      }
      reply(m.id, threadResult(t));
      break;
    }
    case 'thread/list':
      reply(m.id, { data: list(p), nextCursor: null });
      break;
    case 'thread/turns/list':
      reply(m.id, { data: [], nextCursor: null });
      break;
    case 'turn/start':
      for (const k of ['approvalPolicy', 'sandboxPolicy', 'collaborationMode']) {
        if (p[k] === undefined || p[k] === null) violation('turn/start without ' + k);
      }
      if (isObj(p.sandboxPolicy) && p.sandboxPolicy.excludeTmpdirEnvVar === true) violation('turn/start with excludeTmpdirEnvVar');
      startTurn(m.id, p);
      break;
    case 'turn/interrupt': {
      const id = str(p, 'threadId');
      const s = stops.get(id);
      stops.delete(id);
      s?.fire();
      reply(m.id, {});
      break;
    }
    default:
      fail(m.id, 'unknown variant `' + m.method + '`');
  }
});

function list(p: Obj): Obj[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // none
  }
  const ts: Thread[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const t = load(n.slice(0, -'.json'.length));
    if (t) ts.push(t);
  }
  ts.sort((a, b) => b.updatedAt - a.updatedAt);
  const ids = Array.isArray(p.includedThreadIds) ? p.includedThreadIds : [];
  const cwd = str(p, 'cwd');
  return ts.filter((t) => (cwd === '' || t.cwd === cwd) && (ids.length === 0 || ids.includes(t.id))).map(threadInfo);
}

/** Answers turn/start and plays the turn. */
function startTurn(id: Json | undefined, p: Obj): void {
  const threadId = str(p, 'threadId');
  const t = load(threadId);
  if (!t) {
    fail(id, 'thread not found: ' + threadId);
    return;
  }
  const input = Array.isArray(p.input) ? p.input : [];
  const text: string[] = [];
  for (const b of input) {
    if (isObj(b) && b.type === 'text') text.push(typeof b.text === 'string' ? b.text : '');
  }
  const prompt = text.join(' ').trim();
  t.turns++;
  t.updatedAt = now();
  if (t.preview === '') t.preview = prompt;
  save(t);
  const turn = `turn-${t.turns}`;
  const stop = new Signal();
  stops.set(threadId, stop);
  reply(id, { turn: { id: turn, status: 'inProgress', items: [] } });
  notify('turn/started', { threadId, turn: { id: turn, status: 'inProgress', items: [] } });
  const clientId = str(p, 'clientUserMessageId');
  const user = { type: 'userMessage', id: `user-${t.turns}`, content: p.input ?? null, clientId };
  notify('item/started', { threadId, turnId: turn, item: user });
  notify('item/completed', { threadId, turnId: turn, item: user });
  void (async () => {
    const status = await play(t, turn, prompt, stop);
    if (stops.get(threadId) === stop) stops.delete(threadId);
    notify('turn/completed', { threadId, turn: { id: turn, status, items: [] } });
  })();
}

/** Runs a turn's items; its status. */
async function play(t: Thread, turn: string, prompt: string, stop: Signal): Promise<string> {
  const item = (started: boolean, it: unknown) =>
    notify(started ? 'item/started' : 'item/completed', { threadId: t.id, turnId: turn, item: it });
  const say = (text: string) => {
    const id = `msg-${t.turns}`;
    item(true, { type: 'agentMessage', id, text: '', phase: null });
    for (const w of splitAfter(text, ' ')) notify('item/agentMessage/delta', { threadId: t.id, turnId: turn, itemId: id, delta: w });
    item(false, { type: 'agentMessage', id, text, phase: 'final_answer' });
    const usage = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
    notify('thread/tokenUsage/updated', {
      threadId: t.id,
      turnId: turn,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 100000 },
    });
  };
  if (prompt === 'hold') {
    item(true, { type: 'reasoning', id: `think-${t.turns}`, summary: [], content: [] });
    await stop.wait;
    return 'interrupted';
  }
  if (prompt.startsWith('permission ')) {
    const name = base(prompt.slice('permission '.length).trim());
    const id = `cmd-${t.turns}`;
    const command = `/bin/sh -c 'echo written by the fake codex > ${name}'`;
    const cmd: Record<string, unknown> = {
      type: 'commandExecution',
      id,
      command,
      cwd: t.cwd,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
    };
    item(true, cmd);
    const res = await requests.call(
      'item/commandExecution/requestApproval',
      { threadId: t.id, turnId: turn, itemId: id, command, cwd: t.cwd, reason: 'write ' + name, startedAtMs: Date.now() },
      stop,
    );
    if (res === undefined) return 'interrupted';
    const decision = isObj(res) ? res.decision : undefined;
    if (decision === 'accept' || decision === 'acceptForSession') {
      try {
        writeFileSync(join(t.cwd, name), 'written by the fake codex\n', { mode: 0o600 });
      } catch {
        // the item completes all the same
      }
      cmd.status = 'completed';
      cmd.exitCode = 0;
      cmd.aggregatedOutput = '';
      item(false, cmd);
      say('Permission granted, wrote ' + name + '.');
    } else {
      if (isObj(decision)) violation('an approval with an amendment');
      cmd.status = 'declined';
      item(false, cmd);
      say('Permission rejected.');
    }
    return 'completed';
  }
  say(`Echo #${t.turns}: ${prompt}`);
  return 'completed';
}

/** The pieces of s after each separator, which each keeps (the last
 * one maybe empty). */
function splitAfter(s: string, sep: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = s.indexOf(sep); i >= 0; i = s.indexOf(sep, from)) {
    out.push(s.slice(from, i + sep.length));
    from = i + sep.length;
  }
  out.push(s.slice(from));
  return out;
}

/** The last name of a POSIX path ("." for an empty one). */
function base(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return p === '' ? '.' : '/';
  return posix.basename(trimmed);
}

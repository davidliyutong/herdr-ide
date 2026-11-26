// A coding agent for the end-to-end tests: it speaks the Agent Client
// Protocol on its standard input and output as `kimi acp` does
// (spec/vectors/chat/acp), deterministic and offline. The tests install
// it as `kimi` in a directory of the isolated instance's PATH, so the chat
// host runs it for the kind kimi.
//
// What it answers depends on the prompt's text:
//
//   - "permission <name>": a tool call that writes <name> in the session's
//     directory, after a session/request_permission; the file is written
//     only when the user allows it. "permission <name> when <flag>" asks
//     once the file $HOME/<flag> exists, so a test decides when.
//   - "hold": a turn that keeps working until session/cancel.
//   - "demo review": the fixed, rich conversation used by the screenshot generator.
//   - anything else: "Echo #<n>: <text>", n counting the session's turns,
//     which the session keeps across processes (session/resume), so a test
//     can tell a resumed session from a new one.
//
// Sessions are files below $HOME/.fakeacp; nothing else is written but the
// files permission prompts allow.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Json, type Message, type Obj, Requests, Signal, hasID, paramsOf, send, serve, str } from './lib';

interface Session {
  sessionId: string;
  cwd: string;
  title?: string;
  turns: number;
  updatedAt: string;
}

if (process.argv[2] !== 'acp') {
  process.stderr.write('usage: kimi acp (a fake agent for end-to-end tests)\n');
  process.exit(2);
}

const dir = join(homedir(), '.fakeacp');
try {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
} catch (e) {
  process.stderr.write(`${e}\n`);
  process.exit(1);
}

const requests = new Requests(1);
/** A session's running turn. */
const cancels = new Map<string, Signal>();

const msg = (m: Record<string, unknown>) => send({ jsonrpc: '2.0', ...m });
const reply = (id: Json | undefined, result: unknown) => msg({ id, result });
const fail = (id: Json | undefined, code: number, message: string) => msg({ id, error: { code, message } });
const update = (sessionId: string, u: Record<string, unknown>) => msg({ method: 'session/update', params: { sessionId, update: u } });

let lastNano = 0n;
/** A session id of the wall clock in nanoseconds, never one twice. */
function newSessionID(): string {
  let n = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  if (n <= lastNano) n = lastNano + 1n;
  lastNano = n;
  return `fake-${n}`;
}

serve((m: Message) => {
  if (!m.method) {
    // A response to one of ours.
    requests.answer(m);
    return;
  }
  const p = paramsOf(m);
  switch (m.method) {
    case 'initialize':
      reply(m.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [],
        agentInfo: { name: 'Fake ACP agent', version: '1.0.0' },
      });
      break;
    case 'session/new': {
      const s: Session = { sessionId: newSessionID(), cwd: str(p, 'cwd'), turns: 0, updatedAt: '' };
      save(s);
      reply(m.id, { sessionId: s.sessionId, configOptions: configOptions('default') });
      break;
    }
    case 'session/resume':
    case 'session/load':
      if (!load(str(p, 'sessionId'))) {
        fail(m.id, -32002, 'session not found');
        return;
      }
      reply(m.id, { configOptions: configOptions('default') });
      break;
    case 'session/list':
      reply(m.id, { sessions: list(str(p, 'cwd')) });
      break;
    case 'session/set_config_option':
      reply(m.id, { configOptions: configOptions(str(p, 'configId') === 'mode' ? str(p, 'value') : 'default') });
      break;
    case 'session/cancel': {
      const id = str(p, 'sessionId');
      cancels.get(id)?.fire();
      cancels.delete(id);
      break;
    }
    case 'session/prompt': {
      const s = load(str(p, 'sessionId'));
      if (!s) {
        fail(m.id, -32002, 'session not found');
        return;
      }
      let text = '';
      for (const b of Array.isArray(p.prompt) ? p.prompt : []) {
        if (b && typeof b === 'object' && !Array.isArray(b) && b.type === 'text' && typeof b.text === 'string') text += b.text;
      }
      const c = new Signal();
      cancels.set(s.sessionId, c);
      void turn(m.id, s, text.trim(), c);
      break;
    }
    default:
      if (hasID(m)) fail(m.id, -32601, 'method not found');
  }
});

const permissionPrompt = /^permission ([A-Za-z0-9._-]+)(?: when ([A-Za-z0-9._-]+))?$/;

/** Answers one prompt. */
async function turn(id: Json | undefined, s: Session, text: string, cancel: Signal): Promise<void> {
  let stop = 'end_turn';
  const say = (t: string) => update(s.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  try {
    if (!s.title) {
      s.title = text === 'demo review' ? 'Review training stability' : text;
      update(s.sessionId, { sessionUpdate: 'session_info_update', title: s.title });
    }
    const mt = permissionPrompt.exec(text);
    if (mt) {
      const name = mt[1];
      const flag = mt[2];
      if (flag && !(await waitFile(join(dirname(dir), flag), cancel))) {
        stop = 'cancelled';
        return;
      }
      const call = `call-${s.turns + 1}`;
      update(s.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: call,
        title: 'Write ' + name,
        kind: 'edit',
        status: 'pending',
        rawInput: { path: name, content: 'written by the fake agent\n' },
      });
      const res = await requests.call(
        'session/request_permission',
        {
          sessionId: s.sessionId,
          toolCall: { toolCallId: call, title: 'Write ' + name, kind: 'edit' },
          options: [
            { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
        cancel,
        { jsonrpc: '2.0' },
      );
      if (res === undefined) {
        stop = 'cancelled';
        return;
      }
      const outcome = (res as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome;
      if (outcome?.outcome !== 'selected' || outcome.optionId !== 'approve_once') {
        update(s.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed' });
        say('Permission rejected.');
        return;
      }
      let status = 'completed';
      try {
        writeFileSync(join(s.cwd, name), 'written by the fake agent\n', { mode: 0o644 });
      } catch {
        status = 'failed';
      }
      update(s.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: call,
        status,
        content: [{ type: 'content', content: { type: 'text', text: 'Wrote ' + name } }],
      });
      say('Permission granted, wrote ' + name + '.');
    } else if (text === 'hold') {
      say('Holding until cancelled.');
      await cancel.wait;
      stop = 'cancelled';
    } else if (text === 'demo review') {
      update(s.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-training',
        title: 'Read train.py and configs/base.toml',
        kind: 'read',
        status: 'completed',
        rawInput: { path: 'train.py' },
        content: [{ type: 'content', content: { type: 'text', text: '400 steps · learning_rate = 0.0003 · eval_interval = 20' } }],
      });
      update(s.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-training',
        title: 'Update train.py',
        kind: 'edit',
        status: 'completed',
        rawInput: { path: 'train.py' },
        content: [
          {
            type: 'diff',
            path: 'train.py',
            oldText: 'if log_interval(step):\n    print(f"step={step:03d} loss={loss:.4f}")\n',
            newText: 'if log_interval(step):\n    print(f"step={step:03d} loss={loss:.4f} lr={metrics.learning_rate:.1e}")\n',
          },
        ],
      });
      say(
        '## Training review\n\nThe run is stable: validation loss tracks the training curve without divergence.\n\n- Log the learning rate beside every loss value.\n- Keep the ten-step warmup before cosine decay.\n- The schedule is $\\eta_t = \\frac{\\eta_0}{1 + \\gamma t}$.\n\n**Next step:** approve the small logging change, then rerun the 400-step smoke test.',
      );
    } else {
      say(`Echo #${s.turns + 1}`);
      say(': ' + text);
    }
  } finally {
    if (cancels.get(s.sessionId) === cancel) cancels.delete(s.sessionId);
    s.turns++;
    save(s);
    reply(id, { stopReason: stop });
    update(s.sessionId, { sessionUpdate: 'usage_update', used: 1000 * (s.turns + 1), size: 200000 });
  }
}

/** Waits for a file to exist; false when the turn is cancelled. */
async function waitFile(path: string, cancel: Signal): Promise<boolean> {
  for (;;) {
    if (existsSync(path)) return true;
    await Promise.race([cancel.wait, new Promise((r) => setTimeout(r, 50))]);
    if (cancel.fired) return false;
  }
}

function configOptions(mode: string): Obj[] {
  return [
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'fake-model',
      options: [{ value: 'fake-model', name: 'Fake Model' }],
    },
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: mode,
      options: [
        { value: 'default', name: 'Default', description: 'Manual approvals.' },
        { value: 'plan', name: 'Plan', description: 'Read-only planning.' },
      ],
    },
  ];
}

const safeID = /^[A-Za-z0-9-]{1,64}$/;
const pathOf = (id: string) => join(dir, id + '.json');

function save(s: Session): void {
  s.updatedAt = new Date().toISOString();
  const out: Record<string, unknown> = { sessionId: s.sessionId, cwd: s.cwd };
  if (s.title) out.title = s.title;
  out.turns = s.turns;
  out.updatedAt = s.updatedAt;
  try {
    writeFileSync(pathOf(s.sessionId), JSON.stringify(out), { mode: 0o600 });
  } catch {
    // A session that cannot be saved is not one.
  }
}

/** A session read from its file (undefined when it is not one). */
function parse(text: string): Session | undefined {
  try {
    const v = JSON.parse(text) as Partial<Session>;
    if (!v || typeof v !== 'object') return undefined;
    return {
      sessionId: typeof v.sessionId === 'string' ? v.sessionId : '',
      cwd: typeof v.cwd === 'string' ? v.cwd : '',
      title: typeof v.title === 'string' && v.title ? v.title : undefined,
      turns: typeof v.turns === 'number' ? v.turns : 0,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    };
  } catch {
    return undefined;
  }
}

function load(id: string): Session | undefined {
  if (!safeID.test(id)) return undefined;
  try {
    return parse(readFileSync(pathOf(id), 'utf8'));
  } catch {
    return undefined;
  }
}

function list(cwd: string): Obj[] {
  const out: Obj[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    // none
  }
  for (const n of names) {
    let s: Session | undefined;
    try {
      s = parse(readFileSync(join(dir, n), 'utf8'));
    } catch {
      continue;
    }
    if (s && (cwd === '' || s.cwd === cwd)) {
      const o: Obj = { sessionId: s.sessionId, cwd: s.cwd };
      if (s.title) o.title = s.title;
      o.turns = s.turns;
      o.updatedAt = s.updatedAt;
      out.push(o);
    }
  }
  return out;
}

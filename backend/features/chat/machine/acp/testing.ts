// The ACP adapter's test harness: scripts of the fake agent
// (testdata/fakeagent.ts) made of the recordings in spec/vectors/chat/acp,
// and a host (a Sink) that records what it gets as the Go adapter's tests
// record it, so that the TypeScript adapter's records can be compared with
// the Go adapter's golden files (internal/chatadapter/acp/testdata) made of
// the same recordings.
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as chat from '#shared/proto/chatproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import { AgentProcesses } from '../agentproc.ts';
import type { PermissionAnswer, PermissionRequest, QuestionAnswer, Sink, StartParams } from '../adapter.ts';

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const VECTORS = join(REPO, 'spec', 'vectors', 'chat', 'acp');
/** The Go adapter's golden files of the same scenarios. */
export const GO_GOLDEN = join(REPO, 'internal', 'chatadapter', 'acp', 'testdata');
const FAKE = join(import.meta.dir, 'testdata', 'fakeagent.ts');

export type Msg = Record<string, unknown>;

/** A line of a fake's script: a message of a recording, or a directive
 * (exit, child, stubborn). */
export interface Step {
  dir: string;
  msg?: Msg;
  code?: number;
  stderr?: string;
}

/** A temporary directory, its path without links (the recordings' /work). */
export const tempDir = (prefix = 'acp-'): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A recording of spec/vectors/chat/acp as steps, its working directory
 * /work made dir. */
export function recording(agent: string, name: string, dir: string): Step[] {
  return readFileSync(join(VECTORS, agent, name + '.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const r = JSON.parse(l) as { dir: string; msg: unknown };
      return { dir: r.dir, msg: JSON.parse(JSON.stringify(r.msg).replaceAll('"/work', '"' + dir)) as Msg };
    });
}

/** steps without the messages of a method, and the answers to the calls of
 * it. */
export function without(steps: Step[], method: string): Step[] {
  const ids = new Set<string>();
  return steps.filter((s) => {
    const w = s.msg ?? {};
    if (w.method === method) {
      if (s.dir === 'out' && 'id' in w) ids.add(JSON.stringify(w.id));
      return false;
    }
    return !(w.method === undefined && s.dir === 'in' && ids.has(JSON.stringify(w.id)));
  });
}

/** Changes the message of the first step for which fn returns true. */
export function edit(steps: Step[], fn: (m: Msg) => boolean): void {
  for (const s of steps) if (s.msg && fn(s.msg)) return;
  throw new Error('edit: no step changed');
}

/** A step of a message given as JSON text. */
export const msgLine = (dir: string, msg: string): Step => ({ dir, msg: JSON.parse(msg) as Msg });

/** steps from the first client message of method on. */
export function from(steps: Step[], method: string): Step[] {
  const i = steps.findIndex((s) => s.dir === 'out' && s.msg?.method === method);
  return i < 0 ? [] : steps.slice(i);
}

/** The content of the first session/prompt of steps. */
export function promptOf(steps: Step[]): unknown[] {
  const s = steps.find((s) => s.dir === 'out' && s.msg?.method === 'session/prompt');
  if (!s) throw new Error('no prompt');
  return (s.msg!.params as { prompt: unknown[] }).prompt;
}

/** The client's answers to the permissions of steps, in order: the option
 * chosen, "" for cancelled. */
export function answers(steps: Step[]): string[] {
  const out: string[] = [];
  const asked = new Set<string>();
  for (const s of steps) {
    const w = s.msg ?? {};
    if (s.dir === 'in' && w.method === 'session/request_permission') asked.add(JSON.stringify(w.id));
    else if (s.dir === 'out' && w.method === undefined && asked.has(JSON.stringify(w.id))) {
      const r = w.result as { outcome?: { optionId?: string } } | undefined;
      out.push(r?.outcome?.optionId ?? '');
    }
  }
  return out;
}

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

/** A Sink that records what a host gets, with the test's directory written
 * /work: {event} and {permission} in their order, and the chat as the
 * updates left it ({chat}, last). */
export class Host implements Sink {
  readonly dir: string;
  chat = zeroChat();
  readonly recs: Msg[] = [];
  /** The permissions' answers in order: an option, or "" to wait for the
   * cancel. */
  answers: string[] = [];
  asked?: (r: PermissionRequest) => void;
  readonly events: chat.Event[] = [];
  readonly perms: PermissionRequest[] = [];
  private seen = 0;
  private wake: (() => void) | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private record(kind: string, v: unknown): void {
    this.recs.push(JSON.parse(JSON.stringify({ [kind]: v }).replaceAll(this.dir, '/work')) as Msg);
  }

  event(ev: chat.Event): void {
    this.record('event', ev);
    this.events.push(ev);
    this.wake?.();
  }

  update(fn: (c: chat.Chat) => void): void {
    fn(this.chat);
  }

  async permission(r: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    this.record('permission', { Kind: r.kind, ToolCall: r.toolCall, Options: r.options, Parent: r.parent });
    const answer = this.answers.shift() ?? '';
    this.perms.push(r);
    this.wake?.();
    this.asked?.(r);
    if (answer === '') {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { cancelled: true };
    }
    return { option: answer };
  }

  async question(): Promise<QuestionAnswer> {
    throw new Error('no questions in ACP');
  }

  /** Takes events until one that want takes. */
  async await(what: string, want: (ev: chat.Event) => boolean, ms = 10_000): Promise<chat.Event> {
    const deadline = Date.now() + ms;
    for (;;) {
      while (this.seen < this.events.length) {
        const ev = this.events[this.seen++]!;
        if (want(ev)) return ev;
      }
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
      this.wake = null;
    }
  }

  /** Waits for a permission request beyond the first n. */
  async permissionAfter(n: number, ms = 10_000): Promise<PermissionRequest> {
    const deadline = Date.now() + ms;
    while (this.perms.length <= n) {
      if (Date.now() > deadline) throw new Error('no permission');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.perms[n]!;
  }

  /** What the host got, as JSON values, the chat last: as the Go tests'
   * golden lines. */
  lines(): Msg[] {
    return [...this.recs, JSON.parse(JSON.stringify({ chat: this.chat }).replaceAll(this.dir, '/work')) as Msg].map(normalize);
  }
}

/** A record as the comparison with the Go goldens takes it: an info
 * event's chat by its title alone (Go writes the whole of a chat that has
 * only a title). */
function normalize(r: Msg): Msg {
  const ev = r.event as Msg | undefined;
  if (ev?.t === 'info' && ev.chat) return { event: { ...ev, chat: { title: (ev.chat as Msg).title } } };
  return r;
}

/** The Go adapter's golden lines of a scenario, normalized as Host.lines. */
export function goGolden(name: string): Msg[] {
  return readFileSync(join(GO_GOLDEN, name + '.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => normalize(JSON.parse(l) as Msg));
}

/** Writes steps where the fake reads them. */
export function writeScript(steps: Step[]): string {
  const path = join(tempDir('acp-script-'), 'script.jsonl');
  writeFileSync(path, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
  return path;
}

/** A logger that keeps the lines. */
export function logs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: (l) => lines.push(l), lines };
}

/** The start params of the fake playing steps in dir. */
export function fakeParams(
  dir: string,
  steps: Step[],
  procs: AgentProcesses,
  logger: Logger,
  env: Record<string, string> = {},
): StartParams {
  return {
    kind: 'test',
    argv: [process.execPath, FAKE],
    env: { ACP_FAKE_SCRIPT: writeScript(steps), HOME: tempDir('acp-home-'), PATH: '/usr/bin:/bin', ...env },
    cwd: dir,
    procs,
    logger,
    resume: '',
    sessionId: '',
    options: {},
    trusted: false,
    client: { name: 'test-client', version: '1.0' },
    settings: {
      idleStopMinutes: 30,
      maxLive: 8,
      maxChats: 500,
      retentionDays: 30,
      maxTotalBytes: 512 << 20,
      maxChatBytes: 64 << 20,
      defaultMode: 'default',
    },
  };
}

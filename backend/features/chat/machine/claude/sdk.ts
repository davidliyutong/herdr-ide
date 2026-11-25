// The seam to Anthropic's Agent SDK (@anthropic-ai/claude-agent-sdk,
// pinned): what the adapter gives query() beyond its options, and what it
// uses of the SDK that the SDK's types do not declare.
//
// The SDK speaks Claude Code's protocol: it writes the command line and the
// environment, frames the lines, pairs control requests with their answers,
// answers the program's requests (can_use_tool through canUseTool; an MCP
// server's elicitation declined; others refused as unsupported) and hands
// on the program's messages in their order. What it gets from here:
//
//   - spawnClaudeCodeProcess: AgentSpawn runs the program through the host's
//     AgentProcesses (a process group of its own, the end of its standard
//     error kept, ended gracefully, its group swept once it exited), and
//     frames its output before the SDK reads it: a line longer than
//     MAX_LINE is passed over (the SDK's reader has no bound), and the
//     session_state_changed messages the program marks as the host's
//     (sdk_host_only) lose the mark, so that the SDK hands them on in their
//     place among the others (a turn that ends without a result ends at
//     "idle");
//   - Prompts, an AsyncIterable of user messages the SDK writes in order;
//   - cancelAsyncMessage, the SDK's withdrawal of a queued message, which
//     its types do not declare (sdk.test.ts fails when it is gone).
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { Query, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ChatProtoError, Code, MAX_LINE } from '#shared/proto/chatproto/index.ts';
import type { AgentProcess, AgentProcesses, StopTiming } from '../agentproc.ts';

/** The version of the SDK the adapter is built and tested with (the
 * dependency is pinned to it). */
export const SDK_VERSION = '0.3.322';

/** The longest session_state_changed line looked into. */
const STATE_LINE = 4 << 10;

const NL = 0x0a;

/** Hands the lines of a program's output on, each with its newline: a line
 * longer than max bytes is dropped (skipped tells it), and fix may replace
 * a line. */
export class Lines {
  private parts: Buffer[] = [];
  private size = 0;
  /** The line being read is longer than max: its rest is dropped. */
  private long = false;
  private readonly max: number;
  private readonly fix: (line: Buffer) => Buffer;
  private readonly skipped: () => void;

  constructor(max: number, fix: (line: Buffer) => Buffer, skipped: () => void) {
    this.max = max;
    this.fix = fix;
    this.skipped = skipped;
  }

  /** The complete lines chunk ends. */
  write(chunk: Uint8Array): Buffer[] {
    const out: Buffer[] = [];
    const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let i = 0;
    while (i < b.length) {
      const nl = b.indexOf(NL, i);
      const end = nl < 0 ? b.length : nl + 1;
      const piece = b.subarray(i, end);
      i = end;
      if (!this.long) {
        if (this.size + piece.length > this.max + 1) {
          this.long = true;
          this.parts = [];
          this.size = 0;
        } else {
          this.parts.push(Buffer.from(piece));
          this.size += piece.length;
        }
      }
      if (nl < 0) break;
      if (this.long) {
        this.long = false;
        this.skipped();
        continue;
      }
      const line = Buffer.concat(this.parts, this.size);
      this.parts = [];
      this.size = 0;
      out.push(this.fix(line));
    }
    return out;
  }

  /** What is left at the end of the output: a last line without its
   * newline. */
  end(): Buffer[] {
    if (this.long) {
      this.long = false;
      this.skipped();
      return [];
    }
    if (this.size === 0) return [];
    const line = Buffer.concat([...this.parts, Buffer.from('\n')]);
    this.parts = [];
    this.size = 0;
    return [this.fix(line)];
  }
}

/** A session_state_changed line without the sdk_host_only mark the SDK
 * drops those of; any other line as it is. */
export function unhide(line: Buffer): Buffer {
  if (line.length > STATE_LINE || !line.includes('"session_state_changed"') || !line.includes('"sdk_host_only"')) return line;
  let m: unknown;
  try {
    m = JSON.parse(line.toString('utf8'));
  } catch {
    return line;
  }
  if (typeof m !== 'object' || m === null) return line;
  const o = m as Record<string, unknown>;
  if (o.type !== 'system' || o.subtype !== 'session_state_changed' || o.sdk_host_only !== true) return line;
  delete o.sdk_host_only;
  return Buffer.from(JSON.stringify(o) + '\n');
}

/** How a program ended, from AgentProcess.status. */
function exitOf(status: string): { code: number | null; signal: NodeJS.Signals | null } {
  if (status.startsWith('signal: ')) return { code: null, signal: status.slice(8) as NodeJS.Signals };
  const n = Number(status.replace(/^exit status /, ''));
  return { code: Number.isInteger(n) ? n : 1, signal: null };
}

/** What AgentSpawn needs besides the SDK's spawn options. */
export interface SpawnParams {
  procs: AgentProcesses;
  /** The program, argv[0] absolute, and the arguments before the SDK's. */
  argv: string[];
  timing: StopTiming;
  /** A line of the program's output passed over. */
  skipped: () => void;
}

/** The program as the SDK sees it (SpawnedProcess): started through the
 * host's AgentProcesses, its output framed (Lines). The process is ended
 * (AgentProcess.stop) once its output ended or it exited, so what it left
 * in its group goes too; ended settles then. */
export class AgentSpawn extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Settles with the program once it runs; rejects when it cannot start. */
  readonly started: Promise<AgentProcess>;
  /** Settles once the program and its group are gone (never rejects). */
  readonly ended: Promise<void>;
  /** Lines handed to the SDK (tests). */
  lines = 0;
  private proc: AgentProcess | null = null;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private signalled = false;
  private reading = false;
  private done = false;
  private reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> } | null = null;
  private writer: { write(b: Uint8Array): Promise<void>; close(): Promise<void> } | null = null;
  private resolveEnded!: () => void;
  private stopping: Promise<void> | null = null;
  /** The program and its group are gone: its ids may be another's. */
  private gone = false;
  private readonly framer: Lines;
  private readonly timing: StopTiming;

  constructor(p: SpawnParams, o: SpawnOptions) {
    super();
    this.timing = p.timing;
    this.framer = new Lines(MAX_LINE, unhide, p.skipped);
    this.ended = new Promise((r) => (this.resolveEnded = r));
    this.stdout = new Readable({ read: () => void this.pump() });
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.started
          .then((proc) => (this.writer ??= proc.stdin.getWriter()).write(chunk))
          .then(
            () => cb(),
            (e: unknown) => cb(e as Error),
          );
      },
      final: (cb) => {
        this.started.then(
          (proc) => {
            const w = this.writer;
            this.writer = null;
            if (w) void w.close().catch(() => {});
            else proc.closeInput();
            cb();
          },
          () => cb(),
        );
      },
    });
    // The SDK listens too; a write to a program gone is its end, not an
    // error of the host.
    this.stdin.on('error', () => {});
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
    const argv = [...p.argv, ...o.args];
    this.started =
      o.command === p.argv[0]
        ? p.procs.spawn(argv, { cwd: o.cwd ?? '/', env })
        : Promise.reject(new Error(`the SDK runs ${o.command}, not ${p.argv[0]}`));
    this.started.then(
      (proc) => {
        this.proc = proc;
        void proc.exited.then(() => {
          this.exit = exitOf(proc.status());
          this.emit('exit', this.exit.code, this.exit.signal);
          void this.stop();
        });
        void this.pump();
      },
      (e: unknown) => {
        this.exit = { code: null, signal: null };
        this.done = true;
        this.stdout.push(null);
        this.emit('error', e as Error);
        this.resolveEnded();
      },
    );
  }

  get killed(): boolean {
    return this.signalled;
  }

  get exitCode(): number | null {
    return this.exit?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exit?.signal ?? null;
  }

  /** The program's process id while it runs; 0 before and after. */
  get pid(): number {
    return this.proc && !this.proc.gone ? this.proc.pid : 0;
  }

  /** The program, once it runs. */
  get process(): AgentProcess | null {
    return this.proc;
  }

  /** The program's output ended (or it never started): no answer comes. */
  get outputEnded(): boolean {
    return this.done;
  }

  /** Signals the program's group (the SDK's end of a query it closed). */
  kill(signal: NodeJS.Signals): boolean {
    if (!this.proc || this.proc.gone || this.gone) return false;
    this.signalled = true;
    this.proc.signal(signal);
    return true;
  }

  /** Ends the program gracefully (AgentProcess.stop), once; resolves once
   * it and its group are gone. */
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.started.then(
        (proc) => proc.stop(this.timing),
        () => {},
      );
      void this.stopping.then(() => {
        this.gone = true;
        this.resolveEnded();
      });
    }
    return this.stopping;
  }

  /** Ends the program's group at once (SIGKILL), its graceful end begun. */
  killNow(): void {
    void this.stop();
    if (!this.gone) this.proc?.signal('SIGKILL');
  }

  /** Reads the program's output into stdout while the SDK takes it. */
  private async pump(): Promise<void> {
    if (this.reading || this.done || !this.proc) return;
    this.reading = true;
    try {
      const reader = (this.reader ??= this.proc.stdout.getReader());
      for (;;) {
        let r: { done: boolean; value?: Uint8Array };
        try {
          r = await reader.read();
        } catch {
          r = { done: true };
        }
        if (r.done || !r.value) {
          for (const l of this.framer.end()) this.push(l);
          this.done = true;
          this.stdout.push(null);
          void this.stop();
          return;
        }
        let more = true;
        for (const l of this.framer.write(r.value)) more = this.push(l) && more;
        if (!more) return;
      }
    } finally {
      this.reading = false;
    }
  }

  private push(line: Buffer): boolean {
    this.lines++;
    return this.stdout.push(line);
  }
}

/** The SDK's spawnClaudeCodeProcess for p: it keeps the AgentSpawn it made
 * in made. */
export function spawner(p: SpawnParams, made: (s: AgentSpawn) => void): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const s = new AgentSpawn(p, o);
    made(s);
    return s;
  };
}

/** The user's messages of a query, in the order sent: the SDK writes each
 * as it takes it. */
export class Prompts implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  /** Those taken, whose taker has not asked for the next (it writes a
   * message before it asks again). */
  private taken: Array<() => void> = [];
  private readonly settled: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private ended = false;

  /** Sends m; resolves once the SDK wrote it, rejects when the query ended
   * first. */
  send(m: SDKUserMessage): Promise<void> {
    if (this.ended) return Promise.reject(new ChatProtoError({ code: Code.Ended, message: 'claude: the agent ended' }));
    return new Promise((resolve, reject) => {
      this.settled.push({ resolve, reject });
      const w = this.waiting;
      if (w) {
        this.waiting = null;
        this.hand(m, w);
      } else this.queue.push(m);
    });
  }

  /** Ends the messages: those not written fail with err. */
  end(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.settled.splice(0)) s.reject(err);
    this.queue.length = 0;
    // What the SDK took it wrote as it took it.
    for (const r of this.taken.splice(0)) r();
    this.waiting?.({ done: true, value: undefined });
    this.waiting = null;
  }

  private hand(m: SDKUserMessage, to: (r: IteratorResult<SDKUserMessage>) => void): void {
    const s = this.settled.shift();
    if (s) this.taken.push(s.resolve);
    to({ done: false, value: m });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        // The taker asks again: what it took before is written.
        for (const r of this.taken.splice(0)) r();
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        const m = this.queue.shift();
        if (m) return new Promise((r) => this.hand(m, r));
        return new Promise((r) => (this.waiting = r));
      },
      return: () => {
        this.end(new ChatProtoError({ code: Code.Ended, message: 'claude: the agent ended' }));
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** The SDK's Query with its undeclared cancelAsyncMessage. */
interface WithCancel {
  cancelAsyncMessage?: (uuid: string) => Promise<boolean>;
}

/** Withdraws the queued user message uuid before Claude Code takes it
 * (cancel_async_message): true when it was withdrawn, false when the
 * program had taken it. The SDK's Query has it, its types do not declare
 * it; a Query without it throws unsupported (sdk.test.ts fails then). */
export function cancelAsyncMessage(q: Query, uuid: string): Promise<boolean> {
  const f = (q as unknown as WithCancel).cancelAsyncMessage;
  if (typeof f !== 'function')
    return Promise.reject(new ChatProtoError({ code: Code.Unsupported, message: 'claude: the SDK cannot withdraw a queued message' }));
  return f.call(q, uuid);
}

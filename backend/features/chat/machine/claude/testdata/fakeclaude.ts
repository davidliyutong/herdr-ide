// A fake Claude Code for the adapter's tests, run by Bun: it plays a script
// of the program's side of the SDK protocol (a recording of
// spec/vectors/chat/claude, prepared by testing.ts). It writes the "out"
// lines, and at each "in" line waits for the adapter's line that matches
// it, answering the adapter's other control requests from canned answers
// meanwhile (and after the script, until its input ends). It records what
// it got in FAKE_CLAUDE_LOG and tells the test at FAKE_CLAUDE_SOCK where it
// is: {"at": <the script's line>, "written": <lines written so far>} at
// each "in" line, at -1 when the script ended. A run started with
// --allow-dangerously-skip-permissions plays FAKE_CLAUDE_FULL_SCRIPT
// instead when it is set. Run with FAKE_CLAUDE_ROLE=grandchild it is a
// process a fake left in its group ("spawn"): it sleeps, holding the fake's
// output and standard error.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

type Msg = Record<string, unknown>;

/** A line of a script: Dir is in, out, raw (text written as it is), big (a
 * line of n bytes), exit (text on stderr, then exit with code), sleep (n
 * ms), spawn (a process of the fake's group that holds its output and
 * standard error and sleeps; text "stubborn" ignores SIGTERM; its pid is
 * logged). */
interface Line {
  dir: string;
  msg?: Msg;
  text?: string;
  n?: number;
  code?: number;
}

interface Script {
  lines: Line[];
  /** --resume fails as a real newly initialized session does before its
   * first turn was saved. */
  noConversation?: boolean;
  /** The answers to the adapter's own control requests, by subtype; silent
   * the subtypes never answered. */
  canned?: Record<string, unknown>;
  silent?: string[];
}

if (process.env.FAKE_CLAUDE_ROLE === 'grandchild') {
  if (process.env.FAKE_CLAUDE_STUBBORN) process.on('SIGTERM', () => {});
  // Ready: the fake goes on.
  writeSync(3, 'x');
  setTimeout(() => {}, 3_600_000);
} else await main();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let file = process.env.FAKE_CLAUDE_SCRIPT ?? '';
  if (args.includes('--allow-dangerously-skip-permissions') && process.env.FAKE_CLAUDE_FULL_SCRIPT)
    file = process.env.FAKE_CLAUDE_FULL_SCRIPT;
  let sc: Script;
  try {
    sc = JSON.parse(readFileSync(file, 'utf8')) as Script;
  } catch (e) {
    process.stderr.write(`fake: script: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const logFile = process.env.FAKE_CLAUDE_LOG ?? '';
  const record = (r: Msg) => appendFileSync(logFile, JSON.stringify(r) + '\n', { mode: 0o600 });
  const env: Record<string, string> = {};
  for (const k of [
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SDK_READS_SESSION_STATE',
    'CLAUDE_AGENT_SDK_VERSION',
    'NODE_OPTIONS',
    'DEBUG',
    'DEBUG_CLAUDE_AGENT_SDK',
    'KEEP_ME',
  ])
    if (process.env[k] !== undefined) env[k] = process.env[k]!;
  record({ argv: args, env, pid: process.pid });
  if (sc.noConversation)
    for (const a of args) {
      const id = a.startsWith('--resume=') ? a.slice(9) : '';
      if (id) {
        process.stderr.write(`No conversation found with session ID: ${id}\n`);
        process.exit(1);
      }
    }

  let sock: Socket | null = null;
  if (process.env.FAKE_CLAUDE_SOCK) {
    const s = connect(process.env.FAKE_CLAUDE_SOCK);
    await new Promise<void>((r) => {
      s.once('connect', () => r());
      s.once('error', () => r());
    });
    if (!s.destroyed) sock = s;
  }
  const signal = (at: number, written: number) => sock?.write(JSON.stringify({ at, written }) + '\n');

  // The adapter's lines, as they come.
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (l) => {
    queue.push(l);
    wake?.();
  });
  rl.on('close', () => {
    ended = true;
    wake?.();
  });
  const next = async (): Promise<string | null> => {
    while (queue.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
    wake = null;
    return queue.shift() ?? null;
  };

  let written = 0;
  const ids = new Map<string, string>();
  const subst = (s: string) => {
    for (const [from, to] of ids) s = s.replaceAll(`"${from}"`, `"${to}"`);
    return s;
  };
  const write = (s: string) => {
    writeSync(1, s + '\n');
    written++;
  };

  /** Answers a control request of the adapter's from the canned answers;
   * passes over the adapter's answers it does not wait for (to a request it
   * cancelled). false for anything else. */
  const auto = (got: string): boolean => {
    let r: Msg;
    try {
      r = JSON.parse(got) as Msg;
    } catch {
      return false;
    }
    if (r.type === 'control_response' || r.type === 'control_cancel_request') return true;
    if (r.type !== 'control_request') return false;
    const req = (r.request ?? {}) as Msg;
    const sub = String(req.subtype ?? '');
    if (sc.silent?.includes(sub)) return true;
    let resp: unknown = {};
    if (sub === 'set_permission_mode') resp = { mode: req.mode };
    else if (sub === 'set_model') resp = { model: req.model };
    else if (sub === 'interrupt') resp = { still_queued: [] };
    else if (sub === 'cancel_async_message') resp = { cancelled: true, message_uuid: req.message_uuid };
    if (sc.canned && sub in sc.canned) resp = sc.canned[sub];
    write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: r.request_id, response: resp } }));
    return true;
  };

  for (let i = 0; i < sc.lines.length; i++) {
    const l = sc.lines[i]!;
    switch (l.dir) {
      case 'out':
        write(subst(JSON.stringify(l.msg)));
        break;
      case 'raw':
        write(l.text ?? '');
        break;
      case 'big':
        write(`{"type":"assistant","pad":"${'x'.repeat(l.n ?? 0)}"}`);
        break;
      case 'sleep':
        await new Promise((r) => setTimeout(r, l.n ?? 0));
        break;
      case 'spawn': {
        const child = spawn(process.execPath, [import.meta.path], {
          env: { ...process.env, FAKE_CLAUDE_ROLE: 'grandchild', ...(l.text === 'stubborn' ? { FAKE_CLAUDE_STUBBORN: '1' } : {}) },
          stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
        });
        // Once it ignores what it is to ignore.
        await new Promise<void>((r) => {
          (child.stdio[3] as NodeJS.ReadableStream).once('data', () => r());
          child.once('exit', () => r());
        });
        (child.stdio[3] as unknown as { destroy(): void }).destroy();
        child.unref();
        record({ child: child.pid });
        break;
      }
      case 'exit':
        process.stderr.write(l.text ?? '', () => process.exit(l.code ?? 0));
        await new Promise(() => {});
        break;
      case 'in': {
        signal(i, written);
        const want = JSON.parse(subst(JSON.stringify(l.msg))) as Msg;
        for (;;) {
          const got = await next();
          if (got === null) {
            record({ mismatch: `line ${i}: the input ended` });
            process.exit(3);
          }
          record({ got: JSON.parse(got) as unknown });
          const bind = match(want, got);
          if (bind) {
            for (const [k, v] of bind) ids.set(k, v);
            break;
          }
          if (auto(got)) continue;
          record({ mismatch: `line ${i}: want ${JSON.stringify(want)}` });
          process.exit(4);
        }
        break;
      }
    }
  }
  signal(-1, written);
  for (let got = await next(); got !== null; got = await next()) {
    record({ got: JSON.parse(got) as unknown });
    auto(got);
  }
  process.exit(0);
}

/** Whether got is the adapter's line that want stands for, and the ids of
 * want's that got names otherwise (a user message's uuid, a control
 * request's id); null when it is not. */
function match(w: Msg, line: string): Map<string, string> | null {
  let g: Msg;
  try {
    g = JSON.parse(line) as Msg;
  } catch {
    return null;
  }
  if (w.type !== g.type) return null;
  const bind = new Map<string, string>();
  switch (w.type) {
    case 'user': {
      const wm = (w.message ?? {}) as Msg;
      const gm = (g.message ?? {}) as Msg;
      const wc = typeof wm.content === 'string' ? [{ type: 'text', text: wm.content }] : wm.content;
      if (!Bun.deepEquals(wc, gm.content)) return null;
      if (typeof w.uuid === 'string' && w.uuid !== '') bind.set(w.uuid, String(g.uuid));
      return bind;
    }
    case 'control_request': {
      if (!Bun.deepEquals(w.request, g.request)) return null;
      bind.set(String(w.request_id), String(g.request_id));
      return bind;
    }
    case 'control_response': {
      const wr = (w.response ?? {}) as Msg;
      const gr = (g.response ?? {}) as Msg;
      if (wr.request_id !== gr.request_id || wr.subtype !== gr.subtype) return null;
      const wb = (wr.response ?? {}) as Msg;
      const gb = (gr.response ?? {}) as Msg;
      if (wb.behavior !== gb.behavior) return null;
      if (
        wb.behavior === 'allow' &&
        (!Bun.deepEquals(wb.updatedInput, gb.updatedInput) || !Bun.deepEquals(wb.updatedPermissions, gb.updatedPermissions))
      )
        return null;
      return bind;
    }
  }
  return Bun.deepEquals(w, g) ? bind : null;
}

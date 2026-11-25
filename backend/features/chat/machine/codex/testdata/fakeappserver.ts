// A fake Codex app-server for the adapter's tests, started as
// [process.execPath, this file]: it plays a recorded conversation
// (spec/vectors/chat/codex) to whatever client talks to it on its standard
// input and output. The client's requests are matched to the recording's
// by method (and their parameters, where several have the method); what
// the recording's app-server sent after a request is sent again, its
// answers renumbered to the client's ids. A request of the app-server in
// the recording waits for the client's answer before the rest is sent.
//
// The environment:
//
//   FAKE_DIR       where the fake records: started-N (one per process),
//                  recv-N.jsonl (every line the client sent), events-N.txt
//                  (eof, term, timeout, exit)
//   FAKE_SCRIPTS   the recordings, one per process started (the last one for
//                  those after), separated by ":"
//   FAKE_FALLBACK  recordings whose answers serve the requests the process's
//                  own does not have (not used up)
//   FAKE_MODE      ignore-eof: keep running when the input ends;
//                  ignore-term: keep running after SIGTERM
//   FAKE_CHILD     a file: the fake starts a process of its group that
//                  ignores SIGTERM (leftover.ts), which writes its pid there
//
// A recording's line {"dir": "in", "exit": N} ends the fake with status N;
// {"dir": "in", "sleep": N} waits N milliseconds; {"dir": "in", "raw":
// "..."} sends a line as it is; {"dir": "in", "big": N} sends a line of N
// bytes.
import { spawn } from 'node:child_process';
import { appendFileSync, openSync, closeSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

interface Line {
  dir: string;
  sleep?: number;
  msg?: Wire;
  raw?: string;
  big?: number;
  exit?: number;
}

type Wire = { id?: unknown; method?: string; params?: unknown; [k: string]: unknown };

/** What a segment does: send a line, or wait for the answer to a request
 * it sent (the recording's id of it, as JSON). */
type Step = { send: Line } | { await: string };

/** A request of the recording's client and what followed it. */
interface Segment {
  method: string;
  id: string;
  params: Record<string, unknown>;
  steps: Step[];
  used: boolean;
}

/** v's JSON with its members sorted. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v !== 'object' || v === null) return JSON.stringify(v);
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

const hasID = (w: Wire) => w.id !== undefined && w.id !== null;

function load(path: string): { head: Step[]; segs: Segment[] } {
  const head: Step[] = [];
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    const sl = JSON.parse(l) as Line;
    const add = (st: Step) => (cur ? cur.steps.push(st) : head.push(st));
    if (sl.dir !== 'out') {
      add({ send: sl });
      continue;
    }
    const w = sl.msg;
    if (!w) continue;
    if (typeof w.method === 'string' && w.method !== '' && hasID(w)) {
      cur = { method: w.method, id: JSON.stringify(w.id), params: (w.params ?? {}) as Record<string, unknown>, steps: [], used: false };
      segs.push(cur);
    } else if (hasID(w) && w.method === undefined) {
      add({ await: JSON.stringify(w.id) });
    }
  }
  return { head, segs };
}

const dir = process.env.FAKE_DIR!;
let n = 1;
for (; ; n++) {
  try {
    closeSync(openSync(join(dir, `started-${n}`), 'wx', 0o600));
    break;
  } catch {
    // taken by an earlier process
  }
}
const scripts = (process.env.FAKE_SCRIPTS ?? '').split(':');
const script = scripts[Math.min(n, scripts.length) - 1]!;
const recv = join(dir, `recv-${n}.jsonl`);
const events = join(dir, `events-${n}.txt`);
appendFileSync(recv, '');
appendFileSync(events, '');
const mode = process.env.FAKE_MODE ?? '';

const event = (s: string) => appendFileSync(events, s + '\n');
const write = (s: string) => {
  const b = Buffer.from(s + '\n');
  for (let off = 0; off < b.length;) off += writeSync(1, b, off);
};

const { head, segs } = load(script);
const fall: Segment[] = [];
for (const f of (process.env.FAKE_FALLBACK ?? '').split(':')) if (f) fall.push(...load(f).segs);
/** The recording's request ids → the client's. */
const ids = new Map<string, unknown>();

if (process.env.FAKE_CHILD) {
  spawn(process.execPath, [join(import.meta.dir, 'leftover.ts'), process.env.FAKE_CHILD], { stdio: 'ignore' });
}

// Runs until it ends itself or is killed, whatever its input does.
setInterval(() => {}, 1 << 30);

process.on('SIGTERM', () => {
  event('term');
  if (!mode.includes('ignore-term')) process.exit(143);
});

// The client's lines, in order.
const input: Wire[] = [];
let wake = null as (() => void) | null;
let eof = false;
const later: Wire[] = [];

function next(): Promise<Wire | null> {
  return new Promise((resolve) => {
    const take = () => {
      if (input.length > 0) return resolve(input.shift()!);
      if (eof) return resolve(null);
      wake = take;
    };
    take();
  });
}

(async () => {
  let buf = '';
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      appendFileSync(recv, line.replace(/\n$/, '') + '\n');
      try {
        input.push(JSON.parse(line) as Wire);
      } catch {
        // not JSON: recorded only
      }
      const w = wake;
      wake = null;
      w?.();
    }
  }
  event('eof');
  if (!mode.includes('ignore-eof')) process.exit(0);
  eof = true;
  const w = wake;
  wake = null;
  w?.();
})();

/** The recording's request for w: the first unused one of its method whose
 * parameters have most in common with w's, else the fallback's. */
function match(w: Wire): Segment | null {
  const params = (typeof w.params === 'object' && w.params !== null ? w.params : {}) as Record<string, unknown>;
  const pick = (list: Segment[], use: boolean): Segment | null => {
    let best: Segment | null = null;
    let score = -1;
    for (const s of list) {
      if (s.method !== w.method || (use && s.used)) continue;
      let k = 0;
      for (const [key, v] of Object.entries(s.params)) if (key in params && canonical(v) === canonical(params[key])) k++;
      if (k > score) {
        best = s;
        score = k;
      }
    }
    if (best && use) best.used = true;
    return best;
  };
  return pick(segs, true) ?? pick(fall, false);
}

/** Waits for the client's answer to the request id; its requests meanwhile
 * wait for their turn. */
async function awaitAnswer(id: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const w = await Promise.race([
      next(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))),
    ]);
    if (w === 'timeout' || w === null) {
      if (w === 'timeout') wake = null;
      return false;
    }
    if (w.method === undefined && JSON.stringify(w.id) === id) return true;
    if (typeof w.method === 'string' && hasID(w)) later.push(w);
  }
}

/** Plays steps; resolves with an exit status when the fake ends. */
async function play(steps: Step[]): Promise<number | null> {
  for (const st of steps) {
    if ('await' in st) {
      if (!(await awaitAnswer(st.await))) {
        event('timeout ' + st.await);
        return 1;
      }
      continue;
    }
    const l = st.send;
    if (l.exit !== undefined) {
      event('exit');
      return l.exit;
    }
    if (l.sleep) await new Promise((r) => setTimeout(r, l.sleep));
    else if (l.raw !== undefined) write(l.raw);
    else if (l.big) write('x'.repeat(l.big));
    else if (l.msg) {
      const w = l.msg;
      if (w.method === undefined && hasID(w)) {
        // An answer: to the client's id of its request.
        const key = JSON.stringify(w.id);
        if (!ids.has(key)) continue;
        write(JSON.stringify({ ...w, id: ids.get(key) }));
        continue;
      }
      write(JSON.stringify(w));
    }
  }
  return null;
}

const code = await (async (): Promise<number> => {
  const c = await play(head);
  if (c !== null) return c;
  for (;;) {
    const w = later.length > 0 ? later.shift()! : await next();
    if (w === null) await new Promise(() => {}); // ignore-eof: runs until it is killed
    if (!w || typeof w.method !== 'string' || !hasID(w)) continue;
    const seg = match(w);
    if (!seg) {
      write(JSON.stringify({ id: w.id, error: { code: -32600, message: 'fake: no recording of ' + w.method } }));
      continue;
    }
    ids.set(seg.id, w.id);
    const c = await play(seg.steps);
    if (c !== null) return c;
  }
})();
process.exit(code);

// A fake ACP agent for the adapter's tests, started as
// [process.execPath, this file] with ACP_FAKE_SCRIPT naming a script: it
// plays the script and checks what the client sends, as the Go adapter's
// fake (internal/chatadapter/acp/fake_test.go) does.
//
// A script's line is a message of a recording (spec/vectors/chat/acp: "in"
// the agent writes it, "out" the client is to send one like it), or a
// directive: "raw" (msg written as it is), "exit" with code (after writing stderr to its standard
// error), "child" (start a process in its group, its pid written to the
// file of ACP_FAKE_PIDFILE), "stubborn" (ignore SIGTERM and the end of the
// input). The client's lines are checked against the recording's in order,
// but in any order within a run of the client's lines (a cancel and the
// answer of the permission it cancels race); answers go out with the ids
// the client gave the calls. Once through the script it reads its input to
// its end, as an agent does. A client line that does not match fails it:
// exit status 3, the reason on its standard error.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';

interface Step {
  dir: string;
  msg?: Record<string, unknown>;
  code?: number;
  stderr?: string;
}

type Wire = Record<string, unknown>;

/** The methods whose params a client must send as the recording has them
 * (initialize's clientInfo is the client's own). */
const EXACT = new Set([
  'session/new',
  'session/load',
  'session/resume',
  'session/prompt',
  'session/cancel',
  'session/set_config_option',
  'session/set_mode',
  'session/list',
]);

const isResponse = (w: Wire) => typeof w.method !== 'string';

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && same((a as Wire)[k], (b as Wire)[k]));
}

const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as Wire).code : undefined);

function sameInit(a: unknown, b: unknown): boolean {
  const x = { ...(a as Wire) };
  const y = { ...(b as Wire) };
  delete x.clientInfo;
  delete y.clientInfo;
  return same(x, y);
}

/** The first unmatched line of want that got is; -1 and why for none. */
function match(want: Step[], matched: boolean[], got: Wire): [number, string] {
  let why = 'nothing of the recording';
  for (let k = 0; k < want.length; k++) {
    if (matched[k]) continue;
    const w = want[k]!.msg as Wire;
    if (isResponse(w) !== isResponse(got)) continue;
    if (isResponse(w)) {
      if (JSON.stringify(w.id) !== JSON.stringify(got.id)) continue;
      const bothErr = 'error' in w && 'error' in got;
      const neitherErr = !('error' in w) && !('error' in got);
      if (!(neitherErr ? same(w.result, got.result) : bothErr && code(w.error) === code(got.error))) {
        why = 'another answer than ' + JSON.stringify(w);
        continue;
      }
    } else {
      if (w.method !== got.method) continue;
      if (EXACT.has(w.method as string) && !same(w.params, got.params)) {
        why = 'other params than ' + JSON.stringify(w.params);
        continue;
      }
      if (w.method === 'initialize' && !sameInit(w.params, got.params)) {
        why = 'other initialize params than ' + JSON.stringify(w.params);
        continue;
      }
    }
    return [k, ''];
  }
  return [-1, why];
}

/** The client's lines, as they come. */
class Lines {
  private buf = '';
  private queue: string[] = [];
  private waiting: ((l: string | null) => void) | null = null;
  private ended = false;

  constructor() {
    process.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
    });
    process.stdin.on('end', () => {
      this.ended = true;
      this.waiting?.(null);
      this.waiting = null;
    });
  }

  private push(l: string): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w(l);
    } else this.queue.push(l);
  }

  next(ms: number): Promise<string | null | 'timeout'> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting = null;
        resolve('timeout');
      }, ms);
      this.waiting = (l) => {
        clearTimeout(t);
        resolve(l);
      };
    });
  }

  drained(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ended) return resolve();
      process.stdin.on('end', () => resolve());
    });
  }
}

const out = (s: string) => writeSync(1, s + '\n');

async function main(): Promise<number> {
  const steps: Step[] = readFileSync(process.env.ACP_FAKE_SCRIPT!, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Step);
  const lines = new Lines();
  const ids = new Map<string, unknown>();
  let stubborn = false;
  const fail = (i: number, why: string) => {
    writeSync(2, `fake: step ${i + 1}: ${why}\n`);
    return 3;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    switch (s.dir) {
      case 'in': {
        const m = { ...s.msg! };
        if (isResponse(m)) {
          const key = JSON.stringify(m.id);
          if (!ids.has(key)) return fail(i, `a response to a call the client did not make: ${key}`);
          m.id = ids.get(key);
        }
        out(JSON.stringify(m));
        break;
      }
      case 'out': {
        let j = i;
        while (j < steps.length && steps[j]!.dir === 'out') j++;
        const want = steps.slice(i, j);
        const matched = want.map(() => false);
        for (let n = 0; n < want.length; n++) {
          const l = await lines.next(10_000);
          if (l === 'timeout') return fail(i, 'the client sent nothing');
          if (l === null) return fail(i, "the client's output ended");
          let got: Wire;
          try {
            got = JSON.parse(l) as Wire;
          } catch {
            return fail(i, `the client sent ${l}`);
          }
          const [k, why] = match(want, matched, got);
          if (k < 0) return fail(i, `the client sent ${l.trim()}: ${why}`);
          matched[k] = true;
          const w = want[k]!.msg as Wire;
          if (!isResponse(w) && 'id' in w) ids.set(JSON.stringify(w.id), got.id);
        }
        i = j - 1;
        break;
      }
      case 'raw':
        // A line written as it is: an answer to a call nobody made.
        out(JSON.stringify(s.msg));
        break;
      case 'exit':
        if (s.stderr) writeSync(2, s.stderr);
        return s.code ?? 0;
      case 'child': {
        const c = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
        await new Promise((r) => c.once('spawn', r));
        writeFileSync(process.env.ACP_FAKE_PIDFILE!, String(c.pid));
        c.unref();
        break;
      }
      case 'stubborn':
        stubborn = true;
        process.on('SIGTERM', () => {});
        break;
      default:
        return fail(i, `unknown step ${JSON.stringify(s.dir)}`);
    }
  }
  await lines.drained();
  if (stubborn) await new Promise(() => setInterval(() => {}, 1 << 30));
  return 0;
}

process.exit(await main());

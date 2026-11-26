import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentProcesses, Tail, signalGroup } from './agentproc.ts';

const SH = '/bin/sh';
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const timing = { grace: 200, term: 300, drain: 200 };

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  const r = s.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) return out;
    out += new TextDecoder().decode(value);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('agent processes', () => {
  test('a program gets its input, its output is read, its standard error kept at the end', async () => {
    const procs = new AgentProcesses();
    const p = await procs.spawn([SH, '-c', 'cat; echo oops >&2; exit 3'], { cwd: tmpdir(), env });
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode('hello\n'));
    await w.close();
    expect(await readAll(p.stdout)).toBe('hello\n');
    await p.exited;
    await p.stop(timing);
    expect(p.status()).toBe('exit status 3');
    expect(p.stderr()).toBe('oops\n');
    expect(procs.size).toBe(0);
  });

  test('a program that cannot start is refused', async () => {
    const procs = new AgentProcesses();
    await expect(procs.spawn(['/no/such/program'], { cwd: tmpdir(), env })).rejects.toThrow();
    await expect(procs.spawn(['relative'], { cwd: tmpdir(), env })).rejects.toThrow('absolute');
  });

  test('stop: input closed first, then SIGTERM, then SIGKILL for a program that ignores both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentproc-'));
    const procs = new AgentProcesses();
    // Ignores SIGTERM and its input's end; a program it left in its group
    // writes its pid.
    const p = await procs.spawn(
      [SH, '-c', `trap '' TERM HUP INT; (trap '' TERM; sleep 30) & echo $! > ${dir}/bg; while :; do sleep 1; done`],
      {
        cwd: dir,
        env,
      },
    );
    for (let i = 0; i < 100 && !existsText(join(dir, 'bg')); i++) await Bun.sleep(10);
    const bg = Number(readFileSync(join(dir, 'bg'), 'utf8'));
    expect(alive(bg)).toBe(true);
    const t0 = Date.now();
    await p.stop(timing);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timing.grace + timing.term - 50);
    expect(p.status()).toBe('signal: SIGKILL');
    for (let i = 0; i < 100 && alive(bg); i++) await Bun.sleep(10);
    expect(alive(bg)).toBe(false);
    expect(signalGroup(p.pid, 0)).toBe(false);
  });

  test('what a program left in its group goes once it exited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentproc-'));
    const procs = new AgentProcesses();
    const p = await procs.spawn([SH, '-c', `sleep 30 & echo $! > ${dir}/bg; exit 0`], { cwd: dir, env });
    await p.exited;
    const bg = Number(readFileSync(join(dir, 'bg'), 'utf8'));
    expect(alive(bg)).toBe(true);
    expect(procs.size).toBe(1);
    await p.stop(timing);
    for (let i = 0; i < 100 && alive(bg); i++) await Bun.sleep(10);
    expect(alive(bg)).toBe(false);
    expect(procs.size).toBe(0);
  });

  test('the registry signals every live group', async () => {
    const procs = new AgentProcesses();
    const a = await procs.spawn([SH, '-c', 'sleep 30'], { cwd: tmpdir(), env });
    const b = await procs.spawn([SH, '-c', 'sleep 30'], { cwd: tmpdir(), env });
    procs.signal('SIGKILL');
    await Promise.all([a.exited, b.exited]);
    expect([a.status(), b.status()]).toEqual(['signal: SIGKILL', 'signal: SIGKILL']);
    await Promise.all([a.stop(timing), b.stop(timing)]);
    expect(procs.size).toBe(0);
  });

  test('the tail keeps the last bytes as text', () => {
    const t = new Tail(4);
    t.write(Buffer.from('abcdef'));
    expect(t.toString()).toBe('cdef');
    t.write(Buffer.from('gh'));
    expect(t.toString()).toBe('efgh');
    const u = new Tail(3);
    u.write(Buffer.from('é€', 'utf8')); // 2 + 3 bytes: the euro sign's 3
    expect(u.toString()).toBe('€');
  });
});

function existsText(p: string): boolean {
  try {
    return readFileSync(p, 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

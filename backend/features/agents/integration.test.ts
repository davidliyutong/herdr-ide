// Detection and sessions against a real herdr-core in an isolated session
// with its own state, home and configuration (the instance's socket of a
// test agent):
//
//	HC_TEST_BIN=/path/to/herdr-core bun test features/agents/integration.test.ts
//
// (`bun backend/scripts/fetch-hc.ts --exe <file> <os>/<arch>` fetches the pinned
// one.) Without HC_TEST_BIN it skips.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { Op, SessionFrom, readLine, type DetectEvent } from '#shared/proto/agentproto/index.ts';
import type { Terminal } from '#shared/proto/hc/index.ts';
import { call } from '#kernel/agent.ts';
import { dialHC } from '#machine/hidden.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { agentsMachine } from './machine.ts';
import { agentsProtocol } from './protocol.ts';

const bin = process.env.HC_TEST_BIN ?? '';
const SESSION = '5e551011-0000-4000-8000-000000000001';
let r: Rig | undefined;
let core: (...args: string[]) => { status: number | null; out: string };

beforeAll(async () => {
  if (!bin) return;
  r = await rig({ features: [agentsMachine()] });
  const state = join(r.home, 's');
  const cfg = join(r.home, 'c');
  for (const d of [state, cfg]) mkdirSync(d, { mode: 0o700 });
  // The terminal core of the test agent's socket, in a session and with
  // state of its own: never the user's.
  const env = {
    HOME: r.home,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HC_SESSION: `${SLUG}-it`,
    HC_SOCKET: r.agent.hc.socket,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: cfg,
  };
  core = (...args) => {
    const p = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 45_000 });
    return { status: p.status, out: `${p.stdout}${p.stderr}` };
  };
  const started = core('server', 'start', '--json');
  if (started.status !== 0) throw new Error(`server start: ${started.out}`);
});

afterAll(async () => {
  if (!r) return;
  core('server', 'stop', '--json');
  await r.close();
});

/** A stand-in for Claude Code: its record of its process and its session's
 * transcript, as Claude Code writes them, then its screens: a turn in
 * progress, a permission dialog once "block" exists, its prompt once
 * "idle" does. */
const FAKE_CLAUDE = String.raw`#!/bin/sh
dir=$(pwd)
esc=$(printf %s "$dir" | sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$HOME/.claude/sessions" "$HOME/.claude/projects/$esc"
printf '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"%s","sessionId":"%s","timestamp":"2026-11-25T00:00:00.000Z"}\n' "$dir" "${SESSION}" >"$HOME/.claude/projects/$esc/${SESSION}.jsonl"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s000}\n' $$ "${SESSION}" "$dir" "$(date +%s)" >"$HOME/.claude/sessions/$$.json"
printf '\033[2J\033[H\342\234\273 Thinking\342\200\246 (3s \302\267 esc to interrupt)\n'
while [ ! -e block ]; do sleep 0.1; done
printf '\033[2J\033[H Do you want to proceed?\n \342\235\257 1. Yes\n   2. No\n'
while [ ! -e idle ]; do sleep 0.1; done
printf '\033[2J\033[H\342\217\272 Done.\n\342\224\200\342\224\200\342\224\200\n\342\235\257 \n\342\224\200\342\224\200\342\224\200\n'
while :; do sleep 1; done
`;

test.skipIf(!bin)(
  'a program the agent takes for Claude Code: its statuses from its screen, its session from its record, resolved for its directory',
  async () => {
    const signal = AbortSignal.timeout(90_000);
    const dir = join(r!.home, 'w');
    mkdirSync(dir, { mode: 0o700 });
    const script = join(dir, 'claude');
    writeFileSync(script, FAKE_CLAUDE);
    chmodSync(script, 0o700);
    const conn = await dialHC(r!.agent.hc.socket, signal);
    try {
      const { conn: st } = await r!.session.open({ op: Op.Detect, sessions: true }, { signal });
      const term = await conn.call<Terminal>(
        'terminal.run',
        { argv: ['/bin/sh', script], cwd: dir, size: { cols: 80, rows: 24 } },
        { signal },
      );
      const seen: DetectEvent[] = [];
      const until = async (cond: (e: DetectEvent) => boolean, what: string) => {
        for (;;) {
          const e = await readLine<DetectEvent>(st.reader);
          if (e.terminal !== term.address) continue;
          seen.push(e);
          if (cond(e)) return e;
          if (signal.aborted) throw new Error(`no ${what}: ${JSON.stringify(seen)}`);
        }
      };
      await until((e) => e.agent === 'claude' && e.status === 'working', 'working');
      const found = await until((e) => !!e.session, 'session');
      expect([found.session, found.session_source]).toEqual([SESSION, SessionFrom.PID]);
      writeFileSync(join(dir, 'block'), '');
      expect((await until((e) => e.status === 'blocked', 'blocked')).session).toBe(SESSION);
      writeFileSync(join(dir, 'idle'), '');
      await until((e) => e.status === 'done', 'done');
      // The machine has the session's transcript, of this directory.
      const m = machineOf(r!.session);
      expect(await call(m, agentsProtocol, 'resolve', { kind: 'claude', session: SESSION, cwd: dir })).toEqual({ ok: true });
      expect(await call(m, agentsProtocol, 'resolve', { kind: 'claude', session: SESSION, cwd: '/elsewhere' })).toEqual({
        ok: false,
        code: 'other_cwd',
      });
      await conn.call('terminal.kill', { terminal: term.address }, { signal });
      await until((e) => e.agent === '', 'the agent gone');
      st.reader.release();
      st.stream.end();
    } finally {
      conn.close();
    }
  },
  120_000,
);

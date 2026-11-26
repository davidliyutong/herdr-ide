// The agents feature's machine side through the wire, as the hub drives
// it: resolve with the kernel's call (the protocol's schemas check the
// answers), and op detect over a fake terminal core (testdata/fakecore.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { readLine, Op, RESOLVE_OTHER_CWD, TranscriptCode, type DetectEvent, type Reply } from '#shared/proto/agentproto/index.ts';
import { call } from '#kernel/agent.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { Resolver } from '#machine/agents/sessions.ts';
import { machineOf, rig, until, type Rig } from '#machine/testing.ts';
import { MAX_CWD, agentsMachine, resolveSession, type AgentsMachineOptions } from './machine.ts';
import type { SessionResolver } from './machine/detector.ts';
import { agentsProtocol } from './protocol.ts';
import { DetectCore } from './testdata/fakecore.ts';

// The session and the directory of a shared vector's transcript, and a
// Codex session in the same directory.
const CLAUDE_SESSION = 'e6cdc860-1055-488f-9ed2-8b8019061bb9';
const CODEX_SESSION = '01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3';
const VECTOR_CWD = '/home/dev/project';
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The start of a rollout of Codex CLI 0.170.0's of CODEX_SESSION. */
const CODEX_ROLLOUT = [
  `{"timestamp":"2026-11-21T19:44:00.320Z","ordinal":0,"type":"session_meta","payload":{"id":"${CODEX_SESSION}","session_id":"${CODEX_SESSION}","timestamp":"2026-11-21T19:43:47.797Z","cwd":"${VECTOR_CWD}","originator":"codex-tui","cli_version":"0.170.0"}}`,
  '{"timestamp":"2026-11-21T19:44:00.321Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started"}}',
];

const vectorLines = (name: string): string[] =>
  (JSON.parse(readFileSync(posix.join(REPO_ROOT, 'spec/vectors/transcript', `${name}.json`), 'utf8')) as { lines: string[] }).lines;

const rigs: Rig[] = [];
const cores: DetectCore[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) c.close();
  for (const r of rigs.splice(0)) await r.close();
});

async function newRig(o: AgentsMachineOptions = {}): Promise<Rig> {
  const r = await rig({ features: [agentsMachine(o)] });
  rigs.push(r);
  return r;
}

function write(p: string, lines: string[] | string): string {
  mkdirSync(posix.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, Array.isArray(lines) ? lines.map((l) => l + '\n').join('') : lines, { mode: 0o600 });
  return p;
}

describe('resolve', () => {
  // A session resolves when its transcript exists and records the
  // directory asked about, which is compared, never looked at. No answer
  // names a path of the machine.
  test('answers', async () => {
    const r = await newRig();
    const claude = (id: string) => posix.join(r.home, '.claude/projects/-home-dev-project', `${id}.jsonl`);
    write(claude(CLAUDE_SESSION), vectorLines('claude-2.1.330-tools'));
    write(posix.join(r.home, '.codex/sessions/2026/11/21', `rollout-2026-11-21T19-43-47-${CODEX_SESSION}.jsonl`), CODEX_ROLLOUT);
    write(claude(sid(1)) + '.zst', 'x');
    // A transcript that records no directory yet.
    write(claude(sid(2)), ['{"type":"mode","stub":true}']);
    const m = machineOf(r.session);
    const cases: Array<[string, string, string, { ok: boolean; code?: string }]> = [
      ['claude', CLAUDE_SESSION, VECTOR_CWD, { ok: true }],
      ['claude', CLAUDE_SESSION, VECTOR_CWD + '/', { ok: true }],
      ['claude', CLAUDE_SESSION, '/home/dev/./project', { ok: true }],
      ['codex', CODEX_SESSION, VECTOR_CWD, { ok: true }],
      ['claude', CLAUDE_SESSION, '/home/dev', { ok: false, code: RESOLVE_OTHER_CWD }],
      ['codex', CODEX_SESSION, '/home/dev/project2', { ok: false, code: RESOLVE_OTHER_CWD }],
      ['claude', sid(3), VECTOR_CWD, { ok: false, code: TranscriptCode.NotFound }],
      ['codex', CLAUDE_SESSION, VECTOR_CWD, { ok: false, code: TranscriptCode.NotFound }],
      ['claude', sid(2), VECTOR_CWD, { ok: false, code: TranscriptCode.NotFound }],
      ['claude', sid(1), VECTOR_CWD, { ok: false, code: TranscriptCode.Compressed }],
      ['gemini', CLAUDE_SESSION, VECTOR_CWD, { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', '../' + CLAUDE_SESSION, VECTOR_CWD, { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', CLAUDE_SESSION, 'home/dev/project', { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', CLAUDE_SESSION, '', { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', CLAUDE_SESSION, VECTOR_CWD + '\0', { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', CLAUDE_SESSION, '/' + 'a'.repeat(MAX_CWD), { ok: false, code: TranscriptCode.BadRequest }],
      ['claude', CLAUDE_SESSION, '/home/\ud800', { ok: false, code: TranscriptCode.BadRequest }],
    ];
    for (const [kind, session, cwd, want] of cases) {
      const got = await call(m, agentsProtocol, 'resolve', { kind, session, cwd });
      expect([kind, session, cwd, got]).toEqual([kind, session, cwd, want]);
      expect(JSON.stringify(got)).not.toContain(r.home);
    }
  });

  // An unknown action fails (the tail of earlier versions too), and so do
  // a resolve's params of another shape.
  test('bad params', async () => {
    const r = await newRig();
    for (const [action, params] of [
      ['', null],
      ['capture', null],
      ['tail', { refs: [{ kind: 'claude', session: CLAUDE_SESSION, back: true }] }],
      ['resolve', [1]],
      ['resolve', { kind: 'claude', session: 1, cwd: '/' }],
    ] as const) {
      const rep = await r.session.request({ op: Op.Plugin, plugin: 'agents', action, params }).then(
        () => ({ ok: true }) as Reply,
        (e: AgentError) => e.reply!,
      );
      expect([action, rep.ok, rep.code]).toEqual([action, false, 'bad_params']);
    }
  });

  // The resolver keeps what it found between requests: a transcript
  // removed after it was located is not found again.
  test('one resolver for the agent', async () => {
    const home = (await newRig()).home;
    const res = new Resolver({ home });
    const p = write(posix.join(home, '.claude/projects/p', `${sid(5)}.jsonl`), vectorLines('claude-2.1.330-tools'));
    expect(await resolveSession(res, { kind: 'claude', session: sid(5), cwd: VECTOR_CWD })).toEqual({ ok: true });
    writeFileSync(p, '');
    expect(await resolveSession(res, { kind: 'claude', session: sid(5), cwd: VECTOR_CWD })).toEqual({
      ok: false,
      code: TranscriptCode.NotFound,
    });
  });
});

describe('op detect', () => {
  const claudeTerm = (address: string, pid: number, cwd = '/w') => ({
    address,
    state: 'live',
    argv: null,
    cwd,
    cols: 80,
    rows: 24,
    created_ms: 0,
    labels: null,
    screen: '',
    foreground: { pid, name: 'claude', argv: ['claude'], cwd },
    status: { state: 'idle' },
    reported: true,
  });

  async function setup(o: AgentsMachineOptions = {}) {
    const r = await newRig(o);
    const core = new DetectCore();
    cores.push(core);
    await core.listen(r.agent.hc.socket);
    return { r, core };
  }

  const open = async (r: Rig, sessions: boolean) => {
    const { conn } = await r.session.open({ op: Op.Detect, ...(sessions ? { sessions } : {}) });
    return { conn, next: () => readLine<DetectEvent>(conn.reader) };
  };

  test('refused without a terminal core', async () => {
    const r = await newRig();
    const err = await r.session.request({ op: Op.Detect }).then(
      () => null,
      (e: AgentError) => e.reply,
    );
    expect(err?.ok).toBe(false);
    expect(err?.error).toMatch(/^terminal core: /);
  });

  // A stream opened without sessions makes no resolver and reads no
  // session file; with them, the stream has one for the agent's home,
  // whose peers are the detector's.
  test('sessions only when asked', async () => {
    const made: string[] = [];
    const resolver: SessionResolver = { resolve: async () => null, stamp: async () => '' };
    const { r, core } = await setup({
      detect: {
        newResolver: (home, peers) => {
          made.push(home);
          expect(peers('claude', '/w')).toBe(0);
          return resolver;
        },
      },
    });
    core.terminals = [claudeTerm('t1', 400) as never];
    const a = await open(r, false);
    expect(await a.next()).toEqual({ terminal: 't1', agent: 'claude', status: 'idle' });
    expect(made).toEqual([]);
    const b = await open(r, true);
    expect(await b.next()).toEqual({ terminal: 't1', agent: 'claude', status: 'idle' });
    expect(made).toEqual([r.home]);
  });

  // Events follow the terminal core's notifications in order; the stream
  // ends, and with it the connection to the terminal core, when the hub
  // closes it.
  test('follows the terminal core until the hub closes the stream', async () => {
    const { r, core } = await setup();
    core.terminals = [claudeTerm('t1', 1) as never];
    const { conn, next } = await open(r, false);
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'idle' });
    core.notify('event', { seq: 2, type: 'status', terminal: 't1', data: { status: { state: 'working' } } });
    core.notify('event', { seq: 3, type: 'foreground', terminal: 't1', data: { pid: 9, name: 'zsh', argv: ['zsh'], cwd: '/w' } });
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'working' });
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'done' });
    expect(await next()).toEqual({ terminal: 't1', agent: '', status: '' });
    core.notify('missed', { seq: 9, terminals: [claudeTerm('t2', 2)] });
    expect(await next()).toEqual({ terminal: 't2', agent: 'claude', status: 'idle' });
    expect(core.conns.size).toBe(1);
    conn.stream.end();
    await until(() => core.conns.size === 0, 'the connection to the terminal core to end');
  });

  // A program that reports nothing is read from its screen, never with
  // history lines.
  test('the screen of an agent', async () => {
    const { r, core } = await setup({ detect: { timing: { startupGraceMs: 50, pollMs: 20, idleRecheckMs: 10, idleCapMs: 70 } } });
    core.terminals = [{ ...claudeTerm('t1', 1), status: null, reported: false } as never];
    core.screens.set('t1', '✻ Thinking… (3s · esc to interrupt)\n');
    const { next } = await open(r, false);
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'unknown' });
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'working' });
    core.screens.set('t1', ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n');
    expect(await next()).toEqual({ terminal: 't1', agent: 'claude', status: 'blocked' });
    const reads = core.calls.filter((c) => c.method === 'terminal.read');
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) expect(c.params).toEqual({ terminal: 't1' });
  });

  // A terminal core that stops sending (no heartbeat) ends the stream.
  test('a silent terminal core ends the stream', async () => {
    const { r, core } = await setup({ detect: { silenceMs: 150 } });
    core.terminals = [];
    const { conn } = await open(r, false);
    await until(() => core.conns.size === 0, 'the stream to end', 5000);
    expect(await conn.reader.chunk()).toBeNull();
  });
});

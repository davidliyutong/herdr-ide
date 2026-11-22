// An agent comes back in its own session after its terminal core started
// again: the layout's leaf remembers the session the machine found from
// the agent's process (never a guess), and a page types the agent's
// command for that session only when the machine confirmed it for the
// terminal's directory; in every other case the directory's latest
// conversation is continued, as without a session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from '../term/layout';
import {
  confirmSession,
  rememberAgents,
  rememberedSession,
  replaceTerminal,
  RESOLVE_TIMEOUT_MS,
  resumeSession,
  takeResume,
} from '../restore';
import { FakeCore, settle } from './fakeTerms';
import { useStore } from '../state/store';

const S1 = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
const S2 = '1b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
const S3 = '2b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';

/** Values of a leaf's session that must never reach a shell. */
const HOSTILE = [
  'x; rm -rf ~',
  `${S1}; rm -rf ~`,
  '$(reboot)',
  '`reboot`',
  `${S1}\n`,
  `${S1}\nrm -rf ~`,
  S1.toUpperCase(),
  `${S1}0`,
  ` ${S1}`,
  `'${S1}'`,
  `${S1} --dangerously-skip-permissions`,
  '',
];

const layoutOf = (...leaves: L.TerminalLeaf[]): L.Layout => ({
  version: 2,
  workspaces: [{ id: 'wwwwwwww', name: '', cwd: '', tabs: leaves.map((leaf) => ({ root: leaf, focused: leaf.terminal })), selected: 0 }],
  selected: 0,
});
const leaves = (l: L.Layout) => l.workspaces.flatMap((w) => w.tabs.flatMap((t) => L.leavesOf(t.root)));
const leaf = (l: L.Layout | undefined, address: string) => (l ? (L.findLeaf(l, address) as L.TerminalLeaf | undefined) : undefined);
const never = () => false;
/** A terminal's pane, attached, that records what is typed into it. */
const into = (typed: string[]) => ({ attached: true, type: (text: string) => void typed.push(text) });
const claude = (extra: Record<string, unknown> = {}) => FakeCore.term('t1', { pid: 7, agent: 'claude', ...extra });

/** An answer of the resolve route. */
const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

/** Waits until pending promises, messages and the page's writes ran. */
async function flush() {
  for (let i = 0; i < 8; i++) await settle();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useStore.setState({ readOnly: false });
});

describe('the session a leaf remembers', () => {
  it('is the one the machine found from the agent’s process, and follows the record', () => {
    let r = claude({ agent_session: S1, agent_session_source: 'pid' });
    const get = () => r;
    const l = rememberAgents(layoutOf({ terminal: 't1' }), get, never);
    expect(leaves(l)).toEqual([{ terminal: 't1', agent: 'claude', pid: 7, session: S1 }]);
    expect(rememberAgents(l, get, never)).toBe(l);
    // /clear: the agent runs another session.
    r = claude({ agent_session: S2, agent_session_source: 'pid' });
    const cleared = rememberAgents(l, get, never);
    expect(leaves(cleared)).toEqual([{ terminal: 't1', agent: 'claude', pid: 7, session: S2 }]);
    // A guess, a source this page does not know, or none: the leaf keeps its own.
    for (const source of ['guess', '', 'other', undefined]) {
      r = claude({ agent_session: S3, agent_session_source: source });
      expect(rememberAgents(cleared, get, never), String(source)).toBe(cleared);
    }
    // No session known: the leaf keeps its own.
    r = claude();
    expect(rememberAgents(cleared, get, never)).toBe(cleared);
  });

  it('is never a guess, nor a value that is no session id', () => {
    for (const source of ['argv', 'pid', 'fd', 'start', 'hook'])
      expect(rememberedSession(claude({ agent_session: S1, agent_session_source: source })), source).toBe(S1);
    for (const source of ['guess', '', 'Guess', 'pid ', undefined, 7])
      expect(rememberedSession(claude({ agent_session: S1, agent_session_source: source })), String(source)).toBeUndefined();
    for (const bad of [...HOSTILE, 7, null]) {
      const r = claude({ agent_session: bad, agent_session_source: 'argv' });
      expect(rememberedSession(r), String(bad)).toBeUndefined();
      expect(leaves(rememberAgents(layoutOf({ terminal: 't1' }), () => r, never)), String(bad)).toEqual([
        { terminal: 't1', agent: 'claude', pid: 7 },
      ]);
    }
    const guessed = rememberAgents(layoutOf({ terminal: 't1' }), () => claude({ agent_session: S1, agent_session_source: 'guess' }), never);
    expect(leaves(guessed)).toEqual([{ terminal: 't1', agent: 'claude', pid: 7 }]);
  });

  it('of a new agent’s tab is kept until a record names another', () => {
    // The tab started the agent with its session before any record has it.
    const l = layoutOf({ terminal: 't1', render: 'native', session: S1 });
    expect(
      rememberAgents(
        l,
        () => FakeCore.term('t1', { pid: 7 }),
        () => true,
      ),
    ).toBe(l);
    const seen = rememberAgents(l, () => claude(), never);
    expect(leaves(seen)).toEqual([{ terminal: 't1', render: 'native', session: S1, agent: 'claude', pid: 7 }]);
    expect(rememberAgents(seen, () => claude({ agent_session: S2, agent_session_source: 'guess' }), never)).toBe(seen);
    const named = rememberAgents(seen, () => claude({ agent_session: S2, agent_session_source: 'argv' }), never);
    expect(leaf(named, 't1')?.session).toBe(S2);
  });

  it('is forgotten with the agent', () => {
    const l = layoutOf({ terminal: 't1', render: 'native', agent: 'claude', pid: 7, session: S1 });
    const without = () => FakeCore.term('t1', { pid: 7 });
    expect(rememberAgents(l, without, never)).toBe(l);
    expect(leaves(rememberAgents(l, without, (a) => a === 't1'))).toEqual([{ terminal: 't1', render: 'native' }]);
  });

  it('is another agent’s no longer when another agent runs in the terminal', () => {
    const l = layoutOf({ terminal: 't1', agent: 'claude', pid: 7, session: S1 });
    const codex = (extra: Record<string, unknown> = {}) => FakeCore.term('t1', { pid: 7, agent: 'codex', ...extra });
    expect(leaves(rememberAgents(l, () => codex(), never))).toEqual([{ terminal: 't1', agent: 'codex', pid: 7 }]);
    expect(leaves(rememberAgents(l, () => codex({ agent_session: S2, agent_session_source: 'fd' }), never))).toEqual([
      { terminal: 't1', agent: 'codex', pid: 7, session: S2 },
    ]);
  });

  it('stays when the agent’s program was lost, for its resume', () => {
    const l = layoutOf({ terminal: 't1', agent: 'claude', pid: 7, session: S1 });
    const lost = rememberAgents(l, () => FakeCore.term('t1', { pid: 70 }), never);
    expect(leaves(lost)).toEqual([{ terminal: 't1', session: S1, resume: 'claude' }]);
    // Asked for while the new shell runs: unchanged until it is taken.
    expect(
      rememberAgents(
        lost,
        () => FakeCore.term('t1', { pid: 70 }),
        () => true,
      ),
    ).toBe(lost);
  });
});

describe('a terminal started in place of one that ended with its core', () => {
  it('says which one it replaced, and keeps how it is shown and its session', () => {
    const l = layoutOf({ terminal: 't1', render: 'native', session: S1, before: 't0', agent: 'claude', pid: 7 });
    expect(leaves(replaceTerminal(l, 't1', 't5'))).toEqual([
      { terminal: 't5', render: 'native', session: S1, before: 't1', resume: 'claude' },
    ]);
    // An address of a form no leaf may name as `before`: the stale one goes.
    const odd = layoutOf({ terminal: 't1.x', before: 't0' });
    expect(leaves(replaceTerminal(odd, 't1.x', 't5'))).toEqual([{ terminal: 't5' }]);
  });
});

describe('the session a leaf asks to resume', () => {
  it('is one of an agent that resumes by id, and a session id', () => {
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'claude', session: S1 }), 't1')).toEqual({ agent: 'claude', session: S1 });
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'codex', session: S2 }), 't1')).toEqual({ agent: 'codex', session: S2 });
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'claude' }), 't1')).toBeUndefined();
    expect(resumeSession(layoutOf({ terminal: 't1', session: S1, agent: 'claude' }), 't1')).toBeUndefined();
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'gemini', session: S1 }), 't1')).toBeUndefined();
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'rm -rf ~', session: S1 }), 't1')).toBeUndefined();
    expect(resumeSession(layoutOf({ terminal: 't1', resume: 'claude', session: S1 }), 't2')).toBeUndefined();
    for (const bad of [...HOSTILE, 7, null])
      expect(resumeSession(layoutOf({ terminal: 't1', resume: 'claude', session: bad as string }), 't1'), String(bad)).toBeUndefined();
  });

  it('is resumed by its id only as confirmed, else the directory’s latest', () => {
    const l = layoutOf({ terminal: 't1', resume: 'claude', session: S1 });
    expect(takeResume(l, 't1', { agent: 'claude', session: S1 })).toEqual({
      layout: layoutOf({ terminal: 't1', session: S1 }),
      command: `claude --resume ${S1}`,
    });
    expect(takeResume(layoutOf({ terminal: 't1', resume: 'codex', session: S1 }), 't1', { agent: 'codex', session: S1 })!.command).toBe(
      `codex resume ${S1}`,
    );
    // Not confirmed, confirmed for another session or agent: the latest.
    expect(takeResume(l, 't1')!.command).toBe('claude --continue');
    expect(takeResume(l, 't1', { agent: 'claude', session: S2 })!.command).toBe('claude --continue');
    expect(takeResume(l, 't1', { agent: 'codex', session: S1 })!.command).toBe('claude --continue');
    // A hostile session is never put into the command, confirmed or not.
    for (const bad of HOSTILE) {
      const hostile = layoutOf({ terminal: 't1', resume: 'claude', session: bad });
      expect(takeResume(hostile, 't1', { agent: 'claude', session: bad })!.command, bad).toBe('claude --continue');
      expect(takeResume(hostile, 't1')!.command, bad).toBe('claude --continue');
    }
  });
});

describe('the machine’s confirmation of a session', () => {
  it('asks the agents plugin about the kind, the session and the directory', async () => {
    const fetch = vi.fn(() => answer({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    expect(await confirmSession('m 1', 'claude', S1, '/srv/a b&c')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url, 'http://host');
    expect(u.pathname).toBe('/api/m/m%201/p/agents/resolve');
    expect([...u.searchParams]).toEqual([
      ['kind', 'claude'],
      ['session', S1],
      ['cwd', '/srv/a b&c'],
    ]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is no confirmation for any other answer', async () => {
    for (const [name, reply] of [
      ['other directory', () => answer({ ok: false, code: 'other_cwd' })],
      ['no such session', () => answer({ ok: false, code: 'not_found' })],
      ['compressed', () => answer({ ok: false, code: 'compressed' })],
      ['plugin off', () => answer({ error: 'plugin_disabled' }, 404)],
      ['offline', () => answer({ error: 'offline' }, 409)],
      ['ok in an error', () => answer({ ok: true }, 500)],
      ['ok not a boolean', () => answer({ ok: 'true' })],
      ['not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
      ['a list', () => answer([true])],
      ['failed', () => Promise.reject(new TypeError('network'))],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(reply));
      expect(await confirmSession('m', 'claude', S1, '/srv/app'), name).toBe(false);
    }
  });

  it('makes no request for what the route would refuse', async () => {
    const fetch = vi.fn(() => answer({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    for (const bad of [...HOSTILE, 7 as unknown as string]) expect(await confirmSession('m', 'claude', bad, '/srv/app'), bad).toBe(false);
    for (const agent of ['gemini', 'nobody', '__proto__', 'claude '])
      expect(await confirmSession('m', agent, S1, '/srv/app'), agent).toBe(false);
    for (const cwd of [undefined, '', 'srv/app', '~/app', './app', '/srv/\0app', `/${'x'.repeat(4096)}`])
      expect(await confirmSession('m', 'claude', S1, cwd), String(cwd)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await confirmSession('m', 'claude', S1, `/${'x'.repeat(4095)}`)).toBe(true);
  });

  it('is none after the time to answer, and a later answer is ignored', async () => {
    vi.useFakeTimers();
    let reply!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>((resolve) => (reply = resolve));
      }),
    );
    let result: boolean | undefined;
    void confirmSession('m', 'claude', S1, '/srv/app').then((ok) => (result = ok));
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(signal?.aborted).toBe(true);
    reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe(false);
  });
});

describe('a page resuming an agent', () => {
  /** A machine whose kept terminals t1 and t2 (in /srv/app) lost the
   * agents the layout remembers with their sessions. */
  const machine = (sessions: Array<string | undefined>, agent = 'claude') => {
    const core = new FakeCore();
    const records = sessions.map((_, i) => FakeCore.term(`t${i + 1}`, { pid: 70 + i, cwd: '/srv/app' }));
    const tabs = sessions.map((session, i) => ({
      terminal: `t${i + 1}`,
      agent,
      pid: 7 + i,
      ...(session === undefined ? {} : { session }),
    }));
    const fm = core.machine('m', records, layoutOf(...tabs));
    return { core, fm };
  };
  const resolveCalls = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.map((c) => Object.fromEntries(new URL(c[0] as string, 'http://host').searchParams));

  it('brings two agents of one kind in one directory back in their own sessions', async () => {
    const { core } = machine([S1, S2]);
    const fetch = vi.fn(() => answer({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const model = core.install();
    model.subscribe('m');
    await flush();
    expect(leaves(model.layout('m')!)).toEqual([
      { terminal: 't1', session: S1, resume: 'claude' },
      { terminal: 't2', session: S2, resume: 'claude' },
    ]);
    const t1: string[] = [];
    const t2: string[] = [];
    model.resumeAgent('m', 't1', into(t1));
    model.resumeAgent('m', 't2', into(t2));
    await flush();
    expect(t1).toEqual([`claude --resume ${S1}\r`]);
    expect(t2).toEqual([`claude --resume ${S2}\r`]);
    expect(resolveCalls(fetch)).toEqual([
      { kind: 'claude', session: S1, cwd: '/srv/app' },
      { kind: 'claude', session: S2, cwd: '/srv/app' },
    ]);
    expect(leaves(core.layout('m')!)).toEqual([
      { terminal: 't1', session: S1 },
      { terminal: 't2', session: S2 },
    ]);
    // Taken once: nothing is asked or typed again.
    model.resumeAgent('m', 't1', into(t1));
    await flush();
    expect(t1).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resumes a Codex session by its id', async () => {
    const { core } = machine([S1], 'codex');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer({ ok: true })),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await flush();
    expect(typed).toEqual([`codex resume ${S1}\r`]);
  });

  it('continues the directory’s latest when the machine does not confirm the session', async () => {
    for (const [name, reply] of [
      ['other directory', () => answer({ ok: false, code: 'other_cwd' })],
      ['no such session', () => answer({ ok: false, code: 'not_found' })],
      ['plugin off', () => answer({ error: 'plugin_disabled' }, 404)],
      ['failed', () => Promise.reject(new TypeError('network'))],
    ] as const) {
      const { core } = machine([S1]);
      const fetch = vi.fn(reply);
      vi.stubGlobal('fetch', fetch);
      const model = core.install();
      model.subscribe('m');
      await flush();
      const typed: string[] = [];
      model.resumeAgent('m', 't1', into(typed));
      await flush();
      expect(fetch, name).toHaveBeenCalledTimes(1);
      expect(typed, name).toEqual(['claude --continue\r']);
      expect(leaves(core.layout('m')!), name).toEqual([{ terminal: 't1', session: S1 }]);
    }
  });

  it('continues the latest without asking for a leaf without a session or with a hostile one', async () => {
    for (const session of [undefined, ...HOSTILE]) {
      const { core } = machine([session]);
      const fetch = vi.fn(() => answer({ ok: true }));
      vi.stubGlobal('fetch', fetch);
      const model = core.install();
      model.subscribe('m');
      await flush();
      const typed: string[] = [];
      model.resumeAgent('m', 't1', into(typed));
      await flush();
      expect(fetch, String(session)).not.toHaveBeenCalled();
      expect(typed, String(session)).toEqual(['claude --continue\r']);
    }
  });

  it('continues the latest when the machine does not answer in time, and ignores a later answer', async () => {
    const { core } = machine([S1]);
    let reply!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (reply = resolve))),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    vi.useFakeTimers();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await vi.advanceTimersByTimeAsync(RESOLVE_TIMEOUT_MS - 1);
    expect(typed).toEqual([]);
    // Still asked for while the answer is on its way.
    expect(leaf(core.layout('m'), 't1')?.resume).toBe('claude');
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await flush();
    expect(typed).toEqual(['claude --continue\r']);
    reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await flush();
    expect(typed).toEqual(['claude --continue\r']);
    expect(leaves(core.layout('m')!)).toEqual([{ terminal: 't1', session: S1 }]);
  });

  it('asks once while an answer is on its way, and types into the newest pane', async () => {
    const { core } = machine([S1]);
    let reply!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (reply = resolve)));
    vi.stubGlobal('fetch', fetch);
    const model = core.install();
    model.subscribe('m');
    await flush();
    const first: string[] = [];
    const second: string[] = [];
    model.resumeAgent('m', 't1', into(first));
    model.resumeAgent('m', 't1', into(second));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await flush();
    expect(first).toEqual([]);
    expect(second).toEqual([`claude --resume ${S1}\r`]);
  });

  it('types nothing when its write of the layout lost', async () => {
    const { core, fm } = machine([S1]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer({ ok: true })),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    const handle = core.handle.bind(core);
    let first = true;
    core.handle = (msg) => {
      if (first && msg.t === 'call' && msg.method === 'doc.set') {
        first = false;
        // Another page took the request (and typed) just before.
        fm.layout = layoutOf({ terminal: 't1', session: S1 });
        fm.version++;
      }
      handle(msg);
    };
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await flush();
    expect(core.calls.filter((c) => c.method === 'doc.set').length).toBeGreaterThan(0);
    expect(typed).toEqual([]);
    expect(leaves(model.layout('m')!)).toEqual([{ terminal: 't1', session: S1 }]);
  });

  it('types nothing when another page took the request while the answer was on its way', async () => {
    const { core, fm } = machine([S1]);
    let reply!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (reply = resolve))),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await flush();
    fm.layout = layoutOf({ terminal: 't1', session: S1 });
    fm.version++;
    core.event('m', 'doc', '', { name: 'layout', version: fm.version });
    await flush();
    const writes = core.calls.filter((c) => c.method === 'doc.set').length;
    reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await flush();
    expect(typed).toEqual([]);
    expect(core.calls.filter((c) => c.method === 'doc.set').length).toBe(writes);
  });

  it('resumes by the id only while the leaf names the session confirmed', async () => {
    const { core, fm } = machine([S1]);
    let reply!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (reply = resolve))),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await flush();
    // Another client wrote another session meanwhile.
    fm.layout = layoutOf({ terminal: 't1', session: S2, resume: 'claude' });
    fm.version++;
    core.event('m', 'doc', '', { name: 'layout', version: fm.version });
    await flush();
    reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await flush();
    expect(typed).toEqual(['claude --continue\r']);
  });

  /** A machine whose t1 asks for its agent back, a question for its
   * session on its way, and a pane of it: answer() replies. */
  async function asking() {
    const { core, fm } = machine([S1]);
    let reply!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (reply = resolve)));
    vi.stubGlobal('fetch', fetch);
    const model = core.install();
    model.subscribe('m');
    await flush();
    const typed: string[] = [];
    const pane = { attached: true, type: (text: string) => void typed.push(text) };
    model.resumeAgent('m', 't1', pane);
    await flush();
    const confirm = async () => {
      reply(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await flush();
    };
    return { core, fm, model, fetch, typed, pane, confirm };
  }

  it('leaves the request for the next attach when the pane is not attached, or gone, once the answer came', async () => {
    const { core, model, fetch, typed, pane, confirm } = await asking();
    // Attaching again (for a prelude), or unmounted: input reaches nothing.
    pane.attached = false;
    await confirm();
    expect(typed).toEqual([]);
    expect(leaf(core.layout('m'), 't1')?.resume).toBe('claude');
    // Its next attach asks again and types.
    pane.attached = true;
    model.resumeAgent('m', 't1', pane);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    await confirm();
    expect(typed).toEqual([`claude --resume ${S1}\r`]);
    expect(leaf(core.layout('m'), 't1')?.resume).toBeUndefined();
  });

  it('leaves the request when the terminal got another program while the answer was on its way', async () => {
    const { core, typed, confirm } = await asking();
    core.event('m', 'restarted', 't1', FakeCore.term('t1', { pid: 71, cwd: '/srv/app' }));
    await flush();
    await confirm();
    expect(typed).toEqual([]);
    expect(leaf(core.layout('m'), 't1')?.resume).toBe('claude');
  });

  it('leaves the request when the user started a program in the shell meanwhile, and types once the shell waits again', async () => {
    const { core, model, typed, pane, confirm } = await asking();
    core.event('m', 'foreground', 't1', { pid: 900, name: 'vim', cwd: '/srv/app' });
    await flush();
    await confirm();
    expect(typed).toEqual([]);
    expect(leaf(core.layout('m'), 't1')?.resume).toBe('claude');
    // The shell at its prompt again: its own program in the foreground.
    core.event('m', 'foreground', 't1', { pid: 70, name: 'zsh', cwd: '/srv/app' });
    await flush();
    model.resumeAgent('m', 't1', pane);
    await flush();
    await confirm();
    expect(typed).toEqual([`claude --resume ${S1}\r`]);
  });

  it('types nothing once the request was taken if the terminal runs something else by the time the layout is written', async () => {
    const { core, typed, confirm } = await asking();
    const handle = core.handle.bind(core);
    core.handle = (msg) => {
      // The user starts a program just before the core takes the layout.
      if (msg.t === 'call' && msg.method === 'doc.set') core.event('m', 'foreground', 't1', { pid: 900, name: 'vim', cwd: '/srv/app' });
      handle(msg);
    };
    await confirm();
    expect(typed).toEqual([]);
    // Taken: nothing more happens.
    expect(leaf(core.layout('m'), 't1')?.resume).toBeUndefined();
  });

  it('asks nothing and types nothing in a read-only page', async () => {
    useStore.setState({ readOnly: true });
    const core = new FakeCore();
    core.machine('m', [FakeCore.term('t1', { pid: 70, cwd: '/srv/app' })], layoutOf({ terminal: 't1', session: S1, resume: 'claude' }));
    const fetch = vi.fn(() => answer({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const model = core.install();
    model.subscribe('m');
    await flush();
    const typed: string[] = [];
    model.resumeAgent('m', 't1', into(typed));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
    expect(core.calls.some((c) => c.method === 'doc.set')).toBe(false);
  });

  it('remembers the session the record names, follows /clear, and never writes a guess', async () => {
    const core = new FakeCore();
    core.machine(
      'm',
      [FakeCore.term('t1', { pid: 70, agent: 'claude', agent_session: S1, agent_session_source: 'guess' })],
      layoutOf({ terminal: 't1' }),
    );
    const model = core.install();
    model.subscribe('m');
    await flush();
    expect(leaves(core.layout('m')!)).toEqual([{ terminal: 't1', agent: 'claude', pid: 70 }]);
    core.event('m', 'agent', 't1', { agent_session: S1, agent_session_source: 'pid' });
    await flush();
    expect(leaves(core.layout('m')!)).toEqual([{ terminal: 't1', agent: 'claude', pid: 70, session: S1 }]);
    // /clear starts another session.
    core.event('m', 'agent', 't1', { agent_session: S2, agent_session_source: 'pid' });
    await flush();
    expect(leaf(core.layout('m'), 't1')?.session).toBe(S2);
    core.event('m', 'agent', 't1', { agent_session: S3, agent_session_source: 'guess' });
    await flush();
    expect(leaf(core.layout('m'), 't1')?.session).toBe(S2);
  });
});

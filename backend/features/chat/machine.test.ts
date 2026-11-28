import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { extended } from '#shared/testdata/extended.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import { Fail } from '#shared/lib/fail.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { CHAT_HOST_NAME } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Stream } from '#shared/proto/yamux.ts';
import type { ActionContext, MachineEnv } from '#machine/feature.ts';
import { chatMachine } from './machine.ts';
import { Client, eventually, text } from './machine/host/testing.ts';

setDefaultTimeout(30_000);

const HOST = join(import.meta.dir, 'testdata', 'hostmain.ts');

interface Hidden {
  name: string;
  argv: string[];
  child: ChildProcess;
  exited: Promise<void>;
}

/** A machine whose terminal core runs each hidden terminal as a child of
 * the test, a name to one live terminal at a time. */
class FakeMachine {
  readonly home = mkdtempSync('/tmp/cm');
  readonly run = join(this.home, 'r');
  readonly base = join(this.home, 'b');
  readonly sock = join(this.run, chat.SOCKET_NAME);
  readonly terminals = new Map<string, Hidden>();
  readonly runs: string[][] = [];
  noCore = false;
  /** The variables of the next terminal's program. */
  env: Record<string, string> = {};
  readonly all: Hidden[] = [];

  constructor() {
    mkdirSync(this.run, { mode: 0o700 });
    mkdirSync(this.base, { mode: 0o700 });
  }

  live(name: string): Hidden | undefined {
    const t = this.terminals.get(name);
    return t && t.child.exitCode === null && t.child.signalCode === null ? t : undefined;
  }

  machineEnv(): MachineEnv {
    return {
      instance: '',
      home: this.home,
      base: this.base,
      host: this.base,
      run: this.run,
      logger: () => {},
      expand: (p) => p,
      environ: () => ({}),
      hcSocket: join(this.run, 'hc.sock'),
      sessions: () => [],
      runHidden: async (name, argv) => {
        if (this.noCore) throw new Fail('no_terminal_core', 503, 'the terminal core is not running');
        this.runs.push(argv);
        if (this.live(name)) return;
        const child = spawn(argv[0]!, argv.slice(1), {
          env: { ...process.env, HOME: this.home, ...this.env },
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        const t = { name, argv, child, exited };
        this.terminals.set(name, t);
        this.all.push(t);
      },
      killHidden: async (name, _argv, kill) => {
        const t = this.live(name);
        if (!t) return false;
        if (!kill) return true;
        process.kill(-t.child.pid!, 'SIGKILL');
        await t.exited;
        return true;
      },
      signal: new AbortController().signal,
    } as MachineEnv;
  }

  async cleanup(): Promise<void> {
    for (const t of this.all) {
      try {
        process.kill(-t.child.pid!, 'SIGKILL');
      } catch {
        // gone
      }
      await t.exited;
    }
    rmSync(this.home, { recursive: true, force: true });
  }
}

let machines: FakeMachine[] = [];
afterEach(async () => {
  for (const m of machines) await m.cleanup();
  machines = [];
});

const timing = { startMs: 4000, pollMs: 20, askAgainMs: 100, askMaxMs: 400, stopGraceMs: 2000, goneMs: 20 };

/** Opens a connection to m's chat host as the hub's stream would: the
 * reply, then the host's lines. */
async function open(m: FakeMachine, o: { start?: boolean; version?: string } = {}) {
  const side = chatMachine({ timing, command: () => [process.execPath, HOST], version: o.version ?? 'v1.1.0' });
  const served = side.start(m.machineEnv());
  const [ours, theirs] = duplexPair();
  let reply: unknown = null;
  const ctx = { ...m.machineEnv(), client: 'hub-1', signal: new AbortController().signal } as ActionContext;
  const done = served.actions.open(o.start === undefined ? {} : { start: o.start }, ctx, {
    stream: theirs as unknown as Stream,
    reader: new Reader(theirs),
    reply: async (r) => {
      reply = r ?? 'ok';
    },
  });
  const failed = await Promise.race([
    done.then(
      () => null,
      (e) => e as Fail,
    ),
    eventually('replied', () => reply !== null).then(() => null),
  ]);
  if (failed) {
    ours.destroy();
    throw failed;
  }
  const c = await Client.fromStream(ours);
  return { c, done };
}

async function hostOf(m: FakeMachine, env: Record<string, string> = {}) {
  m.env = env;
  const { c } = await open(m, { version: env.TEST_HOST_VERSION ?? 'v1.1.0' });
  c.close();
  m.env = {};
}

describe('the chat feature on a machine', () => {
  test("open starts a host as a hidden terminal and carries the host's protocol", async () => {
    const m = new FakeMachine();
    machines.push(m);
    const { c } = await open(m);
    expect(c.hello?.host.proto).toBe(chat.PROTO);
    // Asked again while the host starts, one terminal of the name.
    const asked = m.runs.length;
    expect(m.all).toHaveLength(1);
    expect(m.runs[0]!.slice(2)).toEqual(['chat-host', '--base', m.base, '--run', m.run]);
    expect(m.terminals.has(CHAT_HOST_NAME)).toBe(true);
    await c.send({ op: chat.Op.Chats });
    expect(await c.next()).toEqual({ ok: true, chats: [] });
    // A second open finds the host that serves.
    const again = await open(m);
    expect(again.c.hello?.host.pid).toBe(c.hello?.host.pid);
    expect(m.runs).toHaveLength(asked);
    // A watch carries what follows its answer.
    await again.c.send({ op: chat.Op.Watch });
    expect(await again.c.next()).toEqual({ ok: true, states: [] });
    c.close();
    again.c.close();
  });

  test('open without start when no host serves; no terminal core', async () => {
    const m = new FakeMachine();
    machines.push(m);
    await expect(open(m, { start: false })).rejects.toMatchObject({ code: 'not_running' });
    m.noCore = true;
    await expect(open(m)).rejects.toMatchObject({ code: 'no_terminal_core' });
  });

  test('a host of the same build is kept, a newer one never replaced', async () => {
    const m = new FakeMachine();
    machines.push(m);
    await hostOf(m, { TEST_HOST_VERSION: 'v2.0.0' });
    const first = m.live(CHAT_HOST_NAME)!.child.pid;
    const { c } = await open(m, { version: 'v1.1.0' });
    expect(c.hello?.host.version).toBe('v2.0.0');
    expect(c.hello?.host.pid).toBe(first!);
    c.close();
  });

  test("an older build's host makes way when idle; one with a chat at work is used as it is", async () => {
    const m = new FakeMachine();
    machines.push(m);
    await hostOf(m, { TEST_HOST_VERSION: 'v1.0.0' });
    const old = m.live(CHAT_HOST_NAME)!;
    // A chat that works keeps it.
    const n = await open(m, { version: 'v1.0.0' });
    await n.c.send({ op: chat.Op.New, kind: 'fake', cwd: m.home });
    const created = (await n.c.next()) as chat.Response;
    expect(created.ok).toBe(true);
    const a = await open(m, { version: 'v1.0.0' });
    await a.c.send({ op: chat.Op.Attach, chat: created.chat!.id });
    await a.c.next();
    await eventually('idle', async () => {
      const s = await open(m, { start: false });
      await s.c.send({ op: chat.Op.Chats });
      const r = (await s.c.next()) as chat.Response;
      s.c.close();
      return r.chats?.[0]?.state === 'idle';
    });
    await a.c.send({ op: 'prompt', id: 'p', content: text('work') });
    const busy = await open(m, { version: 'v1.1.0' });
    expect(busy.c.hello?.host.version).toBe('v1.0.0');
    busy.c.close();
    // Once idle, it makes way.
    await a.c.send({ op: 'cancel', id: 'x' });
    await eventually('idle again', async () => {
      const s = await open(m, { start: false });
      await s.c.send({ op: chat.Op.Chats });
      const r = (await s.c.next()) as chat.Response;
      s.c.close();
      return r.chats?.[0]?.state === 'idle';
    });
    a.c.close();
    n.c.close();
    const fresh = await open(m, { version: 'v1.1.0' });
    expect(fresh.c.hello?.host.version).toBe('dev');
    await old.exited;
    fresh.c.close();
  });

  test('an idle host of an older dirty build at the same commit makes way for a newer dirty build', async () => {
    const m = new FakeMachine();
    machines.push(m);
    const vOld = 'v0.5.0-219-gb30fecf-dirty.1795770000';
    const vNew = 'v0.5.0-219-gb30fecf-dirty.1795784576';
    await hostOf(m, { TEST_HOST_VERSION: vOld });
    const old = m.live(CHAT_HOST_NAME)!;
    // An even older dirty build never downgrades it.
    const older = await open(m, { version: 'v0.5.0-219-gb30fecf-dirty.1795760000' });
    expect(older.c.hello?.host.version).toBe(vOld);
    expect(older.c.hello?.host.pid).toBe(old.child.pid!);
    older.c.close();
    // A newer dirty build at the same commit replaces the idle host.
    m.env = { TEST_HOST_VERSION: vNew };
    const fresh = await open(m, { version: vNew });
    expect(fresh.c.hello?.host.version).toBe(vNew);
    expect(fresh.c.hello?.host.pid).not.toBe(old.child.pid!);
    await old.exited;
    fresh.c.close();
  });

  test('a host of another protocol that does not make way: upgrading', async () => {
    const m = new FakeMachine();
    machines.push(m);
    m.env = { TEST_HOST_PROTO: '3', TEST_HOST_VERSION: 'v1.0.0' };
    await expect(open(m, { version: 'v1.0.0' })).rejects.toMatchObject({ code: 'upgrading' });
    await expect(open(m, { version: 'v1.1.0' })).rejects.toMatchObject({ code: 'upgrading' });
    await expect(open(m, { start: false })).rejects.toMatchObject({ code: 'upgrading' });
  });

  extended("a terminal that holds the host's name and serves nothing is killed, and a host started", async () => {
    const m = new FakeMachine();
    machines.push(m);
    m.env = { TEST_HOST_SILENT: '1' };
    const p = open(m);
    await eventually('the silent terminal', () => !!m.live(CHAT_HOST_NAME));
    const stuck = m.live(CHAT_HOST_NAME)!;
    m.env = {};
    const { c } = await p;
    await stuck.exited;
    expect(c.hello?.host.proto).toBe(chat.PROTO);
    expect(m.runs.length).toBeGreaterThan(1);
    c.close();
  });
});

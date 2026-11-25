// From a client of /api/v1/term to programs in a real herdr-core
// (HC_TEST_BIN), through the local machine's node of the Go machine build
// (AGENT_TEST_BIN, else built here with go): the core installs the
// executable on the machine, starts the terminal core and the client runs
// shells in it. Everything runs in a temporary home under the instance
// ts-term, whose node and terminal core are stopped at the end; skipped
// without HC_TEST_BIN.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL, Op } from '#shared/proto/agentproto/index.ts';
import { discard } from '#shared/lib/log.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { CORE_BIN } from '#shared/lib/brand.ts';
import { dialNode, localPlatform } from '#kernel/machines/transport/local.ts';
import { localSpec, running, testCore, testMachines, waitFor, type TestCore } from '#kernel/testing.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { terminalsFeature, type TerminalsFeature } from './core.ts';
import { FrameKind } from './messages.ts';
import { errKind, TestClient } from './testing.ts';

const HC = process.env.HC_TEST_BIN ?? '';
const INSTANCE = 'ts-term';
const M = 'local';

describe.skipIf(!HC)('a real herdr-core', () => {
  let home = '';
  let agentBin = '';
  const saved: Record<string, string | undefined> = {};
  let tc: TestCore;
  let feature: TerminalsFeature;
  let machines: Machines;
  let stop: () => Promise<void>;
  const clients: TestClient[] = [];
  const client = async () => {
    const c = await TestClient.open(tc);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    const base = existsSync(`/tmp/claude-${process.getuid?.()}`) ? `/tmp/claude-${process.getuid?.()}` : '/tmp';
    home = mkdtempSync(join(base, 'tt-'));
    const { os, arch } = localPlatform();
    agentBin = process.env.AGENT_TEST_BIN ?? join(home, `${CORE_BIN}-${os}-${arch}`);
    if (!process.env.AGENT_TEST_BIN)
      execFileSync('go', ['build', '-trimpath', '-o', agentBin, `./cmd/${CORE_BIN}`], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    // The node and the terminal core it starts live in the temporary home.
    for (const [k, v] of Object.entries({
      HOME: home,
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_RUNTIME_DIR: undefined,
      SSH_CONNECTION: undefined,
      CLAUDE_CONFIG_DIR: undefined,
    })) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const exe = readFileSync(HC);
    const hc = { gz: gzipSync(exe), digest: createHash('sha256').update(exe).digest('hex') };
    const bin = readFileSync(agentBin);
    const builds = async () => ({ kind: 'go' as const, bin, version: createHash('sha256').update(bin).digest('hex').slice(0, 16) });
    machines = testMachines([localSpec()], {
      dial: async (_spec, signal) => ({
        session: await dialNode({ instance: INSTANCE, builds, logger: discard, signal }),
        platform: `${os}/${arch}`,
      }),
    });
    feature = terminalsFeature({ hc: async () => hc });
    tc = testCore({ features: [feature], machines, settings: { 'terminal.sshEnv': true, 'plugins.agents.enabled': true } });
    stop = running(tc.core);
    await waitFor('the local machine', () => machines.get(M)!.ready, 30_000);
  }, 180_000);

  afterAll(async () => {
    for (const c of clients) if (!c.ended) c.close();
    try {
      await machines?.get(M)?.request({ op: Op.HC, action: 'stop' }, { timeoutMs: 30_000 });
    } catch {
      // stopped below
    }
    await stop?.();
    if (home) {
      try {
        execFileSync(agentBin, ['node', 'stop', '--instance', INSTANCE, '--terminal-core'], {
          env: { ...process.env, HOME: home },
          stdio: 'ignore',
          timeout: 30_000,
        });
      } catch {
        // nothing ran
      }
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (home) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  const run = async (c: TestClient, rid: number, params: object): Promise<string> => {
    const m = await c.call(rid, 'terminal.run', params, M);
    expect(m.error).toBeUndefined();
    return (m.result as { address: string }).address;
  };

  test('a shell, typed into and read, watched, killed', async () => {
    const c = await client();
    await c.ready(M);
    const events = tc.audit.records().map((x) => x.event);
    expect(events).toContain('term.install');
    expect(events).toContain('term.start');
    const addr = await run(c, 1, { argv: ['/bin/sh'], cwd: '/', size: { cols: 80, rows: 24 } });
    c.send({ t: 'attach', rid: 2, m: M, terminal: addr, cols: 100, rows: 30 });
    const sid = (await c.until('attached', 10_000)).s as number;
    c.bin(sid, FrameKind.Data, 'echo term-$((40+2)) $(stty size)\r');
    let out = '';
    while (!out.includes('term-42 30 100')) {
      const m = await c.until('bin', 10_000);
      out += m.data as string;
      c.send({ t: 'ack', s: sid, n: Buffer.byteLength(m.data as string, 'latin1') });
    }
    // A second client finds the terminal in its snapshot and watches it.
    const c2 = await client();
    c2.send({ t: 'sub', m: M });
    const terms = (await c2.until('snapshot')).terminals as Record<string, unknown>[];
    expect(terms.find((t) => t.address === addr)).toMatchObject({ cols: 100 });
    c2.send({ t: 'attach', rid: 1, m: M, terminal: addr, cols: 100, rows: 30, observe: true });
    out = '';
    while (!out.includes('term-42 30 100')) {
      const m = await c2.until('bin', 10_000).catch((e) => {
        throw new Error(`${e.message}: ${JSON.stringify(out)}`);
      });
      if (m.kind === FrameKind.Data) out += m.data as string;
    }
    // Not c.call: the stream's end may come before the reply.
    c.send({ t: 'call', rid: 3, m: M, method: 'terminal.kill', params: { terminal: addr } });
    expect((await c.until('closed', 10_000)).reason).toBe('killed');
  }, 60_000);

  // Typing into a real shell the way program windows do: the record says
  // it waits at its prompt, and the text typed as a viewer of its size runs.
  test('shells', async () => {
    const c = await client();
    await c.ready(M);
    const addr = await run(c, 1, { argv: ['/bin/sh'], cwd: '/' });
    const sh = feature.shells(M)!;
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(100)) {
      const s = await sh.shell(addr).catch(() => ({ pid: 0, idle: false }));
      if (s.pid > 0 && s.idle) break;
      if (Date.now() > deadline) throw new Error('the shell never waited at its prompt');
    }
    const conn = feature.existing(M)!.connection()!;
    const size = async () => {
      const r = await conn.call<{ cols: number; rows: number }>('terminal.get', { terminal: addr });
      return [r.cols, r.rows];
    };
    const before = await size();
    await sh.send(addr, 'echo typed-$((40+2))\r');
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(100)) {
      const r = await conn.call<{ text?: string }>('terminal.read', { terminal: addr });
      if (r.text?.includes('typed-42')) break;
      if (Date.now() > deadline) throw new Error(`screen ${r.text}`);
    }
    expect(await size()).toEqual(before);
    expect(before[0]).toBeGreaterThan(0);
  }, 60_000);

  // A terminal run as the agent runs the chat host (the reserved name and
  // the hidden label) is in no snapshot or list and reached by no address,
  // name or core-prefixed form, also as it starts; one that carries the
  // label without the name stays the clients'.
  test('hidden terminals', async () => {
    const c = await client();
    await c.ready(M);
    await c.until('snapshot');
    const b = feature.existing(M)!;
    const conn = b.connection()!;
    const core = b.coreInfo();
    expect(core.id && core.name).toBeTruthy();
    const runCore = async (name: string, labels: Record<string, string>) =>
      (
        await conn.call<{ address: string }>('terminal.run', {
          argv: ['/bin/sh'],
          cwd: '/',
          labels,
          size: { cols: 80, rows: 24 },
          no_parent: true,
          ...(name ? { name } : {}),
        })
      ).address;
    const hiddenLabels = { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST };
    const mine = await run(c, 1, { argv: ['/bin/sh'], cwd: '/' });
    const labeled = await runCore('', hiddenLabels);
    let hidden = await runCore(CHAT_HOST_NAME, hiddenLabels);
    await waitFor('the backend has it hidden', () => b.isHidden(hidden), 10_000);
    const c2 = await client();
    c2.send({ t: 'sub', m: M });
    const snap = ((await c2.until('snapshot')).terminals as { address: string }[]).map((t) => t.address);
    expect([snap.includes(hidden), snap.includes(mine), snap.includes(labeled)]).toEqual([false, true, true]);
    const list = (
      ((await c.call(2, 'terminal.list', { all: true }, M)).result as { terminals: { address: string }[] }).terminals ?? []
    ).map((t) => t.address);
    expect([list.includes(hidden), list.includes(labeled)]).toEqual([false, true]);

    let rid = 10;
    const targets = [
      hidden,
      CHAT_HOST_NAME,
      `${core.id}/${hidden}`,
      `${core.name}/${hidden}`,
      `${core.id}/${CHAT_HOST_NAME}`,
      `${core.name}/${CHAT_HOST_NAME}`,
    ];
    for (const target of targets) {
      expect([target, errKind(await c.call(++rid, 'terminal.read', { terminal: target }, M))]).toEqual([target, 'not_found']);
      for (const observe of [false, true]) {
        c.send({ t: 'attach', rid: ++rid, m: M, terminal: target, cols: 80, rows: 24, observe });
        expect([target, errKind(await c.until('res'))]).toEqual([target, 'not_found']);
      }
    }
    const sh = feature.shells(M)!;
    for (const target of [hidden, CHAT_HOST_NAME, `${core.name}/${hidden}`]) {
      await expect(sh.shell(target)).rejects.toThrow('not_found');
      await expect(sh.send(target, 'echo typed\r')).rejects.toThrow();
    }
    expect(sh.all()).not.toContain(hidden);
    // As it happens: a client attaches as soon as the terminal exists.
    for (let i = 0; i < 5; i++) {
      await conn.call('terminal.kill', { terminal: hidden }).catch(() => {});
      for (const deadline = Date.now() + 10_000; ; await Bun.sleep(20)) {
        const rec = await conn.call<{ state?: string }>('terminal.get', { terminal: hidden }).catch(() => null);
        if (rec?.state !== 'live') break;
        if (Date.now() > deadline) throw new Error('the hidden terminal did not end');
      }
      hidden = await runCore(CHAT_HOST_NAME, hiddenLabels);
      c.send({ t: 'attach', rid: ++rid, m: M, terminal: hidden, cols: 80, rows: 24 });
      expect(await c.until('res', 10_000)).toMatchObject({ rid, error: { kind: 'not_found' } });
    }
    // Another machine's terminal is refused; the clients' own terminals
    // stay theirs.
    expect(errKind(await c.call(++rid, 'terminal.read', { terminal: `far/${mine}` }, M))).toBe('not_found');
    expect((await c.call(++rid, 'terminal.read', { terminal: `${core.name}/${mine}` }, M)).error).toBeUndefined();
    c.send({ t: 'attach', rid: ++rid, m: M, terminal: labeled, cols: 80, rows: 24, observe: true });
    expect((await c.until('attached', 10_000)).rid).toBe(rid);
    const audit = tc.audit.records();
    expect(audit.some((x) => x.reason === 'hidden')).toBe(true);
    expect(audit.some((x) => x.reason === 'machine')).toBe(true);
    await conn.call('terminal.kill', { terminal: hidden }).catch(() => {});
  }, 120_000);

  // A program the agent takes for Claude Code, followed through the agent's
  // detection to /api/v1/term: working, blocked, done.
  test('agent detection', async () => {
    const dir = mkdtempSync(join(home, 'd-'));
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'claude');
    writeFileSync(
      script,
      `#!/bin/sh
d=$(dirname "$0")
printf '\\033[2J\\033[H\\342\\234\\273 Thinking\\342\\200\\246 (3s \\302\\267 esc to interrupt)\\n'
while [ ! -e "$d/block" ]; do sleep 0.1; done
printf '\\033[2J\\033[H Do you want to proceed?\\n \\342\\235\\257 1. Yes\\n   2. No\\n'
while [ ! -e "$d/idle" ]; do sleep 0.1; done
printf '\\033[2J\\033[H\\342\\217\\272 Done.\\n\\342\\224\\200\\342\\224\\200\\342\\224\\200\\n\\342\\235\\257 \\n\\342\\224\\200\\342\\224\\200\\342\\224\\200\\n'
while :; do sleep 1; done
`,
    );
    chmodSync(script, 0o700);
    const c = await client();
    await c.ready(M);
    const addr = await run(c, 1, { argv: ['/bin/sh', script], cwd: dir });
    const status = async (want: string) => {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        const m = await c.until('event', 30_000);
        if (m.type !== 'agent' || m.terminal !== addr) continue;
        const d = m.data as Record<string, unknown>;
        expect([d.agent, d.agent_session]).toEqual(['claude', null]);
        if (d.agent_status === want) return;
      }
      throw new Error(`no ${want}`);
    };
    const ws: object[] = [];
    const unsub = machines.subscribe({ agent: (ev) => void ws.push(ev.data as object) });
    await status('working');
    writeFileSync(join(dir, 'block'), '');
    await status('blocked');
    writeFileSync(join(dir, 'idle'), '');
    await status('done');
    await waitFor('/ws agent messages', () =>
      ['blocked', 'done'].every((s) => ws.some((x) => JSON.stringify(x).includes(`"agent_status":"${s}"`))),
    );
    unsub();
    c.send({ t: 'call', rid: 2, m: M, method: 'terminal.kill', params: { terminal: addr } });
    for (;;) {
      const m = await c.until('event', 30_000);
      if (m.type === 'agent' && m.terminal === addr && (m.data as Record<string, unknown>).agent === null) break;
    }
  }, 120_000);
});

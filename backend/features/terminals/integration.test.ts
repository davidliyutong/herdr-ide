// From a client of /api/v1/term to programs in a real herdr-core
// (HC_TEST_BIN), through the local machine's node of the machine build
// (AGENT_TEST_BIN, else built here with backend/scripts/build.ts): the hub
// installs the executable on the machine, starts the terminal core and the client runs
// shells in it. Everything runs in a temporary home under the instance
// ts-term, whose node and terminal core are stopped at the end; skipped
// without HC_TEST_BIN.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL, Op } from '#shared/proto/agentproto/index.ts';
import { dataDir } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { call } from '#kernel/agent.ts';
import { dialNode, localPlatform } from '#kernel/machines/transport/local.ts';
import { bareName, machineKey, type MachineBuild } from '#kernel/machines/transport/builds.ts';
import { localSpec, running, testHub, testMachines, waitFor, type TestHub } from '#kernel/testing.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import { historyProtocol } from '#features/history/protocol.ts';
import { loadCache } from '#features/usage/machine/cache.ts';
import { usageProtocol } from '#features/usage/protocol.ts';
import { terminalsFeature, type TerminalsFeature } from './hub.ts';
import { ensure } from './lifecycle.ts';
import { FrameKind } from './messages.ts';
import { errKind, TestClient } from './testing.ts';

const HC = process.env.HC_TEST_BIN || Bun.which('hc') || '';
const INSTANCE = 'ts-term';
const M = 'local';

describe.skipIf(!HC)('a real herdr-core', () => {
  let home = '';
  let agentBin = '';
  const saved: Record<string, string | undefined> = {};
  let tc: TestHub;
  let feature: TerminalsFeature;
  let machines: Machines;
  let stop: () => Promise<void>;
  let workspaceEnvHook:
    ((ws: string) => Promise<{ env: Record<string, string>; names: string[]; presets: string[] } | undefined>) | undefined;
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
    const key = machineKey({ os, arch });
    agentBin = process.env.AGENT_TEST_BIN ?? join(home, bareName(key));
    if (!process.env.AGENT_TEST_BIN)
      execFileSync(process.execPath, [join(REPO_ROOT, 'backend', 'scripts', 'build.ts'), '--out', agentBin, '--version', 'test-term'], {
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
    // The executable as the hub's own: uploaded, checked by its digest.
    const bin = readFileSync(agentBin);
    const digest = createHash('sha256').update(bin).digest('hex');
    const builds = async (): Promise<MachineBuild> => ({
      kind: 'ts',
      key,
      digests: async () => ({ exe: digest, source: 'test' }),
      load: async () => ({ kind: 'gz', bytes: gzipSync(bin) }),
    });
    machines = testMachines([localSpec()], {
      dial: async (_spec, signal) => ({
        session: await dialNode({ instance: INSTANCE, builds, logger: discard, signal }),
        platform: `${os}/${arch}`,
      }),
    });
    feature = terminalsFeature({
      hc: async () => hc,
      workspaceEnv: async (_m, ws) => workspaceEnvHook?.(ws),
    });
    tc = testHub({ features: [feature], machines, settings: { 'terminal.sshEnv': true, 'plugins.agents.enabled': true } });
    stop = running(tc.hub);
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

  test('the compiled node serves history and persists usage from its embedded workers', async () => {
    const m = machines.get(M)!;
    expect((await call(m, historyProtocol, 'list', {})).terminals).toEqual([]);
    const projects = join(home, '.claude', 'projects', '-work');
    mkdirSync(projects, { recursive: true });
    const path = join(projects, 'sample.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        cwd: '/work',
        message: { role: 'assistant', id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20 } },
      }) + '\n',
    );
    const result = await call(m, usageProtocol, 'cost', { since: 0, providers: ['claude'] });
    expect(result.rows).toHaveLength(1);
    expect((await loadCache(join(home, dataDir(INSTANCE)))).files.has(path)).toBe(true);
  }, 30_000);

  test('concurrent ensures share a single terminal core upload and start', async () => {
    const exe = readFileSync(HC);
    const artifact = { gz: gzipSync(exe), digest: createHash('sha256').update(exe).digest('hex') };
    const m = machines.get(M)!;
    let waiting = 0;
    const ready = Promise.withResolvers<void>();
    const hc = async () => {
      if (++waiting === 2) ready.resolve();
      await ready.promise;
      return artifact;
    };
    const signal = AbortSignal.timeout(30_000);
    const request = () =>
      ensure(
        m,
        { restart: false, stopped: () => false, id: M, signal, timeoutMs: 30_000 },
        {
          audit: tc.audit.audit,
          logger: discard,
          readOnly: false,
          hc,
        },
      );
    expect(await Promise.all([request(), request()])).toEqual(['', '']);
    const events = tc.audit.records().map((x) => x.event);
    expect(events.filter((x) => x === 'term.install')).toHaveLength(1);
    expect(events.filter((x) => x === 'term.start')).toHaveLength(1);
  }, 35_000);

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

  test('ephemeral vault env: never written to terminals.json on disk and never reused on kept-terminal recovery', async () => {
    const SECRET_NAME = 'TEST_VAULT_SECRET';
    const SECRET_VAL = 'sentinel-vault-9f8e7d6c-4b3a2918';
    const PUBLIC_VAL = 'client-public-keep-check';
    workspaceEnvHook = async (ws) =>
      ws === 'ws-vault' ? { env: { [SECRET_NAME]: SECRET_VAL }, names: [SECRET_NAME], presets: ['p-vault'] } : undefined;

    const scanTreeFor = (dir: string, skipFile: string, needles: string[]): string[] => {
      const hits: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (full === skipFile) continue;
        const st = lstatSync(full);
        if (st.isDirectory()) hits.push(...scanTreeFor(full, skipFile, needles));
        else if (st.isFile()) {
          const buf = readFileSync(full, 'latin1');
          for (const n of needles) if (buf.includes(n)) hits.push(`${full}:${n}`);
        }
      }
      return hits;
    };

    try {
      const c = await client();
      await c.ready(M);
      const runReply = await c.call(
        1,
        'terminal.run',
        {
          keep: true,
          workspace: 'ws-vault',
          argv: ['/bin/sh'],
          cwd: '/',
          size: { cols: 80, rows: 24 },
          env: { CLIENT_PUBLIC: PUBLIC_VAL, BUN_BE_BUN: '1' },
        },
        M,
      );
      expect(runReply.error).toBeUndefined();
      const createdRec = runReply.result as { address: string; argv?: string[] };
      const addr = createdRec.address;
      expect(createdRec.argv).toEqual(['/bin/sh']);

      c.send({ t: 'attach', rid: 2, m: M, terminal: addr, cols: 80, rows: 24 });
      const sid = (await c.until('attached', 10_000)).s as number;
      c.bin(sid, FrameKind.Data, `printf 'init=%s|%s|%s|%s\\n' "$$" "$${SECRET_NAME}" "$CLIENT_PUBLIC" "$BUN_BE_BUN"\r`);
      let out = '';
      const initRe = /init=(\d+)\|sentinel-vault-9f8e7d6c-4b3a2918\|client-public-keep-check\|1/;
      while (!initRe.test(out)) {
        const m = await c.until('bin', 10_000);
        if (m.kind === FrameKind.Data) {
          out += m.data as string;
          c.send({ t: 'ack', s: sid, n: Buffer.byteLength(m.data as string, 'latin1') });
        }
      }
      const initialPid = Number(initRe.exec(out)![1]);
      expect(initialPid).toBeGreaterThan(1);

      // `execve` replaced `term-env` in place: herdr-core's tracked PID is the shell itself.
      const gotRec = (await c.call(3, 'terminal.get', { terminal: addr }, M)).result as { pid?: number; argv?: string[] };
      expect(gotRec.pid).toBe(initialPid);
      expect(gotRec.argv).toEqual(['/bin/sh']);

      // Locate herdr-core's persisted terminals.json and verify it wrote CLIENT_PUBLIC,
      // while neither SECRET_NAME nor SECRET_VAL exists anywhere in the temporary home!
      const hcRep = await machines.get(M)!.request({ op: Op.HC, action: 'status' });
      const session = hcRep.hc!.session;
      const hcSocket = hcRep.hc!.socket;
      const terminalsJsonPath = join(home, '.local', 'state', 'herdr-core', session, 'terminals.json');
      expect(existsSync(terminalsJsonPath)).toBe(true);
      const rawTerminalsJson = readFileSync(terminalsJsonPath, 'utf8');
      expect(rawTerminalsJson).toContain(PUBLIC_VAL);
      expect(rawTerminalsJson).not.toContain(SECRET_VAL);
      expect(rawTerminalsJson).not.toContain(SECRET_NAME);
      expect(scanTreeFor(home, agentBin, [SECRET_VAL, SECRET_NAME])).toEqual([]);

      // Replaying the consumed token recorded in herdr-core's internal argv fails closed (126).
      const tokenMatch = /"([0-9a-f]{48})"/.exec(rawTerminalsJson);
      expect(tokenMatch).not.toBeNull();
      const replay = spawnSync(agentBin, ['term-env', tokenMatch![1]], {
        env: { ...process.env, HOME: home, HC_TERMINAL_SOCKET: hcSocket },
        encoding: 'utf8',
      });
      expect(replay.status).toBe(126);
      expect(replay.stdout).toBe('');
      expect(replay.stderr).not.toContain(SECRET_VAL);

      // Lock/unlink the vault preset, then crash the shell (SIGKILL) so herdr-core's
      // `keep: true` recovery spawns a replacement shell from `restart_env`.
      workspaceEnvHook = undefined;
      process.kill(initialPid, 'SIGKILL');

      for (const deadline = Date.now() + 15_000; ;) {
        const ev = await c.until('event', Math.max(100, deadline - Date.now()));
        if (ev.terminal === addr && ev.type === 'restarted') {
          expect(JSON.stringify(ev)).not.toContain(tokenMatch![1]);
          break;
        }
      }

      // Attach to the replacement shell on the same kept terminal address:
      // CLIENT_PUBLIC stays from restart_env, while the vault secret is MISSING.
      c.send({ t: 'attach', rid: 4, m: M, terminal: addr, cols: 80, rows: 24 });
      const sid2 = (await c.until('attached', 10_000)).s as number;
      c.bin(sid2, FrameKind.Data, `printf 'after_sigkill=%s|%s\\n' "\${${SECRET_NAME}:-MISSING}" "\${CLIENT_PUBLIC:-MISSING}"\r`);
      out = '';
      while (!out.includes(`after_sigkill=MISSING|${PUBLIC_VAL}`)) {
        const m = await c.until('bin', 10_000);
        if (m.bin === sid2 && m.kind === FrameKind.Data) {
          out += m.data as string;
          c.send({ t: 'ack', s: sid2, n: Buffer.byteLength(m.data as string, 'latin1') });
        }
      }
      expect(out).not.toContain(SECRET_VAL);

      // Also restart herdr-core via the hub route so state reloads from terminals.json
      // on disk, confirming nothing on disk reintroduces the secret.
      expect((await tc.request('POST', `/api/m/${M}/hc/restart`)).status).toBe(200);
      while ((await c.until('backend', 15_000)).state !== 'ready');
      await c.until('snapshot', 15_000);
      expect(scanTreeFor(home, agentBin, [SECRET_VAL, SECRET_NAME])).toEqual([]);

      await c.call(10, 'terminal.kill', { terminal: addr }, M);
    } finally {
      workspaceEnvHook = undefined;
    }
  }, 90_000);
});

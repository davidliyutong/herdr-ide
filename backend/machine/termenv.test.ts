import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reader } from '#shared/lib/streamio.ts';
import { MAX_INLINE, Op, readLine, writeLine } from '#shared/proto/agentproto/index.ts';
import { TermEnvStore, TERM_ENV_SOCK, type TermEnvReply } from './termenv.ts';
import { rig, until, type Rig } from './testing.ts';

let r: Rig | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await r?.close();
  r = undefined;
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function takeFromSock(sock: string, token: string): Promise<TermEnvReply> {
  const c = connect(sock);
  await new Promise<void>((res, rej) => c.once('connect', res).once('error', rej));
  await writeLine(c, { token });
  const rep = await readLine<TermEnvReply>(new Reader(c));
  c.destroy();
  return rep;
}

describe('ephemeral terminal environment staging', () => {
  test('stages in memory on 0600 env.sock, consumes strictly once, supports large payloads and drop', async () => {
    r = await rig();
    const sock = join(r.dirs.run, TERM_ENV_SOCK);
    const staged = await r.session.request({
      op: Op.TermEnv,
      action: 'stage',
      params: { env: { SECRET_KEY: 's3cr3t-one-shot' }, argv: ['/bin/sh', '-c', 'true'] },
    });
    expect(staged.ok).toBe(true);
    expect(existsSync(sock)).toBe(true);
    expect(statSync(sock).mode & 0o777).toBe(0o600);

    const token = staged.termenv!.token;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(staged.termenv!.launch.slice(-5)).toEqual(['term-env', token, '/bin/sh', '-c', 'true']);

    // First read consumes the token; second read gets { ok: false }.
    const first = await takeFromSock(sock, token);
    expect(first).toEqual({
      ok: true,
      env: { SECRET_KEY: 's3cr3t-one-shot' },
      argv: ['/bin/sh', '-c', 'true'],
    });
    const second = await takeFromSock(sock, token);
    expect(second).toEqual({ ok: false });

    // Explicit drop prevents consumption.
    const staged2 = await r.session.request({
      op: Op.TermEnv,
      action: 'stage',
      params: { env: { SECRET_KEY: 'dropped-secret' } },
    });
    await r.session.request({ op: Op.TermEnv, action: 'drop', params: { token: staged2.termenv!.token } });
    expect(await takeFromSock(sock, staged2.termenv!.token)).toEqual({ ok: false });

    // Large payload (> MAX_INLINE) sent via params_length + body.
    const bigVal = 'x'.repeat(MAX_INLINE + 4096);
    const body = Buffer.from(JSON.stringify({ env: { BIG_SECRET: bigVal }, line: 'echo ok' }));
    const big = await r.session.request({ op: Op.TermEnv, action: 'stage', params_length: body.length }, { body });
    const gotBig = await takeFromSock(sock, big.termenv!.token);
    expect(gotBig).toEqual({ ok: true, env: { BIG_SECRET: bigVal }, line: 'echo ok' });
  });

  test('refuses connections from another uid without consuming staged secrets and expires stale tokens', async () => {
    let uid = (process.getuid?.() ?? 0) + 1;
    r = await rig({ peerCred: () => ({ pid: process.pid, uid }) });
    const sock = join(r.dirs.run, TERM_ENV_SOCK);
    const staged = await r.session.request({
      op: Op.TermEnv,
      action: 'stage',
      params: { env: { SECRET_KEY: 'keep-safe' } },
    });
    const token = staged.termenv!.token;

    // Wrong UID is rejected and token remains intact for legitimate caller.
    await expect(takeFromSock(sock, token)).rejects.toThrow();
    uid = process.getuid?.() ?? 0;
    expect(await takeFromSock(sock, token)).toEqual({ ok: true, env: { SECRET_KEY: 'keep-safe' } });

    // Short TTL store expires and wipes values.
    const store = new TermEnvStore({ ttlMs: 15, maxEntries: 2 });
    store.markReady();
    const s1 = store.stage({ env: { EXP: 'soon' } });
    await Bun.sleep(30);
    expect(store.take(s1.token)).toBeNull();
  });

  test('term-env execve replaces process in place (same PID), honors config.toml shell, and fails closed on replay', async () => {
    r = await rig();
    await until(() => existsSync(join(r!.dirs.run, TERM_ENV_SOCK)), 'env.sock');
    const hcSock = join(r.dirs.run, 'hc.sock');

    // Stage with `line` and verify PID preservation across execve.
    const staged = await r.session.request({
      op: Op.TermEnv,
      action: 'stage',
      params: {
        env: { INJECTED_SECRET: 'ephemeral-778899' },
        line: 'printf "%s|%s" "$$" "$INJECTED_SECRET"',
      },
    });
    const launch = staged.termenv!.launch;
    const proc = Bun.spawn(launch, {
      env: { ...process.env, HOME: r.home, HC_TERMINAL_SOCKET: hcSock },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const spawnedPid = proc.pid;
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe(`${spawnedPid}|ephemeral-778899`);

    // Replaying the exact same launch command fails closed (exit 126) without starting a shell.
    const replay = Bun.spawn(launch, {
      env: { ...process.env, HOME: r.home, HC_TERMINAL_SOCKET: hcSock },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [replayCode, replayOut, replayErr] = await Promise.all([
      replay.exited,
      new Response(replay.stdout).text(),
      new Response(replay.stderr).text(),
    ]);
    expect(replayCode).toBe(126);
    expect(replayOut).toBe('');
    expect(replayErr).not.toContain('ephemeral-778899');

    // Default shell resolution honors herdr-core/config.toml `shell`.
    const cfgDir = mkdtempSync(join(tmpdir(), 'hc-cfg-'));
    tempDirs.push(cfgDir);
    mkdirSync(join(cfgDir, 'herdr-core'), { recursive: true });
    writeFileSync(join(cfgDir, 'herdr-core', 'config.toml'), 'shell = ["/bin/sh", "-c", "printf cfg:%s \\"$CFG_SECRET\\""]\n');
    const stagedCfg = await r.session.request({
      op: Op.TermEnv,
      action: 'stage',
      params: { env: { CFG_SECRET: 'from-toml-shell' } },
    });
    const cfgProc = Bun.spawn(stagedCfg.termenv!.launch, {
      env: { ...process.env, HOME: r.home, XDG_CONFIG_HOME: cfgDir, HC_TERMINAL_SOCKET: hcSock },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [cfgCode, cfgOut] = await Promise.all([cfgProc.exited, new Response(cfgProc.stdout).text()]);
    expect(cfgCode).toBe(0);
    expect(cfgOut).toBe('cfg:from-toml-shell');
  });
});

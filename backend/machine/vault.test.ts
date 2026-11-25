import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { Reader } from '#shared/lib/streamio.ts';
import { Op, readLine, writeLine, type Header, type VaultResponse } from '#shared/proto/agentproto/index.ts';
import type { Session } from '#kernel/machines/transport/session.ts';
import { Agent } from './agent.ts';
import { discard } from '#shared/lib/log.ts';
import { inode } from './sockets.ts';
import { rig, until, type Rig } from './testing.ts';
import { runDir } from '#shared/host/hostdirs.ts';
import { dataDir } from '#shared/lib/brand.ts';
import {
  MCP_LINK_NAME,
  MCP_LINK_SCRIPT,
  isMcpLink,
  linkMCP,
  mcpSocketPath,
  mergeLists,
  platformLink,
  processChain,
  vaultRefusal,
} from './vault.ts';

let r: Rig | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

/** Answers the vault streams a hub gets with answer(request, header). */
function hub(s: Session, answer: (req: Record<string, unknown>, h: Header) => VaultResponse | null) {
  const seen: Header[] = [];
  void (async () => {
    for (;;) {
      const st = await s.accept().catch(() => null);
      if (!st) return;
      void (async () => {
        const rd = new Reader(st);
        const h = await readLine<Header>(rd);
        seen.push(h);
        if (h.op !== Op.Vault) return st.end();
        await writeLine(st, { ok: true });
        const req = await readLine<Record<string, unknown>>(rd);
        const resp = answer(req, h);
        if (resp) await writeLine(st, resp);
        else await new Promise((res) => st.once('close', res)); // never answers
        st.end();
      })().catch(() => {});
    }
  })();
  return seen;
}

/** One request on vault.sock: its answer. */
async function ask(sock: string, req: unknown): Promise<VaultResponse> {
  const c = connect(sock);
  await new Promise((res, rej) => c.once('connect', res).once('error', rej));
  await writeLine(c, req);
  const resp = await readLine<VaultResponse>(new Reader(c));
  c.destroy();
  return resp;
}

const sockOf = (rr: Rig) => join(rr.dirs.run, 'vault.sock');

describe('the vault socket', () => {
  test('relays a request to the hub with the process chain the kernel names', async () => {
    r = await rig();
    const seen = hub(r.session, () => ({ ok: true, values: { A: '1' } }));
    await until(() => existsSync(sockOf(r!)), 'the vault socket');
    const resp = await ask(sockOf(r), { tool: 'get', names: ['A'], client: 'claims-anything' });
    expect(resp).toEqual({ ok: true, values: { A: '1' } });
    const h = seen.find((x) => x.op === Op.Vault)!;
    expect(h.process?.[0].pid).toBe(process.pid);
    expect(h.process?.[0].name?.length).toBeGreaterThan(0);
    expect(await ask(sockOf(r), 'nonsense')).toEqual({ ok: false, code: 'bad_request', error: 'not a request' });
  });

  test('asks every hub: the first grant answers, lists merge, refusals rank', async () => {
    r = await rig();
    const second = r.connect('hub-2');
    hub(r.session, (req) =>
      req.tool === 'list' ? { ok: true, variables: [{ name: 'A' }, { name: 'B' }] } : { ok: false, code: 'vault_locked' },
    );
    hub(second, (req) => (req.tool === 'list' ? { ok: true, variables: [{ name: 'B' }, { name: 'C' }] } : null));
    await until(() => existsSync(sockOf(r!)), 'the vault socket');
    await until(() => r!.agent.liveSessions().length === 2, 'both sessions');
    const list = await ask(sockOf(r), { tool: 'list' });
    expect(list.variables?.map((v) => v.name).sort()).toEqual(['A', 'B', 'C']);

    expect(
      vaultRefusal([
        { ok: false, code: 'busy' },
        { ok: false, code: 'denied' },
        { ok: false, code: 'unavailable' },
      ]).code,
    ).toBe('denied');
    expect(vaultRefusal([]).code).toBe('unavailable');
    expect(
      mergeLists({ ok: true, variables: [{ name: 'A', description: 'first' }] }, { ok: true, variables: [{ name: 'A', description: 'x' }] })
        .variables,
    ).toEqual([{ name: 'A', description: 'first' }]);
  });

  test('without a hub a request is unavailable', async () => {
    r = await rig();
    r.session.close();
    await until(() => r!.agent.liveSessions().length === 0, 'the session to end');
    await until(() => existsSync(sockOf(r!)), 'the vault socket');
    expect((await ask(sockOf(r), { tool: 'get', names: ['A'] })).code).toBe('unavailable');
  });

  test('the newest agent of the instance takes the socket over, and the other serves it again once it is free', async () => {
    r = await rig();
    await until(() => existsSync(sockOf(r!)), 'the vault socket');
    const first = inode(sockOf(r));
    const other = new Agent({ instance: '', dirs: r.dirs, logger: discard, features: [], socketWatchMs: 50 });
    await until(() => inode(sockOf(r!)) !== first && inode(sockOf(r!)) !== null, 'the newer agent to take the socket');
    const taken = inode(sockOf(r));
    await new Promise((res) => setTimeout(res, 200));
    expect(inode(sockOf(r))).toBe(taken); // the first does not take it back while it is served
    await other.close();
    await until(() => inode(sockOf(r!)) !== null && inode(sockOf(r!)) !== taken, 'the first agent to serve it again');
  });

  test('a connection whose peer is another user, or whose credentials cannot be read, is refused', async () => {
    for (const peerCred of [
      () => ({ pid: 1234, uid: process.getuid!() + 1 }),
      () => {
        throw new Error('getsockopt failed');
      },
    ]) {
      const logs: string[] = [];
      r = await rig({ peerCred, logger: (l) => logs.push(l) });
      const seen = hub(r.session, () => ({ ok: true, values: { A: '1' } }));
      await until(() => existsSync(sockOf(r!)), 'the vault socket');
      await expect(ask(sockOf(r), { tool: 'get', names: ['A'] })).rejects.toThrow();
      expect(seen.filter((h) => h.op === Op.Vault)).toEqual([]);
      expect(logs.some((l) => l.startsWith('vault: refused a connection'))).toBe(true);
      await r.close();
      r = undefined;
    }
  });

  test('the chain stops at init', () => {
    const chain = processChain(process.pid);
    expect(chain[0].pid).toBe(process.pid);
    expect(chain.every((p) => p.pid > 1)).toBe(true);
    expect(chain.length).toBeLessThanOrEqual(8);
  });
});

describe("the MCP command's link", () => {
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'mcplink-')));
  /** A program at dir/name that says its name and arguments. */
  const programAt = (dir: string, name: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho ${name} "$@"\n`, { mode: 0o700 });
    return p;
  };
  /** The link of this host's system and architecture in dir. */
  const hostLink = (dir: string) =>
    join(
      dir,
      platformLink(execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim(), execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim()),
    );

  // TestLinkMCPReplacesTheLink: the stable command is a script running the
  // link of the host's system and architecture, which points at the
  // agent's executable.
  test('the stable command runs the link of this host, which a newer executable replaces', async () => {
    const t = tmp();
    try {
      const dir = join(t, 'bin');
      await linkMCP(dir, programAt(t, 'old'));
      const newer = programAt(t, 'new');
      await linkMCP(dir, newer);
      expect(readlinkSync(hostLink(dir))).toBe(newer);
      expect(execFileSync(join(dir, MCP_LINK_NAME), ['a b'], { encoding: 'utf8' })).toBe('new a b\n');
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(await Bun.file(join(dir, MCP_LINK_NAME)).text()).toBe(MCP_LINK_SCRIPT);
      // A script that changed is written again.
      writeFileSync(join(dir, MCP_LINK_NAME), '#!/bin/sh\necho other\n');
      await linkMCP(dir, newer);
      expect(await Bun.file(join(dir, MCP_LINK_NAME)).text()).toBe(MCP_LINK_SCRIPT);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  test('the agent links its executable when it starts', async () => {
    const t = tmp();
    const dirs = { home: t, base: join(t, '.x'), host: join(t, '.x', 'hosts', 'h'), run: join(t, 'run') };
    const agent = new Agent({ instance: '', dirs, logger: discard, features: [], socketWatchMs: 50, mcpExe: programAt(t, 'agent') });
    try {
      await until(() => existsSync(join(dirs.base, 'bin', MCP_LINK_NAME)), 'the MCP command');
      await until(() => existsSync(hostLink(join(dirs.base, 'bin'))), 'its link');
      expect(execFileSync(join(dirs.base, 'bin', MCP_LINK_NAME), ['x'], { encoding: 'utf8' })).toBe('agent x\n');
    } finally {
      await agent.close();
      rmSync(t, { recursive: true, force: true });
    }
  });

  // TestSocketPath: the data directory holding the command, or the
  // instance's: its runtime directory on this host.
  test('the socket of the data directory the link is in, else of the instance', () => {
    const run = (base: string) => join(runDir(base), 'vault.sock');
    expect(mcpSocketPath(`/home/u/.x-dev/bin/${MCP_LINK_NAME}`, '/home/u', '')).toBe(run('/home/u/.x-dev'));
    expect(mcpSocketPath(`/home/u/.x-dev/bin/${platformLink('Linux', 'x86_64')}`, '/home/u', '')).toBe(run('/home/u/.x-dev'));
    const byInstance = run(join('/home/u', dataDir('dev')));
    expect(mcpSocketPath(MCP_LINK_NAME, '/home/u', 'dev')).toBe(byInstance);
    expect(mcpSocketPath('/usr/bin/agent', '/home/u', 'dev')).toBe(byInstance);
    expect(isMcpLink(`/x/bin/${platformLink('Darwin', 'arm64')}`)).toBe(true);
    expect(isMcpLink('/x/bin/agent')).toBe(false);
  });
});

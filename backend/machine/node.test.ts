import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { discard } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { NodeOp, Op, newer, readLine, writeLine, type Header, type NodeInfo } from '#shared/proto/agentproto/index.ts';
import { Session } from '#kernel/machines/transport/session.ts';
import { dialNodeSocket, nodeSocket, stopNodes } from './dial.ts';
import { runNode, type NodeOptions } from './node.ts';
import { until, withHome } from './testing.ts';

const FAST = { idleMs: 300, takeoverWaitMs: 3000, drainMaxMs: 60_000, buildCheckMs: 50 };
const build = (b: string, exeTime: number): NodeInfo => ({ build: b, version: 'dev', exe_time: exeTime, pid: process.pid });

/** Runs a node of the temporary home in this process; done resolves when
 * it returned. */
function startNode(o: Partial<NodeOptions> = {}) {
  const ac = new AbortController();
  const done = runNode({ instance: '', logger: discard, features: [], timing: FAST, me: build('aaaa', 1), signal: ac.signal, ...o });
  return { done, stop: () => ac.abort() };
}

const sock = () => nodeSocket(dirsFor('').run);

/** A session through the node: the node's build and the hello reply. */
async function helloThrough(sshConn = '') {
  const { conn, node } = await dialNodeSocket(sock(), { op: NodeOp.Serve, ...(sshConn ? { ssh_connection: sshConn } : {}) });
  const s = new Session(conn, () => conn.destroy());
  const rep = await s.request({ op: Op.Hello });
  return { s, node, rep };
}

describe('the node', () => {
  test('serves several clients at once, each with its ssh session, on a private socket', () =>
    withHome(async () => {
      const n = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      expect(statSync(sock()).mode & 0o777).toBe(0o600);
      const a = await helloThrough('10.0.0.1 1 10.0.0.2 22');
      const b = await helloThrough();
      expect(a.node?.build).toBe('aaaa');
      expect(a.rep.ssh).toBe('10.0.0.1 1 10.0.0.2 22');
      expect(b.rep.ssh).toBeUndefined();
      a.s.close();
      b.s.close();
      n.stop();
      await n.done;
    }));

  test('one per instance: a second returns at once, leaving the first', () =>
    withHome(async () => {
      const n = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      await runNode({ instance: '', logger: discard, features: [], timing: FAST, me: build('bbbb', 2) });
      expect((await helloThrough()).node?.build).toBe('aaaa');
      n.stop();
      await n.done;
    }));

  test('ends after its idle time without a client, and when asked to stop', () =>
    withHome(async () => {
      const n = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      const c = await helloThrough();
      await new Promise((r) => setTimeout(r, FAST.idleMs * 2));
      expect((await c.s.request({ op: Op.Hello })).ok).toBe(true); // a client keeps it
      c.s.close();
      await n.done;
      expect(existsSync(sock())).toBe(false);

      const m = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      expect(await stopNodes('')).toBe(1);
      await m.done;
    }));

  test('takes no new client once the file of its build is gone', () =>
    withHome(async (home) => {
      const file = join(home, 'bundle.js');
      writeFileSync(file, '');
      const n = startNode({ build: file });
      await until(() => existsSync(sock()), 'the node to listen');
      const c = await helloThrough();
      rmSync(file);
      await until(() => !existsSync(sock()), 'the node to leave its socket');
      expect((await c.s.request({ op: Op.Hello })).ok).toBe(true);
      c.s.close();
      await n.done;
    }));

  test('a node taking over gets the socket: the old one tells its cores to move and ends once they left', () =>
    withHome(async () => {
      const old = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      const { s } = await helloThrough();
      // The core's side: the drain the old node announces.
      let drained = false;
      void (async () => {
        const st = await s.accept();
        const r = new Reader(st);
        const h = await readLine<Header>(r);
        if (h.op === Op.NodeDrain) {
          drained = true;
          await writeLine(st, { ok: true });
        }
        st.end();
      })().catch(() => {});
      let oldEnded = false;
      void old.done.then(() => (oldEnded = true));
      const next = startNode({ me: build('bbbb', 2), takeover: true });
      await until(() => drained, 'the old node to announce its drain');
      // The old session still works until its core leaves.
      expect((await s.request({ op: Op.Hello })).ok).toBe(true);
      await until(
        async () =>
          (await helloThrough()
            .then((c) => (c.s.close(), c.node?.build))
            .catch(() => '')) === 'bbbb',
        'the new node',
      );
      expect(oldEnded).toBe(false);
      s.close();
      await old.done;
      expect(existsSync(sock())).toBe(true); // the new node's
      next.stop();
      await next.done;
    }));

  test('refuses a hello it does not know', () =>
    withHome(async () => {
      const n = startNode();
      await until(() => existsSync(sock()), 'the node to listen');
      await expect(dialNodeSocket(sock(), { op: 'nope' })).rejects.toThrow(/unknown node op/);
      n.stop();
      await n.done;
    }));
});

test('a build is newer by its version when both are known, else by when it was written', () => {
  const a: NodeInfo = { build: 'a', version: 'v1.2.0', exe_time: 2 };
  const b: NodeInfo = { build: 'b', version: 'v1.3.0', exe_time: 1 };
  const dev1: NodeInfo = { build: 'c', version: 'dev', exe_time: 1 };
  const dev2: NodeInfo = { build: 'd', version: 'dev', exe_time: 2 };
  expect(newer(b, a)).toBe(true);
  expect(newer(a, b)).toBe(false);
  expect(newer(dev2, dev1)).toBe(true);
  expect(newer(dev1, dev2)).toBe(false);
  expect(newer(a, a)).toBe(false);
});

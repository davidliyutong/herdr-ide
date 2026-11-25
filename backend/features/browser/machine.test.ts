import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Fail } from '#shared/lib/fail.ts';
import { Op } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { call, open } from '#kernel/agent.ts';
import { AgentError } from '#kernel/machines/transport/session.ts';
import { rig, machineOf, until, type Rig } from '#machine/testing.ts';
import { browserMachine } from './machine.ts';
import { MAX_PORTS, listeners, parseLsof, reachable, tidy } from './machine/listening.ts';
import { browserProtocol } from './protocol.ts';

let r: Rig | undefined;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await r?.close();
  r = undefined;
});

/** A service on a loopback address that answers each line with "got: "
 * and the line; its port, or null when the host has no such address. */
async function service(host: string, onConn?: (c: Socket) => void): Promise<number | null> {
  const srv = createServer((c) => {
    c.on('error', () => {});
    onConn?.(c);
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        c.write(`got: ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  });
  try {
    await new Promise<void>((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, host, () => res());
    });
  } catch {
    return null;
  }
  servers.push(srv);
  return (srv.address() as AddressInfo).port;
}

const freePort = async () => {
  const p = (await service('127.0.0.1'))!;
  servers.pop()!.close();
  return p;
};

describe('dial', () => {
  for (const host of ['127.0.0.1', '::1'])
    test(`connects the stream to a service on ${host} and carries bytes both ways until the hub closes it`, async () => {
      const port = await service(host);
      if (port === null) return; // no such address here
      r = await rig({ features: [browserMachine()] });
      const { conn } = await open(machineOf(r.session), browserProtocol, 'dial', { port });
      for (const text of ['one', 'two']) {
        conn.stream.write(`${text}\n`);
        expect(await conn.reader.line(100)).toBe(`got: ${text}`);
      }
      conn.reader.release();
      closeStream(conn.stream);
      expect((await r.session.request({ op: Op.Hello })).ok).toBe(true);
    });

  test('the stream ends when the service does, and when the agent stops', async () => {
    const accepted: Socket[] = [];
    const port = (await service('127.0.0.1', (c) => accepted.push(c)))!;
    r = await rig({ features: [browserMachine()] });
    let { conn } = await open(machineOf(r.session), browserProtocol, 'dial', { port });
    await until(() => accepted.length === 1, 'the service to accept');
    accepted[0].destroy();
    expect(await conn.reader.chunk()).toBeNull();

    ({ conn } = await open(machineOf(r.session), browserProtocol, 'dial', { port }));
    await until(() => accepted.length === 2, 'the service to accept');
    const ended = new Promise((res) => accepted[1].once('close', res));
    await r.agent.close();
    await ended;
    expect(await conn.reader.chunk().catch(() => null)).toBeNull();
  });

  test('a port nobody listens on, and what is no port, are refused with a code and nothing is carried', async () => {
    const free = await freePort();
    r = await rig({ features: [browserMachine({ dialMs: 2000 })] });
    const codeOf = async (params: unknown) => {
      try {
        await r!.session.request({ op: Op.Plugin, plugin: 'browser', action: 'dial', params });
      } catch (e) {
        return (e as AgentError).reply?.code;
      }
      return 'ok';
    };
    expect(await codeOf({ port: free })).toBe('refused');
    for (const p of [{ port: 0 }, { port: 65536 }, { port: -1 }, {}, { port: '80' }]) expect(await codeOf(p)).toBe('bad_params');
    const err = await call(machineOf(r.session), browserProtocol, 'dial', { port: free }).catch((e) => e as Fail);
    expect(err.code).toBe('refused');
  });
});

describe('listening', () => {
  test('sorted, one entry per port (the one naming its program), no number that is no port, bounded', () => {
    expect(
      tidy([
        { port: 8080 },
        { port: 3000, process: 'node' },
        { port: 8080, process: 'python3' },
        { port: 3000 },
        { port: 0 },
        { port: 70000 },
        { port: -1 },
      ]),
    ).toEqual([
      { port: 3000, process: 'node' },
      { port: 8080, process: 'python3' },
    ]);
    const many = Array.from({ length: MAX_PORTS + 50 }, (_, i) => ({ port: MAX_PORTS + 50 - i }));
    const got = tidy(many);
    expect(got).toHaveLength(MAX_PORTS);
    expect(got[0].port).toBe(1);
    expect(got[MAX_PORTS - 1].port).toBe(MAX_PORTS);
    expect(tidy([])).toEqual([]);
  });

  test("the machine's ports include a service of the test, where the system's list can be read", async () => {
    const port = (await service('127.0.0.1'))!;
    r = await rig({ features: [browserMachine()] });
    const { ports } = await call(machineOf(r.session), browserProtocol, 'listening', {});
    expect(ports.map((p) => p.port)).toContain(port);
    expect(ports.find((p) => p.port === port)?.process?.length).toBeGreaterThan(0);
  });

  // The kernel's tables as /proc/net/tcp and tcp6 print them on a
  // little-endian machine.
  const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0
   2: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0
   3: 0F02000A:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0
   4: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55555 1 0000000000000000 100 0 0 10 0
   5: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 66666 1 0000000000000000 20 4 30 10 -1
   6: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 77777 1 0000000000000000 100 0 0 10 0
   7: 0100007F0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 88888 1 0000000000000000 100 0 0 10 0
   8: 0100007F:0BB9 00000000:0000 0A
`;
  const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1451 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12121 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 23232 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:2710 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 34343 1 0000000000000000 100 0 0 10 0
   3: 000080FE00000000FF005452FE563412:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45454 1 0000000000000000 100 0 0 10 0
   4: 0000000000000000FFFF00000F02000A:1F92 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 56565 1 0000000000000000 100 0 0 10 0
`;

  test("the user's listening sockets a dial to loopback reaches, from the kernel's tables", () => {
    const got = new Map<string, number>();
    listeners(PROC_TCP, '1000', got);
    listeners(PROC_TCP6, '1000', got);
    expect(Object.fromEntries(got)).toEqual({ '11111': 3000, '22222': 8080, '33333': 53, '12121': 5201, '23232': 9000, '34343': 10000 });
    const root = new Map<string, number>();
    listeners(PROC_TCP, '0', root);
    expect(Object.fromEntries(root)).toEqual({ '55555': 5432 });
    const none = new Map<string, number>();
    listeners('', '1000', none);
    listeners(PROC_TCP.split('\n')[0] + '\n', '1000', none);
    expect(none.size).toBe(0);
  });

  test('the addresses a dial to loopback reaches', () => {
    const want: Record<string, boolean> = {
      '0100007F': true, // 127.0.0.1
      '0101007F': true, // 127.0.1.1
      '00000000': true, // 0.0.0.0
      '0F02000A': false, // 10.0.2.15
      '0100A8C0': false, // 192.168.0.1
      '00000000000000000000000001000000': true, // ::1
      '00000000000000000000000000000000': true, // ::
      '0000000000000000FFFF00000100007F': true, // ::ffff:127.0.0.1
      '000080FE00000000FF005452FE563412': false, // fe80::...
      B80D0120000000000000000001000000: false, // 2001:db8::1
      '': false,
      '0100007': false,
      xyz: false,
      '0100007F00': false,
    };
    for (const [addr, w] of Object.entries(want)) expect([addr, reachable(addr)]).toEqual([addr, w]);
  });

  test("lsof's fields on macOS", () => {
    expect(
      parseLsof(
        'p1\ncnode\nn127.0.0.1:3000\nn*:8080\nn10.0.0.2:9000\np2\ncpython3\nn[::1]:5000\nn[fe80::1]:5001\nn[::ffff:127.0.0.1]:5002\nnbad\n',
      ),
    ).toEqual([
      { port: 3000, process: 'node' },
      { port: 8080, process: 'node' },
      { port: 5000, process: 'python3' },
      { port: 5002, process: 'python3' },
    ]);
  });
});

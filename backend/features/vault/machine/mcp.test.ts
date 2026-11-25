import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Reader } from '#shared/lib/streamio.ts';
import type { VaultRequest, VaultResponse } from '#shared/proto/agentproto/index.ts';
import { MAX_LINE, dialSocket, serveMcp, type McpOptions } from './mcp.ts';
import { survivors } from './testdata/procs.ts';
import { fakeHub, type FakeHub } from './testdata/fakehub.ts';

type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A client of a server in this process: what it sends goes to the
 * server's input, what it reads is the server's output. */
class Client {
  readonly in = new PassThrough();
  readonly out = new PassThrough();
  private readonly r = new Reader(this.out);
  private id = 0;
  done: Promise<unknown>;
  readonly stop = new AbortController();

  constructor(o: McpOptions) {
    this.done = serveMcp(o, this.in, this.out, this.stop.signal).then(
      () => null,
      (e: Error) => e,
    );
  }

  send(v: unknown): void {
    this.in.write(JSON.stringify(v) + '\n');
  }

  async read(): Promise<Msg> {
    return JSON.parse(await this.r.line(64 << 20)) as Msg;
  }

  async call(method: string, params?: unknown): Promise<Msg> {
    const id = ++this.id;
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const resp = await this.read();
    expect(resp.id).toBe(id);
    expect(resp.jsonrpc).toBe('2.0');
    return resp;
  }

  async init(): Promise<void> {
    await this.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async tool(name: string, args?: unknown): Promise<{ text: string; isError: boolean }> {
    const r = await this.call('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
    expect(r.result).toBeDefined();
    return { text: r.result.content[0].text, isError: r.result.isError === true };
  }
}

let hubs: FakeHub[] = [];
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) {
    c.in.end();
    await c.done;
  }
  for (const c of hubs) c.close();
  hubs = [];
  clients = [];
});

async function hub(answer: (req: VaultRequest) => VaultResponse | null): Promise<FakeHub> {
  const c = await fakeHub(answer);
  hubs.push(c);
  return c;
}

function client(o: McpOptions): Client {
  const c = new Client(o);
  clients.push(c);
  return c;
}

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'mcp-')));

/** Waits for files names in dir to hold a process id each. */
async function pidsIn(dir: string, ...names: string[]): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pids = names.map((n) => {
      const p = join(dir, n);
      const s = existsSync(p) ? readFileSync(p, 'utf8') : '';
      return s.endsWith('\n') ? Number(s.trim()) : NaN;
    });
    if (pids.every((p) => Number.isInteger(p))) return pids;
    if (Date.now() > deadline) throw new Error(`no process ids in ${dir}`);
    await Bun.sleep(10);
  }
}

const runCall = (id: number | string, command: string, dir: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'run_with_env', arguments: { command, names: ['V'], cwd: dir } },
});

describe('the MCP server', () => {
  // TestProtocol
  test('speaks MCP: the handshake, the tools and their calls', async () => {
    const fc = await hub((req): VaultResponse => {
      switch (req.tool) {
        case 'list':
          return { ok: true, variables: [{ name: 'TOKEN', description: 'd' }] };
        case 'get':
          return req.names![0] === 'SECRET' ? { ok: false, code: 'inject_only', error: 'no' } : { ok: true, values: { TOKEN: 'tok-123' } };
      }
      return { ok: true, values: { TOKEN: 'tok-123', SECRET: 'hunter2hunter2' } };
    });
    const c = client({ dial: dialSocket(fc.path), client: 'claude', terminal: 't7' });

    let r = await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toEndWith('-vault');
    expect(r.result.instructions).toContain('run_with_env');
    // The Go server's revisions all negotiate; one it does not know gets
    // the newest.
    for (const v of ['2025-06-18', '2024-11-05']) {
      r = await c.call('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(r.result.protocolVersion).toBe(v);
    }
    r = await c.call('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.result.protocolVersion >= '2025-06-18').toBe(true);
    // A notification gets no response: the next line answers the ping.
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect((await c.call('ping')).result).toEqual({});
    r = await c.call('tools/list', {});
    expect(r.result.tools.map((t: Msg) => t.name)).toEqual(['list_variables', 'get_variable', 'run_with_env']);
    expect(r.result.tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(r.result.tools[2].inputSchema.required).toEqual(['command', 'names']);
    expect((await c.call('nope')).error.code).toBe(-32601);

    let t = await c.tool('list_variables');
    expect(t.isError).toBe(false);
    expect(t.text).toContain('"TOKEN"');
    const first = fc.seen.at(-1)!;
    expect([first.client, first.terminal, first.cwd]).toEqual(['claude', 't7', process.cwd()]);
    t = await c.tool('get_variable', { name: 'TOKEN' });
    expect(t).toEqual({ text: 'tok-123', isError: false });
    t = await c.tool('get_variable', { name: 'SECRET' });
    expect(t.isError).toBe(true);
    expect(t.text.startsWith('inject_only')).toBe(true);
    t = await c.tool('run_with_env', {
      command: `echo "token=$TOKEN"; echo "secret=$SECRET" >&2; printf %s "$SECRET" | cut -c1-6`,
      names: ['TOKEN', 'SECRET'],
    });
    expect(t.isError).toBe(false);
    expect(t.text).toContain('exit status: 0');
    expect(t.text).toContain('token=***');
    expect(t.text).toContain('secret=***');
    expect(t.text).not.toContain('tok-123');
    expect(t.text).not.toContain('hunter2hunter2');
    // Masking is not a guarantee: a part of a value is shown.
    expect(t.text).toContain('hunter');
    const env = fc.seen.at(-1)!;
    expect([env.tool, env.names?.length]).toEqual(['env', 2]);
    // Arguments a tool does not take are refused, nothing is asked or run.
    const asked = fc.seen.length;
    expect((await c.call('tools/call', { name: 'run_with_env', arguments: { command: 'true' } })).error.code).toBe(-32602);
    expect((await c.call('tools/call', { name: 'get_variable', arguments: {} })).error.code).toBe(-32602);
    expect((await c.call('tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602);
    expect(fc.seen.length).toBe(asked);

    // The server ends when its input does.
    c.in.end();
    expect(await c.done).toBeNull();
  });

  // TestErrorsReachTheModel
  test("the hub's refusals and an absent agent reach the model as the tool's errors", async () => {
    const fc = await hub(() => ({ ok: false, code: 'denied', error: 'the user denied the request' }));
    let c = client({ dial: dialSocket(fc.path) });
    await c.init();
    let t = await c.tool('get_variable', { name: 'X' });
    expect(t.isError).toBe(true);
    expect(t.text).toContain('denied');
    c = client({ dial: dialSocket(join(tmpdir(), 'no-such-dir-x', 'vault.sock')) });
    await c.init();
    t = await c.tool('list_variables');
    expect(t.isError).toBe(true);
    expect(t.text.startsWith('unavailable')).toBe(true);
  });

  // TestRunLimitsFromTheHub
  test("the hub's limits bound run_with_env's command", async () => {
    const fc = await hub(() => ({ ok: true, values: { K: 'v' }, run: { timeout: 1, max_timeout: 2, max_output: 50 } }));
    const c = client({ dial: dialSocket(fc.path) });
    await c.init();
    let t = await c.tool('run_with_env', { command: 'yes abcdefghij | head -c 5000', names: ['K'] });
    expect(t.text).toContain('[output truncated: 50 of 5000 bytes]');
    // The call's own timeout, under the hub's longest.
    t = await c.tool('run_with_env', { command: 'sleep 30', names: ['K'], timeout: 0.2 });
    expect(t.isError).toBe(true);
    expect(t.text).toContain('timed out after 200ms');
    // The hub's longest bounds the call's.
    t = await c.tool('run_with_env', { command: 'sleep 30', names: ['K'], timeout: 3600 });
    expect(t.text).toContain('timed out after 2s');
  });

  // TestCancelledRequestLeavesTheHub: a call the client cancels while it
  // waits for the user's approval ends: its request to the hub goes away
  // (the hub takes it as a denial) and it gets no response.
  test('a cancelled call leaves the hub and gets no response', async () => {
    const fc = await hub(() => null);
    const c = client({ dial: dialSocket(fc.path) });
    await c.init();
    c.send({ jsonrpc: '2.0', id: 'call-7', method: 'tools/call', params: { name: 'get_variable', arguments: { name: 'KEY' } } });
    const deadline = Date.now() + 5000;
    while (fc.seen.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-7' } });
    while (fc.left === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(fc.left).toBe(1);
    // The next line answers the ping: the cancelled call has none.
    expect((await c.call('ping')).result).toEqual({});
  });

  // TestCancelledCommandIsKilled: its command is killed, with what it left
  // in the background, and it gets no response.
  test('a cancelled command is killed with what it left in the background', async () => {
    const fc = await hub(() => ({ ok: true, values: { V: 'secret' } }));
    const c = client({ dial: dialSocket(fc.path) });
    await c.init();
    const dir = tmp();
    try {
      c.send(runCall(41, 'sleep 300 & echo $! > bg; echo $$ > sh; wait', dir));
      const pids = await pidsIn(dir, 'bg', 'sh');
      c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41, reason: 'the user pressed Esc' } });
      expect(await survivors(pids)).toEqual([]);
      expect((await c.call('ping')).result).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a command still running when the input ends is killed before the server returns', async () => {
    const fc = await hub(() => ({ ok: true, values: { V: 'secret' } }));
    const c = client({ dial: dialSocket(fc.path) });
    await c.init();
    const dir = tmp();
    try {
      c.send(runCall(5, 'sleep 300 & echo $! > bg; echo $$ > sh; wait', dir));
      const pids = await pidsIn(dir, 'bg', 'sh');
      c.in.end();
      expect(await c.done).toBeNull();
      expect(await survivors(pids)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a line longer than the server takes ends it with an error', async () => {
    const fc = await hub(() => ({ ok: true }));
    const c = client({ dial: dialSocket(fc.path) });
    c.in.write('{"x":"' + 'a'.repeat(MAX_LINE) + '"}\n');
    const e = (await c.done) as Error | null;
    expect(e).toBeInstanceOf(Error);
  });
});

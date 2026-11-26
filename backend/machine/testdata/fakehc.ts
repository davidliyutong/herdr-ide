// A terminal core in memory for the machine side's tests: hello, then
// framed JSON-RPC with terminals by name (terminal.run, terminal.get,
// terminal.kill), machine.exec answered by exec, and anything else by
// answer.
import { createServer, type Server } from 'node:net';
import { Reader } from '#shared/lib/streamio.ts';
import { Kind, encodeFrame, readFrame } from '#shared/proto/hc/wire.ts';

export interface FakeTerminal {
  address: string;
  name?: string;
  state: string;
  argv: string[];
  labels: Record<string, string>;
}

export class FakeCore {
  readonly terminals = new Map<string, FakeTerminal>();
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** machine.exec's result. */
  exec: unknown = { code: 0 };
  /** Overrides an answer: an error kind for a method. */
  fail = new Map<string, string>();
  /** terminal.kill removes the terminal and answers not_found, as
   * herdr-core does for one run with rm. */
  killRemoves = false;
  private next = 1;
  private server?: Server;

  /** Serves the socket at path. */
  listen(path: string): Promise<void> {
    this.server = createServer((c) => {
      c.on('error', () => {});
      void this.serve(c).catch(() => c.destroy());
    });
    return new Promise((res) => this.server!.listen(path, res));
  }

  close(): void {
    this.server?.close();
  }

  private async serve(c: import('node:net').Socket): Promise<void> {
    const r = new Reader(c);
    await r.line(1 << 20);
    c.write(
      JSON.stringify({ jsonrpc: '2.0', id: 0, result: { generation: 1, version: '9.9.9', framed: true, core: { id: 'x', name: 'x' } } }) +
        '\n',
    );
    for (let f = await readFrame(r); f; f = await readFrame(r)) {
      if (f.channel !== 0) continue;
      const req = JSON.parse(f.payload.toString()) as { id: number; method: string; params: Record<string, unknown> };
      if (req.method === '$/cancelRequest') continue;
      this.calls.push({ method: req.method, params: req.params });
      const send = (body: object) =>
        c.write(encodeFrame(0, Kind.Data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }))));
      const err = (kind: string) => send({ error: { code: -32000, message: kind, data: { kind } } });
      const forced = this.fail.get(req.method);
      if (forced) {
        err(forced);
        continue;
      }
      const p = req.params;
      switch (req.method) {
        case 'terminal.run': {
          const name = p.name as string | undefined;
          if (name && [...this.terminals.values()].some((t) => t.name === name && t.state === 'live')) {
            err('name_taken');
            break;
          }
          const t: FakeTerminal = {
            address: `t${this.next++}`,
            name,
            state: 'live',
            argv: p.argv as string[],
            labels: (p.labels as Record<string, string>) ?? {},
          };
          this.terminals.set(t.address, t);
          send({ result: { address: t.address } });
          break;
        }
        case 'terminal.get': {
          const key = p.terminal as string;
          const t = this.terminals.get(key) ?? [...this.terminals.values()].find((x) => x.name === key && x.state === 'live');
          if (t) send({ result: t });
          else err('not_found');
          break;
        }
        case 'terminal.kill': {
          const t = this.terminals.get(p.terminal as string);
          if (!t) {
            err('not_found');
            break;
          }
          this.terminals.delete(t.address);
          if (this.killRemoves) err('not_found');
          else send({ result: {} });
          break;
        }
        case 'machine.exec':
          send({ result: this.exec });
          break;
        default:
          send({ result: {} });
      }
    }
  }
}

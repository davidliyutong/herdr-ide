// A terminal core on a unix socket that speaks enough of herdr-core's API
// for detection: the hello, events.subscribe (the terminals given, then the
// notifications a test sends, as lines on the subscription's channel), and
// terminal.read of a screen set by the test; attaches are refused, so the
// detector reads on every poll. Every call is recorded.
import { createServer, type Server, type Socket } from 'node:net';
import { Reader } from '#shared/lib/streamio.ts';
import type { Terminal } from '#shared/proto/hc/index.ts';
import { Kind, encodeFrame, readFrame } from '#shared/proto/hc/wire.ts';

export class DetectCore {
  terminals: Terminal[] = [];
  readonly screens = new Map<string, string>();
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** The connections open now. */
  readonly conns = new Set<Socket>();
  private readonly subs = new Set<(line: string) => void>();
  private server?: Server;

  listen(path: string): Promise<void> {
    this.server = createServer((c) => {
      this.conns.add(c);
      c.on('error', () => {});
      c.on('close', () => this.conns.delete(c));
      void this.serve(c).catch(() => c.destroy());
    });
    return new Promise((res) => this.server!.listen(path, res));
  }

  close(): void {
    this.server?.close();
    for (const c of this.conns) c.destroy();
  }

  /** Sends a notification to every subscription. */
  notify(method: string, params: Record<string, unknown>): void {
    const line = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    for (const s of this.subs) s(line);
  }

  private async serve(c: Socket): Promise<void> {
    const r = new Reader(c);
    await r.line(1 << 20);
    c.write('{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"}}}\n');
    const write = (b: Buffer) => c.destroyed || c.write(b);
    let sub: ((line: string) => void) | undefined;
    c.on('close', () => sub && this.subs.delete(sub));
    for (let f = await readFrame(r); f; f = await readFrame(r)) {
      if (f.channel !== 0) continue;
      let req: { id?: number; method: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(f.payload.toString('utf8'));
      } catch {
        continue;
      }
      if (req.id === undefined || req.id === null) continue;
      const p = req.params ?? {};
      this.calls.push({ method: req.method, params: p });
      const reply = (body: object) =>
        write(encodeFrame(0, Kind.Data, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }))));
      const failure = (kind: string) => reply({ error: { code: -32000, message: kind, data: { kind } } });
      switch (req.method) {
        case 'events.subscribe': {
          reply({ result: { channel: 7, seq: 1, terminals: this.terminals } });
          sub = (line) => write(encodeFrame(7, Kind.Data, Buffer.from(line)));
          this.subs.add(sub);
          break;
        }
        case 'terminal.read': {
          const text = this.screens.get(p.terminal as string);
          if (text === undefined) failure('not_found');
          else reply({ result: { text, complete: true, how: 'screen' } });
          break;
        }
        default:
          failure('not_found');
      }
    }
  }
}

// A stand-in for the agent's vault socket in the MCP server's tests: each
// connection gets one request, which answer() answers as the core would
// (null: never, until the server leaves), recording the requests.
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reader, writeLine } from '#shared/lib/streamio.ts';
import type { VaultRequest, VaultResponse } from '#shared/proto/agentproto/index.ts';

export interface FakeCore {
  path: string;
  seen: VaultRequest[];
  /** Connections that left before an answer, which the core takes as a
   * denial. */
  left: number;
  close(): void;
}

export async function fakeCore(answer: (req: VaultRequest) => VaultResponse | null): Promise<FakeCore> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-'));
  const path = join(dir, 'vault.sock');
  const core: FakeCore = { path, seen: [], left: 0, close: () => {} };
  const server: Server = createServer((c: Socket) => {
    c.on('error', () => {});
    void (async () => {
      const r = new Reader(c);
      let req: VaultRequest;
      try {
        req = JSON.parse(await r.line(1 << 20)) as VaultRequest;
      } catch {
        return c.destroy();
      }
      core.seen.push(req);
      const resp = answer(req);
      if (resp) {
        await writeLine(c, resp).catch(() => {});
        c.end();
        return;
      }
      // Waits for the user, until the requester leaves.
      r.release()
        .resume()
        .once('close', () => core.left++);
    })();
  });
  await new Promise<void>((res) => server.listen(path, res));
  core.close = () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return core;
}

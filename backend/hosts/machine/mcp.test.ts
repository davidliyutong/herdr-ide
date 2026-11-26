import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { survivors } from '#features/vault/machine/testdata/procs.ts';
import { mcpCommand } from './mcp.ts';

const helper = join(import.meta.dir, 'testdata', 'mcpserver.ts');

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

describe('the mcp command', () => {
  test('a wrong command line is refused with status 2', async () => {
    expect(await mcpCommand('mcp', ['--nope'])).toBe(2);
    expect(await mcpCommand('mcp', ['extra'])).toBe(2);
    expect(await mcpCommand('mcp', ['--instance', 'Not Valid'])).toBe(2);
  });

  // TestSignalEndsCommands: a server ended by a signal kills the commands
  // it runs, and the programs they left in the background: SIGTERM (as
  // SIGINT and SIGHUP) ends it in order, and SIGKILL, which it cannot see,
  // ends them through the watcher in their group.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGKILL'] as const)
    test(`${sig} ends the server and the commands it runs`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpsig-')));
      const srv = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'inherit'] });
      try {
        const exited = new Promise<{ code: number | null; signal: string | null }>((res) =>
          srv.on('exit', (code, signal) => res({ code, signal })),
        );
        srv.stdin!.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
          }) + '\n',
        );
        srv.stdin!.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'run_with_env',
              arguments: { command: 'sleep 300 & echo $! > bg; echo $$ > sh; wait', names: ['V'], cwd: dir },
            },
          }) + '\n',
        );
        const pids = await pidsIn(dir, 'bg', 'sh');
        srv.kill(sig);
        const end = await Promise.race([exited, Bun.sleep(10_000).then(() => null)]);
        expect(end).not.toBeNull();
        // A signal it handles ends it in order, once its commands are
        // killed.
        if (sig !== 'SIGKILL') expect(end).toEqual({ code: 0, signal: null });
        expect(await survivors(pids)).toEqual([]);
      } finally {
        srv.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    });
});

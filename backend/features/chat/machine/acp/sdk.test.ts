// The adapter and @agentclientprotocol/sdk: the recordings are what the
// SDK's stable schema takes, and the adapter's notifications do not depend
// on it (rpc.ts hands each one to the session before the SDK sees anything).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { client, type AnyMessage } from '@agentclientprotocol/sdk';
import * as chat from '#shared/proto/chatproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import { acpAdapter } from './adapter.ts';
import type { AcpSession } from './session.ts';
import { Host, fakeParams, logs, msgLine, promptOf, recording, tempDir } from './testing.ts';

const VECTORS = join(import.meta.dir, '..', '..', '..', '..', '..', 'spec', 'vectors', 'chat', 'acp');
const SID = 'session_00000000-0000-4000-8000-000000000001';

/** How many of the notifications the SDK's own dispatch hands to a typed
 * session/update handler (the stable schema's parse), the rest dropped. */
async function takenBySDK(params: unknown[]): Promise<number> {
  let taken = 0;
  const app = client({ name: 'test' }).onNotification('session/update', () => void taken++);
  let ctl!: ReadableStreamDefaultController<AnyMessage>;
  const readable = new ReadableStream<AnyMessage>({ start: (c) => void (ctl = c) });
  const conn = app.connect({ readable, writable: new WritableStream<AnyMessage>() });
  for (const p of params) ctl.enqueue({ jsonrpc: '2.0', method: 'session/update', params: p } as AnyMessage);
  // The SDK dispatches asynchronously: let it.
  for (let i = 0; i < 50; i++) await Bun.sleep(2);
  conn.close();
  return taken;
}

let quiet: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  quiet?.mockRestore();
  quiet = undefined;
});

describe('the SDK', () => {
  test("every session/update of the recordings validates against the SDK's stable schema", async () => {
    const params: unknown[] = [];
    for (const agent of readdirSync(VECTORS))
      for (const f of readdirSync(join(VECTORS, agent)))
        for (const l of readFileSync(join(VECTORS, agent, f), 'utf8').split('\n')) {
          if (!l.trim()) continue;
          const { dir, msg } = JSON.parse(l) as { dir: string; msg: { method?: string; params?: unknown } };
          if (dir === 'in' && msg.method === 'session/update') params.push(msg.params);
        }
    expect(params.length).toBe(635);
    expect(await takenBySDK(params)).toBe(params.length);
  });

  test("an update the stable schema refuses, which the SDK's own dispatch drops, still reaches the adapter's mapping", async () => {
    const untitled = { sessionUpdate: 'tool_call', toolCallId: 'refused-1', status: 'pending' };
    const video = { sessionUpdate: 'agent_message_chunk', content: { type: 'video', uri: 'file:///x' } };
    quiet = spyOn(console, 'error').mockImplementation(() => {});
    expect(await takenBySDK([untitled, video].map((update) => ({ sessionId: SID, update })))).toBe(0);
    quiet.mockRestore();
    quiet = undefined;

    const dir = tempDir();
    const hi = recording('kimi', '03-prompt-hi', dir);
    const update = (u: unknown) =>
      msgLine('in', JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: u } }));
    const steps = recording('kimi', '01-initialize', dir).concat(
      recording('kimi', '02-session-new', dir),
      [hi[0]!, update(untitled), update(video)],
      hi.slice(1),
    );
    const host = new Host(dir);
    const procs = new AgentProcesses();
    const a = acpAdapter({ itemPrefix: () => 'x' });
    const s = (await a.start(fakeParams(dir, steps, procs, logs().logger), host, AbortSignal.timeout(10_000))) as AcpSession;
    await s.prompt({ content: promptOf(hi), message: 'm', clientId: 'c', recorded: true });
    await host.await("the turn's end", (ev) => ev.t === chat.EventType.Turn && ev.state === chat.TurnState.End);
    await s.close(AbortSignal.timeout(10_000));
    const stored = host.events.filter((ev) => !ev.live);
    expect(stored.some((ev) => ev.item === 'refused-1' && (ev.update as { toolCallId?: string }).toolCallId === 'refused-1')).toBe(true);
    expect(stored.some((ev) => JSON.stringify(ev.update) === JSON.stringify(video))).toBe(true);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { MAX_INLINE, Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { defineProtocol } from '#shared/proto/protocol.ts';
import { write } from '#shared/lib/streamio.ts';
import { call, open } from './agent.ts';
import { Fail } from './fail.ts';
import { Machine } from './machines/machine.ts';
import { closeStream, type AgentStream } from './machines/transport/session.ts';
import { agentDialer, noDial, sshSpec, waitFor, type FakeAgentOptions } from './testing.ts';

const proto = defineProtocol('echo', {
  echo: { params: z.object({ text: z.string() }), result: z.object({ text: z.string(), length: z.number() }) },
  tail: { params: z.object({}), result: z.object({ ok: z.boolean() }), stream: true },
  strict: { params: z.object({}), result: z.object({ n: z.number() }) },
});

/** A machine connected to a fake agent that serves the plugin op with
 * serve; stop ends it. */
async function connected(serve: FakeAgentOptions['serve']) {
  const dial = agentDialer({ serve });
  const m = new Machine(sshSpec('x'), { dial, logger: () => {}, publish: () => {}, streams: () => undefined, localSupported: true });
  const ac = new AbortController();
  const done = m.run(ac.signal);
  await waitFor('ready', () => m.ready);
  stops.push(async () => {
    ac.abort();
    await done;
  });
  return { m, agent: dial.agents[0] };
}
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** Serves echo: params inline or as a body, the result inline unless big
 * (then as a body). */
async function echo(h: Header, c: AgentStream): Promise<void> {
  let params = h.params as { text: string };
  if (h.params_length) params = (await readBody(c.reader, h.params_length)) as { text: string };
  const result = { text: params.text, length: params.text.length };
  const encoded = Buffer.from(JSON.stringify(result));
  if (encoded.length > MAX_INLINE) {
    await writeLine(c.stream, { ok: true, plugin_length: encoded.length } satisfies Reply);
    await write(c.stream, encoded);
  } else await writeLine(c.stream, { ok: true, plugin: result } satisfies Reply);
  c.reader.release();
  closeStream(c.stream);
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e) => (e instanceof Fail ? `${e.code} ${e.status}` : `not a Fail: ${(e as Error).name} ${(e as Error).message}`),
  );

describe('agent actions', () => {
  // Params and results within MAX_INLINE travel in their lines; larger
  // ones follow their lines as bodies (params_length, plugin_length).
  test('inline and as bodies', async () => {
    const { m, agent } = await connected(echo);
    expect(await call(m, proto, 'echo', { text: 'hi' })).toEqual({ text: 'hi', length: 2 });
    const h = agent.headers.at(-1)!;
    expect(h).toEqual({ op: Op.Plugin, plugin: 'echo', action: 'echo', params: { text: 'hi' } });

    const big = 'x'.repeat(MAX_INLINE + 1);
    expect(await call(m, proto, 'echo', { text: big })).toEqual({ text: big, length: big.length });
    const hb = agent.headers.at(-1)!;
    expect([hb.params, hb.params_length]).toEqual([undefined, JSON.stringify({ text: big }).length]);

    // At MAX_INLINE exactly the params stay in the line.
    const edge = 'y'.repeat(MAX_INLINE - JSON.stringify({ text: '' }).length);
    expect((await call(m, proto, 'echo', { text: edge })).length).toBe(edge.length);
    expect(agent.headers.at(-1)!.params_length).toBeUndefined();
  });

  // An agent's refusal keeps its code: offline 409, transport 502,
  // not_found 404, the others 400; without a code it is failed.
  test('agent errors', async () => {
    const { m } = await connected(async (h, c) => {
      const code = (h.params as { text: string }).text;
      await writeLine(c.stream, { ok: false, error: `said ${code}`, ...(code ? { code } : {}) } satisfies Reply);
      closeStream(c.stream);
    });
    for (const [code, want] of [
      ['not_found', 'not_found 404'],
      ['offline', 'offline 409'],
      ['transport', 'transport 502'],
      ['denied', 'denied 400'],
      ['', 'failed 400'],
    ])
      expect([code, await codeOf(call(m, proto, 'echo', { text: code }))]).toEqual([code, want]);
    const err = await call(m, proto, 'echo', { text: 'denied' }).then(
      () => null,
      (e: Fail) => e,
    );
    expect(err?.message).toBe('said denied');
  });

  // A stream that breaks before its reply, or whose result body does not
  // arrive, fails with transport.
  test('transport', async () => {
    const { m } = await connected(async (h, c) => {
      if (h.action === 'echo') return void c.stream.destroy();
      await writeLine(c.stream, { ok: true, plugin_length: 100 } satisfies Reply);
      c.stream.end('{"n":');
    });
    expect(await codeOf(call(m, proto, 'echo', { text: 'x' }))).toBe('transport 502');
    expect(await codeOf(call(m, proto, 'strict', {}))).toBe('transport 502');
  });

  test('offline', async () => {
    const m = new Machine(sshSpec('x'), {
      dial: noDial,
      logger: () => {},
      publish: () => {},
      streams: () => undefined,
      localSupported: true,
    });
    expect(await codeOf(call(m, proto, 'echo', { text: 'x' }))).toBe('offline 409');
  });

  // A result that does not match the action fails invalid_result.
  test('invalid result', async () => {
    const { m } = await connected(async (_h, c) => {
      await writeLine(c.stream, { ok: true, plugin: { n: 'one' } } satisfies Reply);
      closeStream(c.stream);
    });
    expect(await codeOf(call(m, proto, 'strict', {}))).toBe('invalid_result 502');
  });

  // A streaming action's bytes follow its reply; the caller reads them
  // from the stream it gets, which ends with the caller's signal.
  test('open and stream', async () => {
    const { m } = await connected(async (_h, c) => {
      await writeLine(c.stream, { ok: true, plugin: { ok: true } } satisfies Reply);
      await write(c.stream, 'first');
      c.stream.resume();
      c.stream.on('error', () => {});
    });
    const ac = new AbortController();
    const { result, conn } = await open(m, proto, 'tail', {}, { signal: ac.signal });
    expect(result).toEqual({ ok: true });
    expect((await conn.reader.exactly(5)).toString()).toBe('first');
    const closed = new Promise((r) => conn.stream.once('close', r));
    ac.abort();
    await closed;
    expect(conn.stream.destroyed).toBe(true);
  });

  // A signal that ends before the reply ends the call with its reason.
  test('aborted', async () => {
    const { m } = await connected(() => {});
    const ac = new AbortController();
    const p = call(m, proto, 'strict', {}, { signal: ac.signal }).then(
      () => null,
      (e: Error) => e,
    );
    setTimeout(() => ac.abort(), 20);
    const err = await p;
    expect(err).not.toBeInstanceOf(Fail);
    expect(err?.name).toBe('AbortError');
  });

  // An action's timeout ends a reply that does not come.
  test('timeout', async () => {
    const { m } = await connected(() => {});
    expect(await codeOf(call(m, proto, 'strict', {}, { timeoutMs: 30 }))).toBe('transport 502');
  });
});

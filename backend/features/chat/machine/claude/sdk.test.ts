// The seam to the Agent SDK: the pinned version, its undeclared
// cancelAsyncMessage (this test fails when an upgrade drops it), the
// framing of the program's output, the user's messages, and the program as
// the SDK sees it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { query, type Query, type SDKUserMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';
import { AgentProcesses } from '../agentproc.ts';
import { AgentSpawn, Lines, Prompts, SDK_VERSION, cancelAsyncMessage, unhide } from './sdk.ts';

test('the SDK is the version the adapter is built with', () => {
  const pkg = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
      'utf8',
    ),
  ) as {
    version: string;
  };
  expect(pkg.version).toBe(SDK_VERSION);
  const own = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  expect({ ...own.dependencies, ...own.devDependencies }['@anthropic-ai/claude-agent-sdk']).toBe(SDK_VERSION);
});

/** A query of the SDK whose program is two pipes: what the SDK writes, and
 * what the test answers. No process runs. */
function piped(): { q: Query; lines: AsyncIterator<string>; answer: (m: unknown) => void } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc: SpawnedProcess = {
    stdin,
    stdout,
    killed: false,
    exitCode: null,
    kill: () => true,
    on: () => {},
    once: () => {},
    off: () => {},
  };
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = query({ prompt, options: { pathToClaudeCodeExecutable: '/nonexistent/claude', spawnClaudeCodeProcess: () => proc } });
  const lines = (async function* () {
    let buf = '';
    for await (const b of stdin) {
      buf += String(b);
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
  })();
  return { q, lines, answer: (m) => stdout.write(JSON.stringify(m) + '\n') };
}

describe('cancelAsyncMessage', () => {
  test("the SDK's Query has it, undeclared: it withdraws a queued message by its uuid", async () => {
    const { q, lines, answer } = piped();
    try {
      expect(typeof (q as unknown as { cancelAsyncMessage?: unknown }).cancelAsyncMessage).toBe('function');
      const init = JSON.parse((await lines.next()).value as string) as { request_id: string; request: { subtype: string } };
      expect(init.request.subtype).toBe('initialize');
      answer({
        type: 'control_response',
        response: { subtype: 'success', request_id: init.request_id, response: { commands: [], models: [] } },
      });
      for (const cancelled of [true, false]) {
        const p = cancelAsyncMessage(q, 'u-1');
        const req = JSON.parse((await lines.next()).value as string) as { request_id: string; request: unknown };
        expect(req.request).toEqual({ subtype: 'cancel_async_message', message_uuid: 'u-1' });
        answer({
          type: 'control_response',
          response: { subtype: 'success', request_id: req.request_id, response: { cancelled, message_uuid: 'u-1' } },
        });
        expect(await p).toBe(cancelled);
      }
    } finally {
      q.close();
    }
  });

  test('a Query without it is refused as unsupported', async () => {
    const e = await cancelAsyncMessage({} as Query, 'u-1').catch((e: unknown) => e);
    expect(e).toBeInstanceOf(ChatProtoError);
    expect((e as ChatProtoError).code).toBe(Code.Unsupported);
  });
});

describe('Lines', () => {
  const take = (l: Lines, ...chunks: string[]) => chunks.flatMap((c) => l.write(Buffer.from(c))).map(String);

  test('complete lines with their newlines, a line across chunks, the last without its newline at the end', () => {
    let skipped = 0;
    const l = new Lines(
      10,
      (b) => b,
      () => skipped++,
    );
    expect(take(l, 'a\nb', 'c\n', '\nd')).toEqual(['a\n', 'bc\n', '\n']);
    expect(l.end().map(String)).toEqual(['d\n']);
    expect(l.end()).toEqual([]);
    expect(skipped).toBe(0);
  });

  test('a line longer than its bound is dropped, the next one kept', () => {
    let skipped = 0;
    const l = new Lines(
      4,
      (b) => b,
      () => skipped++,
    );
    expect(take(l, '1234\n', '12345', '67\nok\n', 'xxxxxxx')).toEqual(['1234\n', 'ok\n']);
    expect(skipped).toBe(1);
    expect(l.end()).toEqual([]);
    expect(skipped).toBe(2);
  });

  test('session_state_changed loses the mark the SDK drops it for; nothing else changes', () => {
    const line = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
    const hidden = { type: 'system', subtype: 'session_state_changed', state: 'idle', sdk_host_only: true, uuid: 'u' };
    expect(JSON.parse(String(unhide(line(hidden))))).toEqual({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      uuid: 'u',
    });
    for (const v of [
      { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      { type: 'system', subtype: 'status', sdk_host_only: true, note: 'session_state_changed' },
      { type: 'assistant', text: '"session_state_changed" "sdk_host_only"' },
    ]) {
      const b = line(v);
      expect(unhide(b)).toBe(b);
    }
    const broken = Buffer.from('{"session_state_changed" "sdk_host_only"\n');
    expect(unhide(broken)).toBe(broken);
  });
});

describe('Prompts', () => {
  test('a message is sent once the SDK took it and asked for the next; the end fails those not taken', async () => {
    const p = new Prompts();
    const it = p[Symbol.asyncIterator]();
    const m = (uuid: string) => ({ type: 'user', uuid }) as unknown as SDKUserMessage;
    let sent1 = false;
    const s1 = p.send(m('1')).then(() => (sent1 = true));
    const s2 = p.send(m('2'));
    expect(((await it.next()).value as { uuid: string }).uuid).toBe('1');
    await Bun.sleep(1);
    expect(sent1).toBe(false);
    const n2 = it.next();
    await s1;
    expect(((await n2).value as { uuid: string }).uuid).toBe('2');
    p.end(new Error('gone'));
    expect(
      await s2.then(
        () => 'sent',
        (e: Error) => e.message,
      ),
    ).toBe('sent');
    const s3 = await p.send(m('3')).catch((e: unknown) => e);
    expect((s3 as ChatProtoError).code).toBe(Code.Ended);
    expect((await it.next()).done).toBe(true);
  });

  test('ending while a message waits fails it', async () => {
    const p = new Prompts();
    const s = p.send({ type: 'user' } as unknown as SDKUserMessage).catch((e: Error) => e.message);
    p.end(new Error('gone'));
    expect(await s).toBe('gone');
  });
});

describe('AgentSpawn', () => {
  const timing = { grace: 200, term: 200, drain: 200 };

  test('runs the program after the arguments given, frames its output, tells its exit and ends', async () => {
    const procs = new AgentProcesses();
    const s = new AgentSpawn(
      { procs, argv: ['/bin/sh', '-c', 'printf "a\\nb"; echo "$1" >&2; exit 3', 'sh'], timing, skipped: () => {} },
      {
        command: '/bin/sh',
        args: ['arg'],
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', GONE: undefined },
        signal: new AbortController().signal,
      },
    );
    const exit = new Promise<[number | null, string | null]>((r) => s.once('exit', (c, sig) => r([c, sig])));
    const out: string[] = [];
    for await (const b of s.stdout) out.push(String(b));
    expect(out.join('')).toBe('a\nb\n');
    expect(await exit).toEqual([3, null]);
    await s.ended;
    expect(s.exitCode).toBe(3);
    expect(s.process?.stderr()).toBe('arg\n');
    expect(s.pid).toBe(0);
    expect(s.outputEnded).toBe(true);
  });

  test('refuses another program than the one given', async () => {
    const s = new AgentSpawn(
      { procs: new AgentProcesses(), argv: ['/bin/sh'], timing, skipped: () => {} },
      { command: '/usr/bin/env', args: [], env: {}, signal: new AbortController().signal },
    );
    const err = await new Promise<Error>((r) => s.once('error', r));
    expect(err.message).toContain('not /bin/sh');
    await s.ended;
    expect(s.outputEnded).toBe(true);
  });
});

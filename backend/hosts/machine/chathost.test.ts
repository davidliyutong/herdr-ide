import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { chatSpec } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { TestHost } from '#features/chat/machine/host/testing.ts';
import { chatHostCommand } from './chathost.ts';
import { chatAdapters } from './features.ts';

setDefaultTimeout(30_000);

let h: TestHost | null = null;
afterEach(async () => {
  await h?.stop();
  h?.cleanup();
  h = null;
});

test('the kinds whose adapter is not ported are refused as kinds without a chat, the host goes on', async () => {
  h = new TestHost();
  h.o = { ...h.o, adapters: chatAdapters(), spec: chatSpec };
  await h.serve();
  const agents = await h.request({ op: chat.Op.Agents, kinds: ['claude', 'opencode'] });
  expect(agents.agents).toEqual([
    { kind: 'claude', available: false, reason: 'unsupported' },
    { kind: 'opencode', available: false, reason: 'unsupported' },
  ]);
  for (const kind of ['claude']) {
    expect((await h.request({ op: chat.Op.New, kind, cwd: h.cwd })).error).toEqual({
      code: 'unsupported',
      message: `this host has no adapter ${kind}`,
    });
    expect((await h.request({ op: chat.Op.Sessions, kind, cwd: h.cwd })).error?.code).toBe('unsupported');
    expect((await h.request({ op: chat.Op.New, kind, cwd: h.cwd, resume: 'abc', import: true })).error?.code).toBe('unsupported');
  }
  expect((await h.request({ op: chat.Op.New, kind: 'opencode', cwd: h.cwd })).error).toEqual({
    code: 'unsupported',
    message: 'the kind has no chat',
  });
  expect((await h.request({ op: chat.Op.Chats })).chats).toEqual([]);
  // The ACP kinds and Codex have their adapter (their programs are not
  // installed here).
  expect((await h.request({ op: chat.Op.Agents, kinds: ['kimi', 'codex'] })).agents).toEqual([
    { kind: 'kimi', available: false, reason: 'not_found' },
    { kind: 'codex', available: false, reason: 'not_found' },
  ]);
});

test('chat-host: a wrong command line is status 2', async () => {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    expect(await chatHostCommand([])).toBe(2);
    expect(await chatHostCommand(['--base', '/b'])).toBe(2);
    expect(await chatHostCommand(['--base', '/b', '--run', '/r', 'extra'])).toBe(2);
    expect(await chatHostCommand(['--nope'])).toBe(2);
  } finally {
    process.stderr.write = write;
  }
});

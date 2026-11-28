import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { chatSpec } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { TestHost, eventually } from '#features/chat/machine/host/testing.ts';
import { chatHostCommand } from './chathost.ts';
import { chatAdapters } from './features.ts';

setDefaultTimeout(30_000);

let h: TestHost | null = null;
afterEach(async () => {
  await h?.stop();
  h?.cleanup();
  h = null;
});

test('the host has every adapter; a kind without a chat is refused, the host goes on', async () => {
  h = new TestHost();
  h.o = { ...h.o, adapters: chatAdapters({ base: h.base }), spec: chatSpec };
  await h.serve();
  // Every adapter is there: Claude Code's, Codex's and the ACP kinds'
  // (their programs are not installed here; the test host looks in the
  // system's PATH only).
  const agents = await h.request({ op: chat.Op.Agents, kinds: ['claude', 'codex', 'agy', 'kimi', 'opencode'] });
  expect(agents.agents).toEqual([
    { kind: 'claude', available: false, reason: 'not_found' },
    { kind: 'codex', available: false, reason: 'not_found' },
    { kind: 'agy', available: false, reason: 'not_found' },
    { kind: 'kimi', available: false, reason: 'not_found' },
    { kind: 'opencode', available: false, reason: 'unsupported' },
  ]);
  expect((await h.request({ op: chat.Op.New, kind: 'opencode', cwd: h.cwd })).error).toEqual({
    code: 'unsupported',
    message: 'the kind has no chat',
  });
  // Claude Code's sessions are its transcripts (none in the test's home).
  expect((await h.request({ op: chat.Op.Sessions, kind: 'claude', cwd: h.cwd })).sessions ?? []).toEqual([]);
  expect((await h.request({ op: chat.Op.Chats })).chats).toEqual([]);
});

test('a Claude Code chat on a machine without the Agent SDK fails with sdk_unavailable, before anything runs; the host goes on', async () => {
  h = new TestHost();
  // A program for the kind that is there, which nothing runs: the SDK is
  // loaded first, from the host's data directory, where none was installed.
  const spec = (id: string) => (id === 'claude' ? { ...chatSpec('claude')!, argv: ['/bin/sh', '-c', 'exit 3'] } : chatSpec(id));
  h.o = { ...h.o, adapters: chatAdapters({ base: h.base }), spec };
  await h.serve();
  const res = await h.request({ op: chat.Op.New, kind: 'claude', cwd: h.cwd });
  const id = res.chat!.id;
  await eventually('failed', () => h!.chat(id).r.chat.state === chat.State.Failed);
  expect(h.chat(id).r.chat.error?.code).toBe(chat.Code.SdkUnavailable);
  expect(h.chat(id).r.chat.error?.message).toContain('@anthropic-ai/claude-agent-sdk 0.3.322 is not on this machine');
  expect((await h.request({ op: chat.Op.Chats })).chats?.map((c) => c.id)).toEqual([id]);
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

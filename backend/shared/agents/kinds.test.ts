import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, Adapter, PLACEHOLDER, all, byId, chatKinds, chatSpec, validSessionId, type Kind } from './kinds.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { PROVIDERS } from '#features/usage/settings.ts';

const repo = REPO_ROOT;
const ids = (list: Kind[]) => list.map((k) => k.id);
const sorted = (list: string[]) => [...list].sort();

// The detector's manifests (features/agents/machine/detect/manifests), by
// id: each file's top-level id.
function manifestIds(): string[] {
  const dir = join(repo, 'backend/features/agents/machine/detect/manifests');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.toml'))
    .map((f) => {
      const id = readFileSync(join(dir, f), 'utf8').match(/^id\s*=\s*"([^"]+)"/m)?.[1];
      if (!id) throw new Error(`${f}: no id`);
      return id;
    })
    .sort();
}

// The registry the web UI reads (spec/generated/registry.json).
const registry = () => JSON.parse(readFileSync(join(repo, 'spec/generated/registry.json'), 'utf8'));

// The registry, the detector's manifests and the settings' list of agents
// name the same agents; each provider of the AI usage plugin a kind names
// is one of its providers.
test('kinds match the manifests and the settings', () => {
  const manifests = manifestIds();
  const got = ids(all());
  expect(new Set(got).size).toBe(got.length);
  expect(sorted(got)).toEqual(manifests);
  // The settings' list of silent agents offers the kinds' ids
  // (uisettings.Agents); its default is one of them.
  const muted = registry().settings['notifications.mutedAgents'] as string[];
  for (const id of muted) expect(got).toContain(id);
  for (const k of all()) {
    expect(k.title).not.toBe('');
    if (k.usageProvider !== undefined) expect<readonly string[]>(PROVIDERS).toContain(k.usageProvider);
    if (k.transcript !== undefined) {
      expect(k.resumeById).toBeDefined();
      expect(k.continueLatest).toBeDefined();
    }
    if (k.newSession !== undefined) expect(k.start).toBeDefined();
    for (const tokens of [k.newSession, k.resumeById]) if (tokens) expect(tokens).toContain(PLACEHOLDER);
  }
  expect(byId('agy')?.usageProvider).toBe('antigravity');
});

// The values the web UI had in its own tables before the registry: the
// commands that continue a directory's latest conversation, and the agents
// the command palette starts, in its order.
test('kinds keep the UI’s commands', () => {
  const cont: Record<string, string> = {};
  const started: string[] = [];
  for (const k of all()) {
    if (k.continueLatest) cont[k.id] = k.continueLatest.join(' ');
    if (k.start) {
      started.push(k.id);
      expect(k.start).toEqual([k.id]);
    }
  }
  expect(cont).toEqual({ claude: 'claude --continue', codex: 'codex resume --last' });
  expect(started).toEqual(['claude', 'codex', 'gemini', 'opencode', 'kimi', 'grok', 'cursor', 'copilot', 'qwen', 'amp']);
  const claude = byId('claude')!;
  expect(claude.resumeById).toEqual(['claude', '--resume', PLACEHOLDER]);
  expect([...claude.start!, ...claude.newSession!]).toEqual(['claude', '--session-id', PLACEHOLDER]);
  const codex = byId('codex')!;
  expect(codex.resumeById).toEqual(['codex', 'resume', PLACEHOLDER]);
  expect(codex.newSession).toBeUndefined();
  expect(byId('nobody')).toBeUndefined();
});

// Only a lower-case UUID is a session id: quotes, separators,
// substitutions and newlines are refused.
test('session ids', () => {
  const good = '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f';
  expect(validSessionId(good)).toBe(true);
  for (const bad of [
    '',
    '0B6F5C1E-8D3A-4C2B-9E1F-2A3B4C5D6E7F',
    good + ' ',
    ' ' + good,
    good + '\n',
    good + '; rm -rf ~',
    '$(id)',
    '`id`',
    'x; rm -rf ~',
    "'" + good + "'",
    '0b6f5c1e8d3a4c2b9e1f2a3b4c5d6e7f',
    '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7',
    '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f0',
    '../../etc/passwd',
    '0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7g',
  ]) {
    expect(validSessionId(bad)).toBe(false);
  }
});

// The registry cannot be changed through what all, byId, chatKinds and
// chatSpec return.
test('kinds are copies', () => {
  const k = byId('claude')!;
  k.start![0] = 'rm';
  k.chat!.adapter = Adapter.ACP;
  all()[0]!.resumeById![0] = 'rm';
  chatKinds()[0]!.start![0] = 'rm';
  const spec = chatSpec('claude')!;
  spec.argv[0] = 'rm';
  spec.adapter = Adapter.ACP;
  const grok = chatSpec('grok')!;
  grok.newSessionMeta!.yoloMode = true;
  grok.argv.splice(1, grok.argv.length - 1, '--yolo');
  const again = byId('claude')!;
  expect(again.start![0]).toBe('claude');
  expect(again.resumeById![0]).toBe('claude');
  expect(again.chat!.adapter).toBe(Adapter.Claude);
  expect(chatSpec('claude')).toEqual({ adapter: Adapter.Claude, argv: ['claude'] });
  expect(chatSpec('grok')!.newSessionMeta).toEqual({ yoloMode: false });
  expect(chatSpec('grok')!.argv).toEqual(['grok', 'agent', '--no-leader', 'stdio']);
  expect(() => (ADAPTERS as string[]).push('x')).toThrow();
});

// The kinds the chat host runs: each has a detector manifest (so its
// terminals are recognized too), an adapter of the host's, and a command
// whose program is the one the kind starts in a terminal; ACP's session
// metadata is a JSON object. OpenCode has none: its ACP mode listens on a
// TCP port without authentication.
test('chat kinds', () => {
  const manifests = manifestIds();
  expect(ids(chatKinds())).toEqual(['claude', 'codex', 'kimi', 'grok']);
  for (const k of all()) {
    const spec = chatSpec(k.id);
    if (!k.chat) {
      expect(spec).toBeUndefined();
      expect(ids(chatKinds())).not.toContain(k.id);
      continue;
    }
    expect(spec?.adapter).toBe(k.chat.adapter);
    expect(manifests).toContain(k.id);
    expect(ADAPTERS).toContain(k.chat.adapter);
    expect(spec!.argv.length).toBeGreaterThan(0);
    expect(k.start?.length).toBeGreaterThan(0);
    expect(spec!.argv[0]).toBe(k.start![0]!);
    const meta = spec!.newSessionMeta;
    if (meta !== undefined) {
      expect(k.chat.adapter).toBe(Adapter.ACP);
      expect(typeof meta === 'object' && meta !== null && !Array.isArray(meta)).toBe(true);
    }
  }
  expect(byId('opencode')!.chat).toBeUndefined();
  expect(chatSpec('opencode')).toBeUndefined();
  const want: Record<string, string> = {
    claude: 'claude [claude]',
    codex: 'codex [codex app-server --listen stdio://]',
    kimi: 'acp [kimi acp]',
    grok: 'acp [grok agent --no-leader stdio]',
  };
  for (const [id, w] of Object.entries(want)) {
    const spec = chatSpec(id)!;
    expect(`${spec.adapter} [${spec.argv.join(' ')}]`).toBe(w);
  }
  expect(ADAPTERS).toEqual(['claude', 'codex', 'acp']);
});

describe('JSON', () => {
  // The kinds' JSON, as the web UI reads it from the generated registry.
  test('a kind', () => {
    expect(JSON.stringify(byId('codex'))).toBe(
      '{"id":"codex","title":"Codex","usageProvider":"codex","start":["codex"],"continueLatest":["codex","resume","--last"],"resumeById":["codex","resume","{id}"],"transcript":"codex","chat":{"adapter":"codex"}}',
    );
    // A chat's command, environment and session metadata stay on the
    // machine's side.
    expect(JSON.stringify(byId('grok'))).toBe(
      '{"id":"grok","title":"Grok","usageProvider":"grok","start":["grok"],"chat":{"adapter":"acp"}}',
    );
    expect(JSON.stringify(byId('droid'))).toBe('{"id":"droid","title":"Droid"}');
  });

  // The registry the core generates (kernel/config/registry.ts) is the same,
  // member for member and in order.
  test('the generated registry', () => {
    expect(JSON.stringify(registry().agents)).toBe(JSON.stringify(all()));
  });
});

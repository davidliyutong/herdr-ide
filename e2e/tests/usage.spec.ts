import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '../harness/fixtures';
import { showPanel } from '../harness/ui';
import { waitFor } from '../harness/wait';

interface Cost {
  rows: { provider: string; model: string; cost: number; priced: boolean; machine: string }[];
}

test('AI usage prices a Claude Code log at API prices, and at the user’s own', async ({ app, instance }) => {
  // One assistant message of claude-opus-5-5: 1M input tokens at $4 and
  // 100k output tokens at $20 per million make $6.
  const dir = join(instance.home, '.claude', 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  const line = {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    uuid: '00000000-0000-4000-8000-000000000001',
    cwd: instance.work,
    message: { role: 'assistant', id: 'msg_e2e', model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
  };
  writeFileSync(join(dir, '00000000-0000-4000-8000-0000000000aa.jsonl'), JSON.stringify(line) + '\n');

  const cost = await instance.api<Cost>('GET', '/api/p/usage/cost?days=7&tz=0');
  expect(cost.rows).toEqual([
    expect.objectContaining({ provider: 'claude', model: 'claude-opus-5-5', cost: 6, priced: true, machine: 'local' }),
  ]);
  const panel = await showPanel(app, 'AI Usage');
  await expect(panel).toContainText('Claude $6.00');
  await expect(panel).toContainText('claude-opus-5-5');

  // The user's price for the model: $1 in, $0.5 cached, $10 out → $2.
  await instance.api('PUT', '/api/settings', { key: 'usage.prices', value: ['claude-opus-5-5 1 0.5 10'] });
  await waitFor(async () => (await instance.api<Cost>('GET', '/api/p/usage/cost?days=7&tz=0')).rows[0]?.cost === 2, {
    what: 'the cost at the user’s price',
  });
  // The panel reads the report again at once.
  await expect(panel).toContainText('Claude $2.00');
});

test('AI usage reads OpenCode’s database on the machine, its steps at the cost OpenCode recorded', async ({ instance }) => {
  // A database of OpenCode's, its writer gone: the machine reads it
  // read-only (the TypeScript side in a worker thread of SQLite's).
  const dir = join(instance.home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(
    'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)',
  );
  const now = Date.now();
  const step = {
    role: 'assistant',
    time: { created: now },
    modelID: 'deepseek-v4-flash',
    providerID: 'deepseek',
    cost: 0.25,
    path: { cwd: instance.work },
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_e2e', 'ses_1', now, now, JSON.stringify(step));
  db.close();

  const cost = await instance.api<Cost>('GET', '/api/p/usage/cost?days=7&tz=0');
  expect(cost.rows).toEqual([
    expect.objectContaining({ provider: 'opencode', model: 'deepseek-v4-flash', cost: 0.25, priced: true, machine: 'local' }),
  ]);
});

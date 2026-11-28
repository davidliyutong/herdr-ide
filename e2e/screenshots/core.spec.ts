import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../harness/fixtures';
import { git, gitConfig } from '../harness/git';
import { cdInTerminal, explorer, newTerminalTab, terminalOfPane } from '../harness/ui';
import { capture, newChat, newTerminal, prepare, restoreEditor, seedWorkspace, sendChat, showPanel } from './support';
import { DEMO_NOW } from './demo';
import { wants } from './manifest';

test.beforeEach(async ({ app, instance }) => {
  await prepare(app, instance);
});

(wants('chat') ? test : test.skip)('agent chat screenshot', async ({ app, instance }) => {
  const pane = await newChat(app);
  await sendChat(pane, 'demo review');
  await expect(pane).toContainText('Training review');
  const edit = pane.locator('[role="log"] button').filter({ hasText: 'train.py' }).nth(1);
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(pane.locator('.conv-diff')).toBeVisible();
  await sendChat(pane, 'permission train.py');
  await expect(pane.locator('.chat-state')).toHaveText('Waiting for you');
  await showPanel(app, 'chat');
  await capture(app, instance, 'chat', async () => {
    await showPanel(app, 'chat');
    const chatHost = app.locator('.pane:has(.chat-pane)');
    await expect(chatHost).toContainText('Training review');
    if (!(await chatHost.locator('.conv-diff').isVisible()))
      await chatHost.locator('[role="log"] button').filter({ hasText: 'train.py' }).nth(1).click();
    await expect(chatHost.locator('.conv-diff')).toBeVisible();
    await expect(chatHost.locator('.chat-state')).toHaveText(/^(?:Waiting for you|等待你的回复)$/);
  });
});

async function workspaceTerminal(
  app: Parameters<typeof newTerminalTab>[0],
  instance: Parameters<typeof seedWorkspace>[0],
  term: Parameters<typeof terminalOfPane>[0],
) {
  await seedWorkspace(instance);
  await newTerminal(app);
  const addr = await terminalOfPane(term, 1);
  await cdInTerminal(app, term, addr, instance.work);
  return addr;
}

(wants('files') ? test : test.skip)('file explorer screenshot', async ({ app, instance, term }) => {
  await workspaceTerminal(app, instance, term);
  const tree = await explorer(app);
  await tree.getByRole('treeitem', { name: 'train.py', exact: true }).click();
  await expect(app.locator('.files-editor .monaco-editor')).toContainText('log_interval');
  await capture(app, instance, 'files', async () => {
    await restoreEditor(app, 'train.py');
    await expect(app.locator('.files-editor .monaco-editor')).toContainText('learning_rate');
    await expect(app.getByRole('navigation', { name: /Folder shown|文件夹/ })).toHaveAttribute('title', instance.work);
  });
});

(wants('quicklook') ? test : test.skip)('Quick Look screenshot', async ({ app, instance, term }) => {
  await workspaceTerminal(app, instance, term);
  const tree = await explorer(app);
  await tree.getByRole('treeitem', { name: 'plots', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'loss.svg', exact: true }).click();
  await expect(app.locator('.files-editor img')).toBeVisible();
  await expect.poll(() => app.locator('.files-editor img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1200);
  await capture(app, instance, 'quicklook', async () => {
    await restoreEditor(app, 'loss.svg');
    await expect(app.locator('.files-editor img')).toBeVisible();
  });
});

(wants('search') ? test : test.skip)('project search screenshot', async ({ app, instance, term }) => {
  await workspaceTerminal(app, instance, term);
  await capture(app, instance, 'search', async () => {
    const panel = await showPanel(app, 'search');
    await panel.locator('.search-input').first().fill('learning_rate');
    await panel.locator('.search-scope button').last().click();
    await panel.locator('.search-details input').first().fill('*.py');
    await panel.locator('.search-input').first().press('Enter');
    await expect(panel.locator('.search-results')).toContainText('train.py');
    await expect(panel.locator('.search-results')).toContainText('model.py');
    await panel.locator('.search-match').first().click();
    await expect(app.locator('.files-editor .monaco-editor')).toContainText('learning_rate');
  });
});

function commit(instance: Parameters<typeof gitConfig>[0], message: string, date: string) {
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: instance.work,
    env: {
      HOME: instance.home,
      PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ada Research',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Research',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

function seedGit(instance: Parameters<typeof gitConfig>[0]) {
  gitConfig(instance);
  git(instance, instance.work, 'init', '-q');
  git(instance, instance.work, 'add', '-A');
  commit(instance, 'Initial training pipeline', '2026-11-20T10:00:00Z');
  appendFileSync(join(instance.work, 'docs', 'optimization.md'), '\nWarmup keeps early updates small.\n');
  git(instance, instance.work, 'add', '-A');
  commit(instance, 'Document warmup and cosine decay', '2026-11-21T11:30:00Z');
  git(instance, instance.work, 'checkout', '-q', '-b', 'feature/learning-rate');
  appendFileSync(join(instance.work, 'train.py'), '\n# Learning rates are included in every metrics record.\n');
  git(instance, instance.work, 'add', '-A');
  commit(instance, 'Add learning-rate metrics', '2026-11-22T14:45:00Z');
  git(instance, instance.work, 'checkout', '-q', 'main');
  appendFileSync(join(instance.work, 'configs', 'base.toml'), 'warmup_steps = 10\n');
  git(instance, instance.work, 'add', '-A');
  commit(instance, 'Configure a ten-step warmup', '2026-11-23T09:15:00Z');
  execFileSync('git', ['merge', '-q', '--no-ff', 'feature/learning-rate', '-m', 'Merge learning-rate observability'], {
    cwd: instance.work,
    env: {
      HOME: instance.home,
      PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ada Research',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Research',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '2026-11-24T16:20:00Z',
      GIT_COMMITTER_DATE: '2026-11-24T16:20:00Z',
    },
  });
  git(instance, instance.work, 'tag', '-a', 'v0.4.0', '-m', 'Training observability');
  appendFileSync(join(instance.work, 'README.md'), '\nMetrics now include the learning rate at every log interval.\n');
  git(instance, instance.work, 'add', 'README.md');
  appendFileSync(join(instance.work, 'train.py'), '\n# Next experiment: record validation loss every twenty steps.\n');
  writeFileSync(join(instance.work, 'evaluate.py'), '"""Run a fixed evaluation batch."""\nprint("val/loss=2.147")\n');
}

(wants('git') ? test : test.skip)('Git graph and diff screenshot', async ({ app, instance, term }) => {
  await workspaceTerminal(app, instance, term);
  seedGit(instance);
  const panel = await showPanel(app, 'git');
  await expect(panel.getByRole('tree', { name: 'Changes' })).toContainText('train.py');
  await panel.getByRole('button', { name: 'Open Git Graph' }).click();
  await expect(app.locator('.git-graph')).toContainText('Merge learning-rate observability');
  await app.locator('.git-graph-row').filter({ hasText: 'Add learning-rate metrics' }).click();
  await expect(app.locator('.git-detail')).toContainText('Ada Research');
  await app.locator('.git-detail .git-file').filter({ hasText: 'train.py' }).click();
  await expect(app.locator('.git-diff')).toBeVisible();
  await capture(app, instance, 'git', async () => {
    await app.clock.setFixedTime(DEMO_NOW);
    await showPanel(app, 'git');
    if (await app.locator('.git-history.open').isVisible()) await app.locator('.git-history-head').click();
    if (!(await app.locator('.git-detail').isVisible()))
      await app.locator('.git-graph-row').filter({ hasText: 'Add learning-rate metrics' }).click();
    await expect(app.locator('.git-detail')).toContainText('Ada Research');
    await expect(app.locator('.git-graph')).toContainText('v0.4.0');
    await expect(app.locator('.git-diff')).toContainText('train.py');
  });
});

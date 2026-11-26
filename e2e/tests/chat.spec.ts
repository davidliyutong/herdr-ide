import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../harness/fixtures';
import { AGENT, chatPane, chats, log, newChat, onlyChat, send } from '../harness/chat';
import { showPanel } from '../harness/ui';
import { waitFor } from '../harness/wait';

test('a chat streams answers and asks before it writes', async ({ app, instance }) => {
  const pane = await newChat(app);
  await send(pane, 'hello there');
  await expect(log(pane)).toContainText('Echo #1: hello there');
  await expect(pane.locator('.chat-title')).toHaveText('hello there');

  // Allowed once: the agent writes the file.
  await send(pane, 'permission allowed.txt');
  const ask = log(pane)
    .getByRole('group')
    .filter({ hasText: `${AGENT} wants to change files` });
  await expect(ask).toBeVisible();
  await expect(pane.locator('.chat-state')).toHaveText('Waiting for you');
  await ask.getByRole('button', { name: 'Approve once' }).click();
  await expect(log(pane)).toContainText('Permission granted, wrote allowed.txt.');
  expect(readFileSync(join(instance.home, 'allowed.txt'), 'utf8')).toBe('written by the fake agent\n');

  // Rejected: nothing is written.
  await send(pane, 'permission rejected.txt');
  const second = log(pane)
    .getByRole('group')
    .filter({ hasText: `${AGENT} wants to change files` })
    .last();
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(log(pane)).toContainText('Permission rejected.');
  expect(existsSync(join(instance.home, 'rejected.txt'))).toBe(false);
  await expect(pane.locator('.chat-state')).toHaveText('Ready');

  const chat = await onlyChat(instance);
  expect(chat.title).toBe('hello there');
  expect(await chats(instance)).toHaveLength(1);
});

test('an archived chat keeps its log and comes back from the Chats panel', async ({ app, instance }) => {
  const pane = await newChat(app);
  await send(pane, 'keep me');
  await expect(log(pane)).toContainText('Echo #1: keep me');
  const panel = await showPanel(app, 'Chats');
  const list = panel.getByRole('list', { name: 'Chats' });
  await expect(list.getByRole('listitem')).toHaveCount(1);

  // Archive: out of the list, said in a toast, listed apart.
  // Row actions show on hover.
  await list.getByRole('listitem').hover();
  await list.getByRole('button', { name: 'Archive the chat keep me' }).click();
  await expect(app.locator('.toasts-left')).toContainText('“keep me” archived.');
  await expect(list.getByRole('listitem')).toHaveCount(0);
  await waitFor(async () => (await onlyChat(instance)).archived, { what: 'the chat archived on the host' });
  await panel.getByRole('button', { name: 'Archived (1)' }).click();
  const archived = panel.getByRole('list', { name: 'Archived chats' });
  await expect(archived.getByRole('listitem')).toHaveCount(1);

  // Restore: back in the list, its log as it was, the session going on.
  await archived.getByRole('listitem').hover();
  await archived.getByRole('button', { name: 'Restore the chat keep me' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  await waitFor(async () => !(await onlyChat(instance)).archived, { what: 'the chat restored on the host' });
  await list
    .getByRole('listitem')
    .getByRole('button', { name: /keep me/ })
    .first()
    .click();
  const shown = chatPane(app);
  await expect(log(shown)).toContainText('Echo #1: keep me');
  await send(shown, 'again');
  await expect(log(shown)).toContainText('Echo #2: again');
});

test('trusted folders: refused where unsafe, listed and revoked in Settings', async ({ app, instance }) => {
  const trusted = async () =>
    (await instance.api<{ trusted: { cwd: string }[] }>('POST', '/api/m/local/p/chat/trusted')).trusted.map((t) => t.cwd);
  const q = (cwd: string) => `?cwd=${encodeURIComponent(cwd)}`;
  // The home directory is never trusted as a whole.
  const home = await instance.fetch('POST', '/api/m/local/p/chat/trust' + q(instance.home));
  expect(home.status).toBe(403);
  expect(await home.text()).toContain('unsafe_folder');
  await instance.api('POST', '/api/m/local/p/chat/trust' + q(instance.work));
  expect(await trusted()).toEqual([instance.work]);

  const panel = await showPanel(app, 'Chats');
  await panel.getByRole('button', { name: 'Manage Chat Hosts & Trusted Folders' }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog).toContainText('Headless Chat Hosts');
  await expect(dialog).toContainText('Running');
  await expect(dialog).toContainText(instance.work);
  await dialog.getByRole('button', { name: 'Revoke Trust' }).click();
  await expect(dialog).toContainText('No trusted folders on this machine.');
  expect(await trusted()).toEqual([]);
});

test('a chat resumes its session after the chat host and the terminal core restart', async ({ app, instance }) => {
  const pane = await newChat(app);
  await send(pane, 'first');
  await expect(log(pane)).toContainText('Echo #1: first');

  // The chat host ends cleanly: the chat sleeps, its next message
  // resumes the agent's session (the fake counts the session's turns).
  await instance.api('POST', '/api/m/local/p/chat/host/stop');
  await waitFor(async () => (await onlyChat(instance)).state === 'sleeping', { what: 'the chat asleep', timeout: 15_000 });
  await send(pane, 'second');
  await expect(log(pane)).toContainText('Echo #2: second');

  // The terminal core, the host's parent, stops: the host and the agent
  // end with it. The pane attaches again and the session goes on.
  await instance.api('POST', '/api/m/local/hc/stop');
  await waitFor(async () => !(await instance.api<{ running: boolean }>('GET', '/api/m/local/hc')).running, {
    what: 'the terminal core to stop',
  });
  await instance.api('POST', '/api/m/local/hc/start');
  await send(pane, 'third');
  await expect(log(pane)).toContainText('Echo #3: third');
  await expect(log(pane)).toContainText('Echo #1: first');
  expect(await chats(instance)).toHaveLength(1);
});

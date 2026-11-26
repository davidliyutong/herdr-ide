// Chats with Codex: the fake app-server (e2e/fakes/codex.ts, installed as
// `codex`) run by the machine's chat host through its Codex adapter.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures';
import { chatPane, chats, onlyChat } from '../harness/chat';
import { waitFor } from '../harness/wait';

const CODEX = 'Codex';

async function newCodexChat(page: Page): Promise<Locator> {
  await page.getByRole('tablist', { name: 'Tabs' }).getByRole('button', { name: 'New tab menu' }).click();
  await page.getByRole('menuitem', { name: `${CODEX} Chat` }).click();
  const pane = chatPane(page);
  await expect(pane.locator('.chat-state')).toHaveText('Ready');
  return pane;
}

async function send(pane: Locator, text: string) {
  const box = pane.getByRole('textbox', { name: `Message to ${CODEX}` });
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

const log = (pane: Locator) => pane.getByRole('log', { name: `Conversation with ${CODEX}` });

/** What the fake recorded the chat host asking for that it must never ask
 * for: a thread that is not read-only, a turn without its policies, an
 * approval with an amendment. */
const violations = (home: string) => join(home, '.fakecodex', 'violations');

test('a Codex chat streams answers and asks before it runs a command, its thread read-only', async ({ app, instance }) => {
  const pane = await newCodexChat(app);
  await send(pane, 'hello there');
  await expect(log(pane)).toContainText('Echo #1: hello there');
  await expect(pane.locator('.chat-title')).toHaveText('hello there');

  // Allowed once: the command writes the file.
  await send(pane, 'permission allowed.txt');
  const ask = log(pane)
    .getByRole('group')
    .filter({ hasText: `${CODEX} wants to run a command` });
  await expect(ask).toBeVisible();
  await expect(pane.locator('.chat-state')).toHaveText('Waiting for you');
  await ask.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(log(pane)).toContainText('Permission granted, wrote allowed.txt.');
  expect(readFileSync(join(instance.home, 'allowed.txt'), 'utf8')).toBe('written by the fake codex\n');

  // Rejected: nothing is written.
  await send(pane, 'permission rejected.txt');
  const second = log(pane)
    .getByRole('group')
    .filter({ hasText: `${CODEX} wants to run a command` })
    .last();
  await second.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(log(pane)).toContainText('Permission rejected.');
  expect(existsSync(join(instance.home, 'rejected.txt'))).toBe(false);
  await expect(pane.locator('.chat-state')).toHaveText('Ready');

  const chat = await onlyChat(instance);
  expect(chat.title).toBe('hello there');
  expect(existsSync(violations(instance.home))).toBe(false);
});

test('a Codex chat stops its turn, and resumes its thread after the chat host restarts', async ({ app, instance }) => {
  const pane = await newCodexChat(app);
  await send(pane, 'first');
  await expect(log(pane)).toContainText('Echo #1: first');

  // A turn that runs until it is stopped.
  await send(pane, 'hold');
  await expect(pane.locator('.chat-state')).toHaveText('Working');
  await pane.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(pane.locator('.chat-state')).toHaveText('Ready');

  // The chat host ends cleanly: the chat sleeps, its next message resumes
  // the thread (thread/resume; the fake counts the thread's turns).
  await instance.api('POST', '/api/m/local/p/chat/host/stop');
  await waitFor(async () => (await onlyChat(instance)).state === 'sleeping', { what: 'the chat asleep', timeout: 15_000 });
  await send(pane, 'third');
  await expect(log(pane)).toContainText('Echo #3: third');
  await expect(log(pane)).toContainText('Echo #1: first');
  expect(await chats(instance)).toHaveLength(1);
  expect(existsSync(violations(instance.home))).toBe(false);
});

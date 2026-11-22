import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures';
import { AGENT, chatPane, log, newChat, send } from '../harness/chat';
import type { Instance } from '../harness/instance';
import { newTerminalTab } from '../harness/ui';

/** A chat in tab 1 whose agent asks for a permission once tab 2, a
 * terminal, is shown: the chat waits while nobody looks at it. */
async function chatWaitingInBackground(app: Page, instance: Instance) {
  const pane = await newChat(app);
  await send(pane, 'permission later.txt when go');
  await expect(pane.locator('.chat-state')).toHaveText('Working');
  await newTerminalTab(app);
  writeFileSync(join(instance.home, 'go'), '');
}

test('a chat that waits for an answer draws attention while it is not shown', async ({ app, instance }) => {
  const { name } = await instance.api<{ name: string }>('GET', '/api/config');
  await chatWaitingInBackground(app, instance);

  // The sidebar's agents, the tab's and the workspace's dots, the title's
  // count and a toast.
  const inbox = app.getByRole('group', { name: 'Agents' });
  await expect(inbox).toContainText('1 need you');
  const item = inbox.getByRole('button').filter({ hasText: 'permission later.txt when go' });
  await expect(item).toContainText('Needs input');
  await expect(app.getByRole('tab', { name: /^Tab 1/ }).locator('.dot-blocked')).toBeVisible();
  await expect(app.getByRole('treeitem', { selected: true }).locator('.dot-blocked')).toBeVisible();
  await expect(app).toHaveTitle(`(1) ${name}`);
  await expect(app.locator('.toasts')).toContainText(`${AGENT} needs your input`);

  // The inbox shows the chat, where the answer goes.
  await item.click();
  await expect(app.getByRole('tab', { name: /^Tab 1/ })).toHaveAttribute('aria-selected', 'true');
  const pane = chatPane(app);
  await log(pane).getByRole('button', { name: 'Approve once' }).click();
  await expect(log(pane)).toContainText('Permission granted, wrote later.txt.');
  await expect(inbox).toContainText('No agent is waiting for you');
  await expect(app).toHaveTitle(name);
});

test('a page in the background gets a web notification whose click shows the chat', async ({ app, instance }) => {
  // The page has no focus, and the browser's notifications are recorded.
  await app.evaluate(() => {
    const w = window as unknown as { __notes: { title: string; body?: string; n: { onclick: null | (() => void) } }[] };
    w.__notes = [];
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: null | (() => void) = null;
      onclose: null | (() => void) = null;
      constructor(title: string, o?: NotificationOptions) {
        w.__notes.push({ title, body: o?.body, n: this });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    document.hasFocus = () => false;
  });
  await chatWaitingInBackground(app, instance);

  const notes = () => app.evaluate(() => (window as unknown as { __notes: { title: string }[] }).__notes.map((n) => n.title));
  await expect.poll(notes).toEqual([`${AGENT} needs your input`]);
  await app.evaluate(() => (window as unknown as { __notes: { n: { onclick: () => void } }[] }).__notes[0].n.onclick());
  await expect(app.getByRole('tab', { name: /^Tab 1/ })).toHaveAttribute('aria-selected', 'true');
  await expect(log(chatPane(app)).getByRole('button', { name: 'Approve once' })).toBeVisible();
});

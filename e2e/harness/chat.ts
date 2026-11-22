// Chats with the fake agent (e2e/fakeacp, installed as `kimi`).

import { expect, type Locator, type Page } from '@playwright/test';
import type { Instance } from './instance';
import { waitFor } from './wait';

export const AGENT = 'Kimi Code';

/** Opens a chat with the fake agent in a new tab, from the new-tab menu. */
export async function newChat(page: Page): Promise<Locator> {
  await page.getByRole('tablist', { name: 'Tabs' }).getByRole('button', { name: 'New tab menu' }).click();
  await page.getByRole('menuitem', { name: `${AGENT} Chat` }).click();
  const pane = chatPane(page);
  await expect(pane.locator('.chat-state')).toHaveText('Ready');
  return pane;
}

/** The chat pane shown in the focused pane. */
export function chatPane(page: Page): Locator {
  return page.locator('.pane:has(> .pane-header.focused) .chat-pane');
}

/** Sends a message from the composer. */
export async function send(pane: Locator, text: string) {
  const box = pane.getByRole('textbox', { name: `Message to ${AGENT}` });
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
}

/** The conversation's log. */
export function log(pane: Locator): Locator {
  return pane.getByRole('log', { name: `Conversation with ${AGENT}` });
}

export interface ChatState {
  id: string;
  state?: string;
  status?: string;
  archived?: number | boolean;
  title?: string;
  [k: string]: unknown;
}

/** The local machine's chats, as its chat host lists them. */
export async function chats(inst: Instance): Promise<ChatState[]> {
  const r = await inst.api<{ chats: ChatState[] }>('GET', '/api/m/local/p/chat/chats');
  return r.chats;
}

/** Waits for the only chat of the machine, and answers it. */
export async function onlyChat(inst: Instance): Promise<ChatState> {
  return waitFor(
    async () => {
      const c = await chats(inst);
      return c.length === 1 ? c[0] : null;
    },
    { what: 'one chat' },
  );
}

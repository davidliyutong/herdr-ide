import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures';
import { unported } from '../harness/paths';
import { AGENT, chatPane, log, newChat, send } from '../harness/chat';
import type { Instance } from '../harness/instance';
import { cdInTerminal, newTerminalTab, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';

/** A stand-in for Claude Code run in a terminal as ./claude: it writes, as
 * Claude Code does, its record of its process (~/.claude/sessions/<pid>.json)
 * and its session's transcript in its directory's projects directory, then
 * shows its screens: a turn in progress, a permission dialog once the file
 * "block" exists, its prompt once "idle" does. */
const FAKE_CLAUDE = (id: string) => String.raw`#!/bin/sh
dir=$(pwd)
esc=$(printf %s "$dir" | sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$HOME/.claude/sessions" "$HOME/.claude/projects/$esc"
printf '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"%s","sessionId":"%s","timestamp":"2026-11-25T00:00:00.000Z"}\n' "$dir" "${id}" >"$HOME/.claude/projects/$esc/${id}.jsonl"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s000}\n' $$ "${id}" "$dir" "$(date +%s)" >"$HOME/.claude/sessions/$$.json"
printf '\033[2J\033[H\342\234\273 Thinking\342\200\246 (3s \302\267 esc to interrupt)\n'
while [ ! -e block ]; do sleep 0.1; done
printf '\033[2J\033[H Do you want to proceed?\n \342\235\257 1. Yes\n   2. No\n'
while [ ! -e idle ]; do sleep 0.1; done
printf '\033[2J\033[H\342\217\272 Done.\n\342\224\200\342\224\200\342\224\200\n\342\235\257 \n\342\224\200\342\224\200\342\224\200\n'
while :; do sleep 1; done
`;

// A coding agent in a terminal, detected on its machine (op detect): its
// status from its screen, its session from its record, which the machine
// confirms for a resume in its directory.
test('a coding agent in a terminal that waits for an answer draws attention, and its session is found', async ({ app, instance, term }) => {
  const id = randomUUID();
  const script = join(instance.work, 'claude');
  writeFileSync(script, FAKE_CLAUDE(id));
  chmodSync(script, 0o755);
  await newTerminalTab(app);
  const addr = await terminalOfPane(term, 1);
  await cdInTerminal(app, term, addr, instance.work);
  await app.keyboard.type('./claude');
  await app.keyboard.press('Enter');
  await waitFor(
    () => {
      const a = term.agent(addr);
      return a.agent === 'claude' && a.agent_status === 'working' && a.agent_session === id && a.agent_session_source === 'pid';
    },
    { what: 'the agent working, its session found', timeout: 30_000 },
  );
  // The machine has the session's transcript, of this directory.
  const resolve = (cwd: string) =>
    instance.api('GET', `/api/m/local/p/agents/resolve?kind=claude&session=${id}&cwd=${encodeURIComponent(cwd)}`);
  expect(await resolve(instance.work)).toEqual({ ok: true });
  expect(await resolve('/elsewhere')).toEqual({ ok: false, code: 'other_cwd' });

  // While another tab is shown, the agent asks for an answer.
  const { name } = await instance.api<{ name: string }>('GET', '/api/config');
  await newTerminalTab(app);
  writeFileSync(join(instance.work, 'block'), '');
  const inbox = app.getByRole('group', { name: 'Agents' });
  await expect(inbox).toContainText('1 need you');
  const item = inbox.getByRole('button').filter({ hasText: 'Needs input' });
  await expect(item).toBeVisible();
  await expect(app.getByRole('tab', { name: /^Tab 1/ }).locator('.dot-blocked')).toBeVisible();
  await expect(app).toHaveTitle(`(1) ${name}`);

  // Shown and answered: its turn ends while the user looks at it.
  await item.click();
  await expect(app.getByRole('tab', { name: /^Tab 1/ })).toHaveAttribute('aria-selected', 'true');
  writeFileSync(join(instance.work, 'idle'), '');
  await expect(inbox).toContainText('No agent is waiting for you');
  await expect(app).toHaveTitle(name);
  expect(term.agent(addr).agent_session).toBe(id);
  // The page remembers the session in the terminal's leaf, for a resume
  // after the terminal core restarts.
  await waitFor(async () => JSON.stringify(await term.layout()).includes(`"session":"${id}"`), { what: 'the session in the layout' });
});

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
  test.skip(!!unported('chat'), unported('chat'));
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
  test.skip(!!unported('chat'), unported('chat'));
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

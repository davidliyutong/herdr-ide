// SSH machines: a container running OpenSSH (harness/sshd.ts) added as a
// user adds one, reached with the instance's own throwaway key. Skipped
// without Docker (failing instead with E2E_REQUIRE_DOCKER=1).

import { test, expect } from '../harness/fixtures';
import { AGENT, chatPane, log, send } from '../harness/chat';
import type { Instance } from '../harness/instance';
import { ALIAS, HOME, USER, type SSHMachine } from '../harness/sshd';
import { TermClient } from '../harness/term';
import { explorer, focusTerminal, newTerminalTab, run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import type { Locator, Page } from '@playwright/test';

/** The SSH machine of the core, once its state is `status`. */
async function remote(inst: Instance, status = 'ready', timeout = 60_000) {
  return waitFor(
    async () => {
      const m = (await inst.machines()).find((x) => x.id !== 'local');
      return m?.status === status ? m : null;
    },
    { what: `the SSH machine ${status}`, timeout },
  );
}

/** Adds the container as a machine through the API, as the dialog does. */
async function addMachine(inst: Instance): Promise<string> {
  await inst.api('POST', '/api/machines', { target: ALIAS, label: '' });
  return (await remote(inst)).id;
}

/** The sidebar's row of the SSH machine, and its body. */
function machineRow(page: Page): { head: Locator; body: Locator } {
  const box = page.locator('.machine').filter({ has: page.locator('.machine-label', { hasText: ALIAS }) });
  return { head: box.locator('.machine-head'), body: box.locator('.machine-body') };
}

/** Shows the machine's terminals in the page: its workspace, selected. */
async function showMachine(page: Page) {
  const { body } = machineRow(page);
  await body.getByRole('treeitem', { name: 'Show its terminals' }).click();
  await expect(body.locator('.ws-item.selected')).toBeVisible({ timeout: 30_000 });
}

/** A new terminal tab on the machine shown, its address once a prompt shows. */
async function remoteTerminal(page: Page, term: TermClient): Promise<string> {
  await newTerminalTab(page);
  return terminalOfPane(term, 1);
}

async function pidOf(sshd: SSHMachine, re: RegExp): Promise<string[]> {
  return (await sshd.processes()).filter((p) => re.test(p));
}

test('an SSH machine added from the sidebar runs terminals and shows its files', async ({ app, instance, sshd }) => {
  // The dialog offers the alias of the ssh configuration.
  await app.getByRole('button', { name: 'Add Machine…' }).click();
  const dialog = app.getByRole('dialog', { name: 'Add machine' });
  const option = dialog.getByRole('option', { name: new RegExp(ALIAS) });
  await expect(option).toContainText(`${USER}@127.0.0.1`);
  await option.click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(app.locator('.toasts-left, .toasts')).toContainText(`Added ${ALIAS}.`);
  const m = await remote(instance);
  expect(m.platform).toMatch(/^linux\//);
  await expect(machineRow(app).head.locator('.mstatus.ms-ready')).toBeVisible();

  // A terminal on the machine: input and output go through the page, and
  // its shell runs in the container.
  await showMachine(app);
  const term = new TermClient(instance.baseURL, m.id);
  try {
    const addr = await remoteTerminal(app, term);
    await run(app, term, addr, 'echo "$(uname -s) $(hostname) $(whoami) $((6*7))"', new RegExp(`^Linux ${sshd.hostname} ${USER} 42$`, 'm'));
    expect((await pidOf(sshd, /herdr-core serve/)).length).toBe(1);

    // The explorer follows the terminal into the machine's home.
    await sshd.user('mkdir -p projects && echo remote > remote-notes.txt');
    const tree = await explorer(app);
    await expect(tree.getByRole('treeitem', { name: 'remote-notes.txt' })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: 'projects' })).toBeVisible();
    await expect(app.getByRole('navigation', { name: 'Folder shown' })).toHaveAttribute('title', HOME);
  } finally {
    term.close();
  }
});

test('an SSH machine that drops shows offline, then comes back with its terminals', async ({ app, instance, sshd }) => {
  const id = await addMachine(instance);
  await showMachine(app);
  const term = new TermClient(instance.baseURL, id);
  try {
    const addr = await remoteTerminal(app, term);
    await run(app, term, addr, 'echo "before-$((6*7))"', /^before-42$/m);
    const core = await pidOf(sshd, /herdr-core serve/);
    expect(core).toHaveLength(1);
    const workspaces = (await term.layout()).workspaces?.length;

    // The connection drops and sshd refuses new ones: the machine shows
    // offline and the core keeps trying.
    await sshd.offline();
    const { head, body } = machineRow(app);
    await expect(head.locator('.mstatus.ms-error')).toBeVisible({ timeout: 60_000 });
    await expect(body.locator('.machine-status.ms-error')).toContainText('Error');
    await remote(instance, 'error', 5_000);

    // Back: the same terminal core, its terminal and workspace as they were.
    await sshd.online();
    await expect(head.locator('.mstatus.ms-ready')).toBeVisible({ timeout: 60_000 });
    await expect(body.locator('.ws-item.selected')).toBeVisible({ timeout: 30_000 });
    expect(await pidOf(sshd, /herdr-core serve/)).toEqual(core);
    await waitFor(async () => (await term.live()).some((t) => t.address === addr), { what: `${addr} live again`, timeout: 30_000 });
    expect((await term.layout()).workspaces?.length).toBe(workspaces);
    await term.waitScreen(addr, /^before-42$/m);
    await focusTerminal(app);
    await run(app, term, addr, 'echo "after-$((6*7))"', /^after-42$/m);
  } finally {
    term.close();
  }
});

test('a chat on an SSH machine shows it offline and goes on, and nothing stays when the core stops', async ({ app, instance, sshd }) => {
  const id = await addMachine(instance);
  await showMachine(app);
  // A chat in a new tab on the machine shown.
  await app.getByRole('tablist', { name: 'Tabs' }).getByRole('button', { name: 'New tab menu' }).click();
  await app.getByRole('menuitem', { name: `${AGENT} Chat` }).click();
  const pane = chatPane(app);
  const state = pane.locator('.chat-state');
  await expect(state).toHaveText('Ready', { timeout: 30_000 });
  await send(pane, 'hello remote');
  await expect(log(pane)).toContainText('Echo #1: hello remote');
  // The agent runs on the machine, its session in the machine's home.
  expect(await pidOf(sshd, /kimi acp/)).toHaveLength(1);
  await sshd.user('ls .fakeacp | grep -q .');

  // A turn that keeps working while the machine is away.
  await send(pane, 'hold');
  await expect(state).toHaveText('Working');
  await sshd.offline();
  await expect(state).toHaveText('Reconnecting', { timeout: 60_000 });
  await expect(pane).toContainText('Not connected: the chat goes on once the machine or this window connects again.');

  // Back: the turn is still running on the machine; stopped, the session
  // goes on where it was.
  await sshd.online();
  await expect(state).toHaveText('Working', { timeout: 60_000 });
  await pane.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(state).toHaveText('Ready');
  await send(pane, 'again');
  await expect(log(pane)).toContainText('Echo #3: again');

  // Rule 6: the terminal core stopped from the machine's menu ends its
  // terminals, the chat host and the agents it ran; the core stopped, its
  // `node dial` on the machine ends with the ssh session, and the node
  // without a client after NodeIdle (15 s).
  const mine = /herdr-core|chat-host|kimi|node --instance|node dial/;
  expect(await pidOf(sshd, /node dial/)).toHaveLength(1);
  expect(await pidOf(sshd, /node --instance/)).toHaveLength(1);
  await instance.api('POST', `/api/m/${id}/hc/stop`);
  await waitFor(async () => (await pidOf(sshd, /herdr-core|chat-host|kimi/)).length === 0, {
    what: 'the terminal core, the chat host and the agent to end on the machine',
    timeout: 45_000,
  });
  await instance.stopCore();
  await waitFor(async () => (await pidOf(sshd, /node dial/)).length === 0, { what: 'node dial to end on the machine', timeout: 30_000 });
  await waitFor(async () => (await pidOf(sshd, mine)).length === 0, { what: 'the node to end on the machine', timeout: 45_000 });
});

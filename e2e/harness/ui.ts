// Steps of the UI that several tests take.

import { expect, type Locator, type Page } from '@playwright/test';
import type { TermClient } from './term';
import { waitFor } from './wait';

/** Opens a terminal tab with the New Tab button and waits for its shell. */
export async function newTerminalTab(page: Page) {
  const tabs = page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
  const before = await tabs.count();
  await page.getByRole('tablist', { name: 'Tabs' }).getByRole('button', { name: 'New Tab', exact: true }).click();
  await expect(tabs).toHaveCount(before + 1);
  await expect(focusedTerminal(page)).toBeFocused();
}

/** The input of the terminal in the focused pane. */
export function focusedTerminal(page: Page): Locator {
  return page.locator('.pane:has(> .pane-header.focused) textarea.term-input');
}

/** Clicks into the terminal of the focused pane. */
export async function focusTerminal(page: Page) {
  await page.locator('.pane:has(> .pane-header.focused) .term-host').click();
  await expect(focusedTerminal(page)).toBeFocused();
}

/** The modifier of the page's shortcuts on this system. */
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Types a command into the focused terminal and waits for its output. */
export async function run(page: Page, term: TermClient, addr: string, command: string, expect: RegExp) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  return term.waitScreen(addr, expect);
}

/** Changes the focused terminal's directory and waits until the terminal
 * core reports it. */
export async function cdInTerminal(page: Page, term: TermClient, addr: string, dir: string) {
  await run(page, term, addr, `cd '${dir}' && echo "in-$((6*7))"`, /^in-42$/m);
  await waitFor(
    async () => {
      const t = (await term.terminals()).find((x) => x.address === addr);
      const fg = t?.foreground as { cwd?: string } | undefined;
      return fg?.cwd === dir || t?.cwd === dir;
    },
    { what: `${addr} in ${dir}` },
  );
}

/** Shows a panel of the right sidebar (Explorer, Source Control, Chats…). */
export async function showPanel(page: Page, name: string): Promise<Locator> {
  const button = page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  const panel = page.locator('aside.panel').filter({ has: page.locator('.panel-title', { hasText: name }) });
  await expect(panel).toBeVisible();
  return panel;
}

/** Shows the Explorer and answers its tree. */
export async function explorer(page: Page): Promise<Locator> {
  const panel = await showPanel(page, 'Explorer');
  return panel.getByRole('tree', { name: 'Explorer' });
}

/** Waits until the machine has n live terminals (or more: a closed pane's
 * terminal lives on while Undo Close can bring it back) and answers the
 * newest, once its shell shows a prompt. */
export async function terminalOfPane(term: TermClient, n: number): Promise<string> {
  const live = await waitFor(
    async () => {
      const l = await term.live();
      return l.length >= n ? l : null;
    },
    { what: `${n} live terminals` },
  );
  const addr = live
    .map((t) => t.address)
    .sort(byAddress)
    .at(-1)!;
  await term.waitScreen(addr, /^\$ ?$/m);
  return addr;
}

/** Orders terminal addresses by their creation (t2 before t10). */
export function byAddress(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

import { test, expect } from '../harness/fixtures';
import { leafTerminals } from '../harness/term';
import { focusTerminal, focusedTerminal, newTerminalTab, run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';

test('Close Pane leaves the last pane of a pinned tab', async ({ app, instance, term }) => {
  // Browsers keep Cmd+W, so the desktop app's binding of pane.close is
  // given to a key the page gets, through the keybindings API.
  await instance.api('PUT', '/api/keybindings', [{ key: 'ctrl+alt+w', command: 'pane.close' }]);
  await newTerminalTab(app);
  const first = await terminalOfPane(term, 1);
  const tab = app.getByRole('tab', { name: /^Tab 1/ });
  await tab.click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Pin Tab' }).click();
  await waitFor(async () => (await term.layout()).workspaces?.[0]?.tabs?.[0]?.pinned === true, { what: 'the tab pinned in the layout' });

  // Two panes: the key closes one, then leaves the last, also held.
  await focusTerminal(app);
  await app.getByRole('button', { name: 'Split Right' }).first().click();
  await expect(app.locator('.pane-header')).toHaveCount(2);
  await terminalOfPane(term, 2);
  await focusTerminal(app);
  await app.keyboard.press('Control+Alt+w');
  await expect(app.locator('.pane-header')).toHaveCount(1);
  for (let i = 0; i < 3; i++) await app.keyboard.press('Control+Alt+w');
  // The keys went before this command: its output shows the pane stayed.
  await run(app, term, first, 'echo still-$((1+1))', /^still-2$/m);
  await expect(app.locator('.pane-header')).toHaveCount(1);
  await expect(app.getByRole('tablist', { name: 'Tabs' }).getByRole('tab')).toHaveCount(1);
  const tabs = (await term.layout()).workspaces?.[0]?.tabs ?? [];
  expect(tabs).toHaveLength(1);
  expect(leafTerminals(tabs[0].root)).toHaveLength(1);

  // An unpinned tab's last pane closes with its tab.
  await newTerminalTab(app);
  await terminalOfPane(term, 2);
  await app.keyboard.press('Control+Alt+w');
  await expect(app.getByRole('tablist', { name: 'Tabs' }).getByRole('tab')).toHaveCount(1);
});

test('Ctrl+B moves the keyboard to the pane header, whose buttons Enter presses', async ({ app, term }) => {
  await newTerminalTab(app);
  await terminalOfPane(term, 1);
  const input = focusedTerminal(app);
  await expect(input).toBeFocused();
  await app.keyboard.press('Control+b');
  const header = app.locator('.pane-header.focused');
  await expect(header).toBeFocused();
  // Escape gives the keyboard back to the terminal.
  await app.keyboard.press('Escape');
  await expect(input).toBeFocused();

  await app.keyboard.press('Control+b');
  await expect(header).toBeFocused();
  const split = header.getByRole('button', { name: 'Split Right' });
  // The header is a toolbar: arrows move between its title and buttons.
  for (let i = 0; i < 10 && !(await split.evaluate((b) => b === document.activeElement)); i++) await app.keyboard.press('ArrowRight');
  await expect(split).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(app.locator('.pane-header')).toHaveCount(2);
  await terminalOfPane(term, 2);
});

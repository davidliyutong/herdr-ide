import { test, expect } from '../harness/fixtures';
import { newTerminalTab, terminalOfPane } from '../harness/ui';

test('a new tab runs a shell whose input and output go through the page', async ({ app, term }) => {
  await newTerminalTab(app);
  const addr = await terminalOfPane(term, 1);
  await app.keyboard.type('echo round-$((40+2))-trip');
  await app.keyboard.press('Enter');
  await term.waitScreen(addr, /^round-42-trip$/m);
  // The pane's header follows the shell.
  await expect(app.getByRole('toolbar', { name: /^Pane: bash/ })).toBeVisible();
});

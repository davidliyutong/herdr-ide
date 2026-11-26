import { test, expect } from '../harness/fixtures';
import { leafTerminals, type Layout } from '../harness/term';
import { byAddress, cdInTerminal, focusTerminal, newTerminalTab, run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';

/** The workspaces' tabs and their terminals, as the layout document has them. */
function shape(l: Layout) {
  return (l.workspaces ?? []).map((w) => (w.tabs ?? []).map((t) => ({ pinned: !!t.pinned, terminals: leafTerminals(t.root) })));
}

test('workspaces come back after the terminal core stops and starts again', async ({ app, instance, term }) => {
  // Tab 1: a shell in the work folder split beside another, pinned.
  await newTerminalTab(app);
  const left = await terminalOfPane(term, 1);
  await cdInTerminal(app, term, left, instance.work);
  await app.getByRole('button', { name: 'Split Right' }).first().click();
  await terminalOfPane(term, 2);
  await app.getByRole('tab', { name: /^Tab 1/ }).click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Pin Tab' }).click();
  // Tab 2: one shell.
  await newTerminalTab(app);
  await terminalOfPane(term, 3);
  const before = await waitFor(
    async () => {
      const s = shape(await term.layout());
      return s[0]?.length === 2 && s[0][0].pinned && s[0][0].terminals.length === 2 ? s : null;
    },
    { what: 'the layout with two tabs' },
  );

  await instance.api('POST', '/api/m/local/hc/stop');
  await waitFor(async () => !(await instance.api<{ running: boolean }>('GET', '/api/m/local/hc')).running, {
    what: 'the terminal core to stop',
  });
  await instance.api('POST', '/api/m/local/hc/start');

  // The same terminals at the same addresses, each a new shell; the one
  // that was in the work folder starts there.
  const addrs = before
    .flat()
    .flatMap((t) => t.terminals)
    .sort(byAddress);
  await waitFor(
    async () => {
      // live with a process: a record read before its shell started again
      // is live with none.
      const live = (await term.live()).filter((t) => typeof t.pid === 'number').map((t) => t.address);
      return addrs.every((a) => live.includes(a));
    },
    { what: `${addrs.join(' ')} running again`, timeout: 20_000 },
  );
  for (const a of addrs) await term.waitScreen(a, /^\$ ?$/m);
  const rec = (await term.terminals()).find((t) => t.address === left);
  expect(rec?.cwd).toBe(instance.work);
  expect(shape(await term.layout())).toEqual(before);

  // The page shows them as they were and its terminals take input.
  const tabs = app.getByRole('tablist', { name: 'Tabs' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await tabs.first().click();
  await expect(app.locator('.pane-header')).toHaveCount(2);
  await app.locator('.term-host').first().click();
  await run(app, term, left, 'echo back-$((2*3)) $PWD', new RegExp(`^back-6 ${instance.work}$`, 'm'));

  // And so does a page loaded anew.
  await app.reload();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first().getByRole('img', { name: 'Pinned' })).toBeVisible();
  await tabs.first().click();
  await expect(app.locator('.pane-header')).toHaveCount(2);
  await focusTerminal(app);
});

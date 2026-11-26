// Two hubs of one instance on one computer: two UIs of the same machines,
// which reach the local machine through the same node; a newer build's
// hub takes the node over without the other noticing (the upgrade path).

import { test, expect } from '../harness/fixtures';
import { nodeProcesses as nodes, type Instance } from '../harness/instance';
import { TermClient } from '../harness/term';
import { newTerminalTab, run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { paths } from '../harness/paths';

test('two hubs share the local node: each sees the terminals of the other, and one leaving keeps the other', async ({ instance, term }) => {
  const second = await instance.second();
  const other = new TermClient(second.baseURL);
  try {
    expect(nodes(instance.name)).toHaveLength(1);

    // A terminal started through the first hub runs for the second.
    const rec = await term.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "shared-$((6*7))"; sleep 600'] });
    await other.waitScreen(rec.address, /shared-42/);

    // The first hub gone, the second keeps its session to the node.
    await instance.stopHub(false);
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await second.machine()).status).toBe('ready');
    expect((await other.live()).map((t) => t.address)).toContain(rec.address);
    expect(nodes(instance.name)).toHaveLength(1);
  } finally {
    other.close();
    await second.stop();
  }
  // No hub left: the node ends after its idle time.
  await waitFor(async () => nodes(instance.name).length === 0, { what: 'the node to end', timeout: 30_000 });
});

/** A newer hub (exe) of the instance takes its node over: the first hub's
 * machine stays ready all along, both end up on the newer build's node
 * alone, and the terminals go on. */
async function takeOver(app: import('@playwright/test').Page, instance: Instance, term: TermClient, exe: string): Promise<void> {
  // A terminal of the page, typed into after the move.
  await newTerminalTab(app);
  const pane = await terminalOfPane(term, 1);
  const rec = await term.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "before-$((6*7))"; sleep 600'] });
  await term.waitScreen(rec.address, /before-42/);
  expect(nodes(instance.name)).toHaveLength(1);

  // The first hub's machine is watched while the newer hub starts.
  const seen = new Set<string>();
  let watching = true;
  const watch = (async () => {
    while (watching) {
      seen.add((await instance.machine()).status);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const newer = await instance.second(false, exe);
  try {
    // The newer build's node serves the instance, both hubs through it;
    // the old one ends once the first hub moved.
    const onNewer = async (i: { machine(): Promise<{ info?: { version: string } }> }) =>
      (await i.machine()).info?.version === paths.newerVersion;
    await waitFor(async () => nodes(instance.name).length === 1 && (await onNewer(instance)) && (await onNewer(newer)), {
      what: 'the newer node alone to serve the instance',
      timeout: 30_000,
    });
    watching = false;
    await watch;
    expect([...seen]).toEqual(['ready']);

    // Both hubs work through the new node: the terminal goes on. The hub's
    // connection to the terminal core moves with the node, so a call made
    // just as the machine moved may find it unavailable for a moment.
    const other = new TermClient(newer.baseURL);
    try {
      await term.waitScreen(rec.address, /before-42/);
      const next = await term.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "after-$((6*7))"; sleep 600'] });
      await other.waitScreen(next.address, /after-42/);
      await run(app, term, pane, 'echo "typed-$((6*7))"', /^typed-42$/m);
    } finally {
      other.close();
    }
  } finally {
    watching = false;
    await newer.stop();
  }
}

test('a newer build takes the node over: the other hub moves to it and stays ready, its terminals with it', async ({
  app,
  instance,
  term,
}) => {
  await takeOver(app, instance, term, paths.hubNewer);
});

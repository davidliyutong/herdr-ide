// Two cores of one instance on one computer: two UIs of the same machines,
// which reach the local machine through the same node; a newer build's
// core takes the node over without the other noticing, also when the newer
// build is the other machine build (the Go program from the TypeScript
// machine side, and the other way round: the upgrade path).

import { test, expect } from '../harness/fixtures';
import { nodeProcesses as nodes, tsNode, type Instance } from '../harness/instance';
import { TermClient } from '../harness/term';
import { newTerminalTab, run, terminalOfPane } from '../harness/ui';
import { waitFor } from '../harness/wait';
import { paths } from '../harness/paths';

test('two cores share the local node: each sees the terminals of the other, and one leaving keeps the other', async ({
  instance,
  term,
}) => {
  const second = await instance.second();
  const other = new TermClient(second.baseURL);
  try {
    expect(nodes(instance.name)).toHaveLength(1);

    // A terminal started through the first core runs for the second.
    const rec = await term.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "shared-$((6*7))"; sleep 600'] });
    await other.waitScreen(rec.address, /shared-42/);

    // The first core gone, the second keeps its session to the node.
    await instance.stopCore(false);
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await second.machine()).status).toBe('ready');
    expect((await other.live()).map((t) => t.address)).toContain(rec.address);
    expect(nodes(instance.name)).toHaveLength(1);
  } finally {
    other.close();
    await second.stop();
  }
  // No core left: the node ends after its idle time.
  await waitFor(async () => nodes(instance.name).length === 0, { what: 'the node to end', timeout: 30_000 });
});

/** A newer core (exe) of the instance takes its node over: the first core's
 * machine stays ready all along, both end up on the newer build's node
 * alone, whose build is ts or not, and the terminals go on. */
async function takeOver(
  app: import('@playwright/test').Page,
  instance: Instance,
  term: TermClient,
  exe: string,
  ts: boolean,
): Promise<void> {
  // A terminal of the page, typed into after the move.
  await newTerminalTab(app);
  const pane = await terminalOfPane(term, 1);
  const rec = await term.call<{ address: string }>('terminal.run', { argv: ['/bin/sh', '-c', 'echo "before-$((6*7))"; sleep 600'] });
  await term.waitScreen(rec.address, /before-42/);
  expect(nodes(instance.name)).toHaveLength(1);

  // The first core's machine is watched while the newer core starts.
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
    // The newer build's node serves the instance, both cores through it;
    // the old one ends once the first core moved.
    const onNewer = async (i: { machine(): Promise<{ info?: { version: string } }> }) =>
      (await i.machine()).info?.version === paths.newerVersion;
    await waitFor(async () => nodes(instance.name).length === 1 && (await onNewer(instance)) && (await onNewer(newer)), {
      what: 'the newer node alone to serve the instance',
      timeout: 30_000,
    });
    expect(tsNode(nodes(instance.name)[0])).toBe(ts);
    watching = false;
    await watch;
    expect([...seen]).toEqual(['ready']);

    // Both cores work through the new node: the terminal goes on.
    const other = new TermClient(newer.baseURL);
    try {
      expect(await term.screen(rec.address)).toMatch(/before-42/);
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

test('a newer build takes the node over: the other core moves to it and stays ready, its terminals with it', async ({
  app,
  instance,
  term,
}) => {
  await takeOver(app, instance, term, paths.coreNewer, paths.machine === 'ts');
});

test(`a newer ${paths.machine === 'ts' ? 'Go' : 'TypeScript'} machine build takes the node over, its terminals with it`, async ({
  app,
  instance,
  term,
}) => {
  await takeOver(app, instance, term, paths.otherNewer, paths.machine !== 'ts');
});

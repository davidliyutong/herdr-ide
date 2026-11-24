// Two cores of one instance on one computer: two UIs of the same machines,
// which reach the local machine through the same node.

import { execFileSync } from 'node:child_process';
import { test, expect } from '../harness/fixtures';
import { TermClient } from '../harness/term';
import { waitFor } from '../harness/wait';
import { paths } from '../harness/paths';

/** The node processes of the instance. */
function nodes(name: string): string[] {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(paths.core) && l.includes(`node --instance ${name}`));
}

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

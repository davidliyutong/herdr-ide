// What brings a machine's workspaces back after its terminal core started
// again (a reboot, a stop and start): the tabs with their directories and
// the coding agents' conversations.
//
// The layout document survives the core and names terminals by addresses
// that are never given twice. A terminal started as one to keep gets a new
// shell from the core itself, at its address, in the directory it was in.
// One the core reports finished with the core's own end as the reason is
// started again by the page that reads the layout first, in the directory
// it started in, and takes the old one's place.
//
// A program is never started again. For an agent that can pick up its last
// conversation of a directory, the layout's leaf remembers which agent ran
// (`agent`, with the `pid` of the terminal's program then); a terminal
// whose program is another one since has lost it, and the leaf says
// `resume`. A page that has the terminal attached (shown, or kept while
// another tab is) takes the request out of the layout and, once that
// layout is written, types the agent's own command for it into the new
// shell: of several pages only the one whose write the core took types.
// The command comes from the table here, never from the document, which
// any client of the machine writes.
import * as L from './term/layout';
import { isLive, type TerminalRecord } from './term/protocol';
import { agentOf } from './lib/machine';

/** What continues the latest conversation of the directory, by agent. */
export const RESUME_COMMANDS: Readonly<Record<string, string>> = {
  claude: 'claude --continue',
  codex: 'codex resume --last',
};

/** How long a terminal is without its agent before the layout forgets it:
 * longer than a machine takes to go down, during which its programs end
 * before the connection does. */
export const AGENT_FORGET_MS = 30_000;

const CORE_ENDED = new Set(['stopped_by_restart', 'holder_lost', 'server_stop', 'host_shutdown']);

/** Whether a terminal ended because its core or its machine did, not its program. */
export function endedWithCore(r: TerminalRecord | undefined): boolean {
  return !!r && r.state === 'finished' && typeof r.reason === 'string' && CORE_ENDED.has(r.reason);
}

const resumable = (agent: unknown): agent is string => typeof agent === 'string' && Object.hasOwn(RESUME_COMMANDS, agent);

function without(leaf: L.TerminalLeaf, ...fields: string[]): L.TerminalLeaf {
  const next = { ...leaf };
  for (const f of fields) delete next[f];
  return next;
}

/** The layout with what its live terminals' leaves remember brought up to
 * date: the agent running in each, and `resume` where the program the
 * agent ran in is gone. gone(address) says whether a terminal has been
 * without its agent for AGENT_FORGET_MS. The same layout when nothing changed. */
export function rememberAgents(
  layout: L.Layout,
  record: (address: string) => TerminalRecord | undefined,
  gone: (address: string) => boolean,
): L.Layout {
  return L.mapTerminals(layout, (leaf) => {
    const r = record(leaf.terminal);
    if (!r || !isLive(r) || typeof r.pid !== 'number') return leaf;
    if (resumable(leaf.agent) && leaf.pid !== r.pid) return { ...without(leaf, 'agent', 'pid'), resume: leaf.agent };
    const agent = agentOf(r);
    if (resumable(agent)) return leaf.agent === agent && leaf.pid === r.pid ? leaf : { ...without(leaf, 'resume'), agent, pid: r.pid };
    return leaf.agent !== undefined && gone(leaf.terminal) ? without(leaf, 'agent', 'pid') : leaf;
  });
}

/** The command to type into a terminal that asks for its agent back, and
 * the layout without the request; undefined when it asks for none. */
export function takeResume(layout: L.Layout, address: string): { layout: L.Layout; command?: string } | undefined {
  const leaf = L.findLeaf(layout, address);
  if (!leaf || !L.isTerminalLeaf(leaf) || leaf.resume === undefined) return undefined;
  const command = resumable(leaf.resume) ? RESUME_COMMANDS[leaf.resume] : undefined;
  return { layout: L.mapTerminals(layout, (x) => (x.terminal === address ? without(x, 'resume') : x)), command };
}

/** The layout with a terminal started in place of one that ended with its
 * core: the leaf has the new address and asks for its agent back. The same
 * layout when the old one is no longer in it. */
export function replaceTerminal(layout: L.Layout, old: string, address: string): L.Layout {
  return L.mapTerminals(layout, (leaf) => {
    if (leaf.terminal !== old) return leaf;
    const next = { ...without(leaf, 'agent', 'pid'), terminal: address };
    return resumable(leaf.agent) ? { ...next, resume: leaf.agent } : next;
  });
}

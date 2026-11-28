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
// A program is never started again. For an agent that can pick up a
// conversation, the layout's leaf remembers which agent ran (`agent`, with
// the `pid` of the terminal's program then) and the session it ran
// (`session`) when the machine found it from the agent's process; a
// terminal whose program is another one since has lost it, and the leaf
// says `resume`. A page that has the terminal attached (shown, or kept
// while another tab is) takes the request out of the layout and, once that
// layout is written, types the agent's own command for it into the new
// shell: of several pages only the one whose write the core took types.
// The command is the agent kind's (conversation/kinds.ts), never text of
// the document, which any client of the machine writes: the session's by
// its id when the machine confirmed that session for the terminal's
// directory (confirmSession), else the directory's latest.
import * as L from './term/layout';
import { CORE_ENDED, isLive, type TerminalRecord } from './term/protocol';
import { agentOf, agentSession } from './lib/machine';
import { agentKind, isSessionId, resumeCommand } from './conversation/kinds';
import { jsonBody } from './lib/pluginApi';

/** How long a terminal is without its agent before the layout forgets it:
 * longer than a machine takes to go down, during which its programs end
 * before the connection does. */
export const AGENT_FORGET_MS = 30_000;

/** How long a page waits for the machine to confirm a session before it
 * continues the directory's latest conversation instead. */
export const RESOLVE_TIMEOUT_MS = 3_000;

/** Whether a terminal ended because its core or its machine did, not its program. */
export function endedWithCore(r: TerminalRecord | undefined): boolean {
  return !!r && r.state === 'finished' && typeof r.reason === 'string' && CORE_ENDED.has(r.reason);
}

/** Whether a terminal record is a kept terminal waiting for its shell to come
 * back (lost, starting, or restarting after a reboot): never pruned from the
 * layout while the terminal core restarts it. */
export function keptWhileRestarting(r: TerminalRecord | undefined): boolean {
  if (!r || isLive(r)) return false;
  if (r.state !== 'finished') return true;
  return r.keep === true && !r.reason;
}

/** Terminals named in layout that have no record because the terminal core
 * started empty (for example after a host was powered off or disabled longer
 * than finished records are retained): restored in place rather than pruned. */
export function missingOnEmptyCore(layout: L.Layout, records: readonly TerminalRecord[]): string[] {
  if (records.length > 0) return [];
  return L.layoutTerminals(layout);
}

/** Whether an agent can be brought back: its kind continues the
 * directory's latest conversation (continueLatest). */
const resumable = (agent: unknown): agent is string => typeof agent === 'string' && resumeCommand(agent) !== undefined;

/** How the machine finds a session from the agent's own process
 * (agentproto's SessionFrom*), the sources a leaf remembers. A guess (the
 * newest session of the agent's directory) may be another terminal's, and
 * a source this page does not know is taken as one. */
const REMEMBERED_SOURCES: ReadonlySet<string> = new Set(['argv', 'pid', 'fd', 'start', 'hook']);

/** The session of a terminal's agent that its leaf may remember: the
 * record's, when the machine found it from the agent's process and not by
 * a guess. */
export function rememberedSession(r: TerminalRecord | undefined): string | undefined {
  const s = agentSession(r);
  return s && REMEMBERED_SOURCES.has(s.source) ? s.id : undefined;
}

function without(leaf: L.TerminalLeaf, ...fields: string[]): L.TerminalLeaf {
  const next = { ...leaf };
  for (const f of fields) delete next[f];
  return next;
}

/** The layout with what its live terminals' leaves remember brought up to
 * date: the agent running in each with its session, and `resume` where the
 * program the agent ran in is gone. The session follows the record's
 * (a /clear starts another); a record that names none, or only a guess,
 * leaves the leaf's as it is unless the leaf remembered another agent: a
 * new agent's tab carries the session it started the agent with before any
 * record does. gone(address) says whether a terminal has been without its
 * agent for AGENT_FORGET_MS: the agent and its session are forgotten then.
 * The same layout when nothing changed. */
export function rememberAgents(
  layout: L.Layout,
  record: (address: string) => TerminalRecord | undefined,
  gone: (address: string) => boolean,
  restarted?: (address: string) => boolean,
): L.Layout {
  return L.mapTerminals(layout, (leaf) => {
    const r = record(leaf.terminal);
    if (!r || !isLive(r) || typeof r.pid !== 'number') return leaf;
    if (resumable(leaf.agent) && (leaf.pid !== r.pid || restarted?.(leaf.terminal)))
      return { ...without(leaf, 'agent', 'pid'), resume: leaf.agent };
    const agent = agentOf(r);
    if (resumable(agent)) {
      const kept = leaf.agent === undefined || leaf.agent === agent ? leaf.session : undefined;
      const session = rememberedSession(r) ?? kept;
      if (leaf.agent === agent && leaf.pid === r.pid && leaf.session === session) return leaf;
      const next: L.TerminalLeaf = { ...without(leaf, 'resume', 'session'), agent, pid: r.pid };
      return session === undefined ? next : { ...next, session };
    }
    return leaf.agent !== undefined && gone(leaf.terminal) ? without(leaf, 'agent', 'pid', 'session') : leaf;
  });
}

/** A session a terminal's leaf asks to resume by its id: when it asks for
 * its agent back, the agent's kind resumes a session by its id, and the
 * leaf's session is a session id. Undefined otherwise, when only the
 * directory's latest conversation can be asked for. */
export function resumeSession(layout: L.Layout, address: string): { agent: string; session: string } | undefined {
  const leaf = L.findLeaf(layout, address);
  if (!leaf || !L.isTerminalLeaf(leaf)) return undefined;
  const { resume: agent, session } = leaf;
  if (!resumable(agent) || !agentKind(agent)?.resumeById?.length || !isSessionId(session)) return undefined;
  return { agent, session };
}

/** The command to type into a terminal that asks for its agent back, and
 * the layout without the request; undefined when it asks for none. The
 * command resumes the leaf's session by its id only when confirmed names
 * that agent and that session (what the machine confirmed for the
 * terminal's directory, confirmSession), else it continues the directory's
 * latest; there is none for a `resume` that names no agent that can be
 * brought back. */
export function takeResume(
  layout: L.Layout,
  address: string,
  confirmed?: { agent: string; session: string },
): { layout: L.Layout; command?: string } | undefined {
  const leaf = L.findLeaf(layout, address);
  if (!leaf || !L.isTerminalLeaf(leaf) || leaf.resume === undefined) return undefined;
  const byId = confirmed && confirmed.agent === leaf.resume && confirmed.session === leaf.session ? confirmed.session : undefined;
  const command = resumable(leaf.resume) ? resumeCommand(leaf.resume, byId) : undefined;
  return { layout: L.mapTerminals(layout, (x) => (x.terminal === address ? without(x, 'resume') : x)), command };
}

/** The layout with a terminal started in place of one that ended with its
 * core: the leaf has the new address, says which terminal it took the
 * place of (`before`), keeps how its pane shows it and its session, and
 * asks for its agent back. The same layout when the old one is no longer
 * in it. */
export function replaceTerminal(layout: L.Layout, old: string, address: string): L.Layout {
  return L.mapTerminals(layout, (leaf) => {
    if (leaf.terminal !== old) return leaf;
    const next: L.TerminalLeaf = { ...without(leaf, 'agent', 'pid', 'before'), terminal: address };
    if (L.isAddress(old)) next.before = old;
    return resumable(leaf.agent) ? { ...next, resume: leaf.agent } : next;
  });
}

/** Whether path is a directory the machine is asked about: an absolute
 * POSIX path of at most 4096 bytes without NUL (the resolve route's own
 * rule, so that a request it refuses is not made). */
function askableDirectory(path: string | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && new TextEncoder().encode(path).length <= 4096;
}

/** HTTP statuses from the resolve route that may succeed on a short retry
 * (concurrency cap 429 busy when many agent panes restore at once after a
 * reboot, or brief transport/gateway errors). */
const RETRYABLE_RESOLVE = new Set([429, 502, 503, 504]);
const RESOLVE_RETRY_MS = 200;

/** Whether the machine m confirms that the agent kept the session's
 * transcript and the session ran in the directory cwd (the agents plugin's
 * resolve route). False for every other answer (another directory, no such
 * session, the plugin off, an error), a failed request, and no answer
 * within RESOLVE_TIMEOUT_MS: an answer that comes later is ignored. No
 * request is made for a session that is not a session id or an agent that
 * does not resume one by its id. Never rejects. */
export function confirmSession(m: string, agent: string, session: string, cwd: string | undefined): Promise<boolean> {
  if (!isSessionId(session) || !resumable(agent) || !agentKind(agent)?.resumeById?.length || !askableDirectory(cwd)) {
    return Promise.resolve(false);
  }
  return new Promise((done) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      done(ok);
    };
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      finish(false);
    }, RESOLVE_TIMEOUT_MS);
    const query = new URLSearchParams({ kind: agent, session, cwd });
    const url = `/api/m/${encodeURIComponent(m)}/p/agents/resolve?${query}`;
    let delay = RESOLVE_RETRY_MS;
    const attempt = () => {
      if (settled) return;
      fetch(url, { cache: 'no-store', signal: abort.signal })
        .then(async (r) => {
          if (r.ok) return finish((await jsonBody(r)).ok === true);
          if (RETRYABLE_RESOLVE.has(r.status) && !settled && !abort.signal.aborted) {
            const wait = delay;
            delay *= 2;
            retryTimer = setTimeout(attempt, wait);
            return;
          }
          finish(false);
        })
        .catch(() => finish(false));
    };
    attempt();
  });
}

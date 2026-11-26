// The machines' terminals as the hub's terminal protocol reports them
// (/api/v1/term, docs/features/22-terminal-protocol.md) and their shared
// arrangement, the layout document of each machine: workspaces, tabs and
// split panes. A machine is subscribed once the user turns to it (which
// installs and starts its terminal core), its layout is read before it is
// edited, edits are written one at a time with the version last read, and
// another client's newer version wins a conflict.

import { create } from 'zustand';
import { TermConnection } from '../term/connection';
import { TerminalStore } from '../term/store';
import { isLive, type BackendState, type TerminalRecord } from '../term/protocol';
import * as L from '../term/layout';
import { nextPlace, settled, SETTLE_MS, type Place } from '../term/place';
import { currentDisplay } from '../appearance';
import { t } from '../i18n';
import { useStore } from './store';
import { useWorkspacePresets, workspacePresetIds } from './workspacePresets';
import {
  AGENT_FORGET_MS,
  confirmSession,
  endedWithCore,
  keptWhileRestarting,
  missingOnEmptyCore,
  rememberAgents,
  replaceTerminal,
  resumeSession,
  takeResume,
} from '../restore';
import { agentOf } from '../lib/machine';

export interface MachineTerms {
  backend?: BackendState;
  /** Terminal records by address. */
  terminals: Record<string, TerminalRecord>;
  /** The layout, once it was read from the machine. */
  layout?: L.Layout;
}

interface TermsState {
  connected: boolean;
  machines: Record<string, MachineTerms>;
}

export const useTerms = create<TermsState>(() => ({ connected: false, machines: {} }));

/** The label of a terminal whose pane was closed: when it ends (Date.now()
 * in ms); empty or absent for one that is not closing. */
export const CLOSING_LABEL = 'closing';

/** What a live terminal runs (TermModel.programOf). */
interface RunningProgram {
  pid: number;
  foreground?: number;
}

/** A terminal's pane on the page, as resumeAgent types into it. */
export interface ResumeTarget {
  /** Whether input reaches the terminal's program now: false once the
   * pane is gone, and while it attaches. */
  readonly attached: boolean;
  type(text: string): void;
}

/** Where a new terminal starts and how it is placed. */
export interface RunOptions {
  /** The workspace whose directory a new tab starts in (the selected one by default). */
  workspace?: string;
  /** A split: the focused terminal's directory first. */
  split?: boolean;
  /** The program, else the machine's shell. */
  argv?: string[];
  cwd?: string;
}

/** Bounded retry schedule when doc.get fails transiently on reconnect. */
const LOAD_RETRY_MIN_MS = 500;
const LOAD_RETRY_MAX_MS = 8_000;
const LOAD_RETRIES = 6;

/** The directory of the workspace holding terminal address a, when set. */
function workspaceCwdOf(layout: L.Layout, address: string): string | undefined {
  const loc = L.locate(layout, address);
  const cwd = loc && layout.workspaces[loc.workspace]?.cwd;
  return typeof cwd === 'string' && cwd ? cwd : undefined;
}

export class TermModel {
  readonly connection: TermConnection;
  readonly store = new TerminalStore();
  private readonly layouts = new Map<string, L.Layout>();
  private readonly versions = new Map<string, number>();
  /** Machines whose layout has been loaded at least once (kept across remote
   * offline/disable so open tabs and unsaved edits are not torn down). */
  private readonly loaded = new Set<string>();
  /** Machines whose layout is synced with the current ready backend session. */
  private readonly synced = new Set<string>();
  /** Machines that have previously loaded or saved a non-empty layout (used to
   * recover if a rebooted core comes back with an empty document and no records). */
  private readonly hadLayout = new Set<string>();
  private readonly saving = new Set<string>();
  private readonly dirty = new Set<string>();
  /** The newest version of each machine's layout an event named. */
  private readonly announced = new Map<string, number>();
  /** Machines a terminal was asked for before their terminals and layout were ready. */
  private readonly pending = new Map<string, Array<(m: string) => void>>();
  private readonly listeners = new Set<(up: boolean) => void>();
  /** Called when a machine's terminals are there (again), by machine. */
  private readonly arrivals = new Map<string, Set<() => void>>();
  private readonly subscribed = new Set<string>();
  /** Terminals whose pane closed, ending at their deadline, by machine and address. */
  private readonly closing = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string }>();
  /** Where each terminal's user is (term/place.ts), by machine and address,
   * and the timers of programs that may settle where they were first seen. */
  private readonly places = new Map<string, Place>();
  private readonly settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each terminal the layout remembers an agent of was first seen without
   * it, and its forget timer, by machine and address. */
  private readonly agentGone = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> }>();
  /** Pending loadLayout retry state after transient doc.get failures, by machine. */
  private readonly loadRetries = new Map<string, { tries: number; timer?: ReturnType<typeof setTimeout> }>();
  /** Terminals being started again in place of ones that ended with their core, by machine and old address. */
  private readonly restoring = new Set<string>();
  /** Terminals that received a `restarted` event while loadLayout(m) was still
   * in flight (not yet synced), applied once loadLayout finishes so same-pid
   * restarts still trigger agent resume. */
  private readonly pendingRestarts = new Map<string, Set<string>>();
  /** Terminals whose agent's session the machine is being asked to
   * confirm before it is resumed, with the pane that types into each, by
   * machine and address. */
  private readonly resuming = new Map<string, ResumeTarget>();
  /** Terminals started in place of ended ones whose layout is not written
   * yet, with the ended ones they replace, by machine: the ended one is
   * removed once a layout naming its replacement is written or read, and
   * stays to be started again when that layout lost. */
  private readonly replacements = new Map<string, Map<string, string>>();
  /** Layout writes started, by machine: a read that a write began during
   * may be from before it. */
  private readonly writes = new Map<string, number>();
  /** Called once a machine's layout as it is now was written (true) or was not, by machine. */
  private readonly written = new Map<string, Array<(ok: boolean) => void>>();
  private started = false;

  constructor(connection: TermConnection) {
    this.connection = connection;
    connection.onMessage = (msg) => this.message(msg);
    connection.onConnection = (up) => {
      if (!up) {
        this.loaded.clear();
        this.synced.clear();
        this.saving.clear();
        this.dirty.clear();
        this.replacements.clear();
        this.restoring.clear();
        this.pendingRestarts.clear();
        this.resuming.clear();
        this.cancelLoadRetry();
        this.clearAgentGone();
        for (const m of [...this.written.keys()]) this.settle(m, false);
      }
      useTerms.setState({ connected: up });
      for (const l of [...this.listeners]) l(up);
      this.publish();
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connection.start();
  }

  /** Calls fn when the connection comes (true) or goes. */
  onConnection(fn: (up: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Calls fn whenever a machine's terminals are there: its backend sent
   * their snapshot, the first time and after the machine or its terminal
   * core was away, which ends the streams without ending the connection. */
  onTerminals(m: string, fn: () => void): () => void {
    const set = this.arrivals.get(m) ?? new Set();
    this.arrivals.set(m, set.add(fn));
    return () => {
      set.delete(fn);
      if (!set.size && this.arrivals.get(m) === set) this.arrivals.delete(m);
    };
  }

  /** Follows a machine's terminals: the hub installs and starts its
   * terminal core. Kept for the page's life. */
  subscribe(m: string) {
    if (this.subscribed.has(m)) return;
    this.subscribed.add(m);
    this.connection.subscribe(m);
    this.publish(m);
  }

  isSubscribed(m: string): boolean {
    return this.subscribed.has(m);
  }

  /** The machines followed, in the order they were first followed. */
  subscribedMachines(): string[] {
    return [...this.subscribed];
  }

  /** Clears per-connection sync state when a machine's backend leaves ready
   * (offline, rebooting, disabled), while preserving the loaded layout so
   * workspaces, open file tabs and agent metadata survive until reconnect. */
  private resetMachineSession(m: string) {
    this.synced.delete(m);
    this.saving.delete(m);
    this.dirty.delete(m);
    this.replacements.delete(m);
    this.settle(m, false);
    this.cancelLoadRetry(m);
    this.clearAgentGone(m);
    this.pendingRestarts.delete(m);
    for (const key of [...this.restoring]) if (key.startsWith(`${m}\n`)) this.restoring.delete(key);
    for (const key of [...this.resuming.keys()]) if (key.startsWith(`${m}\n`)) this.resuming.delete(key);
  }

  private clearAgentGone(m?: string) {
    for (const [key, entry] of [...this.agentGone]) {
      if (m !== undefined && !key.startsWith(`${m}\n`)) continue;
      clearTimeout(entry.timer);
      this.agentGone.delete(key);
    }
  }

  private cancelLoadRetry(m?: string) {
    if (m !== undefined) {
      const r = this.loadRetries.get(m);
      if (r?.timer !== undefined) clearTimeout(r.timer);
      this.loadRetries.delete(m);
      return;
    }
    for (const r of this.loadRetries.values()) if (r.timer !== undefined) clearTimeout(r.timer);
    this.loadRetries.clear();
  }

  /** A machine that is gone: no longer followed. */
  forget(m: string) {
    this.resetMachineSession(m);
    for (const [key, c] of [...this.closing]) {
      if (!key.startsWith(`${m}\n`)) continue;
      clearTimeout(c.timer);
      this.closing.delete(key);
    }
    this.subscribed.delete(m);
    this.connection.unsubscribe(m);
    this.pending.delete(m);
    this.layouts.delete(m);
    this.loaded.delete(m);
    this.hadLayout.delete(m);
    this.versions.delete(m);
    this.announced.delete(m);
    this.store.forget(m);
    this.trackPlaces(m);
    this.publish(m);
  }

  /** A machine's layout, once read. */
  layout(m: string): L.Layout | undefined {
    return this.loaded.has(m) ? this.layouts.get(m) : undefined;
  }

  terminal(m: string, address: string): TerminalRecord | undefined {
    return this.store.terminal(m, address);
  }

  call(m: string, method: string, params: Record<string, unknown> = {}) {
    return this.connection.call(m, method, params);
  }

  private publish(machine?: string, placeChanged = false) {
    const prev = useTerms.getState().machines;
    const machines = { ...prev };
    let changed = placeChanged;
    const ids = machine === undefined ? new Set([...this.subscribed, ...this.store.backends.keys(), ...Object.keys(prev)]) : [machine];
    for (const m of ids) {
      const old = Object.hasOwn(prev, m) ? prev[m] : undefined;
      const backend = this.store.backends.get(m);
      if (!this.subscribed.has(m) && !backend) {
        if (old) {
          delete machines[m];
          changed = true;
        }
        continue;
      }
      const terminals: Record<string, TerminalRecord> = {};
      for (const r of this.store.terminals(m)) terminals[r.address] = r;
      const layout = this.layout(m);
      if (old && old.backend === backend && old.layout === layout && sameRecords(old.terminals, terminals)) continue;
      Object.defineProperty(machines, m, { value: { backend, terminals, layout }, enumerable: true, configurable: true });
      changed = true;
    }
    if (changed) useTerms.setState({ machines });
  }

  private message(msg: Record<string, unknown>) {
    const m = msg.m;
    if (typeof m !== 'string') return;
    this.store.apply(msg);
    if (msg.t === 'backend' && msg.state !== 'ready') this.resetMachineSession(m);
    this.trackPlaces(m, msg.t === 'event' && typeof msg.terminal === 'string' ? msg.terminal : undefined);
    this.watchLabels(m, msg);
    if (msg.t === 'snapshot') {
      // Wait for loadLayout(m) to sync with the reconnected core before
      // mutating agent metadata or closing panes on the new snapshot.
      this.synced.delete(m);
      this.pendingRestarts.delete(m);
      this.cancelLoadRetry(m);
      this.clearAgentGone(m);
      for (const fn of [...(this.arrivals.get(m) ?? [])]) fn();
      this.loadLayout(m, () => {
        const waiting = this.pending.get(m);
        this.pending.delete(m);
        for (const fn of waiting ?? []) fn(m);
      });
    } else if (msg.t === 'event') {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      if (msg.type === 'doc' && data.name === L.LAYOUT_DOCUMENT && typeof data.version === 'number') {
        this.announced.set(m, data.version);
        // While a write of ours is on its way its reply decides.
        if (!this.saving.has(m) && data.version !== this.versions.get(m)) this.loadLayout(m);
      }
      const address = msg.terminal;
      // A terminal that ends with its core keeps its pane: the layout
      // brings it back when the core runs again (restore.ts).
      const kept = msg.type === 'finished' && typeof address === 'string' && endedWithCore(this.store.terminal(m, address));
      if (this.synced.has(m) && (msg.type === 'removed' || msg.type === 'finished') && typeof address === 'string' && !kept) {
        this.mutate(m, (l) => L.closePane(l, address));
        if (msg.type === 'finished') void this.call(m, 'terminal.rm', { terminal: address }).catch(() => {});
      }
    }
    const restartedAddress = msg.t === 'event' && msg.type === 'restarted' && typeof msg.terminal === 'string' ? msg.terminal : undefined;
    if (this.synced.has(m)) this.remember(m, restartedAddress ? new Set([restartedAddress]) : undefined);
    else if (restartedAddress) {
      const set = this.pendingRestarts.get(m) ?? new Set();
      set.add(restartedAddress);
      this.pendingRestarts.set(m, set);
    }
    this.publish(m);
  }

  /** A machine whose layout was never written starts with a workspace to
   * open terminals in: one without a name or a directory, shown as the
   * home directory (L.workspaceTitle). A layout the user closed every
   * workspace of stays empty: the next pane opened makes one (mutate). */
  private firstWorkspace(l: L.Layout, written: boolean): L.Layout {
    return written || l.workspaces.length ? l : L.createWorkspace(l, L.newId(), '');
  }

  private loadLayout(m: string, done?: () => void) {
    const writes = this.writes.get(m) ?? 0;
    this.call(m, 'doc.get', { name: L.LAYOUT_DOCUMENT }).then(
      (doc) => {
        this.cancelLoadRetry(m);
        // A write of ours is on its way, or began since the read was asked
        // for: the read may be from before it (calls run at once on the
        // core) and would end the replacements that write names. Read
        // again once it is done.
        if (this.saving.has(m)) return void this.afterWrite(m, () => this.loadLayout(m, done));
        if ((this.writes.get(m) ?? 0) !== writes) return this.loadLayout(m, done);
        const phase = this.store.backends.get(m)?.phase;
        if (phase === 'error' || phase === 'starting') return;
        this.versions.set(m, typeof doc.version === 'number' ? doc.version : 0);
        const records = this.store.terminals(m);
        const live = new Set(records.filter((r) => isLive(r) || keptWhileRestarting(r)).map((r) => r.address));
        const rawRead = L.parseLayout(doc.value);
        const docPresent = doc.value !== null && doc.value !== undefined;
        const prevLayout = this.layouts.get(m);
        const read =
          !docPresent &&
          records.length === 0 &&
          !this.readOnly() &&
          this.hadLayout.has(m) &&
          prevLayout &&
          prevLayout.workspaces.some((w) => w.tabs.length > 0)
            ? prevLayout
            : rawRead;
        // Another page's layout won: a terminal this one started in place
        // of an ended one and that the layout does not name ends again, and
        // the ended one stays for the layout that names it.
        const named = new Set(L.layoutTerminals(read));
        const retryMissing = new Set<string>();
        for (const [a, old] of this.replacements.get(m) ?? []) {
          if (named.has(a)) this.retire(m, old);
          else {
            void this.kill(m, a);
            // If old was restored from an empty core (no record on core) and is
            // still named in the winning layout, keep and retry restoring it.
            if (named.has(old) && !this.store.terminal(m, old)) retryMissing.add(old);
          }
        }
        this.replacements.delete(m);
        // Keep sibling terminals whose empty-core restore is still in flight
        // from being pruned when loadLayout runs mid-restore.
        const prefix = `${m}\n`;
        for (const key of this.restoring) {
          if (!key.startsWith(prefix)) continue;
          const old = key.slice(prefix.length);
          if (named.has(old)) live.add(old);
        }
        // Terminals that ended with their core — or have no record because the
        // core started empty after a long power-off or disable — stay, to be
        // started again.
        const back = this.readOnly()
          ? []
          : [
              ...new Set([
                ...L.layoutTerminals(read).filter((a) => endedWithCore(this.store.terminal(m, a))),
                ...missingOnEmptyCore(read, records),
                ...retryMissing,
              ]),
            ];
        for (const a of back) live.add(a);
        const layout = this.firstWorkspace(L.pruneLayout(read, live), docPresent || read !== rawRead);
        this.layouts.set(m, layout);
        this.loaded.add(m);
        this.synced.add(m);
        if (docPresent || layout.workspaces.some((w) => w.tabs.length > 0)) this.hadLayout.add(m);
        if (!L.sameLayout(layout, rawRead)) this.save(m);
        for (const a of back) this.restore(m, a, workspaceCwdOf(read, a));
        const pendingRestarts = this.pendingRestarts.get(m);
        this.pendingRestarts.delete(m);
        this.remember(m, pendingRestarts);
        this.publish(m);
        done?.();
      },
      () => {
        const phase = this.store.backends.get(m)?.phase;
        if (phase === 'error' || phase === 'starting') return;
        const cur = this.loadRetries.get(m);
        const tries = (cur?.tries ?? 0) + 1;
        if (tries > LOAD_RETRIES) return;
        if (cur?.timer !== undefined) clearTimeout(cur.timer);
        const delay = Math.min(LOAD_RETRY_MAX_MS, LOAD_RETRY_MIN_MS * 2 ** (tries - 1));
        const timer = setTimeout(() => {
          const r = this.loadRetries.get(m);
          if (r) r.timer = undefined;
          this.loadLayout(m, done);
        }, delay);
        this.loadRetries.set(m, { tries, timer });
      },
    );
  }

  /** Writes a machine's layout, one write at a time: a change made while one
   * is on its way is written when it returns. */
  private save(m: string) {
    if (!this.synced.has(m)) return;
    if (this.saving.has(m)) {
      this.dirty.add(m);
      return;
    }
    const layout = this.layouts.get(m);
    if (!layout) return;
    this.saving.add(m);
    this.writes.set(m, (this.writes.get(m) ?? 0) + 1);
    const version = this.versions.get(m) ?? 0;
    this.call(m, 'doc.set', { name: L.LAYOUT_DOCUMENT, value: layout, version }).then(
      (doc) => {
        this.saving.delete(m);
        const again = this.dirty.delete(m);
        this.versions.set(m, typeof doc.version === 'number' ? doc.version : version + 1);
        if (again) return this.save(m);
        for (const old of this.replacements.get(m)?.values() ?? []) this.retire(m, old);
        this.replacements.delete(m);
        this.settle(m, true);
        if ((this.announced.get(m) ?? 0) > (this.versions.get(m) ?? 0)) this.loadLayout(m);
      },
      (e: { kind?: string }) => {
        this.saving.delete(m);
        this.dirty.delete(m);
        this.settle(m, false);
        // Another client arranged it: theirs wins.
        if (e?.kind === 'conflict') this.loadLayout(m);
      },
    );
  }

  /** Calls fn once the write of a machine's layout on its way is done,
   * whether it was written or not. */
  private afterWrite(m: string, fn: (ok: boolean) => void) {
    const waiting = this.written.get(m) ?? [];
    waiting.push(fn);
    this.written.set(m, waiting);
  }

  /** Removes the record of a terminal that ended with its core once a
   * written layout names its replacement. */
  private retire(m: string, old: string) {
    void this.call(m, 'terminal.rm', { terminal: old }).catch(() => {});
  }

  /** Tells those waiting for a machine's layout to be written how it went. */
  private settle(m: string, ok: boolean) {
    const waiting = this.written.get(m);
    this.written.delete(m);
    for (const fn of waiting ?? []) fn(ok);
  }

  /** Changes a machine's layout once it was read, and saves it when that
   * changed it. Returns whether it changed. */
  mutate(m: string, change: (l: L.Layout) => L.Layout): boolean {
    const before = this.layout(m);
    if (!before) return false;
    let after = change(before);
    // A pane opened where every workspace was closed gets a workspace, as
    // a machine's first one: the layout's functions place panes in one.
    if (!before.workspaces.length && L.sameLayout(after, before)) {
      const placed = change(L.createWorkspace(before, L.newId(), ''));
      if (placed.workspaces.some((w) => w.tabs.length)) after = placed;
    }
    if (L.sameLayout(after, before)) return false;
    this.layouts.set(m, after);
    if (after.workspaces.some((w) => w.tabs.length > 0)) this.hadLayout.add(m);
    this.save(m);
    this.publish(m);
    return true;
  }

  private readOnly(): boolean {
    return useStore.getState().readOnly;
  }

  /** Starts a terminal in place of one that ended with its core, in the
   * directory that one started in (or its workspace's directory when the old
   * record is gone), once: the page whose layout still names the old one when
   * its terminal runs has it take the place, and another page's ends again. */
  private restore(m: string, old: string, fallbackCwd?: string) {
    const key = `${m}\n${old}`;
    if (this.restoring.has(key)) return;
    this.restoring.add(key);
    const cwd = this.store.terminal(m, old)?.cwd ?? fallbackCwd;
    const params: Record<string, unknown> = { keep: true, display: currentDisplay() };
    if (typeof cwd === 'string' && cwd) params.cwd = cwd;
    const curLayout = this.layouts.get(m);
    const at = curLayout ? L.locate(curLayout, old) : null;
    const ws = at ? curLayout!.workspaces[at.workspace] : undefined;
    if (ws) params.workspace = ws.id;
    this.call(m, 'terminal.run', params)
      .then(
        (rec) => {
          // From here the replacement is the layout's to keep or end: a
          // read after a write it lost may start the ended one again.
          this.restoring.delete(key);
          const address = typeof rec.address === 'string' ? rec.address : undefined;
          if (!address) return;
          if (!this.mutate(m, (l) => replaceTerminal(l, old, address))) return void this.kill(m, address);
          // Until the layout naming it is written, it may still lose to
          // another page's: the ended terminal is removed then (save).
          this.replacements.set(m, (this.replacements.get(m) ?? new Map()).set(address, old));
        },
        () => void this.restoring.delete(key),
      )
      .catch(() => {});
  }

  /** Keeps what the layout remembers of its terminals' agents current (restore.ts). */
  private remember(m: string, restarted?: ReadonlySet<string>) {
    if (!this.synced.has(m) || !this.layout(m) || this.readOnly()) return;
    const now = Date.now();
    this.mutate(m, (l) =>
      rememberAgents(
        l,
        (a) => this.store.terminal(m, a),
        (a) => {
          const key = `${m}\n${a}`;
          if (agentOf(this.store.terminal(m, a))) {
            const existing = this.agentGone.get(key);
            if (existing) clearTimeout(existing.timer);
            this.agentGone.delete(key);
            return false;
          }
          const existing = this.agentGone.get(key);
          if (existing === undefined) {
            const timer = setTimeout(() => this.remember(m), AGENT_FORGET_MS + 100);
            this.agentGone.set(key, { since: now, timer });
            return false;
          }
          if (now - existing.since < AGENT_FORGET_MS) return false;
          clearTimeout(existing.timer);
          this.agentGone.delete(key);
          return true;
        },
        restarted?.size ? (a) => restarted.has(a) : undefined,
      ),
    );
  }

  /** Types the command that brings an agent's conversation back into a
   * terminal that lost its agent with its core, into its pane once that is
   * attached (it calls this from onAttached). The request is taken out of the layout first and the
   * command typed once the core took that layout: of several pages that
   * have the terminal, the one whose write won types, and the others read
   * a layout that asks for nothing.
   *
   * A leaf that names a session the agent resumes by its id is asked about
   * first (confirmSession, at most RESOLVE_TIMEOUT_MS), before the request
   * is taken: the answer only chooses between two commands of the agent's
   * kind, and the versioned write that follows still decides whether
   * anything is typed. Asking after the write would leave a layout that no
   * longer asks for the agent while nothing is typed yet, for as long as
   * the machine takes to answer, and a page closed meanwhile would lose the
   * resume. The request is taken from the layout as it is once the answer
   * came, and the session is resumed by its id only while the leaf still
   * names the agent and session confirmed.
   *
   * By then the user may have started something else in the terminal: the
   * request is taken only while the pane is attached (it may have gone, or
   * be attaching again, while the question was on its way) and the
   * terminal runs what it ran when this was asked (sameProgram), else it
   * stays for the pane's next attach; and the command is typed only while
   * the terminal still does, else nothing more happens (the user is in
   * control of the terminal). While a question is on its way for a
   * terminal, other calls for it only give the newest pane. */
  resumeAgent(m: string, address: string, pane: ResumeTarget) {
    const layout = this.layout(m);
    if (!layout || this.readOnly()) return;
    const key = `${m}\n${address}`;
    if (this.resuming.has(key)) return void this.resuming.set(key, pane);
    const program = this.programOf(m, address);
    if (!program) return;
    const asked = resumeSession(layout, address);
    if (!asked) return this.takeAndType(m, address, undefined, pane, program);
    this.resuming.set(key, pane);
    void confirmSession(m, asked.agent, asked.session, this.directory(m, address)).then((ok) => {
      const latest = this.resuming.get(key) ?? pane;
      this.resuming.delete(key);
      this.takeAndType(m, address, ok ? asked : undefined, latest, program);
    });
  }

  /** What a live terminal runs: its program's pid and, when the core says,
   * that of the program in its foreground. */
  private programOf(m: string, address: string): RunningProgram | undefined {
    const r = this.store.terminal(m, address);
    if (!r || !isLive(r) || typeof r.pid !== 'number') return undefined;
    const fg = (r.foreground as { pid?: unknown } | null | undefined)?.pid;
    return typeof fg === 'number' ? { pid: r.pid, foreground: fg } : { pid: r.pid };
  }

  /** Whether a terminal is live and runs what it ran then: the same
   * program, with the same program in its foreground, or its own (its shell
   * waits at its prompt), or none the core says. */
  private sameProgram(m: string, address: string, then: RunningProgram): boolean {
    const now = this.programOf(m, address);
    if (!now || now.pid !== then.pid) return false;
    return now.foreground === undefined || now.foreground === now.pid || now.foreground === then.foreground;
  }

  /** Takes a terminal's request for its agent back out of the layout and
   * types the command once that layout is written (resumeAgent). */
  private takeAndType(
    m: string,
    address: string,
    confirmed: { agent: string; session: string } | undefined,
    pane: ResumeTarget,
    program: RunningProgram,
  ) {
    if (!pane.attached || !this.sameProgram(m, address, program)) return;
    const layout = this.layout(m);
    const taken = layout && !this.readOnly() ? takeResume(layout, address, confirmed) : undefined;
    if (!taken || !this.mutate(m, () => taken.layout)) return;
    const command = taken.command;
    if (!command) return;
    this.afterWrite(m, (ok) => ok && this.sameProgram(m, address, program) && pane.type(`${command}\r`));
  }

  /** Ends a terminal whose pane was closed at deadline (Date.now()), unless
   * cancelClose comes first. Its CLOSING_LABEL holds the deadline, so that
   * every client showing the machine ends it then, also when this page is
   * gone by that time; one whose pane is back is left alone. */
  closeLater(m: string, address: string, deadline: number) {
    const value = String(deadline);
    this.watchClosing(m, address, value, true);
    void this.call(m, 'terminal.label', { terminal: address, labels: { ...this.labels(m, address), [CLOSING_LABEL]: value } }).catch(
      () => {},
    );
  }

  /** Keeps a terminal closeLater would end: its pane is back. */
  cancelClose(m: string, address: string) {
    this.unwatch(m, address);
    void this.call(m, 'terminal.label', { terminal: address, labels: { ...this.labels(m, address), [CLOSING_LABEL]: '' } }).catch(() => {});
  }

  private labels(m: string, address: string): Record<string, string> {
    const labels = this.store.terminal(m, address)?.labels;
    return labels && typeof labels === 'object' ? { ...(labels as Record<string, string>) } : {};
  }

  /** Follows the closing labels of a machine's terminals: a snapshot, or an
   * event that changed a terminal's labels. */
  private watchLabels(m: string, msg: Record<string, unknown>) {
    const records =
      msg.t === 'snapshot'
        ? this.store.terminals(m)
        : msg.t === 'event' && (msg.type === 'labels' || msg.type === 'created') && typeof msg.terminal === 'string'
          ? [this.store.terminal(m, msg.terminal)].filter((r) => r !== undefined)
          : [];
    for (const r of records) {
      const value = (r.labels as Record<string, unknown> | undefined)?.[CLOSING_LABEL];
      const key = `${m}\n${r.address}`;
      if (typeof value === 'string' && value) {
        if (this.closing.get(key)?.value !== value) this.watchClosing(m, r.address, value, false);
      } else if (this.closing.has(key)) {
        // Brought back by another client.
        this.unwatch(m, r.address);
      }
    }
  }

  private watchClosing(m: string, address: string, value: string, own: boolean) {
    this.unwatch(m, address);
    const deadline = Number(value);
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(
      () => {
        this.closing.delete(`${m}\n${address}`);
        const r = this.store.terminal(m, address);
        if (!r || !isLive(r)) return;
        // Another client's close ends only while its label still says so.
        if (!own && (r.labels as Record<string, unknown> | undefined)?.[CLOSING_LABEL] !== value) return;
        const layout = this.layouts.get(m);
        if (layout && L.locate(layout, address)) return;
        void this.kill(m, address);
      },
      Math.max(0, deadline - Date.now()),
    );
    this.closing.set(`${m}\n${address}`, { timer, value });
  }

  private unwatch(m: string, address: string) {
    const key = `${m}\n${address}`;
    const c = this.closing.get(key);
    if (c) clearTimeout(c.timer);
    this.closing.delete(key);
  }

  /** The directory of a terminal: where its user is (term/place.ts: its
   * shell's, or that of a program which stayed where it started; not that
   * of a program walking a tree), else the one it started in. */
  directory(m: string, address: string | undefined): string | undefined {
    if (!address) return undefined;
    const dir = this.places.get(`${m}\n${address}`)?.dir;
    if (dir) return dir;
    const cwd = this.store.terminal(m, address)?.cwd;
    return typeof cwd === 'string' && cwd ? cwd : undefined;
  }

  /** Works out the places of a machine's terminals after their records
   * changed: of one terminal, or of all (a snapshot; none left when the
   * machine is forgotten or its backend is not ready). */
  private trackPlaces(m: string, address?: string) {
    const now = Date.now();
    const one = (a: string) => {
      const key = `${m}\n${a}`;
      const r = this.store.terminal(m, a);
      clearTimeout(this.settling.get(key));
      this.settling.delete(key);
      if (!r) return void this.places.delete(key);
      const place = nextPlace(this.places.get(key), r, now);
      this.places.set(key, place);
      if (!place.seen) return;
      // A program that is where it was first seen by then gives the place.
      this.settling.set(
        key,
        setTimeout(
          () => {
            this.settling.delete(key);
            const p = this.places.get(key);
            const next = p && settled(p, Date.now());
            if (!p || next === p) return;
            this.places.set(key, next!);
            this.publish(m, true);
          },
          Math.max(0, place.seen.at + SETTLE_MS - now),
        ),
      );
    };
    if (address) return one(address);
    const live = new Set(this.store.terminals(m).map((r) => r.address));
    for (const key of [...this.places.keys()]) {
      const [km, a] = key.split('\n');
      if (km === m && !live.has(a)) one(a);
    }
    for (const a of live) one(a);
  }

  /** Starts a terminal (the machine's shell unless argv names a program) and
   * places it with place once it runs. A new tab starts in its workspace's
   * directory, else in the focused terminal's; a split the other way round.
   * A workspace in the home directory (the machine's first one takes it
   * from its first terminal) sends new tabs to the focused terminal's
   * directory too: home is where they would start without one.
   * Asked for while the machine's terminals or layout are not ready, it runs
   * once they are. */
  run(m: string, o: RunOptions, place: (l: L.Layout, address: string) => L.Layout): Promise<string | undefined> {
    const layout = this.layout(m);
    if (this.store.backends.get(m)?.phase !== 'ready' || !this.synced.has(m) || !layout) {
      this.subscribe(m);
      return new Promise((resolve) => {
        const list = this.pending.get(m) ?? [];
        list.push(() => void this.run(m, o, place).then(resolve));
        this.pending.set(m, list);
      });
    }
    const ws = (o.workspace && layout.workspaces.find((w) => w.id === o.workspace)) || L.selectedWorkspace(layout);
    const home = useStore.getState().machines[m]?.info?.home;
    const base = ws?.cwd && !(home && L.normFolder(ws.cwd) === L.normFolder(home)) && ws.cwd !== '~' ? ws.cwd : undefined;
    const focused = this.directory(m, ws?.tabs[ws.selected]?.focused);
    const cwd = o.cwd ?? (o.split ? (focused ?? base) : (base ?? focused));
    // The theme's colors answer the program's first color queries, made
    // before a pane attaches.
    // Kept: when the core starts again without the terminal's program (a
    // reboot), it gives the terminal a new shell in its last directory.
    const params: Record<string, unknown> = { keep: true, display: currentDisplay() };
    if (cwd) params.cwd = cwd;
    if (o.argv?.length) params.argv = o.argv;
    if (ws) {
      params.workspace = ws.id;
      if (workspacePresetIds(m, ws.id).length > 0 && useWorkspacePresets.getState().locked) {
        useStore
          .getState()
          .toast(
            t('vault.inject.locked'),
            { label: t('vault.workspace.presetsOpen'), run: () => useStore.getState().setPanel('vault') },
            undefined,
            'warning',
          );
      }
    }
    return this.call(m, 'terminal.run', params).then((rec) => {
      const address = typeof rec.address === 'string' ? rec.address : undefined;
      // The first pane of a workspace without a directory gives it its own.
      const dir = (typeof rec.cwd === 'string' && rec.cwd) || cwd;
      if (address) this.mutate(m, (l) => (dir ? L.adoptDirectory(place(l, address), address, dir, home) : place(l, address)));
      return address;
    });
  }

  /** Ends a terminal's program; its pane goes with the event that follows. */
  kill(m: string, address: string) {
    return this.call(m, 'terminal.kill', { terminal: address }).catch(() => {});
  }
}

function sameRecords(a: Record<string, TerminalRecord>, b: Record<string, TerminalRecord>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** The page's model, on the hub that served it. */
export let terms = new TermModel(TermConnection.toHub());

/** Replaces the page's model (tests). */
export function setTermModel(model: TermModel) {
  terms = model;
}

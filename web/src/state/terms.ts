// The machines' terminals as the core's terminal protocol reports them
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
import { currentDisplay } from '../appearance';
import { useStore } from './store';

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

export class TermModel {
  readonly connection: TermConnection;
  readonly store = new TerminalStore();
  private readonly layouts = new Map<string, L.Layout>();
  private readonly versions = new Map<string, number>();
  private readonly loaded = new Set<string>();
  private readonly saving = new Set<string>();
  private readonly dirty = new Set<string>();
  /** The newest version of each machine's layout an event named. */
  private readonly announced = new Map<string, number>();
  /** Machines a terminal was asked for before their terminals and layout were ready. */
  private readonly pending = new Map<string, Array<(m: string) => void>>();
  private readonly listeners = new Set<(up: boolean) => void>();
  private readonly subscribed = new Set<string>();
  /** Terminals whose pane closed, ending at their deadline, by machine and address. */
  private readonly closing = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string }>();
  private started = false;

  constructor(connection: TermConnection) {
    this.connection = connection;
    connection.onMessage = (msg) => this.message(msg);
    connection.onConnection = (up) => {
      if (!up) {
        this.loaded.clear();
        this.saving.clear();
        this.dirty.clear();
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

  /** Follows a machine's terminals: the core installs and starts its
   * terminal core. Kept for the page's life. */
  subscribe(m: string) {
    if (this.subscribed.has(m)) return;
    this.subscribed.add(m);
    this.connection.subscribe(m);
    this.publish();
  }

  isSubscribed(m: string): boolean {
    return this.subscribed.has(m);
  }

  /** The machines followed, in the order they were first followed. */
  subscribedMachines(): string[] {
    return [...this.subscribed];
  }

  /** A machine that is gone: no longer followed. */
  forget(m: string) {
    this.subscribed.delete(m);
    this.connection.unsubscribe(m);
    this.pending.delete(m);
    this.layouts.delete(m);
    this.loaded.delete(m);
    this.versions.delete(m);
    this.announced.delete(m);
    this.saving.delete(m);
    this.dirty.delete(m);
    this.store.forget(m);
    this.publish();
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

  private publish() {
    const machines: Record<string, MachineTerms> = {};
    const ids = new Set([...this.subscribed, ...this.store.backends.keys()]);
    const prev = useTerms.getState().machines;
    for (const m of ids) {
      const terminals: Record<string, TerminalRecord> = {};
      for (const r of this.store.terminals(m)) terminals[r.address] = r;
      const next: MachineTerms = { backend: this.store.backends.get(m), terminals, layout: this.layout(m) };
      const old = prev[m];
      machines[m] = old && old.backend === next.backend && old.layout === next.layout && sameRecords(old.terminals, terminals) ? old : next;
    }
    useTerms.setState({ machines });
  }

  private message(msg: Record<string, unknown>) {
    const m = msg.m;
    if (typeof m !== 'string') return;
    this.store.apply(msg);
    this.watchLabels(m, msg);
    if (msg.t === 'snapshot') {
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
      if ((msg.type === 'removed' || msg.type === 'finished') && typeof address === 'string') {
        this.mutate(m, (l) => L.closePane(l, address));
        if (msg.type === 'finished') void this.call(m, 'terminal.rm', { terminal: address }).catch(() => {});
      }
    }
    this.publish();
  }

  /** A layout always has a workspace to open terminals in: one without a
   * name or a directory, shown as the home directory (L.workspaceTitle). */
  private ensureWorkspace(l: L.Layout): L.Layout {
    return l.workspaces.length ? l : L.createWorkspace(l, L.newId(), '');
  }

  private loadLayout(m: string, done?: () => void) {
    this.call(m, 'doc.get', { name: L.LAYOUT_DOCUMENT }).then(
      (doc) => {
        this.versions.set(m, typeof doc.version === 'number' ? doc.version : 0);
        const live = new Set(
          this.store
            .terminals(m)
            .filter(isLive)
            .map((r) => r.address),
        );
        const read = L.parseLayout(doc.value);
        const layout = this.ensureWorkspace(L.pruneLayout(read, live));
        this.layouts.set(m, layout);
        this.loaded.add(m);
        if (!L.sameLayout(layout, read)) this.save(m);
        this.publish();
        done?.();
      },
      () => {},
    );
  }

  /** Writes a machine's layout, one write at a time: a change made while one
   * is on its way is written when it returns. */
  private save(m: string) {
    if (!this.loaded.has(m)) return;
    if (this.saving.has(m)) {
      this.dirty.add(m);
      return;
    }
    const layout = this.layouts.get(m);
    if (!layout) return;
    this.saving.add(m);
    const version = this.versions.get(m) ?? 0;
    this.call(m, 'doc.set', { name: L.LAYOUT_DOCUMENT, value: layout, version }).then(
      (doc) => {
        this.saving.delete(m);
        const again = this.dirty.delete(m);
        this.versions.set(m, typeof doc.version === 'number' ? doc.version : version + 1);
        if (again) this.save(m);
        else if ((this.announced.get(m) ?? 0) > (this.versions.get(m) ?? 0)) this.loadLayout(m);
      },
      (e: { kind?: string }) => {
        this.saving.delete(m);
        this.dirty.delete(m);
        // Another client arranged it: theirs wins.
        if (e?.kind === 'conflict') this.loadLayout(m);
      },
    );
  }

  /** Changes a machine's layout once it was read, and saves it when that
   * changed it. Returns whether it changed. */
  mutate(m: string, change: (l: L.Layout) => L.Layout): boolean {
    const before = this.layout(m);
    if (!before) return false;
    const after = this.ensureWorkspace(change(before));
    if (L.sameLayout(after, before)) return false;
    this.layouts.set(m, after);
    this.save(m);
    this.publish();
    return true;
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

  /** The directory of a terminal: its foreground program's, else the one it started in. */
  directory(m: string, address: string | undefined): string | undefined {
    const r = address ? this.store.terminal(m, address) : undefined;
    const fg = r?.foreground as { cwd?: unknown } | undefined;
    const cwd = typeof fg?.cwd === 'string' && fg.cwd ? fg.cwd : r?.cwd;
    return typeof cwd === 'string' && cwd ? cwd : undefined;
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
    if (this.store.backends.get(m)?.phase !== 'ready' || !layout) {
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
    const params: Record<string, unknown> = { keep: false, display: currentDisplay() };
    if (cwd) params.cwd = cwd;
    if (o.argv?.length) params.argv = o.argv;
    return this.call(m, 'terminal.run', params).then((rec) => {
      const address = typeof rec.address === 'string' ? rec.address : undefined;
      // The first pane of a workspace without a directory gives it its own.
      const dir = (typeof rec.cwd === 'string' && rec.cwd) || cwd;
      if (address) this.mutate(m, (l) => (dir ? L.adoptDirectory(place(l, address), address, dir) : place(l, address)));
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

/** The page's model, on the core that served it. */
export let terms = new TermModel(TermConnection.toCore());

/** Replaces the page's model (tests). */
export function setTermModel(model: TermModel) {
  terms = model;
}

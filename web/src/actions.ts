// User-level commands shared by buttons, the keymap and the command palette.
// Workspaces, tabs and panes are edits of the shown machine's layout
// document plus terminal.run and terminal.kill on its terminal core
// (state/terms.ts); closing ends the programs after asking when one runs.

import * as L from './term/layout';
import { isLive, type TerminalRecord } from './term/protocol';
import { terms, useTerms } from './state/terms';
import { currentDock, currentLastCode, useStore, type TermRef } from './state/store';
import { paneHandle, withPane } from './state/panes';
import { agentOf, agentStatus, statusRank, terminalTitle, type AgentStatus } from './lib/machine';
import { mediaExt } from './terminal/links';
import { bridge } from './lib/bridge';
import { hasMessage, t } from './i18n';
import { confirmDialog, newWorkspaceDialog } from './dialog';
import type { MessageKey } from './i18n/en';

export interface AttentionItem {
  m: string;
  terminal: string;
  record: TerminalRecord;
  status: AgentStatus;
}

/** Terminals with an agent (or a status their program reports) on every
 * machine followed, by how much they need the user. */
export function attentionList(): AttentionItem[] {
  const s = useStore.getState();
  const tm = useTerms.getState().machines;
  const out: AttentionItem[] = [];
  for (const m of s.order) {
    for (const r of Object.values(tm[m]?.terminals ?? {})) {
      const status = agentStatus(r);
      if (isLive(r) && status && (agentOf(r) || status !== 'idle')) out.push({ m, terminal: r.address, record: r, status });
    }
  }
  return out.sort((a, b) => statusRank[b.status] - statusRank[a.status]);
}

/** Each terminal's share of its tab, from the split tree. */
export const paneRects = L.paneRects;

/** The shown machine's selected workspace and tab, and the focused terminal. */
export function current() {
  const m = useStore.getState().machineId;
  const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
  if (!m || !layout) return undefined;
  const ws = L.selectedWorkspace(layout);
  const tab = ws?.tabs[ws.selected];
  return { m, layout, ws, tabIndex: ws?.selected ?? 0, tab, focused: tab?.focused || undefined };
}

/** Puts the keyboard in a terminal once it is on screen. */
function focusDom(m: string, terminal: string) {
  withPane(m, terminal, (h) => h.focus());
}

function report(e: unknown) {
  console.warn(e);
  const msg = e instanceof Error ? e.message : String(e);
  useStore.getState().toast?.(msg);
}

/** The translations of the core's error codes for machine requests. */
const machineErrors: Record<string, MessageKey> = {
  label_taken: 'machine.labelTaken',
  machine_exists: 'machine.exists',
  invalid: 'machine.invalid',
  unknown: 'machine.gone',
  local: 'machine.localOnly',
  save: 'machine.notSaved',
};

/** The reason a machine request failed, from the core's error code (with
 * the system's reason when the file could not be saved). */
async function machineError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  const key = body.error ? machineErrors[body.error] : undefined;
  if (body.error === 'save' && body.detail) return t('machine.notSavedBecause', { detail: body.detail });
  if (key) return t(key);
  return body.detail || body.error || String(res.status);
}

/** How long a new machine is watched for a login it needs. */
const LOGIN_WAIT_MS = 2 * 60_000;

/** Opens the authentication terminal once a machine just added turns
 * auth_required; stops watching once it connected or failed otherwise. */
function awaitLogin(m: string) {
  const decide = (): 'login' | 'done' | undefined => {
    // The machine may reach the store after the reply that added it.
    const st = useStore.getState().machines[m];
    if (st?.status === 'ready' || st?.status === 'error' || st?.status === 'disabled') return 'done';
    return st?.status === 'auth_required' ? 'login' : undefined;
  };
  let off = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (d: 'login' | 'done' | undefined) => {
    if (!d) return false;
    off();
    clearTimeout(timer);
    if (d === 'login') useStore.getState().openAuth(m);
    return true;
  };
  if (settle(decide())) return;
  off = useStore.subscribe(() => void settle(decide()));
  timer = setTimeout(() => off(), LOGIN_WAIT_MS);
}

/** Shells a terminal waits at the prompt in. */
const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'yash',
  'csh',
  'tcsh',
  'nu',
  'xonsh',
  'elvish',
  'osh',
  'pwsh',
  'powershell',
  'cmd',
]);

const procName = (n: string) =>
  n
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .split('/')
    .pop() ?? n;

/** What runs in a terminal in front of its shell: the agent's name for an
 * agent, the foreground program's otherwise; '' when only the shell waits
 * at its prompt or the program has ended. Jobs sent to the background do
 * not count. */
export function runningProgram(r: TerminalRecord | undefined): string {
  if (!r || !isLive(r)) return '';
  const fg = r.foreground as { pid?: number; name?: string } | undefined;
  if (!fg?.name) return '';
  const name = procName(fg.name);
  if (fg.pid === r.pid && SHELLS.has(name.toLowerCase())) return '';
  return agentOf(r) ?? name;
}

/** Asks before ending the programs that run in these terminals; true when
 * nothing runs or the user agreed. */
async function confirmEnd(m: string, addresses: string[], title: MessageKey, single?: boolean): Promise<boolean> {
  const running = [...new Set(addresses.map((a) => runningProgram(terms.terminal(m, a))).filter(Boolean))];
  if (!running.length) return true;
  return confirmDialog({
    title: t(title),
    message: single
      ? t('confirm.closePanePrograms', { programs: running.join(', ') })
      : t('confirm.closeTabPrograms', { programs: running.join(', ') }),
    confirm: t('confirm.close'),
    danger: true,
  });
}

/** Tabs and panes being closed: a second close while the first asks does nothing. */
const closing = new Set<string>();

async function once(key: string, fn: () => Promise<void>) {
  if (closing.has(key)) return;
  closing.add(key);
  try {
    await fn();
  } finally {
    closing.delete(key);
  }
}

/** The slot of an insertion (0 before the first item, n after the last) as
 * the index the moved item ends at. */
export const slotIndex = (from: number, slot: number) => (slot > from ? slot - 1 : slot);

const axisOf = (dir: 'right' | 'down'): L.Axis => (dir === 'right' ? 'horizontal' : 'vertical');

export const actions = {
  /** Splits a terminal's pane: the new terminal starts in its directory. */
  async split(m: string, terminal: string, dir: 'right' | 'down', argv?: string[]) {
    terms.mutate(m, (l) => L.focusTerminal(l, terminal));
    try {
      const address = await terms.run(m, { split: true, argv }, (l, a) => {
        const next = L.splitFocused(l, axisOf(dir), a);
        return next === l ? L.openTerminal(l, a) : next;
      });
      if (address) focusDom(m, address);
    } catch (e) {
      report(e);
    }
  },

  /** Shows a terminal alone in its tab, or all of the tab again. */
  zoom(m: string, terminal: string) {
    const s = useStore.getState();
    s.setZoomed(s.zoomed?.m === m && s.zoomed.terminal === terminal ? undefined : { m, terminal });
    focusDom(m, terminal);
  },

  /** Ends a terminal after asking when a program runs in it; its pane goes
   * with the event that follows. */
  async closePane(m: string, terminal: string) {
    await once(`pane ${m} ${terminal}`, async () => {
      if (!(await confirmEnd(m, [terminal], 'confirm.closePaneTitle', true))) return;
      terms.mutate(m, (l) => L.closeTerminal(l, terminal));
      await terms.kill(m, terminal);
    });
  },

  /** A new terminal in a new tab of a workspace (the selected one). */
  async newTab(m?: string, ws?: string, argv?: string[]) {
    m ??= current()?.m ?? useStore.getState().machineId;
    if (!m) return;
    try {
      const address = await terms.run(m, { workspace: ws, argv }, (l, a) =>
        L.openTerminal(l, a, ws && l.workspaces.some((w) => w.id === ws) ? ws : undefined),
      );
      if (address) focusDom(m, address);
    } catch (e) {
      report(e);
    }
  },

  /** Closes a tab and ends its terminals, asking first when a program runs. */
  async closeTab(m: string, ws: string, index: number) {
    const tab = terms.layout(m)?.workspaces.find((w) => w.id === ws)?.tabs[index];
    if (!tab) return;
    const addresses = L.tabTerminals(tab);
    await once(`tab ${m} ${ws} ${addresses.join(',')}`, async () => {
      if (!(await confirmEnd(m, addresses, 'confirm.closeTabTitle'))) return;
      terms.mutate(m, (l) => {
        const w = l.workspaces.find((x) => x.id === ws);
        const i = w?.tabs.findIndex((x) => L.tabTerminals(x).join() === addresses.join()) ?? -1;
        return i < 0 ? l : L.closeTab(l, ws, i);
      });
      await Promise.all(addresses.map((a) => terms.kill(m, a)));
    });
  },

  /** Adds an SSH machine to the core's machines (docs/features/02) and
   * reports whether it was added. It connects at once; when it needs an
   * interactive login (auth_required) the authentication terminal opens. */
  async addMachine(form: { target: string; label: string }): Promise<boolean> {
    const machine = form.label.trim() || form.target.trim();
    try {
      const res = await fetch('/api/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: form.target.trim(), label: form.label.trim() }),
      });
      if (!res.ok) throw new Error(t('machine.addFailed', { machine, detail: await machineError(res) }));
      const st = (await res.json()) as { id: string };
      useStore.getState().toast(t('addMachine.addedToast', { machine }));
      awaitLogin(st.id);
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  },

  /** Enables or disables a machine (stored by the core). Disabling a
   * connected machine asks first: its agent disconnects and VS Code there
   * stops; its programs keep running there. */
  async setMachineEnabled(m: string, enabled: boolean) {
    const st = useStore.getState().machines[m];
    const machine = st?.label ?? m;
    if (
      !enabled &&
      st?.status !== 'disabled' &&
      !(await confirmDialog({
        title: t('confirm.disableMachineTitle', { machine }),
        message: t('confirm.disableMachine'),
        confirm: t('menu.disableMachine'),
        danger: true,
      }))
    )
      return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(t('machine.enableFailed', { detail: await machineError(res) }));
    } catch (e) {
      report(e);
    }
  },

  /** Removes an SSH machine from the core's machines after asking. */
  async removeMachine(m: string) {
    const st = useStore.getState().machines[m];
    const machine = st?.label ?? m;
    if (
      !(await confirmDialog({
        title: t('confirm.removeMachineTitle', { machine }),
        message: t('confirm.removeMachine', { target: st?.target ?? machine }),
        confirm: t('confirm.remove'),
        danger: true,
      }))
    )
      return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t('machine.removeFailed', { machine, detail: await machineError(res) }));
      useStore.getState().toast(t('machine.removed', { machine }));
    } catch (e) {
      report(e);
    }
  },

  /** Renames an SSH machine. */
  async renameMachine(m: string, label: string) {
    const st = useStore.getState().machines[m];
    if (!label || !st || label === st.label) return;
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}/label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(t('machine.renameFailed', { machine: st.label, detail: await machineError(res) }));
    } catch (e) {
      report(e);
    }
  },

  /** Starts, restarts or stops a machine's terminal core
   * (POST /api/m/{id}/hc/{action}); restarting and stopping ask first. One
   * action at a time per machine. */
  async terminalCore(m: string, action: 'start' | 'restart' | 'stop') {
    const s = useStore.getState();
    const machine = s.machines[m]?.label ?? m;
    if (s.hcBusy[m]) return;
    if (
      action !== 'start' &&
      !(await confirmDialog({
        title: t(action === 'stop' ? 'core.stopTitle' : 'core.restartTitle', { machine }),
        message: t(action === 'stop' ? 'core.stopInfo' : 'core.restartInfo'),
        confirm: t(action === 'stop' ? 'core.stop' : 'core.restart'),
        danger: action === 'stop',
      }))
    )
      return;
    s.setHcBusy(m, true);
    try {
      const res = await fetch(`/api/m/${encodeURIComponent(m)}/hc/${action}`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const code = `backend.${body.error}`;
        throw new Error(t('core.failed', { machine, error: hasMessage(code) ? t(code) : body.error || String(res.status) }));
      }
      s.toast(t(action === 'stop' ? 'core.stopped' : action === 'restart' ? 'core.restarted' : 'core.started', { machine }));
      // A started core is followed again.
      if (action !== 'stop') terms.subscribe(m);
    } catch (e) {
      report(e);
    } finally {
      useStore.getState().setHcBusy(m, false);
    }
  },

  /** Creates a workspace and opens a terminal in it. Without a directory the
   * dialog asks for one and a name; without a name it is called after its
   * directory. */
  async newWorkspace(m?: string, cwd?: string, name = '') {
    m ??= useStore.getState().machineId;
    if (!m) return;
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    if (cwd === undefined) {
      const c = current();
      const def = (c?.m === m && terms.directory(m, c.focused)) || useStore.getState().machines[m]?.info?.home || '~';
      const input = await newWorkspaceDialog(m, def);
      if (!input) return;
      cwd = input.cwd;
      name = input.label;
    }
    const id = L.newWorkspaceId();
    const title = name || cwd.replace(/\/+$/, '').split('/').pop() || t('workspace.default');
    const dir = cwd;
    await whenLoaded(m);
    terms.mutate(m, (l) => L.createWorkspace(l, id, title, dir));
    await actions.newTab(m, id);
  },

  /** Closes a workspace after asking, and ends its terminals. */
  async closeWorkspace(m: string, ws: string) {
    const w = terms.layout(m)?.workspaces.find((x) => x.id === ws);
    if (!w) return;
    const addresses = L.workspaceTerminals(w);
    if (
      !(await confirmDialog({
        title: t('confirm.closeWorkspaceTitle'),
        message: t('confirm.closeWorkspace', { label: w.name || t('workspace.default') }),
        confirm: t('confirm.close'),
        danger: true,
      }))
    )
      return;
    terms.mutate(m, (l) => L.closeWorkspace(l, ws));
    await Promise.all(addresses.map((a) => terms.kill(m, a)));
  },

  /** Moves a tab to a slot of its workspace's tabs: 0 is before the first
   * tab, the tab count after the last. */
  moveTab(m: string, ws: string, from: number, slot: number) {
    terms.mutate(m, (l) => L.moveTab(l, ws, from, slotIndex(from, slot)));
  },

  /** Moves a workspace to a slot of its machine's workspaces. */
  moveWorkspace(m: string, ws: string, slot: number) {
    terms.mutate(m, (l) => {
      const from = l.workspaces.findIndex((w) => w.id === ws);
      return from < 0 ? l : L.moveWorkspace(l, ws, slotIndex(from, slot));
    });
  },

  /** Starts renaming in place; the tab, workspace or pane header shows an editor. */
  startRename(kind: 'pane' | 'tab' | 'workspace' | 'machine', m: string, id: string) {
    const s = useStore.getState();
    if ((kind === 'workspace' || kind === 'machine') && !s.sidebarOpen) s.toggleSidebar();
    s.setRenaming({ kind, m, id });
  },

  /** Names a tab; an empty name gives it its terminal's title again. */
  renameTab(m: string, ws: string, index: number, name: string) {
    terms.mutate(m, (l) => L.renameTab(l, ws, index, name));
  },

  renameWorkspace(m: string, ws: string, name: string) {
    if (name) terms.mutate(m, (l) => L.renameWorkspace(l, ws, name));
  },

  /** Names a terminal's pane (its "name" label); empty shows its title again. */
  async renamePane(m: string, terminal: string, name: string) {
    await terms.call(m, 'terminal.label', { terminal, labels: { name } }).catch(report);
  },

  /** Shows a machine: its terminals are followed from now on. */
  showMachine(m: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
  },

  selectWorkspace(m: string, ws: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    terms.mutate(m, (l) => L.selectWorkspace(l, ws));
  },

  selectTab(m: string, ws: string, index: number) {
    terms.mutate(m, (l) => L.selectTab(l, ws, index));
  },

  /** Selects a terminal's workspace and tab and gives it the focus. */
  focusTerminal(m: string, terminal: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    terms.mutate(m, (l) => L.focusTerminal(l, terminal));
    focusDom(m, terminal);
  },

  focusDirection(dir: L.Direction) {
    const c = current();
    const next = c && L.neighbor(c.layout, dir);
    if (c && next) actions.focusTerminal(c.m, next);
  },

  cyclePane(step: number) {
    const c = current();
    if (!c?.tab) return;
    const ids = L.tabTerminals(c.tab);
    if (!ids.length) return;
    const i = c.focused ? ids.indexOf(c.focused) : -1;
    actions.focusTerminal(c.m, ids[(i + step + ids.length) % ids.length]);
  },

  /** Selects the next (1) or previous (-1) workspace of the shown machine. */
  cycleWorkspace(step: number) {
    const c = current();
    const n = c?.layout.workspaces.length ?? 0;
    if (!c || n < 2) return;
    actions.selectWorkspace(c.m, c.layout.workspaces[(c.layout.selected + step + n) % n].id);
  },

  switchTab(step: number | { index: number }) {
    const c = current();
    if (!c?.ws) return;
    const n = c.ws.tabs.length;
    if (!n) return;
    const index = typeof step === 'number' ? (c.ws.selected + step + n) % n : step.index;
    if (index < n) actions.selectTab(c.m, c.ws.id, index);
  },

  /** The focused terminal, its machine and its directory. */
  focusedContext(): { m: string; terminal?: string; cwd?: string } | undefined {
    const c = current();
    if (!c) return undefined;
    return { m: c.m, terminal: c.focused, cwd: c.focused ? terms.directory(c.m, c.focused) : (c.ws?.cwd ?? undefined) || undefined };
  },

  openPath(m: string, path: string, line?: number, col?: number) {
    if (mediaExt.test(path)) return useStore.getState().openDock({ kind: 'preview', m, path });
    // Code (or unknown) files go to VS Code at the given position; fall back
    // to the preview panel when code-server is unavailable.
    bridge.openFile(m, path, line, col).catch(() => useStore.getState().openDock({ kind: 'preview', m, path }));
  },

  openPreview(m: string, path: string) {
    useStore.getState().openDock({ kind: 'preview', m, path });
  },

  openCode(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
  },

  openDiff(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
    bridge.command(m, folder, { cmd: 'openDiff', repo: folder }).catch(report);
  },

  openGitGraph(m: string, folder?: string) {
    useStore.getState().openDock({ kind: 'code', m, folder });
    bridge.command(m, folder, { cmd: 'gitGraph', repo: folder }).catch(report);
  },

  toggleSidebar() {
    useStore.getState().toggleSidebar();
  },

  /** Shows or hides the selected workspace's VS Code panel: an open panel
   * (VS Code or preview) closes and the terminal gets the keys again;
   * otherwise the VS Code panel the workspace showed last comes back while it
   * is of the focused terminal's machine, else the focused terminal's folder
   * opens in VS Code. */
  toggleCode() {
    const s = useStore.getState();
    const c = actions.focusedContext();
    if (currentDock(s)) {
      s.openDock(undefined);
      if (c?.terminal) paneHandle(c.m, c.terminal)?.focus();
      return;
    }
    const last = currentLastCode(s);
    if (last && (!c || last.m === c.m)) s.openDock(last);
    else if (c) actions.openCode(c.m, c.cwd);
  },

  /** The selected tab: its machine, workspace, index and name. */
  currentTab() {
    const c = current();
    if (!c?.ws || !c.tab) return undefined;
    return { m: c.m, ws: c.ws.id, index: c.tabIndex, name: tabName(c.m, c.tab) };
  },

  /** Jump to the agent that most needs attention (blocked first, then done). */
  openAttention() {
    const best = attentionList()[0];
    if (best) actions.focusTerminal(best.m, best.terminal);
  },

  /** Starts a coding agent in a pane split off the focused one. */
  async startAgent(kind: string) {
    const c = current();
    if (!c) return;
    if (c.focused) await actions.split(c.m, c.focused, 'right', [kind]);
    else await actions.newTab(c.m, undefined, [kind]);
  },
};

/** A tab's name: its own, else its focused terminal's title. */
export function tabName(m: string, tab: L.Tab): string {
  return tab.name || terminalTitle(terms.terminal(m, tab.focused), tab.focused);
}

/** Resolves once a machine's layout was read. */
function whenLoaded(m: string): Promise<void> {
  if (terms.layout(m)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useTerms.subscribe((s) => {
      if (s.machines[m]?.layout) {
        off();
        resolve();
      }
    });
  });
}

export type { TermRef };

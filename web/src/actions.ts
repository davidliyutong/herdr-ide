// User-level commands shared by buttons, the keymap and the command palette.
// Workspaces, tabs and panes are edits of the shown machine's layout
// document plus terminal.run and terminal.kill on its terminal core
// (state/terms.ts); closing ends the programs after asking when one runs.
// VS Code and previews are panes too: they open as a tab or beside the pane
// they came from (docs/features/05-vscode-panes.md).

import * as L from './term/layout';
import { isLive, type TerminalRecord } from './term/protocol';
import { terms, useTerms } from './state/terms';
import { useStore } from './state/store';
import { withView } from './state/panes';
import { agentOf, agentStatus, statusRank, terminalTitle, type AgentStatus } from './lib/machine';
import { mediaExt } from './terminal/links';
import { bridge, hasFrame, type BridgeCommand } from './lib/bridge';
import { reloadFrame, setStopped } from './codeFrames';
import { hasMessage, t } from './i18n';
import { confirmCheckDialog, confirmDialog, editWorkspaceDialog, newWorkspaceDialog } from './dialog';
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

/** Each pane's share of its tab, from the split tree. */
export const paneRects = L.paneRects;

/** The shown machine's selected workspace and tab, and the focused pane. */
export function current() {
  const m = useStore.getState().machineId;
  const layout = m ? useTerms.getState().machines[m]?.layout : undefined;
  if (!m || !layout) return undefined;
  const ws = L.selectedWorkspace(layout);
  const tab = ws?.tabs[ws.selected];
  return { m, layout, ws, tabIndex: ws?.selected ?? 0, tab, focused: tab?.focused || undefined };
}

/** Puts the keyboard in a pane once it is on screen. */
function focusDom(m: string, pane: string) {
  withView(m, pane, (h) => h.focus());
}

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

/** The directory a pane works in: a terminal's (its foreground program's),
 * a VS Code pane's folder, a preview's file's directory. */
export function paneDirectory(m: string, leaf: L.Leaf | null | undefined): string | undefined {
  if (!leaf) return undefined;
  if (L.isTerminalLeaf(leaf)) return terms.directory(m, leaf.terminal);
  if (L.isCodeLeaf(leaf)) return leaf.code.folder || undefined;
  return L.isPreviewLeaf(leaf) ? dirname(leaf.preview.path) : undefined;
}

/** Where a pane opened from another one goes: the workspace and tab of from
 * (the shown machine's focused pane when there is none), with from when it
 * is in the layout. */
function originOf(m: string, layout: L.Layout, from?: string) {
  if (from === undefined && useStore.getState().machineId === m) from = L.focusedPane(layout);
  const at = from ? L.locate(layout, from) : null;
  const ws = at ? layout.workspaces[at.workspace] : L.selectedWorkspace(layout);
  return { ws, tab: at ? at.tab : (ws?.selected ?? 0), from: at ? from : undefined };
}

/** Opens a new pane beside from (to its right), else in a new tab of ws. */
function openBeside(m: string, leaf: L.Leaf, ws: L.Workspace | undefined, from?: string) {
  terms.mutate(m, (l) => {
    const next = from ? L.splitPane(l, from, 'horizontal', leaf) : l;
    return next !== l ? next : L.openPane(l, leaf, ws?.id);
  });
}

/** Shows a VS Code pane (and its machine) and gives it the keyboard; runs
 * cmd there. fresh: the pane was just opened. Asking for VS Code starts it
 * again on a machine whose code-server was stopped from this page. */
async function showCode(m: string, key: string, view: { id: string; folder: string }, fresh: boolean, cmd?: BridgeCommand) {
  setStopped(m, false);
  useStore.getState().selectMachine(m);
  terms.mutate(m, (l) => L.focusPane(l, key));
  focusDom(m, key);
  if (cmd) await bridge.command(m, view.id, view.folder, cmd, fresh).catch(report);
}

/** A VS Code window in a split beside from: the VS Code pane of that tab for
 * folder, else a new one; then cmd there (diff, Git Graph). */
async function codeBeside(m: string, folder: string | undefined, from: string | undefined, cmd: BridgeCommand) {
  await whenLoaded(m);
  const layout = terms.layout(m)!;
  const o = originOf(m, layout, from);
  const f = L.normFolder(folder ?? o.ws?.cwd ?? '');
  const found = o.ws ? L.codeViews(o.ws).find((v) => v.tab === o.tab && L.normFolder(v.view.folder) === f) : undefined;
  if (found) return showCode(m, found.key, found.view, !hasFrame(m, found.view.id), cmd);
  const view = { id: L.newId(), folder: f };
  openBeside(m, { code: view }, o.ws, o.from);
  await showCode(m, L.codeKey(view.id), view, true, cmd);
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
  invalid_target: 'machine.invalidTarget',
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
    if (d === 'login' && useStore.getState().sshLogin) useStore.getState().openAuth(m);
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

/** Starts, restarts or stops a machine's terminal core
 * (POST /api/m/{id}/hc/{action}) without asking; one action at a time per
 * machine. Failures are reported. */
async function runCore(m: string, action: 'start' | 'restart' | 'stop') {
  const s = useStore.getState();
  const machine = s.machines[m]?.label ?? m;
  if (s.hcBusy[m]) return;
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
}

export const actions = {
  /** Splits a pane: the new terminal starts in its directory (a VS Code
   * pane's folder, a preview's file's directory). */
  async split(m: string, pane: string, dir: 'right' | 'down', argv?: string[]) {
    terms.mutate(m, (l) => L.focusPane(l, pane));
    const layout = terms.layout(m);
    const cwd = layout ? paneDirectory(m, L.findLeaf(layout, pane)) : undefined;
    try {
      const address = await terms.run(m, { split: true, argv, cwd }, (l, a) => {
        const next = L.splitPane(l, pane, axisOf(dir), { terminal: a });
        return next === l ? L.openTerminal(l, a) : next;
      });
      if (address) focusDom(m, address);
    } catch (e) {
      report(e);
    }
  },

  /** Moves a pane into a new tab of another workspace of its machine and
   * shows it there. */
  movePaneToWorkspace(m: string, pane: string, ws: string, create?: { name: string; cwd: string }) {
    const s = useStore.getState();
    if (s.zoomed?.m === m && s.zoomed.pane === pane) s.setZoomed(undefined);
    const moved = terms.mutate(m, (l) =>
      // A new workspace only with the pane in it, which may have closed meanwhile.
      create && L.findLeaf(l, pane)
        ? L.moveToNewTab(L.createWorkspace(l, ws, create.name, create.cwd), pane, ws)
        : L.moveToNewTab(l, pane, ws),
    );
    if (moved) focusDom(m, pane);
  },

  /** Moves a pane into a new workspace: the dialog asks for its directory
   * (the pane's to begin with) and name. */
  async movePaneToNewWorkspace(m: string, pane: string) {
    const layout = terms.layout(m);
    const leaf = layout && L.findLeaf(layout, pane);
    if (!leaf) return;
    const def = paneDirectory(m, leaf) || useStore.getState().machines[m]?.info?.home || '~';
    const input = await newWorkspaceDialog(m, def);
    if (!input) return;
    actions.movePaneToWorkspace(m, pane, L.newId(), { name: input.label, cwd: input.cwd });
  },

  /** Shows a pane alone in its tab, or all of the tab again. */
  zoom(m: string, pane: string) {
    const s = useStore.getState();
    s.setZoomed(s.zoomed?.m === m && s.zoomed.pane === pane ? undefined : { m, pane });
    focusDom(m, pane);
  },

  /** Closes a pane. A terminal ends after asking when a program runs in it,
   * and its pane goes with the event that follows; VS Code and previews just
   * go. */
  async closePane(m: string, pane: string) {
    const layout = terms.layout(m);
    const leaf = layout ? L.findLeaf(layout, pane) : null;
    if (leaf && !L.isTerminalLeaf(leaf)) {
      terms.mutate(m, (l) => L.closePane(l, pane));
      return;
    }
    await once(`pane ${m} ${pane}`, async () => {
      if (!(await confirmEnd(m, [pane], 'confirm.closePaneTitle', true))) return;
      terms.mutate(m, (l) => L.closePane(l, pane));
      await terms.kill(m, pane);
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
    const panes = L.tabPanes(tab).join();
    await once(`tab ${m} ${ws} ${panes}`, async () => {
      if (!(await confirmEnd(m, addresses, 'confirm.closeTabTitle'))) return;
      terms.mutate(m, (l) => {
        const w = l.workspaces.find((x) => x.id === ws);
        const i = w?.tabs.findIndex((x) => L.tabPanes(x).join() === panes) ?? -1;
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
    let stop = false;
    if (!enabled && st?.status !== 'disabled') {
      const ask = {
        title: t('confirm.disableMachineTitle', { machine }),
        message: t('confirm.disableMachine'),
        confirm: t('menu.disableMachine'),
        danger: true,
      };
      // While its agent is connected, the machine's terminal core can be
      // stopped with it (unchecked: that ends every terminal there).
      if (st?.status === 'ready' && !st.code) {
        const res = await confirmCheckDialog({ ...ask, check: t('confirm.disableStopCore'), checked: false });
        if (!res) return;
        stop = res.checked;
      } else if (!(await confirmDialog(ask))) return;
    }
    // Stopped before the session ends; a failed stop is reported and the
    // machine is disabled all the same.
    if (stop) await runCore(m, 'stop');
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

  /** Moves a machine to a slot of the machines (0 before the first, the
   * machine count after the last): shown at once, stored by the core
   * (PUT /api/machines/order), which sends every page the new list. */
  async moveMachine(m: string, slot: number) {
    const before = useStore.getState().order;
    const from = before.indexOf(m);
    if (from < 0) return;
    const order = before.filter((x) => x !== m);
    order.splice(Math.max(0, Math.min(slotIndex(from, slot), order.length)), 0, m);
    if (order.every((x, i) => x === before[i])) return;
    useStore.setState({ order });
    try {
      const res = await fetch('/api/machines/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (!res.ok) throw new Error(t('machine.orderFailed', { detail: await machineError(res) }));
    } catch (e) {
      if (useStore.getState().order === order) useStore.setState({ order: before });
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
    await runCore(m, action);
  },

  /** Creates a workspace and opens a terminal in it. Without a directory the
   * dialog asks for one and a name; without a name it is shown with its
   * directory's (L.workspaceTitle). */
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
    const id = L.newId();
    const own = name.trim();
    const dir = cwd;
    await whenLoaded(m);
    terms.mutate(m, (l) => L.createWorkspace(l, id, own, dir));
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
        message: t('confirm.closeWorkspace', { label: workspaceTitle(m, w) }),
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

  /** Names a workspace; an empty name shows its folder's again. */
  renameWorkspace(m: string, ws: string, name: string) {
    terms.mutate(m, (l) => L.renameWorkspace(l, ws, name.trim()));
  },

  /** Edits a workspace's name and directory in a dialog. An emptied name
   * shows its folder's again; an emptied directory has its new terminals
   * start in the focused pane's. */
  async editWorkspace(m: string, ws: string) {
    const w = terms.layout(m)?.workspaces.find((x) => x.id === ws);
    if (!w) return;
    const input = await editWorkspaceDialog(m, w.cwd, w.name);
    if (input) terms.mutate(m, (l) => L.editWorkspace(l, ws, input.label, input.cwd));
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

  /** Selects a pane's machine, workspace and tab and gives it the focus. */
  focusPane(m: string, pane: string) {
    useStore.getState().selectMachine(m);
    terms.subscribe(m);
    terms.mutate(m, (l) => L.focusPane(l, pane));
    focusDom(m, pane);
  },

  focusDirection(dir: L.Direction) {
    const c = current();
    const next = c && L.neighbor(c.layout, dir);
    if (c && next) actions.focusPane(c.m, next);
  },

  cyclePane(step: number) {
    const c = current();
    if (!c?.tab) return;
    const ids = L.tabPanes(c.tab);
    if (!ids.length) return;
    const i = c.focused ? ids.indexOf(c.focused) : -1;
    actions.focusPane(c.m, ids[(i + step + ids.length) % ids.length]);
  },

  /** Selects the next (1) or previous (-1) workspace of the shown machine. */
  cycleWorkspace(step: number) {
    const c = current();
    const n = c?.layout.workspaces.length ?? 0;
    if (!c || n < 2) return;
    actions.selectWorkspace(c.m, c.layout.workspaces[(c.layout.selected + step + n) % n].id);
  },

  /** Selects the next (1) or previous (-1) tab, the tab at an index, or the last one. */
  switchTab(step: number | { index: number } | { last: true }) {
    const c = current();
    if (!c?.ws) return;
    const n = c.ws.tabs.length;
    if (!n) return;
    const index = typeof step === 'number' ? (c.ws.selected + step + n) % n : 'last' in step ? n - 1 : step.index;
    if (index < n) actions.selectTab(c.m, c.ws.id, index);
  },

  /** The focused pane (the terminal, when it is one), its machine and the
   * directory it works in, else its workspace's. */
  focusedContext(): { m: string; pane?: string; terminal?: string; cwd?: string } | undefined {
    const c = current();
    if (!c) return undefined;
    const leaf = c.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
    const terminal = leaf && L.isTerminalLeaf(leaf) ? leaf.terminal : undefined;
    const cwd = (leaf ? paneDirectory(c.m, leaf) : undefined) ?? (c.ws?.cwd || undefined);
    return { m: c.m, pane: leaf ? c.focused : undefined, terminal, cwd };
  },

  /** Opens a path found in a pane (from; the focused pane by default): media
   * in a preview pane (openPreview), anything else in VS Code at the line:
   * in a VS Code pane of the workspace, the one of from's tab whose folder
   * holds the file first, then one of another tab that holds it, then any
   * of from's tab, then any; else in a new one split beside from, for the
   * terminal's directory or the workspace's when the file is below it, else
   * for the file's directory. */
  async openPath(m: string, path: string, line?: number, col?: number, from?: string) {
    if (mediaExt.test(path)) return actions.openPreview(m, path, from);
    return actions.openInCode(m, path, line, col, from);
  },

  /** Opens a file in VS Code at the line, as openPath does for files that
   * are not media; media too (a preview's Open in VS Code). */
  async openInCode(m: string, path: string, line?: number, col?: number, from?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const o = originOf(m, layout, from);
    const cmd: BridgeCommand = { cmd: 'openFile', path, line, col };
    const views = o.ws ? L.codeViews(o.ws) : [];
    const holds = (v: (typeof views)[number]) => L.folderHolds(v.view.folder, path);
    const found = views.find((v) => v.tab === o.tab && holds(v)) ?? views.find(holds) ?? views.find((v) => v.tab === o.tab) ?? views[0];
    if (found) return showCode(m, found.key, found.view, !hasFrame(m, found.view.id), cmd);
    const near = [paneDirectory(m, o.from ? L.findLeaf(layout, o.from) : null), o.ws?.cwd].find((d) => d && L.folderHolds(d, path));
    const view = { id: L.newId(), folder: L.normFolder(near ?? dirname(path)) };
    openBeside(m, { code: view }, o.ws, o.from);
    await showCode(m, L.codeKey(view.id), view, true, cmd);
  },

  /** Shows a file or directory in a preview pane of from's workspace (from:
   * the focused pane by default), the one of from's tab first; else in a new
   * one split beside from. */
  async openPreview(m: string, path: string, from?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const o = originOf(m, layout, from);
    const views = o.ws ? L.previewViews(o.ws) : [];
    const found = views.find((v) => v.tab === o.tab) ?? views[0];
    useStore.getState().selectMachine(m);
    if (found) {
      terms.mutate(m, (l) => L.focusPane(L.setPreviewPath(l, found.key, path), found.key));
      focusDom(m, found.key);
      return;
    }
    const id = L.newId();
    openBeside(m, { preview: { id, path } }, o.ws, o.from);
    focusDom(m, L.previewKey(id));
  },

  /** Opens VS Code for a folder (the workspace's by default) as a new tab of
   * the selected workspace, or selects the VS Code pane that workspace has
   * for the folder. */
  async openCode(m: string, folder?: string) {
    await whenLoaded(m);
    const layout = terms.layout(m)!;
    const ws = L.selectedWorkspace(layout);
    const home = useStore.getState().machines[m]?.info?.home ?? '';
    const f = L.normFolder(folder ?? (ws?.cwd || home));
    const found = ws && L.codeViews(ws).find((v) => L.normFolder(v.view.folder) === f);
    if (found) return showCode(m, found.key, found.view, false);
    const view = { id: L.newId(), folder: f };
    terms.mutate(m, (l) => L.openPane(l, { code: view }, ws?.id));
    await showCode(m, L.codeKey(view.id), view, true);
  },

  /** Shows a folder's changes (VS Code's multi-file diff) beside a pane. */
  openDiff(m: string, folder?: string, from?: string) {
    return codeBeside(m, folder, from, { cmd: 'openDiff', repo: folder });
  },

  /** Opens Git Graph of a folder's repository beside a pane. */
  openGitGraph(m: string, folder?: string, from?: string) {
    return codeBeside(m, folder, from, { cmd: 'gitGraph', repo: folder });
  },

  /** Loads a VS Code pane's window again. */
  reloadCode(m: string, id: string) {
    reloadFrame(m, id);
  },

  /** Stops a machine's code-server, which frees its memory there: this
   * page's VS Code panes of the machine offer to start it again. */
  async stopCode(m: string) {
    setStopped(m, true);
    await fetch(`/api/m/${encodeURIComponent(m)}/code/stop`, { method: 'POST' }).catch(() => {});
  },

  toggleSidebar() {
    useStore.getState().toggleSidebar();
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
    if (best) actions.focusPane(best.m, best.terminal);
  },

  /** Starts a coding agent in a pane split off the focused one. */
  async startAgent(kind: string) {
    const c = current();
    if (!c) return;
    if (c.focused) await actions.split(c.m, c.focused, 'right', [kind]);
    else await actions.newTab(c.m, undefined, [kind]);
  },
};

/** A workspace's name as shown: the user's, else the folder of its only
 * pane (a terminal's current directory, a VS Code pane's folder) while it
 * has one pane, else its own directory (the folder its first pane started
 * in) or, without one, its focused pane's folder; the home directory of
 * its machine as "~". */
export function workspaceTitle(m: string, ws: L.Workspace): string {
  // Without a directory of its own, a workspace with several panes goes by
  // its focused one's, where its new terminals start.
  const leaf = L.soleLeaf(ws) ?? (ws.cwd ? null : L.focusedLeaf(ws));
  const dir = !leaf
    ? undefined
    : L.isCodeLeaf(leaf)
      ? leaf.code.folder
      : L.isTerminalLeaf(leaf)
        ? terms.directory(m, leaf.terminal)
        : undefined;
  return L.workspaceTitle(ws, useStore.getState().machines[m]?.info?.home, dir);
}

/** A pane's title: a terminal's (terminalTitle), a VS Code pane's folder
 * name, a preview's file name. */
export function paneTitle(m: string, leaf: L.Leaf | null, key: string): string {
  if (leaf && L.isCodeLeaf(leaf)) return L.folderName(leaf.code.folder, useStore.getState().machines[m]?.info?.home);
  if (leaf && L.isPreviewLeaf(leaf)) return leaf.preview.path.split('/').pop() || leaf.preview.path;
  return terminalTitle(terms.terminal(m, key), key);
}

/** A tab's name: its own, else its focused pane's title. */
export function tabName(m: string, tab: L.Tab): string {
  return tab.name || paneTitle(m, L.leafOf(tab.root, tab.focused), tab.focused);
}

/** What a tab is called in its tab bar: its own name, else its position
 * (1 for the first); its terminals' titles are in its tooltip and their
 * pane headers. */
export function tabLabel(tab: L.Tab, index: number): string {
  return tab.name || String(index + 1);
}

/** Where a terminal is, as places outside the tab bar name it: its
 * workspace and its tab ("website · 2", or the tab's own name); '' when it
 * is in no tab. */
export function terminalPlace(m: string, terminal: string): string {
  const layout = terms.layout(m);
  const at = layout && L.locate(layout, terminal);
  if (!layout || !at) return '';
  const ws = layout.workspaces[at.workspace];
  return `${workspaceTitle(m, ws)} · ${tabLabel(ws.tabs[at.tab], at.tab)}`;
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

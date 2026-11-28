// What the user does with chats: a new one (in the focused pane's
// directory, else the machine's home, in the permission mode of the
// setting chat.permissionMode), showing one (its pane, else a new tab),
// renaming, closing, archiving, restoring and deleting one, and the menus
// that offer these.
import { createElement, type ComponentType } from 'react';
import {
  ArrowLeftRight,
  Check,
  CirclePower,
  Download,
  FileCode2,
  FileText,
  GitFork,
  Pencil,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { create } from 'zustand';
import { actions } from '../../actions';
import { agentKind, chatAdapter, usageProvider } from '../../conversation/kinds';
import { confirmDialog } from '../../dialog';
import { hasMessage, t, type MessageKey } from '../../i18n';
import type { MenuEntry } from '../../contextMenu';
import { setSetting, useSettings } from '../../settings';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import { ProviderLogo } from '../usage/logos';
import {
  ChatFailure,
  DEFAULT_HANDOFF_MAX_KB,
  HANDOFF_BUDGET_PRESETS,
  chatApi,
  failureText,
  handoffMaxKB,
  permissionMode,
  startModelOptions,
  type NewChatVault,
} from './api';
import { canContinueInTerminal, continueInTerminal } from './handoff';
import { STATE_DELETED, type Options } from './protocol';
import { applyStates, chatGone, chatState, liveKey, loadAgents, offeredKinds, upsertState, useChats } from './state';
import { CHAT_PLUGIN, CHAT_VIEW, chatPane, chatRef } from './view';

/** External request to open inline rewind on a specific user turn in a pane. */
export interface RewindRequest {
  pane: string;
  seq: number;
  nonce: number;
}

/** What the chat panes are asked from outside: the pane (machine and view
 * id, `${m}\n${id}`) whose title is to be edited, or a turn to rewind to. */
export const useChatUi = create<{ renaming?: string; rewind?: RewindRequest }>(() => ({}));

let nextRewindNonce = 0;

/** Focuses a chat pane and opens inline rewind confirmation on user turn `seq`. */
export function requestRewind(m: string, viewId: string, seq: number) {
  useChatUi.setState({ rewind: { pane: `${m}\n${viewId}`, seq, nonce: ++nextRewindNonce } });
  actions.focusPane(m, L.viewKey(viewId));
}

/** An agent's name for people. */
export const agentName = (kind: string | undefined): string => agentKind(kind)?.title || kind || t('chat.pane');

const icons = new Map<string, ComponentType<{ className?: string }>>();
const brandIcons = new Map<string, ComponentType<{ className?: string }>>();

/** The mark of an agent's service, drawn as a plain monochrome icon. */
export function kindIcon(kind: string): ComponentType<{ className?: string }> {
  let icon = icons.get(kind);
  if (!icon) {
    const provider = usageProvider(kind) ?? kind;
    icon = ({ className }) => createElement(ProviderLogo, { provider, plain: true, className });
    icons.set(kind, icon);
  }
  return icon;
}

/** The mark of an agent's service in its brand color (tabs, pane headers, composer badge). */
export function brandKindIcon(kind: string): ComponentType<{ className?: string }> {
  let icon = brandIcons.get(kind);
  if (!icon) {
    const provider = usageProvider(kind) ?? kind;
    icon = ({ className }) => createElement(ProviderLogo, { provider, className });
    brandIcons.set(kind, icon);
  }
  return icon;
}

/** The new-tab menu's name of a chat with an agent. */
export function newTabTitle(kind: string): MessageKey {
  const k = `chat.newTab.${kind}`;
  return hasMessage(k) ? k : 'chat.newTab';
}

/** A path of a machine as the chat host takes a directory: absolute,
 * without empty, . and .. parts; undefined for what is none. */
export function cleanDir(p: string | undefined): string | undefined {
  if (!p?.startsWith('/') || p.includes('\0')) return undefined;
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The directory a new chat on machine m starts in: the focused pane's
 * (a terminal's, its program's), else its workspace's, else the
 * machine's home. */
export function defaultCwd(m: string): string | undefined {
  const c = actions.focusedContext();
  const home = useStore.getState().machines[m]?.info?.home;
  return cleanDir(c?.m === m ? c.cwd : undefined) ?? cleanDir(home);
}

const toast = (msg: string) => useStore.getState().toast(msg, undefined, undefined, 'error');

/** Shows a chat: the pane that shows it, else a new tab of it in the
 * workspace of the pane from (the focused pane's by default). Resolves to
 * the pane's key. */
export async function openChat(m: string, chat: string, kind: string, from?: string): Promise<string | undefined> {
  // Shown again, an archived chat is taken back (from the Chats panel's
  // archived chats or the earlier sessions).
  if (chatState(m, chat)?.archived && !useStore.getState().readOnly) void restoreChat(m, chat, { quiet: true });
  const pane = chatPane(m, chat);
  if (pane) {
    actions.focusPane(m, pane);
    return pane;
  }
  const view: { plugin: string; kind: string } & Record<string, unknown> = { plugin: CHAT_PLUGIN, kind: CHAT_VIEW, chat };
  if (chatAdapter(kind)) view.agent = kind;
  return actions.openView(m, view, { from, tab: true, reuse: (v) => chatRef(v).chat === chat });
}

/** Warns the user when vault preset injection for a new chat was skipped or partial. */
export function reportChatVault(vault?: NewChatVault) {
  if (!vault) return;
  const s = useStore.getState();
  if (vault.locked) {
    s.toast(
      t('vault.inject.locked'),
      { label: t('vault.workspace.presetsOpen'), run: () => useStore.getState().setPanel('vault') },
      undefined,
      'warning',
    );
  } else if (vault.corrupt) {
    s.toast(t('vault.inject.corrupt'), undefined, undefined, 'warning');
  } else if (vault.logFailed) {
    s.toast(t('vault.inject.logFailed'), undefined, undefined, 'warning');
  } else if (vault.missing?.length) {
    s.toast(t('vault.inject.missing', { names: vault.missing.join(', ') }), undefined, undefined, 'warning');
  }
}

/** Workspace id to pass on POST /new whenever a workspace is known, so the hub
 * resolves linked vault presets even before the client's vault snapshot loads. */
export function chatWorkspaceFor(m: string, explicit?: string, from?: string): string | undefined {
  if (explicit) return explicit;
  const layout = terms.layout(m);
  if (!layout) return undefined;
  const at = from ? L.locate(layout, from) : null;
  return (at ? layout.workspaces[at.workspace] : L.selectedWorkspace(layout))?.id;
}

/** How long a new chat waits for the machine's cached model list. */
export const MODELS_WAIT_MS = 2000;

/** What a new chat of agent kind on machine m starts with: the permission
 * mode (permissionMode) and the models (startModelOptions), checked against
 * the models the machine's chat host last listed for the kind when it has
 * them at hand (a GET, which starts nothing); undefined for the agent's own. */
export async function startOptions(m: string, kind: string): Promise<Options | undefined> {
  let offered: string[] | undefined;
  try {
    offered = (await chatApi.models(m, kind, AbortSignal.timeout(MODELS_WAIT_MS))).models.map((x) => x.value);
  } catch {
    // No list at hand (no host running, an older host): the adapters check.
  }
  const values = useSettings.getState().values;
  const mode = permissionMode(values, m, kind);
  const o: Options = { ...(mode ? { mode } : {}), ...startModelOptions(values, kind, offered) };
  return Object.keys(o).length > 0 ? o : undefined;
}

/** Makes a chat with an agent on machine m and shows it in a new tab.
 * Resolves to the pane's key; a failure is said in a toast. */
export async function newChat(m: string, kind: string, o: { cwd?: string; workspace?: string } = {}): Promise<string | undefined> {
  const agent = agentName(kind);
  if (useStore.getState().readOnly) return void toast(t('conversation.error.read_only'));
  const cwd = cleanDir(o.cwd) ?? defaultCwd(m);
  if (!cwd) return void toast(t('chat.noDirectory', { agent }));
  const options = await startOptions(m, kind);
  const workspace = chatWorkspaceFor(m, o.workspace);
  let chat;
  let vault: NewChatVault | undefined;
  try {
    const res = await chatApi.createChat(m, {
      kind,
      cwd,
      ...(options ? { options } : {}),
      ...(workspace ? { workspace } : {}),
    });
    chat = res.chat;
    vault = res.vault;
  } catch (e) {
    toast(failureText(e, agent, 'chat.newFailed'));
    // What it can start may have changed.
    void loadAgents(m, { force: true, fresh: true });
    return undefined;
  }
  // Its host serves now: what it can start, unless known.
  void loadAgents(m);
  reportChatVault(vault);
  upsertState(m, chat);
  return openChat(m, chat.id, kind);
}

/** Ends a chat's agent; the chat stays, closed. */
export async function closeChat(m: string, chat: string) {
  try {
    await chatApi.close(m, chat);
  } catch (e) {
    toast(failureText(e, agentName(chatState(m, chat)?.kind), 'chat.closeFailed'));
  }
}

/** How long the archive confirmation toast stays before auto-dismissing. */
export const ARCHIVE_TOAST_MS = 4000;

/** Archives a chat from the sidebar list: its agent ends and the chat,
 * with its log, is kept apart (the Chats panel's archived chats) until the
 * machine's chat limits remove it. A bottom-left toast says so and can
 * take it back. */
export async function archiveChat(m: string, chat: string): Promise<boolean> {
  const st = chatState(m, chat);
  const agent = agentName(st?.kind);
  const title = st?.title || agent;
  try {
    await chatApi.archive(m, chat);
  } catch (e) {
    toast(failureText(e, agent, 'chat.archiveFailed'));
    return false;
  }
  const cur = chatState(m, chat);
  if (cur && !cur.archived) applyStates(m, [{ ...cur, archived: true, status: 'idle', unread: undefined }], false);
  useStore
    .getState()
    .toast(
      t('chat.archived', { title }),
      { label: t('chat.restore'), run: () => void restoreChat(m, chat), ttl: ARCHIVE_TOAST_MS },
      undefined,
      'info',
      'bottom-left',
    );
  return true;
}

/** A machine's name for people. */
export const machineLabel = (m: string): string => useStore.getState().machines[m]?.label || m;

/** How long restartHost waits for the old host to end before it starts
 * this build's, and how often it looks. */
const HOST_END_MS = 5000;
const HOST_END_EVERY_MS = 250;

/** Restarts machine m's chat host so that one of the hub's build takes
 * its place: the host ends (it refuses while a chat starts, works or
 * waits), ending its idle agents, whose chats resume their sessions at
 * their next message; once it is gone, a host of this build starts. A
 * failure is said in a toast. */
export async function restartHost(m: string): Promise<boolean> {
  const machine = machineLabel(m);
  try {
    await chatApi.stopHost(m);
  } catch (e) {
    const busy = e instanceof ChatFailure && e.code === 'busy';
    toast(busy ? t('chat.host.busy', { machine }) : failureText(e, machine, 'chat.host.restartFailed'));
    return false;
  }
  // The old host ends within its grace; GET agents starts none.
  for (let waited = 0; waited < HOST_END_MS; waited += HOST_END_EVERY_MS) {
    try {
      await chatApi.agents(m);
    } catch (e) {
      if (e instanceof ChatFailure && e.code === 'not_running') break;
    }
    await new Promise((r) => setTimeout(r, HOST_END_EVERY_MS));
  }
  try {
    await chatApi.startAgents(m);
  } catch {
    // The next use starts it.
  }
  // The hub's watch tells the new host's build.
  useChats.setState((s) => ({ hosts: { ...s.hosts, [m]: { version: '', outdated: false } } }));
  useStore.getState().toast(t('chat.host.restarted', { machine }), undefined, undefined, 'info');
  return true;
}

/** Takes an archived chat back into the Chats panel's list; a failure is
 * said in a toast unless quiet. */
export async function restoreChat(m: string, chat: string, o: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    await chatApi.unarchive(m, chat);
  } catch (e) {
    if (!o.quiet) toast(failureText(e, agentName(chatState(m, chat)?.kind), 'chat.restoreFailed'));
    return false;
  }
  const cur = chatState(m, chat);
  if (cur?.archived) applyStates(m, [{ ...cur, archived: undefined }], false);
  return true;
}

/** Deletes a chat once the user confirmed it; resolves to whether it
 * was. */
export async function deleteChat(m: string, chat: string): Promise<boolean> {
  const st = chatState(m, chat);
  const agent = agentName(st?.kind);
  const ok = await confirmDialog({
    title: t('chat.delete.title'),
    message: t('chat.delete.message', { title: st?.title || agent }),
    confirm: t('chat.delete.confirm'),
    danger: true,
  });
  if (!ok) return false;
  try {
    await chatApi.remove(m, chat);
  } catch (e) {
    toast(failureText(e, agent, 'chat.deleteFailed'));
    return false;
  }
  if (st) applyStates(m, [{ ...st, state: STATE_DELETED }], false);
  return true;
}

/** Sets a chat's title; a failure is said in a toast. */
export async function renameChat(m: string, chat: string, title: string) {
  try {
    const { withSource } = await import('./source');
    await withSource(m, chat, (s) => s.rename(title));
  } catch (e) {
    toast(failureText(e, agentName(chatState(m, chat)?.kind), 'chat.renameFailed'));
  }
}

/** Has the pane of a view edit its chat's title (the pane is shown first). */
export function startRename(m: string, viewId: string) {
  useChatUi.setState({ renaming: `${m}\n${viewId}` });
  actions.focusPane(m, L.viewKey(viewId));
}

/** The menu of the agents a new chat on machine m may be with. */
export function kindsMenu(m: string, o: { cwd?: string } = {}): MenuEntry[] {
  void loadAgents(m);
  return offeredKinds(m).map((k) => ({
    label: agentName(k.id),
    icon: createElement(kindIcon(k.id)),
    run: () => void newChat(m, k.id, o),
  }));
}

/** Configured handoff / Markdown export byte budget when non-default, else undefined. */
function customHandoffBytes(explicit?: number): number | undefined {
  if (explicit !== undefined) return explicit;
  const kb = handoffMaxKB(useSettings.getState().values);
  return kb !== DEFAULT_HANDOFF_MAX_KB ? kb * 1024 : undefined;
}

/** Prompts the user before forking a chat whose adapter lacks native fork
 * (falling back to a handoff summary seed). Returns true to proceed. */
export async function confirmLossyFork(m: string, chat: string, kind?: string): Promise<boolean> {
  const live = useChats.getState().live[liveKey(m, chat)];
  const lossy = !!live?.info && !live.info.capabilities?.fork;
  if (!lossy) return true;
  const agent = agentName(kind ?? chatState(m, chat)?.kind);
  return confirmDialog({
    title: t('chat.forkLossyTitle'),
    message: t('chat.forkLossyMessage', { agent }),
    confirm: t('chat.forkLossyConfirm'),
  });
}

/** Forks an existing chat (up to upToSeq, or its end) into a new chat tab. */
export async function forkChat(
  m: string,
  chat: string,
  o: { upToSeq?: number; title?: string; from?: string; maxBytes?: number; workspace?: string } = {},
): Promise<string | undefined> {
  if (useStore.getState().readOnly) return void toast(t('conversation.error.read_only'));
  const st = chatState(m, chat);
  const maxBytes = customHandoffBytes(o.maxBytes);
  const workspace = chatWorkspaceFor(m, o.workspace, o.from);
  let forked;
  let vault: NewChatVault | undefined;
  try {
    const res = await chatApi.forkWithVault(m, {
      chat,
      ...(o.upToSeq !== undefined ? { upToSeq: o.upToSeq } : {}),
      ...(o.title ? { title: o.title } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(workspace ? { workspace } : {}),
    });
    forked = res.chat;
    vault = res.vault;
  } catch (e) {
    toast(failureText(e, agentName(st?.kind), 'chat.forkFailed'));
    return undefined;
  }
  reportChatVault(vault);
  upsertState(m, forked);
  return openChat(m, forked.id, forked.kind, o.from);
}

/** Exports context from a chat and opens a new chat tab with targetKind in the same directory. */
export async function switchChatAgent(
  m: string,
  chat: string,
  targetKind: string,
  o: { upToSeq?: number; from?: string; maxBytes?: number; workspace?: string } = {},
): Promise<string | undefined> {
  if (useStore.getState().readOnly) return void toast(t('conversation.error.read_only'));
  const targetName = agentName(targetKind);
  const options = await startOptions(m, targetKind);
  const maxBytes = customHandoffBytes(o.maxBytes);
  const workspace = chatWorkspaceFor(m, o.workspace, o.from);
  let switched;
  let vault: NewChatVault | undefined;
  try {
    const res = await chatApi.switchChatWithVault(m, {
      chat,
      targetKind,
      ...(options ? { options } : {}),
      ...(o.upToSeq !== undefined ? { upToSeq: o.upToSeq } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(workspace ? { workspace } : {}),
    });
    switched = res.chat;
    vault = res.vault;
  } catch (e) {
    toast(failureText(e, targetName, 'chat.switchAgentFailed'));
    return undefined;
  }
  reportChatVault(vault);
  upsertState(m, switched);
  return openChat(m, switched.id, switched.kind, o.from);
}

/** Submenu entries for configuring the Markdown export & handoff digest budget. */
export function handoffBudgetMenu(): MenuEntry[] {
  const current = handoffMaxKB(useSettings.getState().values);
  const disabled = useStore.getState().readOnly;
  return HANDOFF_BUDGET_PRESETS.map((kb) => ({
    label: kb === DEFAULT_HANDOFF_MAX_KB ? t('chat.handoff.budgetDefault', { kb }) : `${kb} KB`,
    icon: kb === current ? createElement(Check) : undefined,
    disabled,
    run: () => void setSetting('chat.handoffMaxKB', kb),
  }));
}

/** Menu items for switching a chat to another available agent on machine m,
 * with handoff options (Continue in Terminal, Handoff Digest Budget). */
export function switchAgentMenu(m: string, chat: string, currentKind: string | undefined, from?: string, view?: L.PluginView): MenuEntry[] {
  void loadAgents(m);
  const targets: MenuEntry[] = offeredKinds(m)
    .filter((k) => k.id !== currentKind)
    .map((k) => ({
      label: agentName(k.id),
      icon: createElement(brandKindIcon(k.id)),
      run: () => void switchChatAgent(m, chat, k.id, { from }),
    }));
  const extras: MenuEntry[] = [];
  if (view && canContinueInTerminal(m, view)) {
    const st = chatState(m, chat);
    extras.push({
      label: t('chat.continueInTerminal'),
      icon: createElement(SquareTerminal),
      run: () => void continueInTerminal(m, view).catch((e: unknown) => toast(failureText(e, agentName(st?.kind), 'chat.handoffFailed'))),
    });
  }
  if (!targets.length && !extras.length) return [];
  const currentKb = handoffMaxKB(useSettings.getState().values);
  return [
    ...targets,
    ...(targets.length && extras.length ? (['sep'] as const) : []),
    ...extras,
    'sep',
    {
      label: t('chat.handoff.budget'),
      hint: `${currentKb} KB`,
      icon: createElement(SlidersHorizontal),
      submenu: handoffBudgetMenu(),
    },
  ];
}

/** Builds a clean download filename from a chat's title (or agent) and id. */
export function chatExportFileName(title: string | undefined, kind: string | undefined, chat: string, ext: 'md' | 'json' = 'md'): string {
  const raw = (title || agentName(kind) || 'chat')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const stem = raw || 'chat';
  return `${stem}-${chat.slice(0, 8)}.${ext}`;
}

function saveDownload(text: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Exports a chat's conversation as a Markdown file download; a failure is said in a toast. */
export async function exportChatMarkdown(
  m: string,
  chat: string,
  o: { upToSeq?: number; kind?: string; maxBytes?: number } = {},
): Promise<boolean> {
  const st = chatState(m, chat);
  const live = useChats.getState().live[liveKey(m, chat)];
  const kind = o.kind ?? st?.kind;
  const title = live?.info?.title || st?.title;
  const maxBytes = customHandoffBytes(o.maxBytes);
  try {
    const md = await chatApi.exportMarkdown(m, chat, o.upToSeq, maxBytes);
    saveDownload(md, chatExportFileName(title, kind, chat, 'md'), 'text/markdown;charset=utf-8');
    return true;
  } catch (e) {
    toast(failureText(e, agentName(kind), 'chat.exportFailed'));
    return false;
  }
}

/** Exports a chat's lossless raw events and metadata as a JSON file download. */
export async function exportChatJson(m: string, chat: string, o: { upToSeq?: number; kind?: string } = {}): Promise<boolean> {
  const st = chatState(m, chat);
  const live = useChats.getState().live[liveKey(m, chat)];
  const kind = o.kind ?? st?.kind;
  const title = live?.info?.title || st?.title;
  try {
    const data = await chatApi.exportJson(m, chat, o.upToSeq);
    saveDownload(JSON.stringify(data, null, 2) + '\n', chatExportFileName(title, kind, chat, 'json'), 'application/json;charset=utf-8');
    return true;
  } catch (e) {
    toast(failureText(e, agentName(kind), 'chat.exportFailed'));
    return false;
  }
}

/** Dropdown entries for the Export action (Markdown, Raw JSON, and Digest Budget). */
export function exportChatMenu(m: string, chat: string, o: { upToSeq?: number; kind?: string } = {}): MenuEntry[] {
  const currentKb = handoffMaxKB(useSettings.getState().values);
  return [
    {
      label: t('chat.export.markdown'),
      hint: `${currentKb} KB`,
      icon: createElement(FileText),
      run: () => void exportChatMarkdown(m, chat, o),
    },
    {
      label: t('chat.export.json'),
      icon: createElement(FileCode2),
      run: () => void exportChatJson(m, chat, o),
    },
    'sep',
    {
      label: t('chat.handoff.budget'),
      hint: `${currentKb} KB`,
      icon: createElement(SlidersHorizontal),
      submenu: handoffBudgetMenu(),
    },
  ];
}

/** What a chat pane's header and tab menus start with. */
export function chatMenu(m: string, view: L.PluginView): MenuEntry[] {
  const ref = chatRef(view);
  const chat = ref.chat;
  if (!chat) return [];
  const st = chatState(m, chat);
  const kind = ref.agent ?? st?.kind;
  if (useStore.getState().readOnly) {
    if (chatGone(useChats.getState(), m, chat)) return [];
    return [{ label: t('chat.export'), icon: createElement(Download), submenu: exportChatMenu(m, chat, { kind }) }];
  }
  const from = L.viewKey(view.id);
  const working = st?.state === 'working' || st?.state === 'waiting' || st?.state === 'starting';
  const out: MenuEntry[] = [
    { label: t('chat.rename'), icon: createElement(Pencil), run: () => startRename(m, view.id) },
    {
      label: t('chat.fork'),
      icon: createElement(GitFork),
      disabled: working,
      run: () => {
        void confirmLossyFork(m, chat, kind).then((ok) => {
          if (ok) void forkChat(m, chat, { from });
        });
      },
    },
  ];
  const others = switchAgentMenu(m, chat, kind, from);
  if (others.length) out.push({ label: t('chat.switchAgent'), icon: createElement(ArrowLeftRight), disabled: working, submenu: others });
  out.push({ label: t('chat.export'), icon: createElement(Download), submenu: exportChatMenu(m, chat, { kind }) });
  if (canContinueInTerminal(m, view))
    out.push({
      label: t('chat.continueInTerminal'),
      icon: createElement(SquareTerminal),
      run: () => void continueInTerminal(m, view).catch((e: unknown) => toast(failureText(e, agentName(st?.kind), 'chat.handoffFailed'))),
    });
  if (st?.state !== 'closed') out.push({ label: t('chat.close'), icon: createElement(CirclePower), run: () => void closeChat(m, chat) });
  out.push({
    label: t('chat.delete'),
    icon: createElement(Trash2),
    danger: true,
    run: () =>
      void deleteChat(m, chat).then((done) => {
        if (done) void actions.closePane(m, from);
      }),
  });
  return out;
}

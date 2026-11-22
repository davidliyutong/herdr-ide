// What the user does with chats: a new one (in the focused pane's
// directory, else the machine's home, in the permission mode of the
// setting chat.permissionMode), showing one (its pane, else a new tab),
// renaming, closing and deleting one, and the menus that offer these.
import { createElement, type ComponentType } from 'react';
import { CirclePower, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import { create } from 'zustand';
import { actions } from '../../actions';
import { agentKind, chatAdapter, usageProvider } from '../../conversation/kinds';
import { confirmDialog } from '../../dialog';
import { hasMessage, t, type MessageKey } from '../../i18n';
import type { MenuEntry } from '../../contextMenu';
import { useSettings } from '../../settings';
import { useStore } from '../../state/store';
import * as L from '../../term/layout';
import { ProviderLogo } from '../usage/logos';
import { chatApi, failureText, permissionMode } from './api';
import { canContinueInTerminal, continueInTerminal } from './handoff';
import { STATE_DELETED } from './protocol';
import { chatPane } from './status';
import { applyStates, chatState, loadAgents, offeredKinds, upsertState } from './state';
import { withSource } from './source';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

/** What the chat panes are asked from outside: the pane (machine and view
 * id, `${m}\n${id}`) whose title is to be edited. */
export const useChatUi = create<{ renaming?: string }>(() => ({}));

/** An agent's name for people. */
export const agentName = (kind: string | undefined): string => agentKind(kind)?.title || kind || t('chat.pane');

const icons = new Map<string, ComponentType<{ className?: string }>>();

/** The mark of an agent's service, drawn as an icon. */
export function kindIcon(kind: string): ComponentType<{ className?: string }> {
  let icon = icons.get(kind);
  if (!icon) {
    const provider = usageProvider(kind) ?? kind;
    icon = ({ className }) => createElement(ProviderLogo, { provider, plain: true, className });
    icons.set(kind, icon);
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
  const pane = chatPane(m, chat);
  if (pane) {
    actions.focusPane(m, pane);
    return pane;
  }
  const view: { plugin: string; kind: string } & Record<string, unknown> = { plugin: CHAT_PLUGIN, kind: CHAT_VIEW, chat };
  if (chatAdapter(kind)) view.agent = kind;
  return actions.openView(m, view, { from, tab: true, reuse: (v) => chatRef(v).chat === chat });
}

/** Makes a chat with an agent on machine m and shows it in a new tab.
 * Resolves to the pane's key; a failure is said in a toast. */
export async function newChat(m: string, kind: string, o: { cwd?: string } = {}): Promise<string | undefined> {
  const agent = agentName(kind);
  if (useStore.getState().readOnly) return void toast(t('conversation.error.read_only'));
  const cwd = cleanDir(o.cwd) ?? defaultCwd(m);
  if (!cwd) return void toast(t('chat.noDirectory', { agent }));
  const mode = permissionMode(useSettings.getState().values, m);
  let chat;
  try {
    chat = await chatApi.newChat(m, { kind, cwd, ...(mode ? { options: { mode } } : {}) });
  } catch (e) {
    toast(failureText(e, agent, 'chat.newFailed'));
    // What it can start may have changed.
    void loadAgents(m, true);
    return undefined;
  }
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

/** What a chat pane's header and tab menus start with. */
export function chatMenu(m: string, view: L.PluginView): MenuEntry[] {
  const chat = chatRef(view).chat;
  if (!chat || useStore.getState().readOnly) return [];
  const st = chatState(m, chat);
  const out: MenuEntry[] = [{ label: t('chat.rename'), icon: createElement(Pencil), run: () => startRename(m, view.id) }];
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
        if (done) void actions.closePane(m, L.viewKey(view.id));
      }),
  });
  return out;
}

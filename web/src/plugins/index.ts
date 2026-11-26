// The app's plugins, in the order the right sidebar, the status bar and
// the settings list them (api.ts). Heavy optional plugins register lightweight
// lazy shells so rail icons, menus, settings navigation and pane titles render
// synchronously without pulling Monaco, charts, syntax highlighters or feature
// panels into the initial JS entry bundle.
import { createElement, lazy } from 'react';
import { Activity, FileDiff, FilePen, Files, GitBranch, GitGraph, Globe, History, KeyRound, TextSearch } from 'lucide-react';
import { actions, current } from '../actions';
import { t } from '../i18n';
import { useStore } from '../state/store';
import * as L from '../term/layout';
import { definePlugins, ensurePluginLoaded, setPanelCommand } from './registry';
import { lazyPlugin } from './lazy';
import { togglePanel } from '../components/RightBar';
import { transfersPlugin } from './transfers';
import { guiPlugin } from './gui';
import { vscodePlugin } from './vscode';
import { usagePlugin } from './usage';
import { agentsPlugin } from './agents';
import { makeChatPlugin } from './chat/plugin';
import { useChats } from './chat/state';
import { vaultMessage } from './vault/api';

const baseName = (p: string): string => {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1) || '/';
};

const parentOf = (p: string): string => {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
};

const joinPosix = (a: string, b: string): string => (a.endsWith('/') ? a + b : `${a}/${b}`);

const urlHost = (raw: string): string => {
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw;
  }
};

function focusedBrowser(): boolean {
  const c = current();
  const leaf = c?.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
  return !!(c && leaf && L.isPluginLeaf(leaf) && leaf.view.plugin === 'browser' && leaf.view.kind === 'page');
}

function gitDiffTitle(v: L.PluginView): string {
  const path = typeof v.path === 'string' ? v.path : '';
  const name = baseName(path);
  const mode = typeof v.mode === 'string' ? v.mode : 'worktree';
  const rev = typeof v.rev === 'string' ? v.rev.slice(0, 7) : '';
  const rev2 = typeof v.rev2 === 'string' ? v.rev2.slice(0, 7) : '';
  switch (mode) {
    case 'worktree':
      return t('git.diff.worktreeTitle', { name });
    case 'staged':
      return t('git.diff.stagedTitle', { name });
    case 'commit':
      return `${name} (${rev})`;
    default:
      return `${name} (${rev} ↔ ${rev2})`;
  }
}

const browserPlugin = lazyPlugin(
  {
    id: 'browser',
    title: 'browser.title',
    description: 'browser.description',
    icon: Globe,
    settings: { section: 'browser' },
    paneViews: {
      page: {
        icon: Globe,
        title: (_m, v) =>
          typeof v.title === 'string' && v.title ? v.title : typeof v.url === 'string' && v.url ? urlHost(v.url) : t('browser.title'),
      },
    },
    commands: {
      'browser.open': { enabled: () => !useStore.getState().readOnly && !!actions.focusedContext() },
      'browser.reload': { enabled: focusedBrowser },
    },
    newTabItems: [{ id: 'browser', title: 'browser.title', icon: Globe }],
  },
  () => import('./browser').then((m) => m.browserPlugin),
);

const filesPlugin = lazyPlugin(
  {
    id: 'files',
    title: 'files.title',
    description: 'files.description',
    icon: Files,
    settings: { section: 'files' },
    panels: [{ id: 'files', title: 'files.title', icon: Files, command: 'view.panel.files' }],
    paneViews: {
      editor: {
        icon: FilePen,
        title: (_m, v) => baseName(typeof v.path === 'string' ? v.path : '') || 'editor',
        path: (_m, v) => (typeof v.path === 'string' && v.path ? v.path : undefined),
        directory: (_m, v) => (typeof v.path === 'string' && v.path ? parentOf(v.path) : undefined),
        preview: (_m, v) => v.preview === true,
      },
    },
  },
  // Load git in parallel before files resolves so file-tree decorations,
  // useShownDirs listeners and editor quick-diff providers are registered
  // before FilesPanel or EditorPane mounts.
  async () => {
    const [filesMod] = await Promise.all([import('./files'), ensurePluginLoaded('git').catch(() => undefined)]);
    return filesMod.filesPlugin;
  },
);

const searchPlugin = lazyPlugin(
  {
    id: 'search',
    title: 'search.title',
    description: 'search.description',
    icon: TextSearch,
    panels: [{ id: 'search', title: 'search.title', icon: TextSearch, command: 'view.panel.search' }],
  },
  () => import('./search').then((m) => m.searchPlugin),
);

const gitPlugin = lazyPlugin(
  {
    id: 'git',
    title: 'git.title',
    description: 'git.description',
    icon: GitBranch,
    settings: { section: 'git' },
    panels: [{ id: 'git', title: 'git.title', icon: GitBranch, command: 'view.panel.git' }],
    paneViews: {
      graph: {
        icon: GitGraph,
        title: (_m, v) => t('git.graph.title', { repo: baseName(String(v.repo ?? '')) }),
        directory: (_m, v) => (typeof v.repo === 'string' ? v.repo : undefined),
      },
      diff: {
        icon: FileDiff,
        title: (_m, v) => gitDiffTitle(v),
        path: (_m, v) =>
          typeof v.repo === 'string' && v.repo && typeof v.path === 'string' && v.path ? joinPosix(v.repo, v.path) : undefined,
        directory: (_m, v) =>
          typeof v.repo === 'string' && v.repo && typeof v.path === 'string' && v.path ? parentOf(joinPosix(v.repo, v.path)) : undefined,
      },
    },
    commands: { 'git.graph': {} },
  },
  () => import('./git').then((m) => m.gitPlugin),
);

const monitorPlugin = lazyPlugin(
  {
    id: 'monitor',
    title: 'monitor.title',
    description: 'monitor.description',
    icon: Activity,
    settings: { section: 'monitor' },
    panels: [{ id: 'monitor', title: 'monitor.taskManager', icon: Activity, command: 'view.panel.monitor' }],
    statusWidgets: [{ id: 'monitor', title: 'monitor.title' }],
    newTabItems: [{ id: 'monitor', title: 'monitor.taskManager', icon: Activity }],
    hasBackgroundStatus: true,
  },
  () => import('./monitor').then((m) => m.monitorPlugin),
);

const vaultPlugin = lazyPlugin(
  {
    id: 'vault',
    title: 'plugins.vault.title',
    description: 'plugins.vault.description',
    icon: KeyRound,
    settings: { section: 'vault', hasExtra: true },
    panels: [{ id: 'vault', title: 'plugins.vault.title', icon: KeyRound, command: 'view.panel.vault' }],
    hasBackgroundStatus: true,
    onMessage: vaultMessage,
  },
  () => import('./vault').then((m) => m.vaultPlugin),
);

const LazyChatUsageItem = lazy(() => import('./chat/UsageItem').then((m) => ({ default: m.ChatUsageItem })));
function ChatUsageGate() {
  const hasLive = useChats((s) => Object.keys(s.live).length > 0);
  return hasLive ? createElement(LazyChatUsageItem) : null;
}

const chatPlugin = makeChatPlugin({
  ChatPane: lazy(() => import('./chat/ChatPane').then((m) => ({ default: m.ChatPane }))),
  ChatsPanel: lazy(() => import('./chat/ChatsPanel').then((m) => ({ default: m.ChatsPanel }))),
  ChatSettingsExtra: lazy(() => import('./chat/SettingsExtra').then((m) => ({ default: m.ChatSettingsExtra }))),
  ChatUsageItem: ChatUsageGate,
});

const historyPlugin = lazyPlugin(
  {
    id: 'history',
    title: 'history.title',
    description: 'history.description',
    icon: History,
    settings: { section: 'history', hasExtra: true },
    hasBackgroundStatus: true,
  },
  () => import('./history').then((m) => m.historyPlugin),
);

setPanelCommand((panel) => ({ run: () => togglePanel(panel.id) }));
definePlugins([
  transfersPlugin,
  guiPlugin,
  vscodePlugin,
  browserPlugin,
  filesPlugin,
  searchPlugin,
  gitPlugin,
  monitorPlugin,
  usagePlugin,
  vaultPlugin,
  agentsPlugin,
  chatPlugin,
  historyPlugin,
]);

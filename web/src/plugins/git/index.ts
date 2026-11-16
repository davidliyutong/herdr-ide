// Git (docs/features/31-git.md): VS Code's Source Control and the Git
// Graph extension in one, without VS Code. A panel of the right sidebar
// for the focused pane's repository, a graph pane and a diff pane in
// Monaco, and the file explorer's colors for changed files. The core's
// side is internal/plugins/git, the machine's internal/agent/plugin/git.
import { FileDiff, GitBranch, GitGraph } from 'lucide-react';
import type { PluginDef } from '../api';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { registerFileDecorations } from '../files/decorations';
import { followedDir } from '../files/FilesPanel';
import { gitApi, errorText } from './api';
import { gitDecorations } from './decorations';
import { DiffPane, diffOf, diffTitle } from './DiffPane';
import { GitPanel } from './GitPanel';
import { GraphPane } from './GraphPane';
import { baseName, join, openGraph } from './ops';
import { GitPrompt } from './prompt';

registerFileDecorations(gitDecorations);

/** Opens the graph of the focused pane's repository. */
async function graphOfFocused() {
  const s = useStore.getState();
  const m = s.machineId;
  if (!m) return;
  const dir = followedDir() ?? s.machines[m]?.info?.home;
  if (!dir) return;
  try {
    const info = await gitApi.repo(m, dir);
    await openGraph(m, info.root);
  } catch (e) {
    s.toast(errorText(e), undefined, undefined, 'error');
  }
}

const parent = (p: string) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/');

export const gitPlugin: PluginDef = {
  id: 'git',
  title: 'git.title',
  description: 'git.description',
  icon: GitBranch,
  panels: [{ id: 'git', title: 'git.title', icon: GitBranch, component: GitPanel, command: 'view.panel.git' }],
  paneViews: {
    graph: {
      icon: GitGraph,
      title: (_m, v) => t('git.graph.title', { repo: baseName(String(v.repo ?? '')) }),
      directory: (_m, v) => (typeof v.repo === 'string' ? v.repo : undefined),
      component: GraphPane,
    },
    diff: {
      icon: FileDiff,
      title: (_m, v) => diffTitle(diffOf(v)),
      path: (_m, v) => {
        const d = diffOf(v);
        return d.repo && d.path ? join(d.repo, d.path) : undefined;
      },
      directory: (_m, v) => {
        const d = diffOf(v);
        return d.repo && d.path ? parent(join(d.repo, d.path)) : undefined;
      },
      component: DiffPane,
    },
  },
  commands: {
    'git.graph': { run: () => void graphOfFocused() },
  },
  statusItems: [GitPrompt],
};

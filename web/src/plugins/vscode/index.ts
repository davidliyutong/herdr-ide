// VS Code (docs/features/05-vscode-panes.md) as a plugin: code-server's
// windows in panes, the commands that open them (a folder, its changes,
// Git Graph) and the buttons and menu items that offer them. Off, nothing
// offers VS Code, its panes say so and the core refuses its routes
// (internal/plugins/vscode), so code-server is neither fetched nor started.
// The layout keeps VS Code panes ({code: …}) whether it is on or off.
// Its windows run on the UI's origin, so it has a switch for the desktop
// app (plugins.vscode.enabled) and one for browsers
// (plugins.vscode.browser), both off by default; turning the browsers' on
// asks the user to accept that risk (browserRisk).
import { actions, current, spotOpen } from '../../actions';
import { canGo } from '../../paneHistory';
import { useStore } from '../../state/store';
import * as L from '../../term/layout';
import type { PluginDef } from '../api';
import { isPluginOn } from '../registry';
import { CodeIcon } from '../../components/icons';

/** Whether VS Code is offered: its plugin is on. */
export const codeOn = () => isPluginOn('vscode');

const can = () => !useStore.getState().readOnly && !!actions.focusedContext();

/** Whether the focused pane of the tab shown is a VS Code pane. */
function codePaneFocused(): boolean {
  const c = current();
  const leaf = c?.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
  return !!leaf && L.isCodeLeaf(leaf);
}

export const vscodePlugin: PluginDef = {
  id: 'vscode',
  title: 'plugins.vscode.title',
  description: 'plugins.vscode.description',
  icon: CodeIcon,
  browserRisk: {
    title: 'code.risk.title',
    intro: 'code.risk.intro',
    points: ['code.risk.terminals', 'code.risk.files', 'code.risk.app'],
    outro: ['code.risk.source', 'code.risk.scope'],
    check: 'code.risk.check',
    confirm: 'code.risk.enable',
  },
  // VS Code for the workspace's folder, as a tab of its own.
  newTabItems: () => [{ id: 'code', title: 'plugins.vscode.title', icon: CodeIcon, run: (m) => void actions.openCode(m) }],
  commands: {
    'code.open': {
      enabled: can,
      run() {
        const c = actions.focusedContext();
        if (!c) return;
        // On a VS Code pane it hides VS Code again, as its own cmd+j hides
        // its panel: the pane focused before it (Pane Back) is shown.
        if (codePaneFocused() && canGo(-1, spotOpen)) return actions.goPane(-1);
        void actions.openCode(c.m, c.cwd);
      },
    },
    'code.diff': {
      enabled: can,
      run() {
        const c = actions.focusedContext();
        if (c) void actions.openDiff(c.m, c.cwd, c.pane);
      },
    },
    'code.gitGraph': {
      enabled: can,
      run() {
        const c = actions.focusedContext();
        if (c) void actions.openGitGraph(c.m, c.cwd, c.pane);
      },
    },
  },
};

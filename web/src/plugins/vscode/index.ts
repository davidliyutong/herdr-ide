// VS Code (docs/features/05-vscode-panes.md) as a plugin: code-server's
// windows in panes, the commands that open them (a folder, its changes,
// Git Graph) and the buttons and menu items that offer them. Off, nothing
// offers VS Code, its panes say so and the core refuses its routes
// (internal/plugins/vscode), so code-server is neither fetched nor started.
// The layout keeps VS Code panes ({code: …}) whether it is on or off.
import { actions } from '../../actions';
import { useStore } from '../../state/store';
import type { PluginDef } from '../api';
import { isPluginOn } from '../registry';
import { CodeIcon } from '../../components/icons';

/** Whether VS Code is offered: its plugin is on. */
export const codeOn = () => isPluginOn('vscode');

const can = () => !useStore.getState().readOnly && !!actions.focusedContext();

export const vscodePlugin: PluginDef = {
  id: 'vscode',
  title: 'plugins.vscode.title',
  description: 'plugins.vscode.description',
  icon: CodeIcon,
  commands: {
    'code.open': {
      enabled: can,
      run() {
        const c = actions.focusedContext();
        if (c) void actions.openCode(c.m, c.cwd);
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

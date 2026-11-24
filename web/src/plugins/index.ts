// The app's plugins, in the order the right sidebar, the status bar and
// the settings list them (api.ts).
import { definePlugins, setPanelCommand } from './registry';
import { togglePanel } from '../components/RightBar';
import { transfersPlugin } from './transfers';
import { guiPlugin } from './gui';
import { vscodePlugin } from './vscode';
import { browserPlugin } from './browser';
import { filesPlugin } from './files';
import { usagePlugin } from './usage';
import { vaultPlugin } from './vault';
import { gitPlugin } from './git';
import { monitorPlugin } from './monitor';
import { agentsPlugin } from './agents';
import { chatPlugin } from './chat';
import { historyPlugin } from './history';

setPanelCommand((panel) => ({ run: () => togglePanel(panel.id) }));
definePlugins([
  transfersPlugin,
  guiPlugin,
  vscodePlugin,
  browserPlugin,
  filesPlugin,
  gitPlugin,
  monitorPlugin,
  usagePlugin,
  vaultPlugin,
  agentsPlugin,
  chatPlugin,
  historyPlugin,
]);

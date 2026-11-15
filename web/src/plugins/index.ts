// The app's plugins, in the order the right sidebar, the status bar and
// the settings list them (api.ts).
import { definePlugins, setPanelCommand } from './registry';
import { togglePanel } from '../components/RightBar';
import { transfersPlugin } from './transfers';
import { guiPlugin } from './gui';
import { filesPlugin } from './files';
import { usagePlugin } from './usage';
import { vaultPlugin } from './vault';

setPanelCommand((panel) => ({ run: () => togglePanel(panel.id) }));
definePlugins([transfersPlugin, guiPlugin, filesPlugin, usagePlugin, vaultPlugin]);

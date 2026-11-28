// Where a hub keeps its hand-editable files: in the data directory of its
// namespace on the hub host (~/.veldr[-<instance>], the namespace of the
// machines' nodes, --node-instance), settings.json, keybindings.json,
// machines.json and vault.json beside each other. Every hub of the
// namespace shares them: the desktop app and the command line's hub of the
// default namespace read and write the same files.
import { basename, dirname, join } from 'node:path';
import { dataDir } from '#shared/lib/brand.ts';

/** The settings file of the namespace nodeInstance in home. */
export function settingsPath(home: string, nodeInstance: string): string {
  return join(home, dataDir(nodeInstance), 'settings.json');
}

/** The file beside the settings file: machines.json for name
 * "machines". */
export function besideSettings(settings: string, name: string): string {
  return join(dirname(settings), basename(settings).replace('settings', name));
}

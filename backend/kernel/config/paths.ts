// Where an instance keeps its hand-editable files on the hub host: in the
// user's configuration directory (%AppData%, ~/Library/Application Support,
// $XDG_CONFIG_HOME), settings.json, keybindings.json and machines.json, or
// settings-<instance>.json and so on beside each other.
import { basename, dirname, join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';

/** The settings file of instance under configDir (the user's
 * configuration directory). */
export function settingsPath(configDir: string, instance: string): string {
  return join(configDir, SLUG, instance ? `settings-${instance}.json` : 'settings.json');
}

/** The file of the same instance beside the settings file: machines.json
 * or machines-<instance>.json for name "machines". */
export function besideSettings(settings: string, name: string): string {
  return join(dirname(settings), basename(settings).replace('settings', name));
}

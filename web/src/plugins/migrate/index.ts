// The migrate plugin (internal/plugins/migrate,
// docs/features/11-naming-and-renames.md): moving workspaces and tabs from
// the namespace a previous product name left on a machine, at the user's
// pace, while the previous version may still run. Its status bar item
// shows only while a connected machine has such a namespace.
import { ArrowRightLeft } from 'lucide-react';
import type { PluginDef } from '../api';
import { MigrateItem } from './Migrate';
import './migrate.css';

export const migratePlugin: PluginDef = {
  id: 'migrate',
  title: 'migrate.pluginTitle',
  description: 'migrate.description',
  icon: ArrowRightLeft,
  statusItems: [MigrateItem],
};

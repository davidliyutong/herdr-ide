// The terminal history plugin: snapshots of the terminals' output that
// machines keep on their disks (internal/plugins/history), shown above the
// new shell of a terminal whose program was replaced when its terminal
// core started again (follow.ts), with its settings page (section
// "history") and what it ends with (SettingsExtra.tsx).
import { History } from 'lucide-react';
import type { PluginDef } from '../api';
import { HistoryFollower } from './follow';
import { HistorySettingsExtra } from './SettingsExtra';

export const historyPlugin: PluginDef = {
  id: 'history',
  title: 'history.title',
  description: 'history.description',
  icon: History,
  settings: { section: 'history', extra: HistorySettingsExtra },
  // Draws nothing: it follows the snapshots while the plugin is on.
  statusItems: [HistoryFollower],
};

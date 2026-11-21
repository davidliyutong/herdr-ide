// The AI usage plugin (docs/features/29-ai-usage.md): its panel in the right
// sidebar, its status bar item, its settings page (the providers' settings
// on pages of their own), and the core's snapshots (/ws plugin messages).
// The core's side is internal/plugins/usage.
import { Gauge } from 'lucide-react';
import type { PluginDef } from '../api';
import { UsagePanel } from './UsagePanel';
import { UsageStatusItem } from './StatusItem';
import { UsageSettings } from './SettingsPage';
import './usage.css';
import { applySnapshot } from './state';
import type { UsageSnapshot } from './model';

export const usagePlugin: PluginDef = {
  id: 'usage',
  title: 'usage.title',
  description: 'usage.description',
  icon: Gauge,
  settings: { section: 'usage', layout: UsageSettings },
  panels: [{ id: 'usage', title: 'usage.title', icon: Gauge, component: UsagePanel, command: 'view.panel.usage' }],
  statusItems: [{ id: 'usage', title: 'usage.title', component: UsageStatusItem }],
  onMessage(_m, data) {
    if (data && typeof data === 'object') applySnapshot(data as UsageSnapshot);
  },
};

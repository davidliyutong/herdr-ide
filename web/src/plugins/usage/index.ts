// The AI usage plugin (docs/features/29-ai-usage.md): its panel in the right
// sidebar, its status bar items (the accounts' tightest window, and the
// session of the agent in the focused pane), its settings page (the
// providers' settings on pages of their own), and the core's snapshots
// (/ws plugin messages). The core's side is internal/plugins/usage.
import { Gauge } from 'lucide-react';
import type { PluginDef } from '../api';
import { UsagePanel } from './UsagePanel';
import { UsageStatusItem } from './StatusItem';
import { UsageSessionItem } from './SessionItem';
import { UsageSettings } from './SettingsPage';
import { PricesEditor } from './PricesEditor';
import './usage.css';
import { applySnapshot } from './state';
import type { UsageSnapshot } from './model';

export const usagePlugin: PluginDef = {
  id: 'usage',
  title: 'usage.title',
  description: 'usage.description',
  icon: Gauge,
  settings: { section: 'usage', layout: UsageSettings, controls: { 'usage.prices': PricesEditor } },
  panels: [{ id: 'usage', title: 'usage.title', icon: Gauge, component: UsagePanel, command: 'view.panel.usage' }],
  statusItems: [
    { id: 'usage.session', title: 'usage.session.title', component: UsageSessionItem },
    { id: 'usage', title: 'usage.title', component: UsageStatusItem },
  ],
  onMessage(_m, data) {
    if (data && typeof data === 'object') applySnapshot(data as UsageSnapshot);
  },
};

// The System Monitor & Task Manager plugin
// (docs/features/34-system-monitor.md):
//  - Dashboard mode: Cmd+hover on any machine in the left sidebar AND a
//    bottom-right status bar button whose menu floats upward, both rendering
//    the same live CPU / memory / per-GPU / network / disk card.
//  - Task Manager mode: right-sidebar panel (and workspace pane/tab) showing
//    a searchable process list with parent→child Tree View and Flat List.
import { Activity } from 'lucide-react';
import type { PluginDef } from '../api';
import { MachineHoverMonitor, MonitorStatusItem } from './StatusItem';
import { TaskManagerPanel } from './TaskManagerPanel';
import { openTaskManagerTab } from './state';
import './monitor.css';

export const monitorPlugin: PluginDef = {
  id: 'monitor',
  title: 'monitor.title',
  description: 'monitor.description',
  icon: Activity,
  settings: { section: 'monitor' },
  panels: [{ id: 'monitor', title: 'monitor.taskManager', icon: Activity, component: TaskManagerPanel, command: 'view.panel.monitor' }],
  statusItems: [MachineHoverMonitor, { id: 'monitor', title: 'monitor.title', component: MonitorStatusItem }],
  newTabItems: () => [{ id: 'monitor', title: 'monitor.taskManager', icon: Activity, run: (m) => void openTaskManagerTab(m) }],
};

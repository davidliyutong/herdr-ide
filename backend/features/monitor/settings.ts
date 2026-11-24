// The System Monitor's settings (its page in Settings › Plugins), which
// the web UI reads (web/src/plugins/monitor).
import { bool, defineModule, int } from '#kernel/config/settings/index.ts';

const section = 'monitor';

export const settings = defineModule({
  sections: [{ id: section, order: 68, plugin: 'monitor' }],
  settings: {
    /** How often the dashboard popover and the task manager poll metrics
     * and processes while they are shown, in seconds. */
    'monitor.refreshSeconds': int({ default: 2, min: 1, max: 30, section, order: 10 }),
    /** The status bar shows the system monitor's button. */
    'monitor.statusBar': bool({ default: true, section, order: 20 }),
    /** Ask before the task manager sends a process a signal that ends it. */
    'monitor.confirmKill': bool({ default: true, section, order: 30 }),
  },
});

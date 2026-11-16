// Program windows (docs/features/14-gui-windows.md) as a plugin: its tray in
// the status bar and its palette items. It is turned on and off by its own
// setting, gui.enabled, which machines can also have of their own: the
// Plugins page's switch sets the value machines without one take, and the
// tray is there while any machine has program windows on.
import { AppWindow } from 'lucide-react';
import { GuiTray } from '../../gui/GuiMenus';
import { useGui } from '../../gui/state';
import { enableGui } from '../../gui/enable';
import { useStore } from '../../state/store';
import { actions } from '../../actions';
import { t } from '../../i18n';
import type { PaletteItem, PluginDef } from '../api';

export const guiPlugin: PluginDef = {
  id: 'gui',
  title: 'plugins.gui.title',
  description: 'plugins.gui.description',
  icon: AppWindow,
  enableSetting: 'gui.enabled',
  statusItems: [GuiTray],
  paletteItems() {
    const items: PaletteItem[] = [];
    const f = actions.focusedContext();
    const focused = f?.terminal;
    if (f && focused && useGui.getState().machines[f.m]?.phase === 'ready') {
      items.push({ id: 'gui:pane', label: t('action.enableGuiPane'), run: () => void enableGui(f.m, [focused]) });
    }
    const machines = useStore.getState().machines;
    for (const st of Object.values(useGui.getState().machines)) {
      if (st.phase !== 'ready') continue;
      items.push({
        id: `gui:${st.m}`,
        label: t('action.enableGuiMachine', { m: machines[st.m]?.label ?? st.m }),
        run: () => void enableGui(st.m),
      });
    }
    return items;
  },
};

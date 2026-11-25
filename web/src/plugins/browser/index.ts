// The browser (docs/features/32-browser-and-ports.md): a pane that shows a
// web page in a tab, mainly a development server on a machine's localhost,
// reached through a port forward the hub makes (backend/features/browser,
// which has the model). Links to localhost in terminals and documents open
// in it (terminal/openLink.ts).
import { Globe } from 'lucide-react';
import { actions, current } from '../../actions';
import { useStore } from '../../state/store';
import * as L from '../../term/layout';
import type { PluginDef } from '../api';
import { openBrowserTab } from './api';
import { BrowserPane, pageTitle } from './BrowserPane';
import { frameKey, reloadPage } from './frames';

/** The focused pane of the tab shown, when it is a browser pane. */
function focusedBrowser(): { m: string; id: string } | undefined {
  const c = current();
  const leaf = c?.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
  return c && leaf && L.isPluginLeaf(leaf) && leaf.view.plugin === 'browser' && leaf.view.kind === 'page'
    ? { m: c.m, id: leaf.view.id }
    : undefined;
}

export const browserPlugin: PluginDef = {
  id: 'browser',
  title: 'browser.title',
  description: 'browser.description',
  icon: Globe,
  settings: { section: 'browser' },
  paneViews: {
    page: {
      icon: Globe,
      title: (_m, v) => pageTitle(v),
      component: BrowserPane,
    },
  },
  commands: {
    'browser.open': {
      enabled: () => !useStore.getState().readOnly && !!actions.focusedContext(),
      run() {
        const c = actions.focusedContext();
        if (c) void openBrowserTab(c.m);
      },
    },
    'browser.reload': {
      enabled: () => !!focusedBrowser(),
      run() {
        const f = focusedBrowser();
        if (f) reloadPage(frameKey(f.m, f.id));
      },
    },
  },
  newTabItems: () => [{ id: 'browser', title: 'browser.title', icon: Globe, run: (m) => void openBrowserTab(m) }],
};

// Whether a terminal is on screen: in the shown machine's selected
// workspace and tab. A turn an agent ended in a terminal on screen is not
// news; the terminal core marks it seen when the terminal has the focus
// (vt/pane.ts sends focus on its stream).

import { useStore } from './state/store';
import { useTerms } from './state/terms';
import * as L from './term/layout';

export function terminalOnScreen(m: string, terminal: string): boolean {
  if (useStore.getState().machineId !== m) return false;
  const layout = useTerms.getState().machines[m]?.layout;
  const tab = layout && L.selectedTab(layout);
  return !!tab && L.tabTerminals(tab).includes(terminal);
}

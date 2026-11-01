import { useStore } from '../state/store';
import { paneCwd, paneTitle, shortPath } from '../lib/herdr';
import { StatusDot } from './StatusDot';
import { PaneActions } from './PaneHeader';
import { t } from '../i18n';

interface Props {
  m: string;
  tabId: string;
  zoomed?: boolean;
}

/** A bar above the shown tab with the focused pane's title, folder and
 * commands (VS Code, changes, Git Graph, split, zoom, close). It sits
 * outside herdr's grid, so it stays visible for a lone pane too, whose
 * header has no border row to sit on and shows only on hover. */
export function PaneToolbar({ m, tabId, zoomed }: Props) {
  const pane = useStore((s) => {
    const id = s.focused?.m === m ? s.focused.pane : undefined;
    return id ? s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === id && p.tab_id === tabId) : undefined;
  });
  const home = useStore((s) => s.machines[m]?.info?.home);
  const readOnly = useStore((s) => s.readOnly);
  if (readOnly) return null;

  const cwd = paneCwd(pane);
  return (
    <div className="pane-toolbar" role="toolbar" aria-label={t('workspace.paneToolbar')}>
      {pane?.agent && <StatusDot status={pane.agent_status} />}
      {pane && <span className="pane-title">{paneTitle(pane)}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
      <PaneActions m={m} paneId={pane?.pane_id} cwd={cwd} zoomed={zoomed} />
    </div>
  );
}

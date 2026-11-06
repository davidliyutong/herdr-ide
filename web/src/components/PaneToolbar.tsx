import { useStore } from '../state/store';
import { paneCwd, shortPath } from '../lib/herdr';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { StatusDot } from './StatusDot';
import { PaneTitle, paneDragStart } from './PaneHeader';
import { PaneActions } from './PaneActions';
import { t } from '../i18n';

interface Props {
  m: string;
  tabId: string;
  zoomed?: boolean;
}

/** The header of a pane without a border row (a lone pane): one
 * row above herdr's grid with the focused pane's title, agent, folder and
 * commands. Its title renames the pane, it has the pane's menu and drags
 * the pane. Workspace shows it only while the shown tab has such a pane;
 * panes with a border row have their own header there, with the same
 * buttons (PaneHeader). */
export function PaneToolbar({ m, tabId, zoomed }: Props) {
  const pane = useStore((s) => {
    const id = s.focused?.m === m ? s.focused.pane : undefined;
    return id ? s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === id && p.tab_id === tabId) : undefined;
  });
  const home = useStore((s) => s.machines[m]?.info?.home);
  const readOnly = useStore((s) => s.readOnly);

  const cwd = paneCwd(pane);
  const id = pane?.pane_id;
  return (
    <div
      className={`pane-toolbar ${pane && !readOnly && !zoomed ? 'draggable' : ''}`}
      role="toolbar"
      aria-label={t('workspace.paneToolbar')}
      onPointerDown={(ev) => id && paneDragStart(ev, m, id, pane, zoomed)}
      onContextMenu={(e) => id && !(e.target as HTMLElement).closest('input') && openMenu(e, paneMenu(m, id, !!zoomed))}
    >
      {pane?.agent && <StatusDot status={pane.agent_status} />}
      {id && <PaneTitle m={m} paneId={id} pane={pane} />}
      {pane?.agent && <span className="pane-agent">{pane.agent}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
      <PaneActions m={m} paneId={id} cwd={cwd} zoomed={zoomed} />
    </div>
  );
}

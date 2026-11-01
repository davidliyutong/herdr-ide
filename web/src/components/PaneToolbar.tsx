import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { paneCwd, shortPath } from '../lib/herdr';
import { actions } from '../actions';
import { keyHint } from '../keymap';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { StatusDot } from './StatusDot';
import { PaneTitle, paneDragStart } from './PaneHeader';
import { PaneGuiButton } from '../gui/GuiMenus';
import { t } from '../i18n';

interface Props {
  m: string;
  tabId: string;
  zoomed?: boolean;
}

/** The shown tab's toolbar: one row above herdr's grid, whatever the number
 * of panes, with the focused pane's title, agent, folder and commands. It
 * is the focused pane's header too: its title renames the pane, it has the
 * pane's menu and drags the pane. Pane headers on herdr's border rows carry
 * no buttons, and a lone pane, which has no border row, no header. */
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

/** A pane's commands: its program windows, its folder in VS Code (folder,
 * changes, Git Graph), split, zoom and close. Without `paneId` (no pane of
 * the shown tab is focused) the buttons are shown disabled. Read-only
 * browsers get the program windows only. */
function PaneActions({ m, paneId, cwd, zoomed }: { m: string; paneId?: string; cwd?: string; zoomed?: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  const off = !paneId;
  const pane = paneId ?? '';
  return (
    <span className="pane-actions">
      {paneId && <PaneGuiButton m={m} pane={paneId} />}
      {!readOnly && (
        <>
          <button
            disabled={off}
            className="code"
            title={t('pane.openCode', { key: keyHint('open_code') })}
            onClick={() => actions.openCode(m, cwd)}
          >
            <SquareCode />
          </button>
          <button
            disabled={off}
            className="code"
            title={t('pane.diff', { key: keyHint('open_diff') })}
            onClick={() => actions.openDiff(m, cwd)}
          >
            <FileDiff />
          </button>
          <button
            disabled={off}
            className="code"
            title={t('pane.gitGraph', { key: keyHint('open_git_graph') })}
            onClick={() => actions.openGitGraph(m, cwd)}
          >
            <GitGraph />
          </button>
          <span className="sep code" />
          <button
            disabled={off}
            className="split"
            title={t('pane.splitRight', { key: keyHint('split_vertical') })}
            onClick={() => actions.split(m, pane, 'right')}
          >
            <Columns2 />
          </button>
          <button
            disabled={off}
            className="split"
            title={t('pane.splitDown', { key: keyHint('split_horizontal') })}
            onClick={() => actions.split(m, pane, 'down')}
          >
            <Rows2 />
          </button>
          <button
            disabled={off}
            title={t(zoomed ? 'pane.restore' : 'pane.zoom', { key: keyHint('zoom') })}
            onClick={() => actions.zoom(m, pane)}
          >
            {zoomed ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            disabled={off}
            className="danger"
            title={t('pane.close', { key: keyHint('close_pane') })}
            onClick={() => actions.closePane(m, pane)}
          >
            <X />
          </button>
        </>
      )}
    </span>
  );
}

import type { CSSProperties } from 'react';
import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { paneCwd, paneTitle, shortPath } from '../lib/herdr';
import { actions } from '../actions';
import { keyHint } from '../keymap';
import { StatusDot } from './StatusDot';
import { InlineEdit } from './InlineEdit';
import { startPaneDrag } from '../paneDrag';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { t } from '../i18n';
import { PaneGuiButton } from '../gui/GuiMenus';

interface Props {
  m: string;
  paneId: string;
  zoomed?: boolean;
  /** Position over herdr's surface, in CSS pixels. */
  style: CSSProperties;
  /** The pane has no border row: the header floats over its top right
   * corner and shows on hover. */
  floating?: boolean;
}

/** The header of one pane, drawn over the top border row herdr draws for
 * it (its title, agent, working directory and actions). */
export function PaneHeader({ m, paneId, zoomed, style, floating }: Props) {
  const pane = useStore((s) => s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === paneId));
  const home = useStore((s) => s.machines[m]?.info?.home);
  const focused = useStore((s) => s.focused?.m === m && s.focused?.pane === paneId);
  const readOnly = useStore((s) => s.readOnly);
  const renaming = useStore((s) => s.renaming?.kind === 'pane' && s.renaming.m === m && s.renaming.id === paneId);
  const setRenaming = useStore((s) => s.setRenaming);

  const cwd = paneCwd(pane);
  const title = pane ? paneTitle(pane) : paneId;
  const onHeaderPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || readOnly || zoomed || (ev.target as HTMLElement).closest('button, input')) return;
    if (pane) startPaneDrag(ev, { m, pane: paneId, tab: pane.tab_id, ws: pane.workspace_id, label: title });
  };
  return (
    <div
      className={`pane-header ${readOnly || zoomed ? '' : 'draggable'} ${focused ? 'focused' : ''} ${floating ? 'floating' : ''}`}
      style={style}
      data-pane-id={paneId}
      data-tab-id={pane?.tab_id}
      data-m={m}
      onPointerDown={onHeaderPointerDown}
      onMouseDown={() => useStore.getState().focusPane({ m, pane: paneId })}
      onContextMenu={(e) => !(e.target as HTMLElement).closest('input') && openMenu(e, paneMenu(m, paneId, !!zoomed))}
    >
      {pane?.agent && <StatusDot status={pane.agent_status} />}
      {renaming ? (
        <InlineEdit
          className="pane-title-edit"
          value={pane?.label ?? title}
          placeholder={t('pane.renamePlaceholder')}
          onDone={(v) => {
            setRenaming(undefined);
            if (v !== undefined && v !== (pane?.label ?? '')) actions.renamePane(m, paneId, v);
          }}
        />
      ) : (
        <span
          className={`pane-title ${readOnly ? '' : 'editable'}`}
          title={readOnly ? title : t('pane.rename')}
          onClick={() => !readOnly && setRenaming({ kind: 'pane', m, id: paneId })}
        >
          {title}
        </span>
      )}
      {pane?.agent && <span className="pane-agent">{pane.agent}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
      <PaneActions m={m} paneId={paneId} cwd={cwd} zoomed={zoomed} />
    </div>
  );
}

/** A pane's commands: its program windows, its folder in VS Code (folder,
 * changes, Git Graph), split, zoom and close. Without `paneId` (no pane of
 * the shown tab is focused) the buttons are shown disabled. */
export function PaneActions({ m, paneId, cwd, zoomed }: { m: string; paneId?: string; cwd?: string; zoomed?: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  const off = !paneId;
  const pane = paneId ?? '';
  return (
    <span className="pane-actions">
      {paneId && <PaneGuiButton m={m} pane={paneId} />}
      {!readOnly && (
        <>
          <button disabled={off} title={t('pane.openCode', { key: keyHint('open_code') })} onClick={() => actions.openCode(m, cwd)}>
            <SquareCode />
          </button>
          <button disabled={off} title={t('pane.diff', { key: keyHint('open_diff') })} onClick={() => actions.openDiff(m, cwd)}>
            <FileDiff />
          </button>
          <button
            disabled={off}
            title={t('pane.gitGraph', { key: keyHint('open_git_graph') })}
            onClick={() => actions.openGitGraph(m, cwd)}
          >
            <GitGraph />
          </button>
          <span className="sep" />
          <button
            disabled={off}
            title={t('pane.splitRight', { key: keyHint('split_vertical') })}
            onClick={() => actions.split(m, pane, 'right')}
          >
            <Columns2 />
          </button>
          <button
            disabled={off}
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

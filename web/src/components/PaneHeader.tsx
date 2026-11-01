import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../state/store';
import { paneCwd, paneTitle, shortPath, type Pane } from '../lib/herdr';
import { actions } from '../actions';
import { StatusDot } from './StatusDot';
import { InlineEdit } from './InlineEdit';
import { startPaneDrag } from '../paneDrag';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { keyHint } from '../keymap';
import { t } from '../i18n';

interface Props {
  m: string;
  paneId: string;
  zoomed?: boolean;
  /** Position over herdr's surface, in CSS pixels. */
  style: CSSProperties;
}

/** The header of one pane, drawn over the top border row herdr draws for it:
 * its title, agent and working directory; dragging it moves the pane, its
 * menu has the pane's commands. The buttons are in the tab's toolbar
 * (PaneToolbar), for the focused pane. A pane without a border row (a lone
 * pane) has no header; the toolbar stands in for it. */
export function PaneHeader({ m, paneId, zoomed, style }: Props) {
  const pane = useStore((s) => s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === paneId));
  const home = useStore((s) => s.machines[m]?.info?.home);
  const focused = useStore((s) => s.focused?.m === m && s.focused?.pane === paneId);
  const readOnly = useStore((s) => s.readOnly);

  const cwd = paneCwd(pane);
  return (
    <div
      className={`pane-header ${readOnly || zoomed ? '' : 'draggable'} ${focused ? 'focused' : ''}`}
      style={style}
      data-pane-id={paneId}
      data-tab-id={pane?.tab_id}
      data-m={m}
      onPointerDown={(ev) => paneDragStart(ev, m, paneId, pane, zoomed)}
      onMouseDown={() => useStore.getState().focusPane({ m, pane: paneId })}
      onContextMenu={(e) => !(e.target as HTMLElement).closest('input') && openMenu(e, paneMenu(m, paneId, !!zoomed))}
    >
      {pane?.agent && <StatusDot status={pane.agent_status} />}
      <PaneTitle m={m} paneId={paneId} pane={pane} />
      {pane?.agent && <span className="pane-agent">{pane.agent}</span>}
      <span className="pane-cwd" title={cwd}>
        <bdi>{shortPath(cwd, home)}</bdi>
      </span>
    </div>
  );
}

/** Starts dragging a pane from its header or the toolbar (not from its
 * buttons or the title being edited). */
export function paneDragStart(ev: React.PointerEvent, m: string, paneId: string, pane: Pane | undefined, zoomed?: boolean) {
  const { readOnly } = useStore.getState();
  if (ev.button !== 0 || readOnly || zoomed || !pane || (ev.target as HTMLElement).closest('button, input')) return;
  startPaneDrag(ev, { m, pane: paneId, tab: pane.tab_id, ws: pane.workspace_id, label: paneTitle(pane) });
}

/** A pane's title; clicking it renames the pane (unless read-only). */
export function PaneTitle({ m, paneId, pane }: { m: string; paneId: string; pane?: Pane }) {
  const readOnly = useStore((s) => s.readOnly);
  const renaming = useStore((s) => s.renaming?.kind === 'pane' && s.renaming.m === m && s.renaming.id === paneId);
  const setRenaming = useStore((s) => s.setRenaming);
  const title = pane ? paneTitle(pane) : paneId;
  if (renaming)
    return (
      <InlineEdit
        className="pane-title-edit"
        value={pane?.label ?? title}
        placeholder={t('pane.renamePlaceholder')}
        onDone={(v) => {
          setRenaming(undefined);
          if (v !== undefined && v !== (pane?.label ?? '')) actions.renamePane(m, paneId, v);
        }}
      />
    );
  return (
    <span
      className={`pane-title ${readOnly ? '' : 'editable'}`}
      title={readOnly ? title : t('pane.rename')}
      onClick={() => !readOnly && setRenaming({ kind: 'pane', m, id: paneId })}
    >
      {title}
    </span>
  );
}

/** A round close button at a pane's top right corner, over the grid; it
 * shows while the pointer is over the pane (`shown`). Clicking it closes
 * the pane, asking first while an agent works in it, and leaves keyboard
 * focus in the terminal. */
export function PaneCloseButton({ m, paneId, style, shown }: { m: string; paneId: string; style: CSSProperties; shown: boolean }) {
  return (
    <button
      className={`pane-close ${shown ? 'shown' : ''}`}
      style={style}
      tabIndex={-1}
      aria-hidden={!shown}
      title={t('pane.close', { key: keyHint('close_pane') })}
      data-pane-id={paneId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => actions.closePane(m, paneId)}
    >
      <X />
    </button>
  );
}

import { useCallback } from 'react';
import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { paneCwd, paneTitle, shortPath } from '../lib/herdr';
import { TerminalView } from './TerminalView';
import { registerTerm } from '../terminal/registry';
import { actions } from '../actions';
import { handleKey, keyHint } from '../keymap';
import { pathLinkProvider } from '../terminal/links';
import { uploadPasted } from '../lib/files';
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
}

export function PaneView({ m, paneId, zoomed }: Props) {
  const pane = useStore((s) => s.machines[m]?.snapshot?.panes.find((p) => p.pane_id === paneId));
  const home = useStore((s) => s.machines[m]?.info?.home);
  const focused = useStore((s) => s.focused?.m === m && s.focused?.pane === paneId);
  const focusPane = useStore((s) => s.focusPane);
  const readOnly = useStore((s) => s.readOnly);
  const renaming = useStore((s) => s.renaming?.kind === 'pane' && s.renaming.m === m && s.renaming.id === paneId);
  const setRenaming = useStore((s) => s.setRenaming);

  const onFocus = useCallback(() => focusPane({ m, pane: paneId }), [focusPane, m, paneId]);
  const register = useCallback((c: Parameters<typeof registerTerm>[1]) => registerTerm(`${m}|${paneId}`, c), [m, paneId]);
  const linkProvider = useCallback(
    (term: Parameters<typeof pathLinkProvider>[0]) =>
      pathLinkProvider(term, () => {
        const p = useStore.getState().machines[m]?.snapshot?.panes.find((x) => x.pane_id === paneId);
        return { m, cwd: paneCwd(p), home };
      }),
    [m, paneId, home],
  );
  const onPasteFiles = useCallback(
    (files: File[]) => {
      return uploadPasted(m, files);
    },
    [m, paneId],
  );

  const cwd = paneCwd(pane);
  const title = pane ? paneTitle(pane) : paneId;
  const onHeaderPointerDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || readOnly || zoomed || (ev.target as HTMLElement).closest('button, input')) return;
    if (pane) startPaneDrag(ev, { m, pane: paneId, tab: pane.tab_id, ws: pane.workspace_id, label: title });
  };
  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={onFocus} data-pane-id={paneId} data-tab-id={pane?.tab_id} data-m={m}>
      <div
        className={`pane-header ${readOnly || zoomed ? '' : 'draggable'}`}
        onPointerDown={onHeaderPointerDown}
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
        <span className="pane-actions">
          <PaneGuiButton m={m} pane={paneId} />
          {!readOnly && (
            <>
              <button title={t('pane.openCode', { key: keyHint('open_code') })} onClick={() => actions.openCode(m, cwd)}>
                <SquareCode />
              </button>
              <button title={t('pane.diff', { key: keyHint('open_diff') })} onClick={() => actions.openDiff(m, cwd)}>
                <FileDiff />
              </button>
              <button title={t('pane.gitGraph', { key: keyHint('open_git_graph') })} onClick={() => actions.openGitGraph(m, cwd)}>
                <GitGraph />
              </button>
              <span className="sep" />
              <button title={t('pane.splitRight', { key: keyHint('split_vertical') })} onClick={() => actions.split(m, paneId, 'right')}>
                <Columns2 />
              </button>
              <button title={t('pane.splitDown', { key: keyHint('split_horizontal') })} onClick={() => actions.split(m, paneId, 'down')}>
                <Rows2 />
              </button>
              <button title={t(zoomed ? 'pane.restore' : 'pane.zoom', { key: keyHint('zoom') })} onClick={() => actions.zoom(m, paneId)}>
                {zoomed ? <Minimize2 /> : <Maximize2 />}
              </button>
              <button
                className="danger"
                title={t('pane.close', { key: keyHint('close_pane') })}
                onClick={() => actions.closePane(m, paneId)}
              >
                <X />
              </button>
            </>
          )}
        </span>
      </div>
      <div className="pane-body">
        <TerminalView
          m={m}
          pane={paneId}
          mode={readOnly ? 'observe' : 'auto'}
          active={focused}
          onFocus={onFocus}
          onKey={handleKey}
          registerController={register}
          linkProvider={linkProvider}
          onPasteFiles={onPasteFiles}
        />
      </div>
    </div>
  );
}

import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { actions } from '../actions';
import { keyHint } from '../keymap';
import { PaneGuiButton } from '../gui/GuiMenus';
import { t } from '../i18n';

/** A pane's commands: its program windows, its folder in VS Code (folder,
 * changes, Git Graph), split, zoom and close. Without `paneId` (no pane of
 * the shown tab is focused) the buttons are shown disabled. Read-only
 * browsers get the program windows only. Over the grid (`keepFocus`), a
 * press leaves keyboard focus in the terminal. */
export function PaneActions({
  m,
  paneId,
  cwd,
  zoomed,
  keepFocus,
}: {
  m: string;
  paneId?: string;
  cwd?: string;
  zoomed?: boolean;
  keepFocus?: boolean;
}) {
  const readOnly = useStore((s) => s.readOnly);
  const off = !paneId;
  const pane = paneId ?? '';
  return (
    <span
      className="pane-actions"
      onMouseDown={keepFocus ? (e) => (e.target as HTMLElement).closest('button') && e.preventDefault() : undefined}
    >
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
            className="zoom"
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

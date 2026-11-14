import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { actions } from '../actions';
import { keyHint } from '../keymap';
import { PaneGuiButton } from '../gui/GuiMenus';
import { t } from '../i18n';

/** A pane's commands: its program windows, its folder in VS Code (folder,
 * changes, Git Graph), split, zoom and close. Read-only pages get the
 * program windows only. A press leaves the keyboard in the terminal. */
export function PaneActions({ m, terminal, cwd, zoomed }: { m: string; terminal: string; cwd?: string; zoomed?: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  return (
    <span className="pane-actions" onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
      <PaneGuiButton m={m} terminal={terminal} />
      {!readOnly && (
        <>
          <button className="code" title={t('pane.openCode', { key: keyHint('code.open') })} onClick={() => actions.openCode(m, cwd)}>
            <SquareCode />
          </button>
          <button className="code" title={t('pane.diff', { key: keyHint('code.diff') })} onClick={() => actions.openDiff(m, cwd)}>
            <FileDiff />
          </button>
          <button
            className="code"
            title={t('pane.gitGraph', { key: keyHint('code.gitGraph') })}
            onClick={() => actions.openGitGraph(m, cwd)}
          >
            <GitGraph />
          </button>
          <span className="sep code" />
          <button
            className="split"
            title={t('pane.splitRight', { key: keyHint('pane.splitRight') })}
            onClick={() => void actions.split(m, terminal, 'right')}
          >
            <Columns2 />
          </button>
          <button
            className="split"
            title={t('pane.splitDown', { key: keyHint('pane.splitDown') })}
            onClick={() => void actions.split(m, terminal, 'down')}
          >
            <Rows2 />
          </button>
          <button
            className="zoom"
            title={t(zoomed ? 'pane.restore' : 'pane.zoom', { key: keyHint('pane.zoom') })}
            onClick={() => actions.zoom(m, terminal)}
          >
            {zoomed ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            className="danger"
            title={t('pane.close', { key: keyHint('pane.close') })}
            onClick={() => void actions.closePane(m, terminal)}
          >
            <X />
          </button>
        </>
      )}
    </span>
  );
}

import { Columns2, FileDiff, GitGraph, Maximize2, Minimize2, Rows2, SquareCode, X } from 'lucide-react';
import { useStore } from '../state/store';
import { actions } from '../actions';
import { withKey } from '../keymap';
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
          <button
            className="code"
            title={withKey(t('command.code.open'), 'code.open')}
            aria-label={t('command.code.open')}
            onClick={() => actions.openCode(m, cwd)}
          >
            <SquareCode />
          </button>
          <button
            className="code"
            title={withKey(t('command.code.diff'), 'code.diff')}
            aria-label={t('command.code.diff')}
            onClick={() => actions.openDiff(m, cwd)}
          >
            <FileDiff />
          </button>
          <button
            className="code"
            title={withKey(t('command.code.gitGraph'), 'code.gitGraph')}
            aria-label={t('command.code.gitGraph')}
            onClick={() => actions.openGitGraph(m, cwd)}
          >
            <GitGraph />
          </button>
          <span className="sep code" />
          <button
            className="split"
            title={withKey(t('command.pane.splitRight'), 'pane.splitRight')}
            aria-label={t('command.pane.splitRight')}
            onClick={() => void actions.split(m, terminal, 'right')}
          >
            <Columns2 />
          </button>
          <button
            className="split"
            title={withKey(t('command.pane.splitDown'), 'pane.splitDown')}
            aria-label={t('command.pane.splitDown')}
            onClick={() => void actions.split(m, terminal, 'down')}
          >
            <Rows2 />
          </button>
          <button
            className="zoom"
            title={withKey(t(zoomed ? 'menu.restorePane' : 'command.pane.zoom'), 'pane.zoom')}
            aria-label={t(zoomed ? 'menu.restorePane' : 'command.pane.zoom')}
            onClick={() => actions.zoom(m, terminal)}
          >
            {zoomed ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            className="danger"
            title={withKey(t('command.pane.close'), 'pane.close')}
            aria-label={t('command.pane.close')}
            onClick={() => void actions.closePane(m, terminal)}
          >
            <X />
          </button>
        </>
      )}
    </span>
  );
}

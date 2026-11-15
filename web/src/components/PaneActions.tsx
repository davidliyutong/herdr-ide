import { Columns2, Ellipsis, FileDiff, GitGraph, Maximize2, Minimize2, RotateCw, Rows2, X } from 'lucide-react';
import { useStore } from '../state/store';
import { terms } from '../state/terms';
import * as L from '../term/layout';
import { actions } from '../actions';
import { withKey } from '../keymap';
import { PaneGuiButton } from '../gui/GuiMenus';
import { openMenu } from '../contextMenu';
import { paneMenu } from '../menus';
import { CodeIcon } from './icons';
import { t } from '../i18n';

/** A pane's commands: a terminal's program windows and its folder in VS Code
 * (folder, changes, Git Graph), reloading VS Code, then split, zoom, the
 * pane's menu and close. A header too narrow for them all hides the less
 * important ones (styles.css) and shows the menu's button, which has them;
 * close always stays. Read-only pages get the program windows only. A press
 * leaves the keyboard where it is. */
export function PaneActions({ m, pane, leaf, zoomed }: { m: string; pane: string; leaf: L.Leaf; zoomed?: boolean }) {
  const readOnly = useStore((s) => s.readOnly);
  const terminal = L.isTerminalLeaf(leaf);
  return (
    <span className="pane-actions" onMouseDown={(e) => (e.target as HTMLElement).closest('button') && e.preventDefault()}>
      {terminal && <PaneGuiButton m={m} terminal={pane} />}
      {!readOnly && (
        <>
          {terminal && (
            <>
              <button
                className="code"
                title={withKey(t('command.code.open'), 'code.open')}
                aria-label={t('command.code.open')}
                onClick={() => void actions.openCode(m, terms.directory(m, pane))}
              >
                <CodeIcon />
              </button>
              <button
                className="code"
                title={withKey(t('command.code.diff'), 'code.diff')}
                aria-label={t('command.code.diff')}
                onClick={() => void actions.openDiff(m, terms.directory(m, pane), pane)}
              >
                <FileDiff />
              </button>
              <button
                className="code"
                title={withKey(t('command.code.gitGraph'), 'code.gitGraph')}
                aria-label={t('command.code.gitGraph')}
                onClick={() => void actions.openGitGraph(m, terms.directory(m, pane), pane)}
              >
                <GitGraph />
              </button>
              <span className="sep code" />
            </>
          )}
          {L.isCodeLeaf(leaf) && (
            <button
              className="code"
              title={t('code.reload')}
              aria-label={t('code.reload')}
              onClick={() => actions.reloadCode(m, leaf.code.id)}
            >
              <RotateCw />
            </button>
          )}
          <button
            className="split"
            title={withKey(t('command.pane.splitRight'), 'pane.splitRight')}
            aria-label={t('command.pane.splitRight')}
            onClick={() => void actions.split(m, pane, 'right')}
          >
            <Columns2 />
          </button>
          <button
            className="split"
            title={withKey(t('command.pane.splitDown'), 'pane.splitDown')}
            aria-label={t('command.pane.splitDown')}
            onClick={() => void actions.split(m, pane, 'down')}
          >
            <Rows2 />
          </button>
          <button
            className="zoom"
            title={withKey(t(zoomed ? 'menu.restorePane' : 'command.pane.zoom'), 'pane.zoom')}
            aria-label={t(zoomed ? 'menu.restorePane' : 'command.pane.zoom')}
            onClick={() => actions.zoom(m, pane)}
          >
            {zoomed ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            className="more"
            title={t('pane.more')}
            aria-label={t('pane.more')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {}, stopPropagation: () => {} }, paneMenu(m, pane));
            }}
          >
            <Ellipsis />
          </button>
          <button
            className="danger"
            title={withKey(t('command.pane.close'), 'pane.close')}
            aria-label={t('command.pane.close')}
            onClick={() => void actions.closePane(m, pane)}
          >
            <X />
          </button>
        </>
      )}
    </span>
  );
}

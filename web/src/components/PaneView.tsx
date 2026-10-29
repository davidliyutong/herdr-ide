import { useCallback } from 'react';
import { useStore } from '../state/store';
import { paneCwd, paneTitle, shortPath } from '../lib/herdr';
import { TerminalView } from './TerminalView';
import { registerTerm } from '../terminal/registry';
import { actions } from '../actions';
import { handleKey, keyHint } from '../keymap';
import { pathLinkProvider } from '../terminal/links';
import { uploadPasted } from '../lib/files';
import { StatusDot } from './StatusDot';
import { t } from '../i18n';

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
  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={onFocus}>
      <div className="pane-header">
        {pane?.agent && <StatusDot status={pane.agent_status} />}
        <span className="pane-title">{pane ? paneTitle(pane) : paneId}</span>
        {pane?.agent && <span className="pane-agent">{pane.agent}</span>}
        <span className="pane-cwd" title={cwd}>
          <bdi>{shortPath(cwd, home)}</bdi>
        </span>
        <span className="pane-actions">
          {!readOnly && (
            <>
              <button title={t('pane.openCode')} onClick={() => actions.openCode(m, cwd)}>
                ⌘
              </button>
              <button title={t('pane.diff')} onClick={() => actions.openDiff(m, cwd)}>
                ±
              </button>
              <button title={t('pane.gitGraph')} onClick={() => actions.openGitGraph(m, cwd)}>
                ⑂
              </button>
            </>
          )}
          <span className="sep" />
          <button title={t('pane.splitRight', { key: keyHint('split_vertical') })} onClick={() => actions.split(m, paneId, 'right')}>
            ▥
          </button>
          <button title={t('pane.splitDown', { key: keyHint('split_horizontal') })} onClick={() => actions.split(m, paneId, 'down')}>
            ▤
          </button>
          <button title={t(zoomed ? 'pane.restore' : 'pane.zoom', { key: keyHint('zoom') })} onClick={() => actions.zoom(m, paneId)}>
            {zoomed ? '⤡' : '⤢'}
          </button>
          <button title={t('pane.close', { key: keyHint('close_pane') })} onClick={() => actions.closePane(m, paneId)}>
            ✕
          </button>
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

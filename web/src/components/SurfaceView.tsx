import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { usePrefs } from '../prefs';
import { appearanceOf } from '../appearance';
import { handleKey } from '../keymap';
import { uploadPasted } from '../lib/files';
import { paneCwd, type LayoutExport } from '../lib/herdr';
import { SurfaceController } from '../surface/controller';
import { grid, setHostColors, setView, takeOver, useSurface } from '../surface/session';
import type { SurfaceSplit } from '../surface/protocol';
import { setSurfaceFocus } from '../terminal/registry';
import { whenTermFont } from '../terminal/fonts';
import { PaneHeader } from './PaneHeader';
import { t, type MessageKey } from '../i18n';

interface Props {
  m: string;
  tabId: string;
  layout?: LayoutExport;
}

/** The shown tab, as herdr renders it: one canvas for the tab's panes,
 * borders and split lines, with each pane's header over its top border. */
export function SurfaceView({ m, tabId, layout }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ctlRef = useRef<SurfaceController>(undefined);
  const prefs = usePrefs((s) => s.prefs);
  const ownership = useSurface((s) => s.ownership);
  const status = useSurface((s) => s.status);
  const meta = useSurface((s) => s.meta);
  const shown = useSurface((s) => s.shown);
  const bell = useSurface((s) => s.bell);
  const clipFailed = useSurface((s) => s.clipFailed);
  const fulls = useSurface((s) => s.fulls);
  const [cell, setCell] = useState({ cols: 0, rows: 0, cw: 8, ch: 16 });
  const [splitDrag, setSplitDrag] = useState<{ split: SurfaceSplit; ratio: number }>();
  const [title, setTitle] = useState('');
  const [flash, setFlash] = useState(false);
  const focusedPane = useStore((s) => (s.focused?.m === m ? s.focused.pane : undefined));
  const live = useRef({ m, tabId, focusedPane });
  live.current = { m, tabId, focusedPane };

  useEffect(() => {
    const ctl = new SurfaceController(
      hostRef.current!,
      canvasRef.current!,
      inputRef.current!,
      {
        m: () => live.current.m,
        focusedPane: () => live.current.focusedPane,
        focusPane: (pane) => useStore.getState().focusPane({ m: live.current.m, pane }),
        appKey: (ev) => handleKey(ev),
        readOnly: () => useStore.getState().readOnly,
        onPasteFiles: (files) => uploadPasted(live.current.m, files),
        linkContext: (pane) => {
          const s = useStore.getState();
          const st = s.machines[live.current.m];
          return { m: live.current.m, cwd: paneCwd(st?.snapshot?.panes.find((p) => p.pane_id === pane)), home: st?.info?.home };
        },
        onSize: (cols, rows, cw, ch) => setCell({ cols, rows, cw, ch }),
        onSplitDrag: (split, ratio) => setSplitDrag(ratio === undefined ? undefined : { split, ratio }),
        setTitle,
      },
      appearanceOf(prefs),
    );
    ctlRef.current = ctl;
    setSurfaceFocus(() => ctl.focus());
    ctl.focus();
    return () => {
      setSurfaceFocus(undefined);
      ctl.dispose();
      ctlRef.current = undefined;
    };
    // One controller for the component's life; changing values are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Appearance: colors, font and size; herdr learns the colors (OSC 10/11/4).
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    const a = appearanceOf(prefs);
    ctl.setAppearance(a);
    setHostColors(ctl.hostColors());
    return whenTermFont(a.fontWeight, () => ctl.fontChanged());
  }, [prefs]);

  // Showing a tab moves the UI's focus into it (herdr's focused pane of the
  // tab, else its first), so keys and the "seen" marking apply to what is shown.
  useEffect(() => {
    const s = useStore.getState();
    const panes = (s.machines[m]?.snapshot?.panes ?? []).filter((p) => p.tab_id === tabId).map((p) => p.pane_id);
    if (s.focused?.m === m && panes.includes(s.focused.pane)) return;
    const pane = layout?.focused_pane_id && panes.includes(layout.focused_pane_id) ? layout.focused_pane_id : panes[0];
    if (pane) s.focusPane({ m, pane });
  }, [m, tabId, layout?.focused_pane_id]);

  // What herdr should render: this machine and tab, at this size.
  // herdr's focused pane follows the UI's when it is in the shown tab.
  const pane = useStore((s) =>
    focusedPane && s.machines[m]?.snapshot?.panes.some((p) => p.pane_id === focusedPane && p.tab_id === tabId) ? focusedPane : undefined,
  );
  useEffect(() => {
    if (!cell.cols || !cell.rows) return;
    setView({ m, tab: tabId, pane, cols: cell.cols, rows: cell.rows, cw: cell.cw, ch: cell.ch });
  }, [m, tabId, pane, cell]);

  useEffect(() => ctlRef.current?.setMeta(meta && meta.m === m ? meta : undefined), [meta, m]);

  useEffect(() => {
    if (!bell) return;
    setFlash(true);
    const id = setTimeout(() => setFlash(false), 150);
    return () => clearTimeout(id);
  }, [bell]);

  useEffect(() => {
    if (clipFailed) useStore.getState().toast(t('surface.clipboardBlocked'));
  }, [clipFailed]);

  const dpr = window.devicePixelRatio || 1;
  const cw = cell.cw / dpr;
  const ch = cell.ch / dpr;
  const current = fulls > 0 && meta && meta.m === m && shown?.m === m && shown.tab === tabId && grid.ready;
  const headers = useMemo(() => {
    if (!current || !meta) return [];
    return meta.panes.map((p) => {
      const border = p.inner.y > p.rect.y;
      const style = border
        ? { left: (p.rect.x + 1) * cw, top: p.rect.y * ch, width: Math.max(0, p.rect.w - 2) * cw, height: ch }
        : { left: p.inner.x * cw, top: p.inner.y * ch, width: p.inner.w * cw, height: ch };
      return {
        id: p.id,
        style,
        floating: !border,
        box: { left: p.rect.x * cw, top: p.rect.y * ch, width: p.rect.w * cw, height: p.rect.h * ch },
      };
    });
  }, [current, meta, cw, ch]);

  let overlay: { text: string; detail?: string; action?: { label: string; run(): void }; soft?: boolean } | undefined;
  if (ownership === 'busy') overlay = { text: t('surface.busy'), action: { label: t('surface.takeOver'), run: takeOver } };
  else if (ownership === 'taken_over') overlay = { text: t('surface.takenOver'), action: { label: t('surface.takeBack'), run: takeOver } };
  else if (ownership === 'pending') overlay = { text: t('surface.connecting') };
  else if (status?.m === m && status.ev === 'error')
    overlay = { text: t(`surface.error.${status.code ?? 'disconnected'}` as MessageKey), detail: status.detail };
  else if (!current) overlay = { text: t('surface.connecting'), soft: true };

  return (
    <div className={`surface-host ${flash ? 'bell' : ''}`} ref={hostRef} title={title}>
      <canvas ref={canvasRef} className="surface-canvas" />
      <textarea
        ref={inputRef}
        className="surface-input"
        aria-label={t('surface.input')}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={0}
      />
      {headers.map((h) => (
        <div key={`box-${h.id}`} className="pane-area" style={h.box} data-pane-id={h.id} data-tab-id={tabId} data-m={m} />
      ))}
      {headers.map((h) => (
        <PaneHeader key={h.id} m={m} paneId={h.id} zoomed={layout?.zoomed} style={h.style} floating={h.floating} />
      ))}
      {splitDrag && (
        <div
          className={`split-ghost ${splitDrag.split.vertical ? 'v' : 'h'}`}
          style={
            splitDrag.split.vertical
              ? {
                  left: splitDrag.split.area.x * cw,
                  width: splitDrag.split.area.w * cw,
                  top: (splitDrag.split.area.y + splitDrag.ratio * splitDrag.split.area.h) * ch,
                }
              : {
                  top: splitDrag.split.area.y * ch,
                  height: splitDrag.split.area.h * ch,
                  left: (splitDrag.split.area.x + splitDrag.ratio * splitDrag.split.area.w) * cw,
                }
          }
        />
      )}
      {overlay && (
        <div className={`surface-overlay ${overlay.soft ? 'soft' : ''}`}>
          <span>{overlay.text}</span>
          {overlay.detail && <span className="surface-overlay-msg">{overlay.detail}</span>}
          {overlay.action && <button onClick={overlay.action.run}>{overlay.action.label}</button>}
        </div>
      )}
    </div>
  );
}

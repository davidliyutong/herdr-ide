import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, MonitorUp, MonitorX } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store';
import { t } from '../i18n';
import { guiKey, openGuiWindow, paneWindows, useGui, type GuiWindow } from './state';
import { enableGui } from './enable';

interface Entry {
  m: string;
  w: GuiWindow;
}

/** A button listing program windows; one window opens directly. */
function WindowsButton({ entries, className, label }: { entries: Entry[]; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const unseen = useGui((g) => entries.some((e) => g.unseen[guiKey(e.m, e.w.id)]));
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (entries.length === 0) return null;
  const title = (e: Entry) => e.w.title || t('gui.untitled');
  const machines = new Set(entries.map((e) => e.m));
  const openOne = (e: Entry) => {
    setOpen(false);
    if (!openGuiWindow(e.m, e.w)) useStore.getState().toast(t('gui.popupBlocked'));
  };
  return (
    <span className="gui-menu-anchor" ref={ref}>
      <button
        className={`${className ?? ''} ${unseen ? 'attention' : ''}`}
        title={entries.length === 1 ? t('gui.openTitle', { title: title(entries[0]) }) : t('gui.windows')}
        onClick={() => (entries.length === 1 ? openOne(entries[0]) : setOpen(!open))}
      >
        <AppWindow />
        {(label || entries.length > 1) && <span className="gui-count">{label ?? entries.length}</span>}
      </button>
      {open && (
        <div className="gui-menu" role="menu">
          {entries.map((e) => (
            <div key={guiKey(e.m, e.w.id)} className="gui-menu-item" role="menuitem" onClick={() => openOne(e)}>
              <AppWindow />
              <span className="ellipsis">{title(e)}</span>
              {machines.size > 1 && <span className="muted small">{labels[e.m] ?? e.m}</span>}
              <span className="muted small">
                {e.w.w}×{e.w.h}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/** Pane header button for the windows of programs started in the pane. */
export function PaneGuiButton({ m, pane }: { m: string; pane: string }) {
  const windows = useGui(useShallow((g) => paneWindows(g, m, pane)));
  const entries = useMemo(() => windows.map((w) => ({ m, w })), [windows, m]);
  return <WindowsButton entries={entries} />;
}

/** Status bar entry: every program window, and displays being prepared or
 * failing. */
export function GuiTray() {
  const machines = useGui((g) => g.machines);
  const entries = useMemo(() => Object.values(machines).flatMap((st) => st.windows.map((w) => ({ m: st.m, w }))), [machines]);
  const notes = useMemo(
    () => Object.values(machines).filter((st) => st.phase === 'installing' || st.phase === 'starting' || st.phase === 'error'),
    [machines],
  );
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  return (
    <>
      {notes.map((n) => (
        <span key={n.m} className={`gui-note ${n.phase}`} title={n.error}>
          {n.phase === 'error' && <MonitorX />}
          {t(`gui.phase.${n.phase}` as 'gui.phase.error', { m: labels[n.m] ?? n.m })}
        </span>
      ))}
      <WindowsButton entries={entries} className="gui-tray" label={String(entries.length)} />
    </>
  );
}

/** A machine's display state, for the settings dialog. */
export function GuiMachineStatus({ m }: { m: string }) {
  const st = useGui((g) => g.machines[m]);
  if (!st) return null;
  return (
    <span className={`gui-state ${st.phase}`} title={st.error}>
      {t(`gui.state.${st.phase}` as 'gui.state.ready')}
      {st.gpu && st.phase === 'ready' && ' · GPU'}
    </span>
  );
}

/** Enables program windows in the machine's open panes. */
export function GuiEnableButton({ m, disabled }: { m: string; disabled?: boolean }) {
  const ready = useGui((g) => g.machines[m]?.phase === 'ready');
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="icon"
      title={t('gui.enableOpen')}
      aria-label={t('gui.enableOpen')}
      disabled={disabled || !ready || busy}
      onClick={async () => {
        setBusy(true);
        await enableGui(m);
        setBusy(false);
      }}
    >
      <MonitorUp />
    </button>
  );
}

// VS Code panes: the layer of their iframes over the panes (CodeLayer, once
// per page) and the body of each VS Code pane on screen (CodeSlot), which
// the layer places its iframe over. See codeFrames.ts.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Power } from 'lucide-react';
import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import { registerPane } from '../state/panes';
import * as L from '../term/layout';
import {
  codeUrl,
  focusFrame,
  frameKey,
  frameLoaded,
  mountFrame,
  nextFrames,
  place,
  placeAll,
  setStopped,
  showSlot,
  useFrames,
  type Frame,
} from '../codeFrames';
import { t } from '../i18n';
import { useSettings } from '../settings';
import { setPluginSwitch, usePluginOn } from '../plugins/registry';
import { detachedRecordForPane, isDetachedWindow, useDetachedTabs } from '../detachedWindow';

type Machines = ReturnType<typeof useStore.getState>['machines'];
let usableOf: { machines?: Machines; list: string } = { list: '' };

/** The ids of the machines that can have VS Code (the hub lists them and
 * they are not disabled), one per line: worked out again only when the
 * machines change, not on every change of the store. */
function usableMachines(s: { machines: Machines }): string {
  if (s.machines !== usableOf.machines) {
    const list = Object.values(s.machines)
      .filter((x) => x.status !== 'disabled')
      .map((x) => x.id)
      .sort()
      .join('\n');
    usableOf = { machines: s.machines, list };
  }
  return usableOf.list;
}

type Layouts = ReturnType<typeof useTerms.getState>['machines'];
let viewsOf: { machines?: Layouts; list: string } = { list: '' };

/** The VS Code views of every layout read, as machine|id, one per line, and
 * the machines whose layout was read, as machine|: worked out again only
 * when a layout changes. */
function codeViewsOfLayouts(s: { machines: Layouts }): string {
  const changed =
    !viewsOf.machines ||
    Object.keys(s.machines).length !== Object.keys(viewsOf.machines).length ||
    Object.entries(s.machines).some(([m, mt]) => viewsOf.machines![m]?.layout !== mt.layout);
  if (changed) {
    const out: string[] = [];
    for (const [m, mt] of Object.entries(s.machines)) {
      if (!mt.layout) continue;
      out.push(`${m}|`);
      for (const ws of mt.layout.workspaces) for (const v of L.codeViews(ws)) out.push(frameKey(m, v.view.id));
    }
    viewsOf = { machines: s.machines, list: out.sort().join('\n') };
  }
  return viewsOf.list;
}

/** Why a machine's VS Code panes show no VS Code: the VS Code plugin off,
 * read-only mode, the machine disabled, or code-server stopped from this
 * page. */
export type CodeOff = 'plugin' | 'readOnly' | 'disabled' | 'stopped';

export function useCodeOff(m: string): CodeOff | undefined {
  const on = usePluginOn('vscode');
  const readOnly = useStore((s) => s.readOnly);
  const disabled = useStore((s) => s.machines[m]?.status === 'disabled');
  const stopped = useFrames((s) => !!s.stopped[m]);
  return !on ? 'plugin' : readOnly ? 'readOnly' : disabled ? 'disabled' : stopped ? 'stopped' : undefined;
}

/** The iframes of the VS Code panes, over the panes; once per page. */
export function CodeLayer() {
  const frames = useFrames((s) => s.frames);
  const shown = useFrames((s) => s.shown);
  const stopped = useFrames((s) => s.stopped);
  const readOnly = useStore((s) => s.readOnly);
  const on = usePluginOn('vscode');
  const usableList = useStore(usableMachines);
  const viewsList = useTerms(codeViewsOfLayouts);
  const usable = useMemo(() => new Set(usableList ? usableList.split('\n') : []), [usableList]);
  const views = useMemo(() => new Set(viewsList ? viewsList.split('\n') : []), [viewsList]);
  const detachedRecords = useDetachedTabs((s) => s.records);
  const detachedWin = isDetachedWindow();

  useEffect(() => {
    // Disabled and removed machines have no code-server, nor any with the
    // plugin off.
    const off = (m: string) => !on || readOnly || !usable.has(m) || !!stopped[m];
    // A view is alive while its machine's layout holds it and it has not moved
    // to a detached window; unknown while that layout is not read (away).
    const alive = (fr: Frame) => {
      if (!detachedWin && detachedRecordForPane(fr.m, L.codeKey(fr.id), detachedRecords)) return false;
      return views.has(`${fr.m}|`) ? views.has(frameKey(fr.m, fr.id)) : undefined;
    };
    const update = () => {
      const s = useFrames.getState();
      const next = nextFrames(s.frames, s.shown, alive, off, Date.now());
      if (next !== s.frames) useFrames.setState({ frames: next });
    };
    update();
    // Frames off screen expire.
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [shown, stopped, readOnly, usable, views, on, detachedRecords, detachedWin]);

  // Frames are placed relative to the layer: placed again when the window
  // or the layer (the workspace's area, as the sidebar changes) resizes.
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.addEventListener('resize', placeAll);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(placeAll);
    if (layer.current) ro?.observe(layer.current);
    return () => {
      window.removeEventListener('resize', placeAll);
      ro?.disconnect();
    };
  }, []);

  return (
    <div className="code-layer" ref={layer}>
      {Object.entries(frames).map(([k, fr]) => (
        <CodeFrame key={`${k}#${fr.load}`} k={k} frame={fr} />
      ))}
    </div>
  );
}

function CodeFrame({ k, frame }: { k: string; frame: Frame }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => mountFrame(k, ref.current!), [k]);
  return (
    <iframe
      ref={ref}
      className="code-frame"
      data-frame={k}
      data-m={frame.m}
      src={codeUrl(frame.m, frame.folder)}
      title={`VS Code ${frame.folder}`}
      allow="clipboard-read; clipboard-write"
      onLoad={() => ref.current && frameLoaded(k, ref.current)}
    />
  );
}

/** The body of a VS Code pane on screen: the layer places the pane's
 * window over it, or it says why there is none. */
export function CodeSlot({ m, pane, view }: { m: string; pane: string; view: L.CodeView }) {
  const ref = useRef<HTMLDivElement>(null);
  const off = useCodeOff(m);
  const k = frameKey(m, view.id);
  const folder = view.folder;
  useLayoutEffect(() => (off ? undefined : showSlot({ m, id: view.id, folder }, ref.current!)), [m, view.id, folder, off]);
  // The pane may have moved without changing its size.
  useLayoutEffect(() => place(k));
  useEffect(() => registerPane(m, pane, { focus: () => focusFrame(k) }), [m, pane, k]);
  return (
    <div className="code-slot" ref={ref} data-frame={k}>
      {off && <CodeOffNote m={m} off={off} />}
    </div>
  );
}

function CodeOffNote({ m, off }: { m: string; off: CodeOff }) {
  const label = useStore((s) => s.machines[m]?.label ?? m);
  const readOnly = useStore((s) => s.readOnly);
  // This kind of client's switch; a browser's asks to accept the risk.
  const browser = useSettings((s) => s.client) === 'browser';
  if (off === 'plugin')
    return (
      <div className="code-off">
        <span>{t(browser ? 'code.pluginOffBrowser' : 'code.pluginOff')}</span>
        {!readOnly && (
          <button onClick={() => void setPluginSwitch('vscode', true)}>
            <Power /> {t(browser ? 'code.pluginTurnOnBrowser' : 'code.pluginTurnOn')}
          </button>
        )}
      </div>
    );
  if (off === 'stopped')
    return (
      <div className="code-off">
        <span>{t('code.stopped', { machine: label })}</span>
        <button onClick={() => setStopped(m, false)}>
          <Power /> {t('code.start')}
        </button>
      </div>
    );
  return (
    <div className="code-off">
      <span>{off === 'readOnly' ? t('code.readOnly') : t('code.machineDisabled', { machine: label })}</span>
    </div>
  );
}

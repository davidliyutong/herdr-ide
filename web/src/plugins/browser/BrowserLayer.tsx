// Browser panes' frames: the layer of their elements over the panes
// (BrowserLayer, once per page while the plugin is on) and the body of
// each browser pane on screen (BrowserSlot), which the layer places its
// element over. See frames.ts.

import { createElement, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { terms, useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { desktopShell } from '../../shell';
import {
  forgetFrames,
  frameElement,
  frameKey,
  focusedFrame,
  isWebview,
  mountFrame,
  nextFrames,
  place,
  placeAll,
  reportNav,
  showPage,
  showSlot,
  useFrames,
  type Frame,
  type Page,
} from './frames';
import { browserApi, errorText, meantUrl, noteForward, openPopup } from './api';
import './browser.css';

type Layouts = ReturnType<typeof useTerms.getState>['machines'];
let viewsOf: { machines?: Layouts; list: string } = { list: '' };

/** The browser views of every layout read, as machine|id, one per line,
 * and the machines whose layout was read, as machine|: worked out again
 * only when a layout changes. */
function browserViewsOfLayouts(s: { machines: Layouts }): string {
  const changed =
    !viewsOf.machines ||
    Object.keys(s.machines).length !== Object.keys(viewsOf.machines).length ||
    Object.entries(s.machines).some(([m, mt]) => viewsOf.machines![m]?.layout !== mt.layout);
  if (changed) {
    const out: string[] = [];
    for (const [m, mt] of Object.entries(s.machines)) {
      if (!mt.layout) continue;
      out.push(`${m}|`);
      for (const ws of mt.layout.workspaces) for (const v of L.pluginViews(ws, 'browser', 'page')) out.push(frameKey(m, v.view.id));
    }
    viewsOf = { machines: s.machines, list: out.sort().join('\n') };
  }
  return viewsOf.list;
}

/** How often a mounted frame's forward is used again, which keeps it from
 * ending idle. */
export const KEEPALIVE_MS = 5 * 60_000;

/** The elements of the browser panes, over the panes; once per page. */
export function BrowserLayer() {
  const frames = useFrames((s) => s.frames);
  const shown = useFrames((s) => s.shown);
  const viewsList = useTerms(browserViewsOfLayouts);
  const views = useMemo(() => new Set(viewsList ? viewsList.split('\n') : []), [viewsList]);

  useEffect(() => {
    // A view is alive while its machine's layout holds it; unknown while
    // that layout is not read (the machine is away).
    const alive = (fr: Frame) => (views.has(`${fr.m}|`) ? views.has(frameKey(fr.m, fr.id)) : undefined);
    const update = () => {
      const s = useFrames.getState();
      const next = nextFrames(s.frames, s.shown, alive, Date.now());
      if (next !== s.frames) {
        useFrames.setState({ frames: next });
        forgetFrames(next);
      }
    };
    update();
    // Frames off screen expire.
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [shown, views]);

  // With the plugin off the layer goes, and its frames with it.
  useEffect(() => () => useFrames.setState({ frames: {}, pages: {}, nav: {} }), []);

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

  // A press inside a frame gives the page no event: the page learns that
  // the keyboard went into one when its own window loses it.
  useEffect(() => {
    const onBlur = () =>
      setTimeout(() => {
        const k = focusedFrame();
        const fr = k ? useFrames.getState().frames[k] : undefined;
        if (fr) terms.mutate(fr.m, (l) => L.focusPane(l, L.viewKey(fr.id)));
      });
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // A popup of a webview opens as a new browser tab.
  useEffect(() => desktopShell?.browser?.onOpen((url) => void openPopup(url)), []);

  return (
    <div className="browser-layer" ref={layer}>
      {Object.entries(frames).map(([k, fr]) => (
        <BrowserFrame key={`${k}#${fr.load}`} k={k} frame={fr} />
      ))}
    </div>
  );
}

function BrowserFrame({ k, frame }: { k: string; frame: Frame }) {
  const page = useFrames((s) => s.pages[k]);
  if (!page) return null;
  return desktopShell?.browser ? <Webview k={k} frame={frame} page={page} /> : <PageFrame k={k} frame={frame} page={page} />;
}

function PageFrame({ k, frame, page }: { k: string; frame: Frame; page: Page }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => mountFrame(k, ref.current!), [k]);
  useKeepAlive(k, page);
  return (
    <iframe
      ref={ref}
      className="browser-frame"
      data-frame={k}
      data-m={frame.m}
      src={page.src}
      title={page.url}
      // Pages of other origins that run scripts, and nothing of the UI's.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      referrerPolicy="no-referrer"
      allow="clipboard-write"
    />
  );
}

function Webview({ k, frame, page }: { k: string; frame: Frame; page: Page }) {
  const ref = useRef<HTMLElement>(null);
  // The first address is the element's attribute; later ones are loaded.
  const first = useRef(page);
  useLayoutEffect(() => mountFrame(k, ref.current!), [k]);
  useKeepAlive(k, page);
  useEffect(() => {
    const el = ref.current;
    if (!isWebview(el)) return;
    const state = () => {
      try {
        return { back: el.canGoBack(), forward: el.canGoForward() };
      } catch {
        return {};
      }
    };
    const at = (real: string) => (page.forward ? (meantUrl(real, page.forward.port, page.forward.local) ?? real) : real);
    const away = (real: string) => !!page.forward && meantUrl(real, page.forward.port, page.forward.local) === undefined;
    const on = (name: string, fn: (e: Event & Record<string, unknown>) => void) => {
      el.addEventListener(name, fn as EventListener);
      return () => el.removeEventListener(name, fn as EventListener);
    };
    const offs = [
      on('did-navigate', (e) => reportNav(k, { url: at(String(e.url)), away: away(String(e.url)), error: undefined, ...state() })),
      on(
        'did-navigate-in-page',
        (e) => e.isMainFrame !== false && reportNav(k, { url: at(String(e.url)), away: away(String(e.url)), ...state() }),
      ),
      on('page-title-updated', (e) => reportNav(k, { title: String(e.title) })),
      on('did-fail-load', (e) => {
        // -3: a load that was cancelled by another.
        if (e.isMainFrame === false || e.errorCode === -3) return;
        reportNav(k, { error: String(e.errorDescription ?? e.errorCode) });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [k, page.forward]);
  // A page the toolbar loads while the element shows another.
  const loaded = useRef(page);
  useEffect(() => {
    if (loaded.current === page) return;
    loaded.current = page;
    const el = frameElement(k);
    if (!isWebview(el)) return;
    el.loadURL(page.src).catch(() => el.setAttribute('src', page.src));
  }, [k, page]);
  return createWebview(ref, k, frame.m, first.current.src);
}

function createWebview(ref: RefObject<HTMLElement | null>, k: string, m: string, src: string) {
  // The partition is the element's, set before it loads: its own storage,
  // apart from the app's.
  return createElement('webview', {
    ref,
    className: 'browser-frame',
    'data-frame': k,
    'data-m': m,
    partition: 'persist:browser',
    allowpopups: '',
    src,
  });
}

/** Uses a frame's forward every few minutes while the frame is mounted: a
 * forward that nothing uses ends idle. When the forward ended and is made
 * again on another local port, the frame loads from it. */
function useKeepAlive(k: string, page: Page) {
  const fw = page.forward;
  const m = fw?.m;
  const port = fw?.port;
  useEffect(() => {
    if (m === undefined || port === undefined) return;
    const timer = window.setInterval(() => {
      browserApi.ensure(m, port).then(
        (f) => {
          noteForward(f);
          const cur = useFrames.getState().pages[k];
          if (cur?.forward && cur.forward.local !== f.local) {
            const src = cur.src.replace(/:\d+(?=\/|$)/, `:${f.local}`);
            showPage(k, { ...cur, src, forward: { ...cur.forward, local: f.local } });
          }
        },
        (e) => console.warn(errorText(e, m)),
      );
    }, KEEPALIVE_MS);
    return () => window.clearInterval(timer);
  }, [k, m, port]);
}

/** The body of a browser pane on screen: the layer places the pane's frame
 * over it. */
export function BrowserSlot({ m, id, children }: { m: string; id: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const k = frameKey(m, id);
  useLayoutEffect(() => showSlot({ m, id }, ref.current!), [m, id]);
  // The pane may have moved without changing its size.
  useLayoutEffect(() => place(k));
  return (
    <div className="browser-slot" ref={ref} data-frame={k}>
      {children}
    </div>
  );
}

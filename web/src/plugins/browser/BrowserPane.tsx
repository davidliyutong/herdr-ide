// The browser pane ({view: {plugin: 'browser', kind: 'page', url, m?,
// port?}}): a toolbar (back, forward, reload, the address, the machine and
// port of a forwarded page, Ports, open outside) over a body in which the
// layer places the page's frame (BrowserLayer.tsx, frames.ts). With m and
// port the page is that machine's port, shown through a port forward that
// is there before the page loads and stays in use while the pane is
// mounted; without them the frame loads the address itself. `url` is the
// address as the user means it (http://localhost:3000/docs), also while the
// frame is on the local port of a forward.
//
// The view is the layout's, which every client and every script of the
// page can write, and a forward leads into a machine: the pane makes one
// only for a port the user asked for in this page (api.ts grantForward:
// this toolbar, Ports, a link clicked, Forward and open below). For any
// other view it uses the forward when it exists and asks when it does not,
// and it takes m only when it is the machine of its own layout.
//
// An iframe gives no word of where its page goes: back and forward go over
// the addresses loaded from this toolbar, and the address field shows the
// last one. A webview (the desktop app) follows its page, and the view's
// url follows it, so that a reload of the app comes back to it.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Network, RotateCw, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { terms } from '../../state/terms';
import * as L from '../../term/layout';
import { t } from '../../i18n';
import { desktopShell } from '../../shell';
import { useDismiss } from '../../components/useDismiss';
import type { PaneViewProps } from '../api';
import {
  attachForward,
  browserApi,
  BrowserError,
  canFrame,
  errorText,
  forwardedSrc,
  grantForward,
  hostPort,
  isRemote,
  loadForwards,
  loopbackSrc,
  otherHost,
  pageView,
  parseAddress,
  revokeForward,
  useForwards,
  type ListeningPort,
} from './api';
import { clearPage, frameKey, reloadPage, showPage, stepPage, useFrames } from './frames';
import { BrowserSlot } from './BrowserLayer';

type Status =
  | { s: 'start' }
  | { s: 'loading' }
  | { s: 'ready' }
  /** A page that cannot be framed here: it opens in the browser. */
  | { s: 'outside' }
  | { s: 'refused' }
  /** A machine's port that is not forwarded and that the user did not ask
   * for in this page: the pane asks before it makes the forward. */
  | { s: 'ask' }
  | { s: 'error'; code: string; text: string };

/** The code of the failure of a view that names another machine than its
 * layout's; nothing is retried for it. */
const OTHER_MACHINE = 'other_machine';

/** Fields of a view that say where its page is. */
type Fields = { url: string; m?: string; port?: number; title?: string };

const outside = (url: string) => void window.open(url, '_blank', 'noopener');

export function BrowserPane({ m, pane, view }: PaneViewProps) {
  const url = typeof view.url === 'string' ? view.url : '';
  const vm = typeof view.m === 'string' ? view.m : undefined;
  const port = typeof view.port === 'number' ? view.port : undefined;
  const k = frameKey(m, view.id);
  const label = useStore((s) => s.machines[vm ?? m]?.label ?? vm ?? m);
  const page = useFrames((s) => s.pages[k]);
  const nav = useFrames((s) => s.nav[k]);
  const retries = useFrames((s) => s.retries[k] ?? 0);
  const [status, setStatus] = useState<Status>(() =>
    url ? (useFrames.getState().pages[k] ? { s: 'ready' } : { s: 'loading' }) : { s: 'start' },
  );
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState('');

  const setFields = useCallback((f: Fields) => terms.mutate(m, (l) => L.setViewFields(l, pane, { ...f, m: f.m, port: f.port })), [m, pane]);

  // Has the forward (a use of it), then loads the page.
  useEffect(() => {
    let dead = false;
    const fail = (s: Status) => {
      clearPage(k);
      setStatus(s);
    };
    if (!url) return fail({ s: 'start' });
    // A view with a machine's port names that machine's own loopback.
    const p = parseAddress(url, !!(vm && port));
    if (p.kind !== 'page') return fail({ s: 'refused' });
    const cur = useFrames.getState();
    // The frame already shows this address (the pane came back, or the
    // webview's own navigation moved the view): only the forward's use.
    const shown = !!cur.pages[k] && cur.nav[k]?.url === url;
    const load = (src: string, forward?: { m: string; port: number; local: number }) => {
      if (shown) return setStatus({ s: 'ready' });
      showPage(k, { src, url, forward });
      setStatus({ s: 'ready' });
    };
    if (vm && port) {
      // A port of the layout's own machine, or nothing: no request.
      if (vm !== m) return fail({ s: 'error', code: OTHER_MACHINE, text: t('browser.error.other_machine') });
      if (!otherHost()) return fail({ s: 'error', code: 'host', text: t('browser.error.host') });
      if (!shown) setStatus({ s: 'loading' });
      attachForward(vm, port).then(
        (f) => {
          if (dead) return;
          // Not forwarded, and not asked for by the user here.
          if (!f) return fail({ s: 'ask' });
          load(forwardedSrc(url, f.local)!, { m: vm, port, local: f.local });
        },
        (e) => {
          if (dead) return;
          const code = e instanceof BrowserError ? e.code : 'network';
          fail({ s: 'error', code, text: errorText(e, label) });
        },
      );
    } else if (p.loopback) {
      const src = loopbackSrc(url);
      if (!src) return fail({ s: 'error', code: 'host', text: t('browser.error.host') });
      load(src);
    } else if (canFrame(url)) {
      load(p.url);
    } else {
      fail({ s: 'outside' });
    }
    return () => {
      dead = true;
    };
  }, [m, k, url, vm, port, label, attempt, retries]);

  // A webview's own navigation: the view's address follows (debounced).
  const latest = useRef({ url, setFields });
  latest.current = { url, setFields };
  useEffect(() => {
    if (!desktopShell?.browser || !nav?.url) return;
    const timer = setTimeout(() => {
      const cur = latest.current;
      const title = nav.title && nav.title !== (view.title ?? undefined) ? nav.title : undefined;
      if (nav.url === cur.url && !title) return;
      const f = nav.url === cur.url ? {} : nav.away ? { url: nav.url, m: undefined, port: undefined } : { url: nav.url };
      terms.mutate(m, (l) => L.setViewFields(l, pane, { ...f, ...(title ? { title } : {}) }));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav?.url, nav?.title, nav?.away]);

  /** Loads what was typed (or chosen in Ports). */
  const go = useCallback(
    (input: string) => {
      setNote('');
      const p = parseAddress(input, isRemote(m));
      if (p.kind === 'empty') return;
      if (p.kind === 'refused') return setNote(t('browser.refused'));
      const f = pageView(m, input)!;
      if (!canFrame(f.url, !!(f.m && f.port))) {
        // Only loopback addresses can be framed in a browser.
        outside(f.url);
        return setFields({ url: f.url, m: undefined, port: undefined, title: undefined });
      }
      // The user asked for this port of the machine, here.
      if (f.m && f.port) grantForward(f.m, f.port);
      const same = f.url === url && f.m === vm && f.port === port;
      if (same) return reloadPage(k);
      setFields({ ...f, title: undefined });
    },
    [m, k, url, vm, port, setFields],
  );

  const back = (step: -1 | 1) => {
    const to = stepPage(k, step);
    if (to) setFields({ url: to.url, m: to.forward?.m, port: to.forward?.port });
  };

  const local = page?.forward?.local;
  const forwarded = !!vm && port !== undefined;
  const loadedSrc = page?.src;
  const realUrl = loadedSrc ?? (status.s === 'outside' ? url : undefined);

  return (
    <div className="browser-pane">
      <Toolbar
        m={m}
        k={k}
        url={url}
        label={label}
        vm={vm}
        port={port}
        local={local}
        canBack={!!nav?.back}
        canForward={!!nav?.forward}
        empty={!url}
        onGo={go}
        onStep={back}
        onReload={() => reloadPage(k)}
        onOpenOutside={realUrl ? () => outside(realUrl) : undefined}
      />
      {forwarded && local !== undefined && local !== port && (
        <div className="browser-note muted">{t('browser.portNotice', { local, port: port! })}</div>
      )}
      {(note || nav?.error) && <div className="browser-note browser-error">{note || t('browser.loadFailed', { error: nav!.error! })}</div>}
      <BrowserSlot m={m} id={view.id}>
        <Body
          m={m}
          label={label}
          url={url}
          port={port}
          vm={vm}
          status={status}
          onGo={go}
          onRetry={() => setAttempt((a) => a + 1)}
          onForward={() => {
            if (!vm || !port || vm !== m) return;
            grantForward(vm, port);
            setAttempt((a) => a + 1);
          }}
        />
      </BrowserSlot>
    </div>
  );
}

function Body({
  m,
  label,
  url,
  vm,
  port,
  status,
  onGo,
  onRetry,
  onForward,
}: {
  m: string;
  label: string;
  url: string;
  vm?: string;
  port?: number;
  status: Status;
  onGo(input: string): void;
  onRetry(): void;
  /** The user asks for the view's forward. */
  onForward(): void;
}) {
  if (status.s === 'ready') return null;
  if (status.s === 'start') {
    return (
      <div className="browser-cover">
        <div className="browser-start">
          <div className="muted">{t('browser.start')}</div>
          <ListeningPorts m={m} onOpen={(p) => onGo(String(p))} />
        </div>
      </div>
    );
  }
  if (status.s === 'loading')
    return (
      <div className="browser-cover muted">{vm && port ? t('browser.starting', { machine: label, port }) : t('browser.portsLoading')}</div>
    );
  if (status.s === 'refused') return <div className="browser-cover muted">{t('browser.refused')}</div>;
  if (status.s === 'outside')
    return (
      <div className="browser-cover">
        <div className="browser-start">
          <div className="muted">{t('browser.outside')}</div>
          <div className="browser-url ellipsis">{url}</div>
          <button className="primary" onClick={() => outside(url)}>
            {t('browser.outsideOpen')}
          </button>
        </div>
      </div>
    );
  if (status.s === 'ask')
    return (
      <div className="browser-cover" data-testid="browser-ask">
        <div className="browser-start">
          <div className="muted">{t('browser.ask', { machine: label, port: port ?? 0 })}</div>
          <button className="primary" onClick={onForward}>
            {t('browser.askForward')}
          </button>
        </div>
      </div>
    );
  return (
    <div className="browser-cover">
      <div className="browser-start">
        <div className="browser-failure">{status.text}</div>
        {status.code !== OTHER_MACHINE && <button onClick={onRetry}>{t('browser.retry')}</button>}
      </div>
    </div>
  );
}

function Toolbar(props: {
  m: string;
  k: string;
  url: string;
  label: string;
  vm?: string;
  port?: number;
  local?: number;
  canBack: boolean;
  canForward: boolean;
  empty: boolean;
  onGo(input: string): void;
  onStep(step: -1 | 1): void;
  onReload(): void;
  onOpenOutside?: () => void;
}) {
  const { url, vm, port, local } = props;
  const [draft, setDraft] = useState(url);
  // The address field shows the last address loaded.
  useEffect(() => setDraft(url), [url]);
  const [ports, setPorts] = useState(false);
  const chip = vm && port !== undefined;
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="browser-bar toolbar">
      <button
        className="icon"
        title={t('browser.back')}
        aria-label={t('browser.back')}
        disabled={!props.canBack}
        onClick={() => props.onStep(-1)}
      >
        <ArrowLeft />
      </button>
      <button
        className="icon"
        title={t('browser.forward')}
        aria-label={t('browser.forward')}
        disabled={!props.canForward}
        onClick={() => props.onStep(1)}
      >
        <ArrowRight />
      </button>
      <button className="icon" title={t('browser.reload')} aria-label={t('browser.reload')} onClick={props.onReload}>
        <RotateCw />
      </button>
      {chip && (
        <span
          className="browser-chip"
          title={local !== undefined && local !== port ? t('browser.portNotice', { local, port }) : undefined}
          data-testid="browser-chip"
        >
          {local !== undefined && local !== port
            ? t('browser.chipLocal', { machine: props.label, port, local })
            : t('browser.chip', { machine: props.label, port })}
        </span>
      )}
      <input
        className="browser-address"
        value={draft}
        placeholder={t('browser.addressPlaceholder')}
        aria-label={t('browser.address')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-autofocus={props.empty ? '' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onGo(draft);
          else if (e.key === 'Escape') setDraft(url);
        }}
      />
      <button
        ref={anchor}
        className={`icon ${ports ? 'on' : ''}`}
        title={t('browser.ports')}
        aria-label={t('browser.ports')}
        aria-expanded={ports}
        onClick={() => setPorts((v) => !v)}
      >
        <Network />
      </button>
      <button
        className="icon"
        title={t('browser.openOutside')}
        aria-label={t('browser.openOutside')}
        disabled={!props.onOpenOutside}
        onClick={props.onOpenOutside}
      >
        <ExternalLink />
      </button>
      {ports && (
        <PortsPopover
          m={props.m}
          owner={anchor}
          close={() => setPorts(false)}
          onOpen={(p) => {
            setPorts(false);
            props.onGo(String(p));
          }}
        />
      )}
    </div>
  );
}

/** The machine's listening ports, to open one. */
function ListeningPorts({ m, onOpen }: { m: string; onOpen(port: number): void }) {
  const label = useStore((s) => s.machines[m]?.label ?? m);
  const [ports, setPorts] = useState<ListeningPort[] | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let dead = false;
    setPorts('loading');
    // On this computer the core's own port is no page for a pane.
    const mine = (p: ListeningPort) => !isRemote(m) && parseAddress(String(p.port)).kind !== 'page';
    browserApi.listening(m).then(
      (p) => !dead && setPorts(p.filter((x) => !mine(x))),
      () => !dead && setPorts('failed'),
    );
    return () => {
      dead = true;
    };
  }, [m]);
  return (
    <div className="browser-ports" data-testid="browser-listening">
      <div className="browser-ports-head">{t('browser.portsListening', { machine: label })}</div>
      {ports === 'loading' ? (
        <div className="muted">{t('browser.portsLoading')}</div>
      ) : ports === 'failed' ? (
        <div className="muted">{t('browser.portsFailed')}</div>
      ) : ports.length === 0 ? (
        <div className="muted">{t('browser.portsNone')}</div>
      ) : (
        ports.map((p) => (
          <button key={p.port} className="browser-port" title={t('browser.portsOpen', { port: p.port })} onClick={() => onOpen(p.port)}>
            <span className="browser-port-n">{p.port}</span>
            {p.process && <span className="muted ellipsis">{p.process}</span>}
          </button>
        ))
      )}
    </div>
  );
}

/** Ports: what the machine listens on, and the forwards there are. */
function PortsPopover({
  m,
  owner,
  close,
  onOpen,
}: {
  m: string;
  owner: RefObject<HTMLElement | null>;
  close(): void;
  onOpen(port: number): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, close, owner);
  const forwards = useForwards((s) => s.forwards);
  const available = useForwards((s) => s.available);
  const labels = useStore((s) => s.machines);
  useEffect(() => void loadForwards(), []);
  const stop = async (fm: string, fp: number) => {
    // Stopped by the user: a pane showing the port asks before it is made
    // again, also one that had asked for it.
    revokeForward(fm, fp);
    try {
      await browserApi.stop(fm, fp);
    } catch {
      /* already gone */
    }
    void loadForwards();
  };
  return (
    <div className="browser-popover" ref={ref} role="dialog" aria-label={t('browser.ports')}>
      <ListeningPorts m={m} onOpen={onOpen} />
      <div className="browser-ports">
        <div className="browser-ports-head">{t('browser.forwards')}</div>
        {available === false && <div className="muted">{t('browser.forwardsUnavailable')}</div>}
        {available !== false && forwards.length === 0 && <div className="muted">{t('browser.forwardsNone')}</div>}
        {forwards.map((f) => {
          const name = labels[f.m]?.label ?? f.m;
          return (
            <div className="browser-forward" key={`${f.m}|${f.port}`}>
              <span className="ellipsis">{t('browser.forwardLine', { machine: name, port: f.port, local: f.local })}</span>
              <button
                className="icon sm"
                title={t('browser.forwardStop', { machine: name, port: f.port })}
                aria-label={t('browser.forwardStop', { machine: name, port: f.port })}
                onClick={() => void stop(f.m, f.port)}
              >
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The pane's title: the page's, else its address's host. */
export function pageTitle(view: L.PluginView): string {
  if (typeof view.title === 'string' && view.title) return view.title;
  return typeof view.url === 'string' && view.url ? hostPort(view.url) : t('browser.title');
}

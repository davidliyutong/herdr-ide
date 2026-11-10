import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, PanelBottom, PanelRight, Power, X } from 'lucide-react';
import { useStore, type DockView } from '../state/store';
import { usePrefs } from '../prefs';
import { fileUrl, formatSize, listDir, type RemoteStat } from '../lib/files';
import { mediaExt } from '../terminal/links';
import { actions } from '../actions';
import { shortPath } from '../lib/herdr';
import { t } from '../i18n';

export function Dock() {
  const dock = useStore((s) => s.dock);
  const width = useStore((s) => s.dockWidth);
  const setWidth = useStore((s) => s.setDockWidth);
  const height = useStore((s) => s.dockHeight);
  const setHeight = useStore((s) => s.setDockHeight);
  const openDock = useStore((s) => s.openDock);
  const position = usePrefs((s) => s.prefs.dockPosition);
  const setPref = usePrefs((s) => s.setPref);
  const bottom = position === 'bottom';
  // code-server windows stay mounted per machine while in use so switching
  // back is instant; a window hidden for FRAME_TTL is unmounted, which closes
  // its connection and lets the core stop that machine's idle code-server.
  const [frames, setFrames] = useState<Record<string, { folder: string; hidden?: number }>>({});

  useEffect(() => {
    setFrames((f) => {
      const next: typeof f = {};
      for (const [m, fr] of Object.entries(f)) next[m] = { folder: fr.folder, hidden: fr.hidden ?? Date.now() };
      if (dock?.kind === 'code') next[dock.m] = { folder: dock.folder ?? '' };
      return next;
    });
  }, [dock]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setFrames((f) => {
        const now = Date.now();
        const keep = Object.entries(f).filter(([, fr]) => !fr.hidden || now - fr.hidden < FRAME_TTL);
        return keep.length === Object.keys(f).length ? f : Object.fromEntries(keep);
      });
    }, 60_000);
    const onStopped = (e: Event) => {
      const m = (e as CustomEvent<string>).detail;
      setFrames((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== m)));
    };
    window.addEventListener('code-stopped', onStopped);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('code-stopped', onStopped);
    };
  }, []);

  if (!dock && Object.keys(frames).length === 0) return null;

  const onResize = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = width;
    const startH = height;
    const cls = bottom ? 'resizing-row' : 'resizing';
    document.body.classList.add(cls);
    const move = (e: PointerEvent) =>
      bottom
        ? setHeight(Math.min(window.innerHeight - 160, Math.max(160, startH + (startY - e.clientY))))
        : setWidth(Math.min(window.innerWidth - 240, Math.max(320, startW + (startX - e.clientX))));
    const up = () => {
      document.body.classList.remove(cls);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section
      className={`dock ${bottom ? 'dock-bottom' : 'dock-right'}`}
      style={{ ...(bottom ? { height } : { width }), display: dock ? undefined : 'none' }}
    >
      <div className="dock-resizer" onPointerDown={onResize} />
      <div className="dock-head">
        <DockTitle dock={dock} />
        <span className="spacer" />
        {dock?.kind === 'code' && (
          <>
            <a className="icon" href={codeUrl(dock.m, dock.folder)} target="_blank" rel="noreferrer" title={t('dock.openInTab')}>
              <ExternalLink />
            </a>
            <button className="icon" title={t('dock.stopCode')} onClick={() => stopCode(dock.m)}>
              <Power />
            </button>
          </>
        )}
        <button
          className="icon"
          title={t(bottom ? 'dock.moveRight' : 'dock.moveBottom')}
          onClick={() => setPref('dockPosition', bottom ? 'right' : 'bottom')}
        >
          {bottom ? <PanelRight /> : <PanelBottom />}
        </button>
        <button className="icon" title={t('dock.close')} onClick={() => openDock(undefined)}>
          <X />
        </button>
      </div>
      <div className="dock-body">
        {Object.entries(frames).map(([m, fr]) => (
          <iframe
            key={m}
            className="code-frame"
            style={{ display: dock?.kind === 'code' && dock.m === m ? undefined : 'none' }}
            src={codeUrl(m, fr.folder)}
            title={`VS Code ${m}`}
            allow="clipboard-read; clipboard-write"
          />
        ))}
        {dock?.kind === 'preview' && <Preview key={dock.m + dock.path} m={dock.m} path={dock.path} />}
      </div>
    </section>
  );
}

const FRAME_TTL = 10 * 60_000;

async function stopCode(m: string) {
  const s = useStore.getState();
  s.openDock(undefined);
  await fetch(`/api/m/${encodeURIComponent(m)}/code/stop`, { method: 'POST' }).catch(() => {});
  // Remount on next open (the old window's connection is gone anyway).
  window.dispatchEvent(new CustomEvent('code-stopped', { detail: m }));
}

export function codeUrl(m: string, folder?: string) {
  const q = folder ? `?${new URLSearchParams({ folder })}` : '';
  return `/m/${encodeURIComponent(m)}/code/${q}`;
}

function DockTitle({ dock }: { dock?: DockView }) {
  const home = useStore((s) => (dock ? s.machines[dock.m]?.info?.home : undefined));
  const label = useStore((s) => (dock ? s.machines[dock.m]?.label : undefined));
  if (!dock) return null;
  if (dock.kind === 'code')
    return (
      <span className="dock-title ellipsis" title={dock.folder}>
        {t('dock.code')} · {label} · <span className="muted">{shortPath(dock.folder, home) || '~'}</span>
      </span>
    );
  if (dock.kind === 'preview')
    return (
      <span className="dock-title ellipsis" title={dock.path}>
        {t('dock.preview')} · {label} · <span className="muted">{shortPath(dock.path, home)}</span>
      </span>
    );
  return <span className="dock-title">Agent</span>;
}

const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const videoExt = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i;
const audioExt = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;

function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

function Preview({ m, path }: { m: string; path: string }) {
  const openDock = useStore((s) => s.openDock);
  const readOnly = useStore((s) => s.readOnly);
  const [siblings, setSiblings] = useState<RemoteStat[]>([]);
  const [dirEntries, setDirEntries] = useState<RemoteStat[] | undefined>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string>();
  const [videoError, setVideoError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isMedia = mediaExt.test(path);
  const url = fileUrl(m, path);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setText(undefined);
    setDirEntries(undefined);
    (async () => {
      // A path without a media extension may be a directory or a text file.
      if (!isMedia) {
        try {
          const d = await listDir(m, path);
          if (!cancelled) setDirEntries(d.entries);
          return;
        } catch {
          /* not a directory */
        }
        try {
          const r = await fetch(url, { headers: { Range: 'bytes=0-2097151' } });
          if (!r.ok) throw new Error(await r.text());
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.slice(0, 8000).includes(0)) throw new Error(t('dock.binary'));
          if (!cancelled) setText(new TextDecoder().decode(buf));
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    listDir(m, dirname(path))
      .then((d) => !cancelled && setSiblings(d.entries.filter((e) => !e.is_dir && mediaExt.test(e.name))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [m, path, url, isMedia]);

  const index = useMemo(() => siblings.findIndex((s) => dirname(path) + '/' + s.name === path), [siblings, path]);
  const go = (step: number) => {
    if (index < 0 || siblings.length < 2) return;
    const next = siblings[(index + step + siblings.length) % siblings.length];
    openDock({ kind: 'preview', m, path: dirname(path) + '/' + next.name });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="preview" ref={containerRef} tabIndex={-1}>
      <div className="preview-toolbar">
        {siblings.length > 1 && index >= 0 && (
          <>
            <button className="icon" title={t('dock.previous')} onClick={() => go(-1)}>
              <ArrowLeft />
            </button>
            <span className="muted small">
              {index + 1}/{siblings.length}
            </span>
            <button className="icon" title={t('dock.next')} onClick={() => go(1)}>
              <ArrowRight />
            </button>
          </>
        )}
        <span className="spacer" />
        <a className="btn" href={fileUrl(m, path, true)}>
          {t('dock.download')}
        </a>
        {!readOnly && <button onClick={() => actions.openPath(m, path, 1)}>{t('dock.openInCode')}</button>}
      </div>
      <div className="preview-body">
        {error && <div className="error pad">{error}</div>}
        {imageExt.test(path) && <img src={url} alt={path} />}
        {videoExt.test(path) &&
          (videoError ? (
            <div className="pad muted">{t('dock.videoUnsupported')}</div>
          ) : (
            <video src={url} controls autoPlay loop muted playsInline onError={() => setVideoError(true)} />
          ))}
        {audioExt.test(path) && <audio src={url} controls autoPlay />}
        {/\.pdf$/i.test(path) && <iframe className="pdf-frame" src={url} title={path} />}
        {text !== undefined && <pre className="text-preview">{text}</pre>}
        {dirEntries && (
          <div className="dir-list">
            {dirEntries.map((e) => (
              <div
                key={e.name}
                className="dir-entry"
                onClick={() => openDock({ kind: 'preview', m, path: path.replace(/\/$/, '') + '/' + e.name })}
              >
                <span>{e.is_dir ? '📁' : mediaExt.test(e.name) ? '🖼' : '📄'}</span>
                <span className="ellipsis">{e.name}</span>
                <span className="muted small">{e.is_dir ? '' : formatSize(e.size)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

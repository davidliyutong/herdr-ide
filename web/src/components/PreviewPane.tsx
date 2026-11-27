// The body of a preview pane (term/layout.ts PreviewLeaf): an image, video,
// audio, PDF, text file or directory of the pane's machine, with the media
// beside it in its directory one step away (← →). Stepping or entering a
// directory shows that path in the same pane.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Code as CodeIcon, Eye } from 'lucide-react';
import { useStore } from '../state/store';
import { terms } from '../state/terms';
import { registerPane } from '../state/panes';
import * as L from '../term/layout';
import { fileUrl, formatSize, listDir, type RemoteStat } from '../lib/files';
import { mediaExt } from '../terminal/links';
import { actions } from '../actions';
import { t } from '../i18n';
import { usePluginOn } from '../plugins/registry';
import { Code } from '../highlight/Code';
import { languageOf } from '../highlight/languages';
import { isMarkdownPath } from '../markdown/links';
import { Markdown } from '../markdown/Markdown';
import { FileBack } from './PluginPane';

const imageExt = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const videoExt = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i;
const audioExt = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;

export function dirname(p: string) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

/** Whether a path is shown by MediaView (an image, video, audio or PDF). */
export const isMediaPath = (path: string) => mediaExt.test(path);

/** An image, video, audio file or PDF of a machine, as large as fits. */
export function MediaView({ m, path, shown = true }: { m: string; path: string; shown?: boolean }) {
  const [videoError, setVideoError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const machineStatus = useStore((s) => s.machines[m]?.status);
  const prevMachine = useRef({ m, status: machineStatus });
  useEffect(() => setVideoError(false), [path, reloadKey]);
  useEffect(() => {
    const prev = prevMachine.current;
    prevMachine.current = { m, status: machineStatus };
    if (prev.m === m && prev.status !== 'ready' && machineStatus === 'ready') {
      setVideoError(false);
      setReloadKey((n) => n + 1);
    }
  }, [m, machineStatus]);
  useEffect(() => {
    if (!shown) {
      videoRef.current?.pause();
      audioRef.current?.pause();
    }
  }, [shown]);
  const url = fileUrl(m, path);
  return (
    <>
      {imageExt.test(path) && <img key={reloadKey} src={url} alt={path} />}
      {videoExt.test(path) &&
        (videoError ? (
          <div className="pad muted">{t('preview.videoUnsupported')}</div>
        ) : (
          <video
            key={reloadKey}
            ref={videoRef}
            src={url}
            controls
            autoPlay={shown}
            loop
            muted
            playsInline
            onError={() => setVideoError(true)}
          />
        ))}
      {audioExt.test(path) && <audio key={reloadKey} ref={audioRef} src={url} controls autoPlay={shown} />}
      {/\.pdf$/i.test(path) && <iframe key={reloadKey} className="pdf-frame" src={url} title={path} />}
    </>
  );
}

/** The text or directory entries previews showed last, by machine and path
 * (at most KEPT_SHOWN): a preview shown again while its file is gone (a tab
 * switch draws it afresh) keeps showing them, as an editor keeps a deleted
 * file's text, rather than an error. */
const shownLast = new Map<string, { text?: string; dirEntries?: RemoteStat[] }>();
const KEPT_SHOWN = 32;
function keepShown(key: string, shown: { text?: string; dirEntries?: RemoteStat[] }) {
  shownLast.delete(key);
  shownLast.set(key, shown);
  for (const k of shownLast.keys()) {
    if (shownLast.size <= KEPT_SHOWN) break;
    shownLast.delete(k);
  }
}

export function PreviewPane({
  m,
  pane,
  path,
  focused,
  shown = true,
  onActivate,
}: {
  m: string;
  pane: string;
  path: string;
  focused?: boolean;
  shown?: boolean;
  onActivate?(): void;
}) {
  const readOnly = useStore((s) => s.readOnly);
  const code = usePluginOn('vscode');
  const [siblings, setSiblings] = useState<RemoteStat[]>([]);
  const init = shownLast.get(`${m}\n${path}`);
  const [dirEntries, setDirEntries] = useState<RemoteStat[] | undefined>(() => init?.dirEntries);
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string | undefined>(() => init?.text);
  // Whether a Markdown file shows rendered (per pane, not kept).
  const [rendered, setRendered] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  // Bumped when the file, gone, is there again or the machine reconnects: it is loaded again.
  const [loads, setLoads] = useState(0);
  const machineStatus = useStore((s) => s.machines[m]?.status);
  const prevMachine = useRef({ m, status: machineStatus });
  useEffect(() => {
    const prev = prevMachine.current;
    prevMachine.current = { m, status: machineStatus };
    if (prev.m === m && prev.status !== 'ready' && machineStatus === 'ready') setLoads((n) => n + 1);
  }, [m, machineStatus]);

  const isMedia = mediaExt.test(path);
  const url = fileUrl(m, path);
  const show = (next: string) => terms.mutate(m, (l) => L.setPreviewPath(l, pane, next));
  const isMarkdown = isMarkdownPath(path);
  const base = useMemo(() => ({ m, dir: dirname(path) }), [m, path]);

  useEffect(() => registerPane(m, pane, { focus: () => containerRef.current?.focus() }), [m, pane]);

  useEffect(() => {
    if (!shown) return;
    const ac = new AbortController();
    const key = `${m}\n${path}`;
    const last = shownLast.get(key);
    setError(undefined);
    // Hydrate immediately from cached content (if any) without blanking the view.
    setText(last?.text);
    setDirEntries(last?.dirEntries);
    (async () => {
      // A path without a media extension may be a text file or a directory.
      // Fetch the file first (single round-trip in the common case) and only
      // list as a directory when the hub reports 400 is a directory.
      if (!isMedia) {
        try {
          const r = await fetch(url, { headers: { Range: 'bytes=0-2097151' }, signal: ac.signal });
          if (r.status === 400) {
            const msg = await r.text().catch(() => '');
            if (/is a directory/i.test(msg)) {
              const d = await listDir(m, path, ac.signal);
              if (ac.signal.aborted) return;
              setText(undefined);
              setDirEntries(d.entries);
              keepShown(key, { dirEntries: d.entries });
              return;
            }
            throw new Error(msg || r.statusText);
          }
          if (r.status === 404 && last) {
            // Gone since it was shown: what it showed stays.
            if (ac.signal.aborted) return;
            if (last.text !== undefined) setText(last.text);
            else setDirEntries(last.dirEntries);
            return;
          }
          if (!r.ok) throw new Error(await r.text());
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.subarray(0, 8000).includes(0)) {
            if (ac.signal.aborted) return;
            shownLast.delete(key);
            setText(undefined);
            setDirEntries(undefined);
            setError(t('preview.binary'));
            return;
          }
          if (ac.signal.aborted) return;
          const next = new TextDecoder().decode(buf);
          setDirEntries(undefined);
          setText(next);
          keepShown(key, { text: next });
        } catch (e) {
          if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    // Sibling media navigation (← →) only applies to media files.
    if (isMedia) {
      listDir(m, dirname(path), ac.signal)
        .then((d) => !ac.signal.aborted && setSiblings(d.entries.filter((e) => !e.is_dir && mediaExt.test(e.name))))
        .catch(() => {});
    } else {
      setSiblings([]);
    }
    return () => {
      ac.abort();
    };
  }, [m, path, url, isMedia, loads, shown]);

  const index = useMemo(() => siblings.findIndex((s) => dirname(path) + '/' + s.name === path), [siblings, path]);
  const go = (step: number) => {
    if (index < 0 || siblings.length < 2) return;
    const next = siblings[(index + step + siblings.length) % siblings.length];
    show(dirname(path) + '/' + next.name);
  };

  const activate = () => {
    if (!shown || focused) return;
    if (onActivate) onActivate();
    else terms.mutate(m, (l) => L.focusPane(l, pane));
  };

  return (
    <div
      className="preview"
      ref={containerRef}
      tabIndex={-1}
      onMouseDownCapture={activate}
      onFocusCapture={activate}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') go(-1);
        if (e.key === 'ArrowRight') go(1);
      }}
    >
      <FileBack m={m} path={path} onBack={() => setLoads((n) => n + 1)} />
      <div className="preview-toolbar">
        {siblings.length > 1 && index >= 0 && (
          <>
            <button className="icon" title={t('preview.previous')} onClick={() => go(-1)}>
              <ArrowLeft />
            </button>
            <span className="muted small">
              {index + 1}/{siblings.length}
            </span>
            <button className="icon" title={t('preview.next')} onClick={() => go(1)}>
              <ArrowRight />
            </button>
          </>
        )}
        <span className="spacer" />
        {isMarkdown && text !== undefined && (
          <button
            className="icon"
            title={rendered ? t('preview.source') : t('preview.rendered')}
            aria-label={rendered ? t('preview.source') : t('preview.rendered')}
            onClick={() => setRendered(!rendered)}
          >
            {rendered ? <CodeIcon /> : <Eye />}
          </button>
        )}
        <a className="btn" href={fileUrl(m, path, true)}>
          {t('preview.download')}
        </a>
        {!readOnly && code && (
          <button onClick={() => void actions.openInCode(m, path, 1, undefined, pane)}>{t('preview.openInCode')}</button>
        )}
      </div>
      <div className="preview-body">
        {error && <div className="error pad">{error}</div>}
        {isMedia && <MediaView m={m} path={path} shown={shown} />}
        {text !== undefined &&
          (isMarkdown && rendered ? (
            <div className="markdown-preview">
              <Markdown text={text} variant="document" base={base} onOpenPath={show} />
            </div>
          ) : (
            <Code className="text-preview" text={text} lang={languageOf(path, text.split('\n', 1)[0])} />
          ))}
        {dirEntries && (
          <div className="dir-list">
            {dirEntries.map((e) => (
              <div key={e.name} className="dir-entry" onClick={() => show(path.replace(/\/$/, '') + '/' + e.name)}>
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

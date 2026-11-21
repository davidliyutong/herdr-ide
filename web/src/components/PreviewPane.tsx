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
export function MediaView({ m, path }: { m: string; path: string }) {
  const [videoError, setVideoError] = useState(false);
  useEffect(() => setVideoError(false), [path]);
  const url = fileUrl(m, path);
  return (
    <>
      {imageExt.test(path) && <img src={url} alt={path} />}
      {videoExt.test(path) &&
        (videoError ? (
          <div className="pad muted">{t('preview.videoUnsupported')}</div>
        ) : (
          <video src={url} controls autoPlay loop muted playsInline onError={() => setVideoError(true)} />
        ))}
      {audioExt.test(path) && <audio src={url} controls autoPlay />}
      {/\.pdf$/i.test(path) && <iframe className="pdf-frame" src={url} title={path} />}
    </>
  );
}

/** The text or directory entries previews showed last, by machine and path
 * (at most KEPT_SHOWN): a preview shown again while its file is gone (a tab
 * switch draws it afresh) keeps showing them, as an editor keeps a deleted
 * file's text, rather than an error. */
const shownLast = new Map<string, { text?: string; dirEntries?: RemoteStat[] }>();
const KEPT_SHOWN = 8;
function keepShown(key: string, shown: { text?: string; dirEntries?: RemoteStat[] }) {
  shownLast.delete(key);
  shownLast.set(key, shown);
  for (const k of shownLast.keys()) {
    if (shownLast.size <= KEPT_SHOWN) break;
    shownLast.delete(k);
  }
}

export function PreviewPane({ m, pane, path }: { m: string; pane: string; path: string }) {
  const readOnly = useStore((s) => s.readOnly);
  const code = usePluginOn('vscode');
  const [siblings, setSiblings] = useState<RemoteStat[]>([]);
  const [dirEntries, setDirEntries] = useState<RemoteStat[] | undefined>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string>();
  // Whether a Markdown file shows rendered (per pane, not kept).
  const [rendered, setRendered] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  // Bumped when the file, gone, is there again: it is loaded again.
  const [loads, setLoads] = useState(0);

  const isMedia = mediaExt.test(path);
  const url = fileUrl(m, path);
  const show = (next: string) => terms.mutate(m, (l) => L.setPreviewPath(l, pane, next));
  const isMarkdown = languageOf(path) === 'markdown';
  const base = useMemo(() => ({ m, dir: dirname(path) }), [m, path]);

  useEffect(() => registerPane(m, pane, { focus: () => containerRef.current?.focus() }), [m, pane]);

  useEffect(() => {
    let cancelled = false;
    const key = `${m}\n${path}`;
    setError(undefined);
    setText(undefined);
    setDirEntries(undefined);
    (async () => {
      // A path without a media extension may be a directory or a text file.
      if (!isMedia) {
        try {
          const d = await listDir(m, path);
          if (cancelled) return;
          setDirEntries(d.entries);
          keepShown(key, { dirEntries: d.entries });
          return;
        } catch {
          /* not a directory */
        }
        try {
          const r = await fetch(url, { headers: { Range: 'bytes=0-2097151' } });
          const last = shownLast.get(key);
          if (r.status === 404 && last) {
            // Gone since it was shown: what it showed stays.
            if (cancelled) return;
            if (last.text !== undefined) setText(last.text);
            else setDirEntries(last.dirEntries);
            return;
          }
          if (!r.ok) throw new Error(await r.text());
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.subarray(0, 8000).includes(0)) throw new Error(t('preview.binary'));
          if (cancelled) return;
          const shown = new TextDecoder().decode(buf);
          setText(shown);
          keepShown(key, { text: shown });
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
  }, [m, path, url, isMedia, loads]);

  const index = useMemo(() => siblings.findIndex((s) => dirname(path) + '/' + s.name === path), [siblings, path]);
  const go = (step: number) => {
    if (index < 0 || siblings.length < 2) return;
    const next = siblings[(index + step + siblings.length) % siblings.length];
    show(dirname(path) + '/' + next.name);
  };

  return (
    <div
      className="preview"
      ref={containerRef}
      tabIndex={-1}
      onMouseDown={() => terms.mutate(m, (l) => L.focusPane(l, pane))}
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
        {isMedia && <MediaView m={m} path={path} />}
        {text !== undefined &&
          (isMarkdown && rendered ? (
            <div className="markdown-preview">
              <Markdown text={text} base={base} onOpenPath={show} />
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

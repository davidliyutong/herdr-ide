// The file explorer's editor pane ({view: {plugin: 'files', kind: 'editor',
// path, preview}}): a text file of the pane's machine in Monaco, or an
// image, video, audio file or PDF as Quick Look shows it. A preview (a
// single click in the tree) is replaced by the next one until it is kept:
// by a double click, the pin button or the first edit. Cmd+S (Ctrl+S)
// saves it, with the size and modification time it was loaded with: a file
// changed since (by a program, another page) is not overwritten; the pane
// offers to load it again or to overwrite it. While the text has no unsaved
// changes, a change on disk loads it again by itself. Binary files, text
// that is not UTF-8 and files over MAX_SIZE offer a download. Read-only
// mode edits nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileDiff, FolderTree, Pin, RotateCcw, Save } from 'lucide-react';
import { fileUrl } from '../../lib/files';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { useUnsaved } from '../../unsaved';
import type { PaneViewProps } from '../api';
import { createEditor, type CodeEditor, type Monaco } from '../monaco';
import { ConflictError, errorText, filesApi } from './api';
import { keepEditor, reveal } from './ops';
import { lineChanges, quickDiff, type LineChange } from './quickDiff';
import { useDecorationVersion } from './decorations';
import { isMediaPath, MediaView } from '../../components/PreviewPane';
import './files.css';

/** The largest file the editor opens (the core's limit for a save). */
export const MAX_SIZE = 8 << 20;
/** How often an open file is checked for changes on disk. */
export const CHECK_MS = 5000;

/** A file's size and modification time as the editor loaded or saved it. */
export interface Version {
  size: number;
  mtime: number;
}

/** The version in a file response's ETag (W/"<size hex>-<mtime hex>",
 * internal/server/files.go). */
export function versionOf(etag: string | null): Version | undefined {
  const m = /^W\/"([0-9a-f]+)-([0-9a-f]+)"$/i.exec(etag ?? '');
  return m ? { size: parseInt(m[1], 16), mtime: parseInt(m[2], 16) } : undefined;
}

export type Loaded =
  | { kind: 'text'; text: string; version: Version }
  | { kind: 'missing' }
  | { kind: 'binary' | 'tooLarge' | 'notUtf8' }
  | { kind: 'error'; message: string };

/** Reads a file for the editor. */
export async function loadText(m: string, path: string): Promise<Loaded> {
  const url = fileUrl(m, path);
  const head = await fetch(url, { method: 'HEAD' });
  if (head.status === 404) return { kind: 'missing' };
  if (!head.ok) return { kind: 'error', message: head.statusText || `HTTP ${head.status}` };
  const size = Number(head.headers.get('Content-Length') ?? 0);
  if (size > MAX_SIZE) return { kind: 'tooLarge' };
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return { kind: 'error', message: (await r.text()) || r.statusText };
  const version = versionOf(r.headers.get('ETag'));
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { kind: 'notUtf8' };
  }
  return { kind: 'text', text, version: version ?? { size: buf.length, mtime: 0 } };
}

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'conflict'; removed: boolean } | Exclude<Loaded, { kind: 'text' }>;

export function EditorPane(props: PaneViewProps) {
  const path = String(props.view.path ?? '');
  // Another component for media, so that the text editor's state starts
  // afresh when a preview pane turns from one kind to the other.
  return isMediaPath(path) ? <MediaFile {...props} /> : <TextEditor {...props} />;
}

/** The editor bar: the file's state and the pane's tools, a pin for a
 * preview (the pane's header has the file's name and path). */
function EditorBar({ m, pane, view, children }: Pick<PaneViewProps, 'm' | 'pane' | 'view'> & { children?: React.ReactNode }) {
  const path = String(view.path ?? '');
  const readOnly = useStore((s) => s.readOnly);
  return (
    <div className="files-editor-bar">
      {children}
      {view.preview === true && !readOnly && (
        <button className="icon" title={t('files.keep')} aria-label={t('files.keep')} onClick={() => keepEditor(m, pane)}>
          <Pin />
        </button>
      )}
      <button className="icon" title={t('files.reveal')} aria-label={t('files.reveal')} onClick={() => reveal(m, path)}>
        <FolderTree />
      </button>
    </div>
  );
}

/** An image, video, audio file or PDF. */
function MediaFile({ m, pane, view }: PaneViewProps) {
  const path = String(view.path ?? '');
  return (
    <div className="files-editor" data-autofocus tabIndex={-1}>
      <EditorBar m={m} pane={pane} view={view}>
        <span className="spacer" />
        <a className="icon" href={fileUrl(m, path, true)} title={t('preview.download')} aria-label={t('preview.download')}>
          <Download />
        </a>
      </EditorBar>
      <div className="preview-body">
        <MediaView m={m} path={path} />
      </div>
    </div>
  );
}

/** How long after a keystroke the quick diff is computed again. */
const DIFF_DELAY_MS = 250;

/** The editor's quick diff: bars in the gutter and the overview ruler
 * where the text (unsaved changes included) differs from version
 * control's, as VS Code shows them; the number of changed places. */
function useQuickDiff(m: string, path: string, ed: React.RefObject<{ editor: CodeEditor; monaco: Monaco } | undefined>, ready: boolean) {
  const version = useDecorationVersion((s) => s.v);
  const original = useRef<string | undefined>(undefined);
  const [changes, setChanges] = useState<LineChange[]>([]);
  const timer = useRef<number | undefined>(undefined);

  const compute = useCallback(() => {
    const text = ed.current?.editor.getValue();
    setChanges(original.current === undefined || text === undefined ? [] : lineChanges(original.current, text));
  }, [ed]);

  useEffect(() => quickDiff()?.follow(m, path), [m, path]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const p = quickDiff()?.original(m, path) ?? Promise.resolve(undefined);
    p.catch(() => undefined).then((text) => {
      if (cancelled) return;
      original.current = text;
      compute();
    });
    return () => {
      cancelled = true;
    };
  }, [m, path, ready, version, compute]);

  // Again after edits, once typing pauses.
  useEffect(() => {
    const e = ed.current?.editor;
    if (!ready || !e) return;
    const sub = e.onDidChangeModelContent(() => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(compute, DIFF_DELAY_MS);
    });
    return () => {
      sub.dispose();
      window.clearTimeout(timer.current);
    };
  }, [ready, ed, compute]);

  // The decorations.
  useEffect(() => {
    const c = ed.current;
    if (!c || !ready) return;
    const style = getComputedStyle(document.documentElement);
    const color = (kind: string) => style.getPropertyValue(`--ds-git-${kind}`).trim() || '#888888';
    const { monaco, editor } = c;
    const lane = monaco.editor.OverviewRulerLane.Left;
    const collection = editor.createDecorationsCollection(
      changes.map((ch) => {
        const kind = ch.kind === 'deleted' ? 'deleted' : ch.kind === 'added' ? 'added' : 'modified';
        const [start, end] = ch.kind === 'deleted' ? [Math.max(ch.after, 1), Math.max(ch.after, 1)] : [ch.start, ch.end];
        return {
          range: new monaco.Range(start, 1, end, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `qd-${kind}${ch.kind === 'deleted' && ch.after === 0 ? ' qd-top' : ''}`,
            overviewRuler: { color: color(kind), position: lane },
          },
        };
      }),
    );
    return () => collection.clear();
  }, [changes, ready, ed]);

  return changes.length;
}

function TextEditor({ m, pane, view, focused }: PaneViewProps) {
  const path = String(view.path ?? '');
  const readOnly = useStore((s) => s.readOnly);
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<{ editor: CodeEditor; monaco: Monaco }>(undefined);
  /** The version on disk the text was loaded or saved as; undefined for a
   * file not there yet. */
  const version = useRef<Version | undefined>(undefined);
  const savedAt = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const markClean = () => {
    const e = ed.current?.editor;
    savedAt.current = e?.getModel()?.getAlternativeVersionId() ?? 0;
    setDirty(false);
  };

  const showText = useCallback((text: string, v: Version | undefined) => {
    version.current = v;
    const e = ed.current?.editor;
    const model = e?.getModel();
    if (model && model.getValue() !== text) model.setValue(text);
    markClean();
    setStatus({ kind: 'ready' });
  }, []);

  /** Loads the file (again). */
  const reload = useCallback(async () => {
    const r = await loadText(m, path).catch((e): Loaded => ({ kind: 'error', message: errorText(e) }));
    if (r.kind === 'text') showText(r.text, r.version);
    else if (r.kind === 'missing' && ed.current) showText('', undefined);
    else setStatus(r);
    return r;
  }, [m, path, showText]);

  const save = useCallback(
    async (force = false) => {
      const e = ed.current?.editor;
      if (!e || readOnly) return false;
      const text = e.getValue();
      const at = e.getModel()?.getAlternativeVersionId() ?? 0;
      setSaving(true);
      try {
        const r = await filesApi.write(m, path, text, force ? 'force' : (version.current ?? 'new'));
        if (r.entry) version.current = { size: r.entry.size, mtime: r.entry.mtime };
        savedAt.current = at;
        setDirty((e.getModel()?.getAlternativeVersionId() ?? 0) !== at);
        setStatus({ kind: 'ready' });
        return true;
      } catch (err) {
        if (err instanceof ConflictError) setStatus({ kind: 'conflict', removed: !err.current.exists });
        else useStore.getState().toast(t('files.saveFailed', { error: errorText(err) }), undefined, undefined, 'error');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [m, path, readOnly],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
  // The first edit keeps a preview open, as in VS Code.
  useEffect(() => {
    if (dirty && view.preview === true) keepEditor(m, pane);
  }, [dirty, view.preview, m, pane]);
  // Closing the pane with changes not saved asks first (unsaved.ts).
  useUnsaved(m, pane, dirty, path.slice(path.lastIndexOf('/') + 1) || path, () => saveRef.current());

  // The editor, once; the file, for each path.
  useEffect(() => {
    let disposed = false;
    let created: { editor: CodeEditor; monaco: Monaco } | undefined;
    (async () => {
      const first = await loadText(m, path).catch((e): Loaded => ({ kind: 'error', message: errorText(e) }));
      if (disposed) return;
      if (first.kind !== 'text' && first.kind !== 'missing') return setStatus(first);
      const el = host.current;
      if (!el) return;
      created = await createEditor(el, { readOnly: useStore.getState().readOnly });
      if (disposed) return created.editor.dispose();
      const { monaco, editor } = created;
      const uri = monaco.Uri.from({ scheme: 'file', path, query: `m=${m}` });
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', undefined, uri);
      editor.setModel(model);
      ed.current = created;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
      model.onDidChangeContent(() => setDirty(model.getAlternativeVersionId() !== savedAt.current));
      if (first.kind === 'text') showText(first.text, first.version);
      else showText('', undefined);
      if (focused) editor.focus();
    })();
    return () => {
      disposed = true;
      const c = created ?? ed.current;
      ed.current = undefined;
      c?.editor.getModel()?.dispose();
      c?.editor.dispose();
    };
    // focused only matters for the first load.
  }, [m, path, showText]);

  useEffect(() => {
    ed.current?.editor.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    if (focused) ed.current?.editor.focus();
  }, [focused]);

  // A change on disk: loaded again without unsaved changes, else offered.
  useEffect(() => {
    if (status.kind !== 'ready') return;
    const check = async () => {
      if (document.visibilityState !== 'visible' || saving) return;
      const [e] = await filesApi.stat(m, [path]).catch(() => []);
      if (!e) return;
      const v = version.current;
      const same = v ? e.exists && e.size === v.size && e.mtime === v.mtime : !e.exists;
      if (same) return;
      if (dirty) setStatus({ kind: 'conflict', removed: !e.exists });
      else if (e.exists) void reload();
    };
    const id = setInterval(check, CHECK_MS);
    return () => clearInterval(id);
  }, [m, path, status.kind, dirty, saving, reload]);

  const changed = useQuickDiff(m, path, ed, status.kind === 'ready' || status.kind === 'conflict');
  const open = quickDiff()?.openChanges;
  const changes =
    changed > 0 && open ? (
      <button
        className="icon"
        title={t('files.openChanges', { n: changed })}
        aria-label={t('files.openChanges', { n: changed })}
        onClick={() => open(m, path)}
      >
        <FileDiff />
      </button>
    ) : null;

  const name = path.split('/').pop() || path;
  const note = (key: Parameters<typeof t>[0]) => (
    <div className="files-editor-note muted">
      <p>{t(key, { name })}</p>
      <a className="btn" href={fileUrl(m, path, true)}>
        <Download /> {t('preview.download')}
      </a>
    </div>
  );

  return (
    <div className="files-editor" data-autofocus tabIndex={-1}>
      <EditorBar m={m} pane={pane} view={view}>
        {dirty && (
          <span className="files-dirty" title={t('files.unsaved')} aria-label={t('files.unsaved')}>
            ●
          </span>
        )}
        {readOnly && <span className="tag">{t('files.readOnly')}</span>}
        <span className="spacer" />
        {changes}
        <button className="icon" title={t('files.revert')} aria-label={t('files.revert')} onClick={() => void reload()}>
          <RotateCcw />
        </button>
        {!readOnly && (
          <button
            className="icon"
            title={t('files.save')}
            aria-label={t('files.save')}
            disabled={saving || status.kind !== 'ready' || !dirty}
            onClick={() => void save()}
          >
            <Save />
          </button>
        )}
      </EditorBar>
      {status.kind === 'conflict' && (
        <div className="files-conflict" role="alert">
          <span>{t(status.removed ? 'files.conflict.removed' : 'files.conflict.changed', { name })}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => void reload()}>
            {t('files.conflict.reload')}
          </button>
          {!readOnly && (
            <button className="primary danger" onClick={() => void save(true)}>
              {t('files.conflict.overwrite')}
            </button>
          )}
          <button className="btn" onClick={() => setStatus({ kind: 'ready' })}>
            {t('files.conflict.keep')}
          </button>
        </div>
      )}
      {status.kind === 'binary' && note('files.binary')}
      {status.kind === 'tooLarge' && note('files.tooLarge')}
      {status.kind === 'notUtf8' && note('files.notUtf8')}
      {status.kind === 'error' && <div className="files-editor-note error">{status.message}</div>}
      {status.kind === 'loading' && <div className="files-editor-note muted">{t('files.loading')}</div>}
      <div ref={host} className="files-editor-host" hidden={status.kind !== 'ready' && status.kind !== 'conflict'} />
    </div>
  );
}

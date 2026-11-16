// The file explorer's editor pane ({view: {plugin: 'files', kind: 'editor',
// path, preview}}): a text file of the pane's machine in Monaco, or an
// image, video, audio file or PDF as Quick Look shows it. A preview (a
// single click in the tree) is replaced by the next one until it is kept:
// by a double click, the pin button or the first edit. Cmd+S (Ctrl+S)
// saves it, with the size and modification time it was loaded with: a file
// changed since (by a program, another page) is not overwritten; the pane
// offers to load it again or to overwrite it. While the text has no unsaved
// changes, a change on disk loads it again by itself, as an edit that undo
// takes back; typing meanwhile keeps the text and offers the change.
// Binary files, text that is not UTF-8 and files over MAX_SIZE offer a
// download; a UTF-8 byte order mark is kept. Read-only mode edits nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveHandlers } from '../saveKey';
import { Download, FileDiff, FolderTree, Pin, RotateCcw, Save } from 'lucide-react';
import { fileUrl } from '../../lib/files';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { keepEdit, keptEdit, takeEdit, useUnsaved, type KeptEdit } from '../../unsaved';
import type { PaneViewProps } from '../api';
import { createEditor, type CodeEditor, type Monaco, type TextModel } from '../monaco';
import { ConflictError, errorText, FilesError, filesApi, type Entry } from './api';
import { keepEditor, reveal } from './ops';
import { lineChanges, quickDiff, type LineChange } from './quickDiff';
import { useDecorationVersion } from './decorations';
import { startPolling } from './poller';
import { isMediaPath, MediaView } from '../../components/PreviewPane';
import { isMixed, restoreEols, useMixedLineEndings } from '../../eol';
import './files.css';

/** The largest file the editor opens (the core's limit for a save). */
export const MAX_SIZE = 8 << 20;
/** How often an open file is checked for changes on disk. */
export const CHECK_MS = 5000;

/** A file's size and modification time as the editor loaded or saved it;
 * bom: it starts with a UTF-8 byte order mark, which the editor does not
 * show and a save writes back. */
export interface Version {
  size: number;
  mtime: number;
  bom?: boolean;
}

/** The UTF-8 byte order mark, as text. */
const BOM = '﻿';

/** A file's state on disk as a key: what Keep Editing dismissed. */
const diskKey = (e: Pick<Entry, 'exists' | 'size' | 'mtime'>) => (e.exists ? `${e.size}:${e.mtime}` : 'gone');

/** Why a file could not be read, from the status of /file (404 is a file
 * not there yet, not a failure). */
function readFailure(r: Response, body = ''): string {
  if (r.status === 403) return t('files.error.denied');
  if (r.status === 502 || r.status === 504) return t('files.error.transport');
  return t('files.readFailed', { error: body.trim() || r.statusText || `HTTP ${r.status}` });
}

/** Puts text in model. Into text it showed already, as one edit of the
 * part that changed (the cursor stays, undo takes it back); a new model
 * just takes it. */
export function applyText(monaco: Monaco, model: TextModel, text: string, edit: boolean) {
  const old = model.getValue();
  if (old === text) return;
  if (!edit) return model.setValue(text);
  const max = Math.min(old.length, text.length);
  let a = 0;
  while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  // Not inside a surrogate pair or a CRLF.
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  if (a > 0 && (high(old.charCodeAt(a - 1)) || old[a - 1] === '\r')) a--;
  const end = old.length - b;
  if (b > 0 && (high(old.charCodeAt(end - 1)) || (old[end] === '\n' && old[end - 1] === '\r'))) b--;
  const from = model.getPositionAt(a);
  const to = model.getPositionAt(old.length - b);
  model.pushStackElement();
  model.pushEditOperations(
    [],
    [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: text.slice(a, text.length - b) }],
    () => null,
  );
  model.pushStackElement();
  // Line ends the model made its own.
  if (model.getValue() !== text) model.setValue(text);
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

/** Reads a file for the editor. Only a file not there (404) is missing: a
 * file that could not be read is an error, never an empty new file. */
export async function loadText(m: string, path: string): Promise<Loaded> {
  const url = fileUrl(m, path);
  const head = await fetch(url, { method: 'HEAD' });
  if (head.status === 404) return { kind: 'missing' };
  if (!head.ok) return { kind: 'error', message: readFailure(head) };
  const size = Number(head.headers.get('Content-Length') ?? 0);
  if (size > MAX_SIZE) return { kind: 'tooLarge' };
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return { kind: 'error', message: readFailure(r, await r.text().catch(() => '')) };
  const version = versionOf(r.headers.get('ETag'));
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary' };
  let text: string;
  try {
    // The byte order mark stays in the text here, to be taken off below.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return { kind: 'notUtf8' };
  }
  const bom = text.startsWith(BOM);
  return { kind: 'text', text: bom ? text.slice(1) : text, version: { ...(version ?? { size: buf.length, mtime: 0 }), bom } };
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  // disk: the file's state on disk (diskKey) when it is known.
  | { kind: 'conflict'; removed: boolean; disk?: string }
  | Exclude<Loaded, { kind: 'text' }>;

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

/** An editor's unsaved text while its pane's component is not mounted. */
interface KeptText extends KeptEdit {
  path: string;
  model: TextModel;
  version: Version | undefined;
  savedAt: number;
  /** The text as loaded or saved (its line endings, eol.ts). */
  raw: string;
}

function TextEditor({ m, pane, view, focused }: PaneViewProps) {
  const path = String(view.path ?? '');
  const readOnly = useStore((s) => s.readOnly);
  // A file that mixes line endings (eol.ts): Monaco shows one kind; a
  // save keeps each line's own (keep), writes Monaco's (unify), or the
  // file is not edited (readOnly).
  const eolMode = useMixedLineEndings();
  const [mixed, setMixed] = useState(false);
  /** The text as loaded or saved, whose line endings a save keeps. */
  const raw = useRef('');
  const locked = readOnly || (mixed && eolMode === 'readOnly');
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

  /** The model a text was shown in: the next text is an edit of it. */
  const shown = useRef<TextModel | undefined>(undefined);
  /** The file starts with a byte order mark, which a save writes back. */
  const bom = useRef(false);
  /** The state on disk Keep Editing dismissed (diskKey): the bar comes back
   * only for a newer change. */
  const dismissed = useRef<string | undefined>(undefined);

  const showText = useCallback((text: string, v: Version | undefined) => {
    version.current = v;
    bom.current = !!v?.bom;
    raw.current = text;
    setMixed(isMixed(text));
    dismissed.current = undefined;
    const c = ed.current;
    const model = c?.editor.getModel() ?? undefined;
    if (c && model) applyText(c.monaco, model, text, shown.current === model);
    shown.current = model;
    markClean();
    setStatus({ kind: 'ready' });
  }, []);

  /** Loads the file (again). In the background (the file changed on disk
   * while the text had no changes), typing meanwhile wins: the text stays
   * and the bar offers the change. */
  const reload = useCallback(
    async (background = false) => {
      const model = background ? ed.current?.editor.getModel() : undefined;
      const at = model?.getVersionId();
      const r = await loadText(m, path).catch((e): Loaded => ({ kind: 'error', message: errorText(e) }));
      if (background && model) {
        if (ed.current?.editor.getModel() !== model) return r; // closed meanwhile
        if (model.getVersionId() !== at) {
          if (r.kind === 'text' || r.kind === 'missing') {
            const disk = r.kind === 'text' ? diskKey({ exists: true, ...r.version }) : 'gone';
            if (disk !== dismissed.current) setStatus({ kind: 'conflict', removed: r.kind === 'missing', disk });
          }
          return r;
        }
      }
      if (r.kind === 'text') showText(r.text, r.version);
      else if (r.kind === 'missing' && ed.current) showText('', undefined);
      else setStatus(r);
      return r;
    },
    [m, path, showText],
  );

  const save = useCallback(
    async (force = false) => {
      const e = ed.current?.editor;
      if (!e || locked) return false;
      const body = eolMode === 'keep' ? restoreEols(raw.current, e.getValue()) : e.getValue();
      const text = (bom.current ? BOM : '') + body;
      const at = e.getModel()?.getAlternativeVersionId() ?? 0;
      setSaving(true);
      try {
        const r = await filesApi.write(m, path, text, force ? 'force' : (version.current ?? 'new'));
        if (r.entry) version.current = { size: r.entry.size, mtime: r.entry.mtime, bom: bom.current };
        raw.current = body;
        setMixed(isMixed(body));
        dismissed.current = undefined;
        savedAt.current = at;
        setDirty((e.getModel()?.getAlternativeVersionId() ?? 0) !== at);
        setStatus({ kind: 'ready' });
        return true;
      } catch (err) {
        if (err instanceof ConflictError) setStatus({ kind: 'conflict', removed: !err.current.exists, disk: diskKey(err.current) });
        else {
          // A write that stopped partway changed the file: saving again
          // overwrites it, whatever it holds now.
          const again =
            err instanceof FilesError && err.code === 'partial_write'
              ? { label: t('files.saveAgain'), run: () => void saveRef.current(true) }
              : undefined;
          useStore.getState().toast(t('files.saveFailed', { error: errorText(err) }), again, undefined, 'error');
        }
        return false;
      } finally {
        setSaving(false);
      }
    },
    [m, path, locked, eolMode],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveKeys = useMemo(() => saveHandlers(() => saveRef.current()), []);
  // The first edit keeps a preview open, as in VS Code.
  useEffect(() => {
    if (dirty && view.preview === true) keepEditor(m, pane);
  }, [dirty, view.preview, m, pane]);
  // Closing the pane with changes not saved asks first (unsaved.ts).
  useUnsaved(m, pane, dirty, path.slice(path.lastIndexOf('/') + 1) || path, () => saveRef.current());

  // The editor, once; the file, for each path. Text with unsaved changes
  // outlives the component while the pane is in its layout (unsaved.ts):
  // the pane takes it back, with the version it was edited from, when it
  // shows again.
  useEffect(() => {
    let disposed = false;
    let created: { editor: CodeEditor; monaco: Monaco } | undefined;
    let sub: { dispose(): void } | undefined;
    let keys: { dispose(): void } | undefined;
    (async () => {
      const first = await loadText(m, path).catch((e): Loaded => ({ kind: 'error', message: errorText(e) }));
      if (disposed) return;
      const held = keptEdit<KeptText>(m, pane)?.path === path;
      if (first.kind !== 'text' && first.kind !== 'missing' && !held) return setStatus(first);
      const el = host.current;
      if (!el) return;
      created = await createEditor(el, { readOnly: useStore.getState().readOnly });
      if (disposed) return created.editor.dispose();
      const { monaco, editor } = created;
      // A model of the pane's own: another pane of the file has its own text.
      const uri = monaco.Uri.from({ scheme: 'file', path, query: `m=${m}&pane=${pane}` });
      const kept = takeEdit<KeptText>(m, pane, (k) => k.path === path);
      if (kept) {
        version.current = kept.version;
        savedAt.current = kept.savedAt;
        bom.current = !!kept.version?.bom;
        raw.current = kept.raw;
        setMixed(isMixed(kept.raw));
      }
      const model = kept?.model ?? monaco.editor.getModel(uri) ?? monaco.editor.createModel('', undefined, uri);
      editor.setModel(model);
      ed.current = created;
      keys = editor.onKeyDown((e) => saveKeys.editor(e, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS));
      sub = model.onDidChangeContent(() => setDirty(model.getAlternativeVersionId() !== savedAt.current));
      if (kept) {
        setDirty(model.getAlternativeVersionId() !== kept.savedAt);
        setStatus({ kind: 'ready' });
      } else if (first.kind === 'text') showText(first.text, first.version);
      else showText('', undefined);
      if (focused) editor.focus();
    })();
    return () => {
      disposed = true;
      const c = created ?? ed.current;
      ed.current = undefined;
      sub?.dispose();
      keys?.dispose();
      const model = c?.editor.getModel();
      c?.editor.dispose();
      if (!model) return;
      if (model.getAlternativeVersionId() === savedAt.current) return model.dispose();
      const base = version.current;
      const loaded = raw.current;
      const keep = eolMode === 'keep';
      keepEdit<KeptText>(m, pane, {
        name: path.slice(path.lastIndexOf('/') + 1) || path,
        path,
        model,
        version: base,
        savedAt: savedAt.current,
        raw: loaded,
        save: async () => {
          try {
            const body = keep ? restoreEols(loaded, model.getValue()) : model.getValue();
            await filesApi.write(m, path, (base?.bom ? BOM : '') + body, base ?? 'new');
            return true;
          } catch (err) {
            useStore.getState().toast(t('files.saveFailed', { error: errorText(err) }), undefined, undefined, 'error');
            return false;
          }
        },
        dispose: () => model.dispose(),
      });
    };
    // focused only matters for the first load.
  }, [m, path, showText]);

  useEffect(() => {
    ed.current?.editor.updateOptions({ readOnly: locked });
  }, [locked]);

  useEffect(() => {
    if (focused) ed.current?.editor.focus();
  }, [focused]);

  // A change on disk: loaded again without unsaved changes, else offered
  // (not again for the change Keep Editing dismissed). One check at a time,
  // less often after failures (poller.ts).
  useEffect(() => {
    if (status.kind !== 'ready') return;
    let live = true;
    const check = async () => {
      if (saving) return;
      const [e] = await filesApi.stat(m, [path]);
      if (!live || !e || e.error) return;
      const v = version.current;
      const same = v ? e.exists && e.size === v.size && e.mtime === v.mtime : !e.exists;
      if (same) return;
      const disk = diskKey(e);
      if (dirty) {
        if (disk !== dismissed.current) setStatus({ kind: 'conflict', removed: !e.exists, disk });
      } else if (e.exists) await reload(true);
    };
    const stop = startPolling(CHECK_MS, check);
    return () => {
      live = false;
      stop();
    };
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
    <div className="files-editor" data-autofocus tabIndex={-1} onKeyDown={saveKeys.root}>
      <EditorBar m={m} pane={pane} view={view}>
        {dirty && (
          <span className="files-dirty" title={t('files.unsaved')} aria-label={t('files.unsaved')}>
            ●
          </span>
        )}
        {locked && <span className="tag">{t('files.readOnly')}</span>}
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
            disabled={saving || status.kind !== 'ready' || !dirty || locked}
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
          {!locked && (
            <button className="primary danger" onClick={() => void save(true)}>
              {t('files.conflict.overwrite')}
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              dismissed.current = status.disk;
              setStatus({ kind: 'ready' });
            }}
          >
            {t('files.conflict.keep')}
          </button>
        </div>
      )}
      {mixed && (status.kind === 'ready' || status.kind === 'conflict') && (
        <div className="callout eol-note" role="note">
          {t(eolMode === 'readOnly' ? 'eol.readOnly' : eolMode === 'unify' ? 'eol.unify' : 'eol.keep', { name })}
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

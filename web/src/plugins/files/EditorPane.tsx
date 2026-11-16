// The file explorer's editor pane ({view: {plugin: 'files', kind: 'editor',
// path}}): a text file of the pane's machine in Monaco. Cmd+S (Ctrl+S)
// saves it, with the size and modification time it was loaded with: a file
// changed since (by a program, another page) is not overwritten; the pane
// offers to load it again or to overwrite it. While the text has no unsaved
// changes, a change on disk loads it again by itself. Binary files, text
// that is not UTF-8 and files over MAX_SIZE open in Quick Look instead.
// Read-only mode edits nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, FolderTree, RotateCcw, Save } from 'lucide-react';
import { fileUrl } from '../../lib/files';
import { shortPath } from '../../lib/machine';
import { actions } from '../../actions';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { useUnsaved } from '../../unsaved';
import type { PaneViewProps } from '../api';
import { createEditor, type CodeEditor, type Monaco } from '../monaco';
import { ConflictError, errorText, filesApi } from './api';
import { reveal } from './ops';
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

export function EditorPane({ m, pane, view, focused }: PaneViewProps) {
  const path = String(view.path ?? '');
  const readOnly = useStore((s) => s.readOnly);
  const home = useStore((s) => s.machines[m]?.info?.home);
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
        else useStore.getState().toast(t('files.saveFailed', { error: errorText(err) }));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [m, path, readOnly],
  );
  const saveRef = useRef(save);
  saveRef.current = save;
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

  const name = path.split('/').pop() || path;
  const note = (key: Parameters<typeof t>[0]) => (
    <div className="files-editor-note muted">
      <p>{t(key, { name })}</p>
      <button className="btn" onClick={() => void actions.openPreview(m, path)}>
        <Eye /> {t('files.quickLook')}
      </button>
    </div>
  );

  return (
    <div className="files-editor" data-autofocus tabIndex={-1}>
      <div className="files-editor-bar">
        <span className="files-editor-path ellipsis" title={path}>
          {shortPath(path, home)}
        </span>
        {dirty && (
          <span className="files-dirty" title={t('files.unsaved')} aria-label={t('files.unsaved')}>
            ●
          </span>
        )}
        {readOnly && <span className="muted small">{t('files.readOnly')}</span>}
        <span className="spacer" />
        <button className="icon" title={t('files.reveal')} aria-label={t('files.reveal')} onClick={() => reveal(m, path)}>
          <FolderTree />
        </button>
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
      </div>
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

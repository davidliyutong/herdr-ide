// The Git plugin's diff pane ({view: {plugin: 'git', kind: 'diff', repo,
// path, mode, …}}): a file's two versions in Monaco's diff editor, side by
// side or inline, unchanged regions folded, with the previous and next
// change. Modes: worktree (the index left, the working tree right,
// editable: Cmd/Ctrl+S saves through the file explorer's save), staged
// (HEAD left, the index right), commit (the parent left, the commit right)
// and compare (one commit left, another right). Whole files and the
// selected ranges (patch.ts) are staged, unstaged or discarded from its
// toolbar.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Columns2, FileText, FoldVertical, Minus, Plus, RefreshCw, Rows2, Save, Undo2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { confirmDialog } from '../../dialog';
import { t } from '../../i18n';
import type { PaneViewProps } from '../api';
import { useUnsaved } from '../../unsaved';
import { createDiffEditor, type DiffEditor, type Monaco } from '../monaco';
import { ConflictError, filesApi, errorText as filesError } from '../files/api';
import { gitApi, errorText, type Blob } from './api';
import { baseName, join, openFile, short, type DiffMode, type DiffView } from './ops';
import { rangePatch, type Direction, type LineRange, type Side } from './patch';
import { changed, runGit, useRepo } from './state';
import './git.css';

export function diffOf(view: Record<string, unknown>): DiffView {
  const s = (k: string) => (typeof view[k] === 'string' ? (view[k] as string) : undefined);
  return {
    repo: s('repo') ?? '',
    path: s('path') ?? '',
    mode: (s('mode') as DiffMode) ?? 'worktree',
    rev: s('rev'),
    rev2: s('rev2'),
    orig: s('orig'),
    parent: typeof view.parent === 'number' ? view.parent : undefined,
    untracked: view.untracked === true || undefined,
  };
}

/** The title of a diff pane. */
export function diffTitle(d: DiffView): string {
  const name = baseName(d.path);
  switch (d.mode) {
    case 'worktree':
      return t('git.diff.worktreeTitle', { name });
    case 'staged':
      return t('git.diff.stagedTitle', { name });
    case 'commit':
      return `${name} (${short(d.rev ?? '')})`;
    default:
      return `${name} (${short(d.rev ?? '')} ↔ ${short(d.rev2 ?? '')})`;
  }
}

const EMPTY: Blob = { exists: false, text: '', size: 0 };

/** Both sides of a diff. */
export async function loadSides(m: string, d: DiffView): Promise<{ left: Blob; right: Blob }> {
  const left = d.orig ?? d.path;
  switch (d.mode) {
    case 'worktree': {
      const [l, r] = await Promise.all([
        d.untracked ? EMPTY : gitApi.blob(m, d.repo, d.path, 'index'),
        gitApi.blob(m, d.repo, d.path, 'worktree'),
      ]);
      // A conflicted file has no entry of its own in the index: HEAD's.
      return { left: l.exists || d.untracked ? l : await gitApi.blob(m, d.repo, d.path, 'head'), right: r };
    }
    case 'staged': {
      const [l, r] = await Promise.all([gitApi.blob(m, d.repo, left, 'head'), gitApi.blob(m, d.repo, d.path, 'index')]);
      return { left: l, right: r };
    }
    case 'commit': {
      const [l, r] = await Promise.all([gitApi.blob(m, d.repo, left, d.rev!, d.parent ?? 1), gitApi.blob(m, d.repo, d.path, d.rev!)]);
      return { left: l, right: r };
    }
    default: {
      const [l, r] = await Promise.all([gitApi.blob(m, d.repo, left, d.rev!), gitApi.blob(m, d.repo, d.path, d.rev2!)]);
      return { left: l, right: r };
    }
  }
}

/** The lines of selections (a selection ending at a line's start does
 * not take that line). */
export function selectedLines(sels: { startLineNumber: number; endLineNumber: number; endColumn: number }[]): LineRange[] {
  return sels.map((s) => ({
    startLine: s.startLineNumber,
    endLine: s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber,
  }));
}

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'binary' | 'tooLarge' } | { kind: 'error'; message: string };

/** The keys of diff panes with unsaved edits. */
export const dirtyDiffs = new Set<string>();

export function DiffPane({ m, pane, view, focused }: PaneViewProps) {
  const d = diffOf(view);
  const readOnly = useStore((s) => s.readOnly);
  const st = useRepo(m, d.repo);
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<{ editor: DiffEditor; monaco: Monaco }>(undefined);
  const sides = useRef<{ left: Blob; right: Blob }>({ left: EMPTY, right: EMPTY });
  const lastSide = useRef<Side>('modified');
  const savedAt = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [inline, setInline] = useState(false);
  const [fold, setFold] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [changes, setChanges] = useState(0);
  // Panes with unsaved edits keep their file when another one opens (ops.ts openDiff).
  useEffect(() => {
    if (dirty) dirtyDiffs.add(pane);
    else dirtyDiffs.delete(pane);
    return () => void dirtyDiffs.delete(pane);
  }, [dirty, pane]);
  const editable = d.mode === 'worktree' && !readOnly;
  const key = `${d.repo}\u0000${d.path}\u0000${d.mode}\u0000${d.rev ?? ''}\u0000${d.rev2 ?? ''}\u0000${d.parent ?? ''}\u0000${d.orig ?? ''}`;

  const show = useCallback(
    async (keepDirty = false) => {
      let s: { left: Blob; right: Blob };
      try {
        s = await loadSides(m, d);
      } catch (e) {
        setStatus({ kind: 'error', message: errorText(e) });
        return;
      }
      if (s.left.binary || s.right.binary) return setStatus({ kind: 'binary' });
      if (s.left.tooLarge || s.right.tooLarge) return setStatus({ kind: 'tooLarge' });
      sides.current = s;
      const c = ed.current;
      const model = c?.editor.getModel();
      if (model) {
        if (model.original.getValue() !== s.left.text) model.original.setValue(s.left.text);
        if (!keepDirty && model.modified.getValue() !== s.right.text) model.modified.setValue(s.right.text);
        if (!keepDirty) {
          savedAt.current = model.modified.getAlternativeVersionId();
          setDirty(false);
        }
      }
      setStatus({ kind: 'ready' });
    },
    // The view's fields are in key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, key],
  );

  const save = useCallback(async () => {
    const c = ed.current;
    if (!c || !editable) return false;
    const model = c.editor.getModel()!.modified;
    const text = model.getValue();
    const at = model.getAlternativeVersionId();
    const r = sides.current.right;
    try {
      const res = await filesApi.write(m, join(d.repo, d.path), text, r.exists ? { mtime: r.mtime ?? 0, size: r.size } : 'new');
      if (res.entry) sides.current.right = { ...r, exists: true, text, size: res.entry.size, mtime: res.entry.mtime };
      savedAt.current = at;
      setDirty(model.getAlternativeVersionId() !== at);
      void changed(m, d.repo);
      return true;
    } catch (e) {
      if (e instanceof ConflictError) {
        useStore
          .getState()
          .toast(t('git.diff.conflict', { name: baseName(d.path) }), { label: t('git.diff.reload'), run: () => void show() });
      } else useStore.getState().toast(t('git.diff.saveFailed', { error: filesError(e) }));
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, key, editable, show]);
  const saveRef = useRef(save);
  saveRef.current = save;
  // Closing the pane with changes not saved asks first (unsaved.ts).
  useUnsaved(m, pane, dirty, baseName(d.path), () => saveRef.current());

  // The editor, once per file and mode.
  useEffect(() => {
    let disposed = false;
    let created: { editor: DiffEditor; monaco: Monaco } | undefined;
    setStatus({ kind: 'loading' });
    (async () => {
      const el = host.current;
      if (!el) return;
      created = await createDiffEditor(el, { readOnly: !editable, originalEditable: false, renderSideBySide: !inline });
      if (disposed) return created.editor.dispose();
      const { monaco, editor } = created;
      const uri = (side: string) => monaco.Uri.from({ scheme: `git-${side}`, path: '/' + d.path, query: `m=${m}&pane=${pane}` });
      const original = monaco.editor.getModel(uri('l')) ?? monaco.editor.createModel('', undefined, uri('l'));
      const modified = monaco.editor.getModel(uri('r')) ?? monaco.editor.createModel('', undefined, uri('r'));
      editor.setModel({ original, modified });
      ed.current = created;
      editor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
      editor.getModifiedEditor().onDidFocusEditorText(() => (lastSide.current = 'modified'));
      editor.getOriginalEditor().onDidFocusEditorText(() => (lastSide.current = 'original'));
      modified.onDidChangeContent(() => setDirty(modified.getAlternativeVersionId() !== savedAt.current));
      editor.onDidUpdateDiff(() => setChanges(editor.getLineChanges()?.length ?? 0));
      await show();
      if (focused) editor.getModifiedEditor().focus();
    })();
    return () => {
      disposed = true;
      const c = created ?? ed.current;
      ed.current = undefined;
      const model = c?.editor.getModel();
      c?.editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, key]);

  useEffect(() => {
    ed.current?.editor.updateOptions({ renderSideBySide: !inline, hideUnchangedRegions: { enabled: fold } });
  }, [inline, fold]);
  useEffect(() => {
    ed.current?.editor.getModifiedEditor().updateOptions({ readOnly: !editable });
  }, [editable]);
  useEffect(() => {
    if (focused) ed.current?.editor.getModifiedEditor().focus();
  }, [focused]);

  // The repository changed (a commit, a change elsewhere): both sides are
  // read again; unsaved text stays.
  const version = st?.version ?? 0;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (status.kind === 'ready') void show(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  /** The patch of the selected ranges: staging goes forward from the
   * index; unstaging (from the index) and discarding (from the working
   * tree) go backward from the right side. */
  const patchFor = (direction: Direction): string | undefined => {
    const c = ed.current;
    if (!c) return undefined;
    const side = lastSide.current;
    const e = side === 'modified' ? c.editor.getModifiedEditor() : c.editor.getOriginalEditor();
    const model = c.editor.getModel()!;
    const sel = selectedLines(e.getSelections() ?? []);
    return rangePatch(d.path, model.original.getValue(), model.modified.getValue(), c.editor.getLineChanges() ?? [], sel, side, direction);
  };

  const applyRanges = async (what: 'stage' | 'unstage' | 'discard') => {
    if (what === 'discard' && dirty) return useStore.getState().toast(t('git.diff.saveFirst'));
    const patch = patchFor(what === 'stage' ? 'forward' : 'backward');
    if (!patch) return useStore.getState().toast(t('git.diff.noRanges'));
    if (what === 'discard') {
      const ok = await confirmDialog({
        title: t('git.discard.title'),
        message: t('git.diff.discardRanges'),
        confirm: t('git.discard'),
        danger: true,
      });
      if (!ok) return;
    }
    if (await runGit(m, d.repo, 'applyPatch', { patch, cached: what !== 'discard' })) await show(what !== 'discard' && dirty);
  };

  const wholeFile = async (what: 'stage' | 'unstage') => {
    if (what === 'stage' && dirty) await save();
    if (await runGit(m, d.repo, what, { paths: [d.path] })) await show(dirty);
  };

  const go = (dir: 'next' | 'previous') => ed.current?.editor.goToDiff(dir);
  const name = baseName(d.path);
  const canRanges = !readOnly && status.kind === 'ready' && changes > 0;

  return (
    <div className="git-diff" data-autofocus tabIndex={-1}>
      <div className="git-diff-bar">
        <span className="git-diff-path ellipsis" title={d.orig ? `${d.orig} → ${d.path}` : d.path}>
          {diffTitle(d)}
        </span>
        {dirty && (
          <span className="git-dirty" title={t('git.diff.unsaved')} aria-label={t('git.diff.unsaved')}>
            ●
          </span>
        )}
        <span className="spacer" />
        <span className="muted small">{t('git.diff.changes', { n: changes })}</span>
        <button className="icon" title={t('git.diff.previous')} aria-label={t('git.diff.previous')} onClick={() => go('previous')}>
          <ArrowUp />
        </button>
        <button className="icon" title={t('git.diff.next')} aria-label={t('git.diff.next')} onClick={() => go('next')}>
          <ArrowDown />
        </button>
        <button
          className={`icon${inline ? ' on' : ''}`}
          title={t(inline ? 'git.diff.sideBySide' : 'git.diff.inline')}
          aria-label={t(inline ? 'git.diff.sideBySide' : 'git.diff.inline')}
          onClick={() => setInline(!inline)}
        >
          {inline ? <Columns2 /> : <Rows2 />}
        </button>
        <button
          className={`icon${fold ? ' on' : ''}`}
          title={t('git.diff.fold')}
          aria-label={t('git.diff.fold')}
          aria-pressed={fold}
          onClick={() => setFold(!fold)}
        >
          <FoldVertical />
        </button>
        <button className="icon" title={t('git.diff.reload')} aria-label={t('git.diff.reload')} onClick={() => void show(false)}>
          <RefreshCw />
        </button>
        {d.mode === 'worktree' && (
          <button
            className="icon"
            title={t('git.openFile')}
            aria-label={t('git.openFile')}
            onClick={() => void openFile(m, d.repo, d.path)}
          >
            <FileText />
          </button>
        )}
        {editable && (
          <button className="icon" title={t('git.diff.save')} aria-label={t('git.diff.save')} disabled={!dirty} onClick={() => void save()}>
            <Save />
          </button>
        )}
      </div>
      {!readOnly && (d.mode === 'worktree' || d.mode === 'staged') && (
        <div className="git-diff-actions">
          {d.mode === 'worktree' ? (
            <>
              <button className="btn" onClick={() => void wholeFile('stage')}>
                <Plus /> {t('git.diff.stageFile')}
              </button>
              <button className="btn" disabled={!canRanges || d.untracked} onClick={() => void applyRanges('stage')}>
                {t('git.diff.stageRanges')}
              </button>
              <button className="btn" disabled={!canRanges || d.untracked} onClick={() => void applyRanges('discard')}>
                <Undo2 /> {t('git.diff.discardRanges.button')}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void wholeFile('unstage')}>
                <Minus /> {t('git.diff.unstageFile')}
              </button>
              <button className="btn" disabled={!canRanges} onClick={() => void applyRanges('unstage')}>
                {t('git.diff.unstageRanges')}
              </button>
            </>
          )}
        </div>
      )}
      {status.kind === 'binary' && <div className="git-note muted">{t('git.diff.binary', { name })}</div>}
      {status.kind === 'tooLarge' && <div className="git-note muted">{t('git.diff.tooLarge', { name })}</div>}
      {status.kind === 'error' && <div className="git-note error">{status.message}</div>}
      {status.kind === 'loading' && <div className="git-note muted">{t('git.loading')}</div>}
      <div ref={host} className="git-diff-host" hidden={status.kind !== 'ready'} />
    </div>
  );
}

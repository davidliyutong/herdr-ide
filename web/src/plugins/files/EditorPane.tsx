// The file explorer's editor pane ({view: {plugin: 'files', kind: 'editor',
// path, preview}}): a text file of the pane's machine in Monaco, a first-class
// Markdown preview/split/source view for .md/.mdx/.markdown files, or an
// image, video, audio file or PDF as Quick Look shows it. A preview (a single
// click in the tree, or Cmd/Ctrl+click on a terminal link) is replaced by the
// next one until it is kept: by a double click, the pin button or the first
// edit. Cmd+S (Ctrl+S) saves it, with the size and modification time it was
// loaded with: a file changed since (by a program, another page) is not
// overwritten; the pane offers to load it again or to overwrite it. While the
// text has no unsaved changes, a change on disk loads it again by itself, as
// an edit that undo takes back; typing meanwhile keeps the text and offers the
// change. Binary files, text that is not UTF-8 and files over MAX_SIZE offer a
// download; a UTF-8 byte order mark is kept. Read-only mode edits nothing.
//
// Loaded files are cached (fileCache.ts) and kept panes stay mounted across
// tab switches (keptPanes.ts) so returning to an already-opened file never
// flashes "Loading..." and only revalidates silently in the background.

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create as createStore } from 'zustand';
import { saveHandlers } from '../saveKey';
import {
  Code as CodeIcon,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileDiff,
  FolderTree,
  Link,
  Pin,
  RotateCcw,
  Save,
  WrapText,
} from 'lucide-react';
import { fileUrl } from '../../lib/files';
import { APP_SLUG } from '../../brand';
import { loadPref, savePref, useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { t } from '../../i18n';
import { keyLabel } from '../../keys';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { useSettings } from '../../settings';
import { openWebLink } from '../../terminal/openLink';
import { keepEdit, keptEdit, takeEdit, useUnsaved, type KeptEdit } from '../../unsaved';
import type { PaneViewProps } from '../api';
import { createEditor, setLanguage, type CodeEditor, type EditorViewState, type Monaco, type TextModel } from '../monaco';
import { ConflictError, errorText, FilesError, filesApi, type Entry } from './api';
import { copyText, keepEditor, loadRevealable, openEditor, reveal, revealEntries } from './ops';
import { lineChanges, quickDiff, type LineChange } from './quickDiff';
import { useDecorationVersion } from './decorations';
import { noteFile } from './gone';
import { startPolling } from './poller';
import { parentOf } from './tree';
import {
  dedupLoad,
  dropCachedFile,
  dropInflightFile,
  getCachedFile,
  putCachedFile,
  resetFileCache,
  REVALIDATE_MS,
  touchCachedFile,
} from './fileCache';
import { isMediaPath, MediaView } from '../../components/PreviewPane';
import { isMarkdownPath, safeLink } from '../../markdown/links';
import { Markdown } from '../../markdown/Markdown';
import { isMixed, restoreEols, useMixedLineEndings } from '../../eol';
import './files.css';

export { isMarkdownPath, resetFileCache };

/** Browser-local override for soft-wrapping in the file explorer's Monaco editor;
 * null falls back to the `files.wordWrap` hub setting. */
const useWordWrapPref = createStore<{ override: boolean | null }>(() => ({
  override: loadPref<boolean | null>('files.wordWrap', null),
}));

/** Toggles soft-wrap in every open editor pane and remembers it in this browser. */
export function setWordWrap(on: boolean) {
  savePref('files.wordWrap', on);
  useWordWrapPref.setState({ override: on });
}

/** Clears the in-memory word-wrap override (for tests). */
export function resetWordWrapPref() {
  useWordWrapPref.setState({ override: null });
}

function useWordWrap(): boolean {
  const override = useWordWrapPref((s) => s.override);
  const setting = useSettings((s) => s.values['files.wordWrap']?.value === true);
  return override ?? setting;
}

/** The largest file the editor opens (the hub's limit for a save). */
export const MAX_SIZE = 8 << 20;
/** How often an open file is checked for changes on disk. */
export const CHECK_MS = 5000;

/** View modes for Markdown files in the editor pane. */
export type MarkdownMode = 'preview' | 'split' | 'source';

/** A file's size and modification time as the editor loaded or saved it;
 * bom: it starts with a UTF-8 byte order mark, which the editor does not
 * show and a save writes back. */
export interface Version {
  size: number;
  mtime: number;
  bom?: boolean;
}

/** The UTF-8 byte order mark, as text. */
const BOM = '\ufeff';

/** A file's state on disk as a key: what Keep Editing dismissed. */
const diskKey = (e: Pick<Entry, 'exists' | 'size' | 'mtime'>) => (e.exists ? `${e.size}:${e.mtime}` : 'gone');

/** Why a file could not be read, from the status of /file (404 is a file
 * not there yet, not a failure). */
function readFailure(r: Response, body = ''): string {
  if (r.status === 403) return t('files.error.denied');
  if (r.status === 502 || r.status === 504) return t('files.error.transport');
  return t('files.readFailed', { error: body.trim() || r.statusText || `HTTP ${r.status}` });
}

/** The line end Monaco gives a model of text (its text buffer's rule):
 * CRLF when more than half the line ends have a CR; undefined without one. */
export function eolOf(text: string): '\n' | '\r\n' | undefined {
  let all = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      all++;
      cr++;
      if (text.charCodeAt(i + 1) === 10) i++;
    } else if (c === 10) all++;
  }
  if (all === 0) return undefined;
  return cr > all / 2 ? '\r\n' : '\n';
}

/** Puts text in model. Into text it showed already, as one edit of the
 * part that changed (the cursor stays, undo takes it back), a change of
 * the line ends as another; a new model just takes it. A model that holds
 * the text already (with its line ends made one kind) stays as it is:
 * setValue would drop its undo history, which Monaco gives a model made
 * again with the same text. */
export function applyText(monaco: Monaco, model: TextModel, text: string, edit: boolean) {
  const eol = eolOf(text);
  if (edit && eol && eol !== model.getEOL()) {
    model.pushStackElement();
    model.pushEOL(eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  }
  const want = text.replace(/\r\n|\r|\n/g, model.getEOL());
  const old = model.getValue();
  if (old === want) return;
  if (!edit) return model.setValue(text);
  text = want;
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
}

/** The version in a file response's ETag (W/"<size hex>-<mtime hex>",
 * backend/features/files). */
export function versionOf(etag: string | null): Version | undefined {
  const m = /^W\/"([0-9a-f]+)-([0-9a-f]+)"$/i.exec(etag ?? '');
  return m ? { size: parseInt(m[1], 16), mtime: parseInt(m[2], 16) } : undefined;
}

export type Loaded =
  | { kind: 'text'; text: string; version: Version }
  | { kind: 'missing' }
  | { kind: 'binary' | 'tooLarge' | 'notUtf8' | 'isDir' }
  | { kind: 'error'; message: string };

/** Reads a file for the editor in a single HTTP request (passing max_size so
 * the hub rejects oversized files with 413 without streaming them, and checking
 * Content-Length as a fallback). Only 404 is missing; any other failure is an
 * error, never an empty new file. */
export async function loadText(m: string, path: string): Promise<Loaded> {
  const url = `${fileUrl(m, path)}&max_size=${MAX_SIZE}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) return { kind: 'missing' };
  if (r.status === 413) return { kind: 'tooLarge' };
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (r.status === 400 && /is a directory/i.test(body)) return { kind: 'isDir' };
    return { kind: 'error', message: readFailure(r, body) };
  }
  const declared = Number(r.headers.get('Content-Length') ?? 0);
  if (declared > MAX_SIZE) {
    void r.body?.cancel?.().catch(() => {});
    return { kind: 'tooLarge' };
  }
  const version = versionOf(r.headers.get('ETag'));
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > MAX_SIZE) return { kind: 'tooLarge' };
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

/** Tells gone.ts what a load found: a file there, or none (404); a file
 * that could not be read says nothing. */
function noteLoaded(m: string, path: string, r: Loaded) {
  if (r.kind === 'missing') noteFile(m, path, false);
  else if (r.kind !== 'error') noteFile(m, path, true);
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  // disk: the file's state on disk (diskKey) when it is known.
  | { kind: 'conflict'; removed: boolean; disk?: string }
  | Exclude<Loaded, { kind: 'text' }>;

/** Shows line (1-based) and col of the editor's file in the middle of the
 * view, with the cursor there; when endLine >= line is also given, selects the
 * target range (e.g. `file.yaml:17-20`). Monaco keeps places past the end
 * within the document. */
export function revealAt(
  editor: Pick<CodeEditor, 'setPosition' | 'revealLineInCenter'> &
    Partial<Pick<CodeEditor, 'setSelection' | 'revealRangeInCenter' | 'getModel'>>,
  line: number,
  col = 1,
  endLine?: number,
  endCol?: number,
) {
  const startLine = Math.max(1, Math.floor(line));
  const startCol = Math.max(1, Math.floor(col));
  editor.setPosition({ lineNumber: startLine, column: startCol });
  if (typeof endLine === 'number' && endLine >= startLine) {
    const model = editor.getModel?.();
    const maxLine = model?.getLineCount?.();
    const clampedEnd = maxLine ? Math.min(Math.floor(endLine), maxLine) : Math.floor(endLine);
    const targetEndCol = typeof endCol === 'number' && endCol > 0 ? Math.floor(endCol) : (model?.getLineMaxColumn?.(clampedEnd) ?? 1);
    const range = {
      startLineNumber: startLine,
      startColumn: startCol,
      endLineNumber: Math.max(startLine, clampedEnd),
      endColumn: Math.max(1, targetEndCol),
    };
    editor.setSelection?.(range);
    if (editor.revealRangeInCenter) editor.revealRangeInCenter(range);
    else editor.revealLineInCenter(startLine);
    return;
  }
  editor.revealLineInCenter(startLine);
}

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
  // Whether the pane's menus offer Reveal in Finder.
  useEffect(() => loadRevealable(m), [m]);
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
function MediaFile({ m, pane, view, focused, shown = true }: PaneViewProps) {
  const path = String(view.path ?? '');
  return (
    <div className="files-editor" data-autofocus tabIndex={-1} onMouseDown={() => !focused && terms.mutate(m, (l) => L.focusPane(l, pane))}>
      <EditorBar m={m} pane={pane} view={view}>
        <span className="spacer" />
        <a className="icon" href={fileUrl(m, path, true)} title={t('preview.download')} aria-label={t('preview.download')}>
          <Download />
        </a>
      </EditorBar>
      <div className="preview-body">
        <MediaView m={m} path={path} shown={shown} />
      </div>
    </div>
  );
}

/** How long after a keystroke the quick diff is computed again. */
const DIFF_DELAY_MS = 250;

/** The editor's quick diff: bars in the gutter and the overview ruler
 * where the text (unsaved changes included) differs from version
 * control's, as VS Code shows them; the number of changed places. */
function useQuickDiff(
  m: string,
  path: string,
  ed: React.RefObject<{ editor: CodeEditor; monaco: Monaco } | undefined>,
  ready: boolean,
  editorTick: number,
) {
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
    if (!ready || !ed.current) return;
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
  }, [m, path, ready, editorTick, version, compute, ed]);

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
  }, [ready, editorTick, ed, compute]);

  // The decorations.
  useEffect(() => {
    const c = ed.current;
    if (!c || !ready || changes.length === 0) return;
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
  }, [changes, ready, editorTick, ed]);

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

/** An editor's view state (cursor, selection, scroll position, folded regions)
 * kept while its pane stays in the layout across tab/workspace switches. */
interface KeptViewState {
  path: string;
  state: EditorViewState;
}

/** Per-pane Markdown view mode and preview scroll position across tab switches. */
interface KeptMarkdownState {
  path: string;
  mode: MarkdownMode;
  scrollTop: number;
}

export const MAX_VIEW_STATES = 64;
const viewStates = new Map<string, KeptViewState>();
const mdStates = new Map<string, KeptMarkdownState>();
const viewKey = (m: string, pane: string) => `${m}\n${pane}`;
let unfollowTerms: (() => void) | undefined;
let unfollowStore: (() => void) | undefined;

function paneGone(m: string, pane: string, machines = useTerms.getState().machines): boolean {
  const known = useStore.getState().machines;
  if (!known[m] && Object.keys(known).length > 0) return true;
  const layout = machines[m]?.layout;
  return !!layout && !layout.workspaces.some((ws) => ws.tabs.some((tb) => L.tabPanes(tb).includes(pane)));
}

function syncViewWatch() {
  if (viewStates.size > 0 || mdStates.size > 0) {
    unfollowTerms ??= useTerms.subscribe((s) => dropGoneViewStates(s.machines));
    unfollowStore ??= useStore.subscribe(() => dropGoneViewStates());
  } else {
    unfollowTerms?.();
    unfollowTerms = undefined;
    unfollowStore?.();
    unfollowStore = undefined;
  }
}

export function keepViewState(m: string, pane: string, path: string, state: EditorViewState) {
  if (paneGone(m, pane)) {
    dropViewState(m, pane);
    return;
  }
  const k = viewKey(m, pane);
  viewStates.delete(k);
  viewStates.set(k, { path, state });
  while (viewStates.size > MAX_VIEW_STATES) viewStates.delete(viewStates.keys().next().value!);
  syncViewWatch();
}

export function keptViewState(m: string, pane: string, path: string): EditorViewState | undefined {
  const entry = viewStates.get(viewKey(m, pane));
  return entry && entry.path === path ? entry.state : undefined;
}

export function takeViewState(m: string, pane: string, path: string): EditorViewState | undefined {
  const k = viewKey(m, pane);
  const entry = viewStates.get(k);
  if (!entry) return undefined;
  viewStates.delete(k);
  syncViewWatch();
  return entry.path === path ? entry.state : undefined;
}

export function dropViewState(m: string, pane: string) {
  const removedA = viewStates.delete(viewKey(m, pane));
  const removedB = mdStates.delete(viewKey(m, pane));
  if (removedA || removedB) syncViewWatch();
}

function keepMarkdownState(m: string, pane: string, path: string, mode: MarkdownMode, scrollTop: number) {
  if (paneGone(m, pane)) {
    mdStates.delete(viewKey(m, pane));
    syncViewWatch();
    return;
  }
  const k = viewKey(m, pane);
  mdStates.delete(k);
  mdStates.set(k, { path, mode, scrollTop });
  while (mdStates.size > MAX_VIEW_STATES) mdStates.delete(mdStates.keys().next().value!);
  syncViewWatch();
}

export function keptMarkdownMode(m: string, pane: string, path: string): MarkdownMode | undefined {
  const entry = mdStates.get(viewKey(m, pane));
  return entry && entry.path === path ? entry.mode : undefined;
}

function keptMarkdownScroll(m: string, pane: string, path: string): number {
  const entry = mdStates.get(viewKey(m, pane));
  return entry && entry.path === path ? entry.scrollTop : 0;
}

export function dropGoneViewStates(machines = useTerms.getState().machines) {
  for (const k of [...viewStates.keys()]) {
    const [m, pane] = k.split('\n');
    if (paneGone(m, pane, machines)) viewStates.delete(k);
  }
  for (const k of [...mdStates.keys()]) {
    const [m, pane] = k.split('\n');
    if (paneGone(m, pane, machines)) mdStates.delete(k);
  }
  syncViewWatch();
}

export function resetViewStates() {
  viewStates.clear();
  mdStates.clear();
  resetFileCache();
  syncViewWatch();
}

function defaultMdMode(m: string, pane: string, path: string, hasLine: boolean, hasKept: boolean): MarkdownMode {
  if (hasLine) return 'source';
  const saved = keptMarkdownMode(m, pane, path);
  if (hasKept) return saved === 'split' ? 'split' : 'source';
  return saved ?? 'preview';
}

function TextEditor({ m, pane, view, focused, shown: paneShown = true }: PaneViewProps) {
  const path = String(view.path ?? '');
  const isMarkdown = isMarkdownPath(path);
  const hasLineTarget = typeof view.line === 'number' && view.line > 0;
  const readOnly = useStore((s) => s.readOnly);
  const wordWrap = useWordWrap();
  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;
  // A file that mixes line endings (eol.ts): Monaco shows one kind; a
  // save keeps each line's own (keep), writes Monaco's (unify), or the
  // file is not edited (readOnly).
  const eolMode = useMixedLineEndings();
  const [mixed, setMixed] = useState(false);
  /** The text as loaded or saved, whose line endings a save keeps. */
  const raw = useRef('');
  const locked = readOnly || (mixed && eolMode === 'readOnly');
  const host = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const ed = useRef<{ editor: CodeEditor; monaco: Monaco }>(undefined);
  /** Bumped whenever Monaco attaches for the current file so hooks (quick diff, reveal) sync. */
  const [editorTick, setEditorTick] = useState(0);
  /** The version on disk the text was loaded or saved as; undefined for a
   * file not there yet. */
  const version = useRef<Version | undefined>(undefined);
  const savedAt = useRef(0);
  const lastChecked = useRef(0);
  const previewScrollTop = useRef(0);

  // Hydrate synchronously from kept unsaved edit or fileCache so switching back
  // to an opened file tab NEVER flashes "Loading..." even if the component remounted.
  const initialKept = keptEdit<KeptText>(m, pane);
  const initialHasKept = initialKept?.path === path;
  const initialCached = initialHasKept ? undefined : getCachedFile(m, path);
  const [status, setStatus] = useState<Status>(() => (initialHasKept || initialCached ? { kind: 'ready' } : { kind: 'loading' }));
  const [content, setContent] = useState<string>(() =>
    initialHasKept ? initialKept.model.getValue() : initialCached ? initialCached.text : '',
  );
  const deferredContent = useDeferredValue(content);
  const [mdMode, setMdMode] = useState<MarkdownMode>(() =>
    isMarkdown ? defaultMdMode(m, pane, path, hasLineTarget, initialHasKept) : 'source',
  );
  const mdModeRef = useRef(mdMode);
  mdModeRef.current = mdMode;
  const currentKey = `${m}\n${pane}\n${path}`;
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  /** The (m, pane, path) key whose text and mdMode are synced and ready for Effect 2. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const pendingKept = useRef<KeptText | undefined>(undefined);
  const loadKeyRef = useRef('');
  const [retry, setRetry] = useState(0);
  const machineStatus = useStore((s) => s.machines[m]?.status);
  const prevMachine = useRef({ m, status: machineStatus });
  const paneShownRef = useRef(paneShown);
  paneShownRef.current = paneShown;

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

  const showText = useCallback(
    (text: string, v: Version | undefined) => {
      const droppedKept = pendingKept.current;
      pendingKept.current = undefined;
      droppedKept?.dispose();
      version.current = v;
      bom.current = !!v?.bom;
      raw.current = text;
      lastChecked.current = Date.now();
      setMixed(isMixed(text));
      setContent(text);
      dismissed.current = undefined;
      if (v) putCachedFile(m, path, text, v, lastChecked.current);
      const c = ed.current;
      const model = c?.editor.getModel() ?? undefined;
      if (c && model) {
        applyText(c.monaco, model, text, shown.current === model);
        setLanguage(c.monaco, model, path);
      }
      shown.current = model;
      markClean();
      setStatus({ kind: 'ready' });
      setLoadedKey(currentKey);
    },
    [m, path, currentKey],
  );

  /** Loads the file (again). In the background (the file changed on disk
   * while the text had no changes), typing meanwhile wins: the text stays
   * and the bar offers the change. */
  const reload = useCallback(
    async (background = false) => {
      const model = background ? ed.current?.editor.getModel() : undefined;
      const at = model?.getVersionId();
      const r = await loadText(m, path).catch((e): Loaded => ({ kind: 'error', message: errorText(e) }));
      if (loadKeyRef.current !== currentKey) return r;
      noteLoaded(m, path, r);
      if (background) {
        if (savingRef.current) return r;
        const nowModel = ed.current?.editor.getModel();
        let edited = false;
        if (model) {
          if (nowModel !== model) return r; // closed meanwhile
          edited = model.getVersionId() !== at;
        } else {
          edited =
            dirtyRef.current ||
            (!!nowModel && nowModel.getAlternativeVersionId() !== savedAt.current) ||
            (!!pendingKept.current && pendingKept.current.model.getAlternativeVersionId() !== pendingKept.current.savedAt);
        }
        if (edited) {
          if (r.kind === 'text' || r.kind === 'missing') {
            const disk = r.kind === 'text' ? diskKey({ exists: true, ...r.version }) : 'gone';
            if (disk !== dismissed.current) setStatus({ kind: 'conflict', removed: r.kind === 'missing', disk });
          }
          return r;
        }
      }
      if (r.kind === 'text') showText(r.text, r.version);
      else if (r.kind === 'missing') {
        dropCachedFile(m, path);
        showText('', undefined);
      } else {
        dropCachedFile(m, path);
        setStatus(r);
      }
      return r;
    },
    [m, path, currentKey, showText],
  );

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current || locked) return false;
      const e = ed.current?.editor;
      const model = e?.getModel() ?? pendingKept.current?.model;
      if (!model) return false;
      const currentValue = model.getValue();
      const body = eolMode === 'keep' ? restoreEols(raw.current, currentValue) : currentValue;
      const wroteBom = bom.current;
      const text = (wroteBom ? BOM : '') + body;
      const at = model.getAlternativeVersionId();
      savingRef.current = true;
      setSaving(true);
      try {
        const r = await filesApi.write(m, path, text, force ? 'force' : (version.current ?? 'new'));
        noteFile(m, path, true);
        const nextVersion = r.entry ? { size: r.entry.size, mtime: r.entry.mtime, bom: wroteBom } : undefined;
        const now = Date.now();
        if (nextVersion) putCachedFile(m, path, body, nextVersion, now);
        if (loadKeyRef.current !== currentKey) return true;
        if (nextVersion) version.current = nextVersion;
        raw.current = body;
        lastChecked.current = now;
        if (!nextVersion && version.current) putCachedFile(m, path, body, version.current, now);
        setMixed(isMixed(body));
        dismissed.current = undefined;
        savedAt.current = at;
        if (pendingKept.current?.model === model) {
          pendingKept.current.savedAt = at;
          pendingKept.current.version = version.current;
          pendingKept.current.raw = body;
        }
        setDirty(model.getAlternativeVersionId() !== at);
        setStatus({ kind: 'ready' });
        return true;
      } catch (err) {
        if (loadKeyRef.current !== currentKey) return false;
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
        if (loadKeyRef.current === currentKey) {
          savingRef.current = false;
          setSaving(false);
        }
      }
    },
    [m, path, currentKey, locked, eolMode],
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

  /** Lightweight stat check against disk: reloads silently if clean and changed,
   * shows conflict bar if dirty and changed, never flashes "Loading...". */
  const checkDisk = useCallback(async () => {
    if (savingRef.current) return;
    const ms = useStore.getState().machines[m]?.status;
    if (ms && ms !== 'ready') return;
    const [e] = await filesApi.stat(m, [path]);
    if (loadKeyRef.current !== currentKey) return;
    if (!e || e.error) return;
    lastChecked.current = Date.now();
    noteFile(m, path, e.exists);
    const v = version.current;
    const same = v ? e.exists && e.size === v.size && e.mtime === v.mtime : !e.exists;
    const now = statusRef.current;
    const disk = diskKey(e);
    if (now.kind === 'conflict') {
      if (same) {
        touchCachedFile(m, path, lastChecked.current);
        setStatus({ kind: 'ready' });
      } else if (now.disk !== disk) setStatus({ kind: 'conflict', removed: !e.exists, disk });
      return;
    }
    if (same) {
      touchCachedFile(m, path, lastChecked.current);
      return;
    }
    if (dirtyRef.current) {
      if (disk !== dismissed.current) setStatus({ kind: 'conflict', removed: !e.exists, disk });
    } else if (e.exists) {
      await reload(true);
    } else {
      dropCachedFile(m, path);
    }
  }, [m, path, currentKey, reload]);

  const pendingViewState = useRef<EditorViewState | undefined>(undefined);
  const editorCleanup = useRef<(() => void) | undefined>(undefined);
  const eolModeRef = useRef(eolMode);
  eolModeRef.current = eolMode;

  // Effect 1: File data lifecycle per (m, pane, path).
  // Hydrates instantaneously from kept unsaved edit or fileCache (no repeated
  // "Loading..."), and falls back to a single-RTT loadText only on cold open.
  useEffect(() => {
    let disposed = false;
    loadKeyRef.current = currentKey;
    savingRef.current = false;
    setSaving(false);
    pendingViewState.current = undefined;
    pendingKept.current = undefined;
    shown.current = undefined;
    previewScrollTop.current = keptMarkdownScroll(m, pane, path);

    const kept = takeEdit<KeptText>(m, pane, (k) => k.path === path);
    const nextMdMode = isMarkdown ? defaultMdMode(m, pane, path, hasLineTarget, !!kept) : 'source';
    setMdMode(nextMdMode);
    mdModeRef.current = nextMdMode;

    const finishHydrated = (text: string, v: Version | undefined, isDirty: boolean, savedVer: number, revalidate: boolean) => {
      version.current = v;
      bom.current = !!v?.bom;
      raw.current = text;
      savedAt.current = savedVer;
      dismissed.current = undefined;
      setMixed(isMixed(text));
      setContent(kept ? kept.model.getValue() : text);
      setDirty(isDirty);
      setStatus({ kind: 'ready' });
      setLoadedKey(currentKey);
      if (revalidate) {
        void checkDisk().catch(() => {});
      }
    };

    if (kept) {
      pendingKept.current = kept;
      lastChecked.current = 0;
      finishHydrated(kept.raw, kept.version, kept.model.getAlternativeVersionId() !== kept.savedAt, kept.savedAt, true);
    } else {
      const cached = getCachedFile(m, path);
      if (cached) {
        noteFile(m, path, true);
        lastChecked.current = cached.verifiedAt;
        const stale = Date.now() - cached.verifiedAt >= REVALIDATE_MS;
        finishHydrated(cached.text, cached.version, false, 0, stale);
      } else {
        raw.current = '';
        setLoadedKey(null);
        setStatus({ kind: 'loading' });
        setDirty(false);
        setContent('');
        void dedupLoad(m, path, () => loadText(m, path))
          .catch((e): Loaded => ({ kind: 'error', message: errorText(e) }))
          .then((first) => {
            if (disposed) return;
            noteLoaded(m, path, first);
            if (first.kind === 'text') {
              lastChecked.current = Date.now();
              putCachedFile(m, path, first.text, first.version, lastChecked.current);
              finishHydrated(first.text, first.version, false, 0, false);
            } else if (first.kind === 'missing') {
              dropCachedFile(m, path);
              lastChecked.current = Date.now();
              finishHydrated('', undefined, false, 0, false);
            } else {
              dropCachedFile(m, path);
              setLoadedKey(null);
              setStatus(first);
            }
          });
      }
    }

    return () => {
      disposed = true;
      loadKeyRef.current = '';
      savingRef.current = false;
      if (isMarkdown) {
        const scroll = previewRef.current ? previewRef.current.scrollTop : previewScrollTop.current;
        keepMarkdownState(m, pane, path, mdModeRef.current, scroll);
      }
      // Dispose Monaco if mounted, preserving viewState and any unsaved model.
      editorCleanup.current?.();
      editorCleanup.current = undefined;
      // If a kept edit was taken but Monaco had not mounted yet (e.g. quick unmount),
      // put it back so unsaved text is never lost (or dispose if already saved clean).
      const unmountedKept = pendingKept.current;
      pendingKept.current = undefined;
      if (unmountedKept) {
        if (unmountedKept.model.getAlternativeVersionId() === unmountedKept.savedAt) unmountedKept.dispose();
        else keepEdit<KeptText>(m, pane, unmountedKept);
      }
    };
    // hasLineTarget only affects the initial markdown mode when opening a path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, pane, path, currentKey, isMarkdown, checkDisk, retry]);

  const isCurrentLoaded = loadedKey === currentKey;
  const isTextReady = isCurrentLoaded && (status.kind === 'ready' || status.kind === 'conflict');
  const showEditor = !isMarkdown || mdMode !== 'preview';
  const showPreview = isMarkdown && mdMode !== 'source';

  // Effect 2: Mount Monaco lazily when needed (immediately for code/text files,
  // or on first switch to Source / Split for Markdown files). Toggling back to
  // Preview hides Monaco without disposing it so switching modes is instant and
  // keeps undo history and dirty state.
  useEffect(() => {
    if (!isTextReady || !showEditor || ed.current || editorCleanup.current) return;
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let created: { editor: CodeEditor; monaco: Monaco } | undefined;
    let sub: { dispose(): void } | undefined;
    let keys: { dispose(): void } | undefined;
    let wrapAction: { dispose(): void } | undefined;
    const myKey = currentKey;

    const cleanup = () => {
      cancelled = true;
      const c = created ?? ed.current;
      ed.current = undefined;
      sub?.dispose();
      keys?.dispose();
      wrapAction?.dispose();
      const viewState = pendingViewState.current ?? c?.editor.saveViewState?.() ?? null;
      pendingViewState.current = undefined;
      if (c) {
        if (viewState && !paneGone(m, pane)) keepViewState(m, pane, path, viewState);
        else if (paneGone(m, pane)) dropViewState(m, pane);
      }
      const model = c?.editor.getModel();
      c?.editor.dispose();
      if (!model) return;
      if (model.getAlternativeVersionId() === savedAt.current) return model.dispose();
      const base = version.current;
      const loaded = raw.current;
      const keep = eolModeRef.current === 'keep';
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
            noteFile(m, path, true);
            return true;
          } catch (err) {
            useStore.getState().toast(t('files.saveFailed', { error: errorText(err) }), undefined, undefined, 'error');
            return false;
          }
        },
        dispose: () => model.dispose(),
      });
    };
    editorCleanup.current = cleanup;

    (async () => {
      try {
        created = await createEditor(el, {
          readOnly: useStore.getState().readOnly,
          wordWrap: wordWrapRef.current ? 'on' : 'off',
        });
      } catch (err) {
        if (editorCleanup.current === cleanup) editorCleanup.current = undefined;
        if (!cancelled && loadKeyRef.current === myKey) {
          setStatus({ kind: 'error', message: errorText(err) });
        }
        return;
      }
      if (cancelled || loadKeyRef.current !== myKey) {
        created.editor.dispose();
        return;
      }
      const { monaco, editor } = created;
      const savedView = takeViewState(m, pane, path);
      if (savedView) pendingViewState.current = savedView;
      const fileUri = monaco.Uri.from({ scheme: 'file', path, query: `m=${m}` });
      const uri = monaco.editor.getModel(fileUri) ? monaco.Uri.from({ scheme: 'file', path, query: `m=${m}&pane=${pane}` }) : fileUri;
      const kept = pendingKept.current;
      pendingKept.current = undefined;
      const model = kept?.model ?? monaco.editor.getModel(uri) ?? monaco.editor.createModel(raw.current, undefined, uri);
      editor.setModel(model);
      ed.current = created;
      setLanguage(monaco, model, path);
      shown.current = model;
      if (kept) {
        savedAt.current = kept.savedAt;
        setDirty(model.getAlternativeVersionId() !== kept.savedAt);
        setContent(model.getValue());
      } else {
        savedAt.current = model.getAlternativeVersionId();
        setDirty(false);
        // If disk reloaded while Monaco was initializing, sync the latest text.
        if (model.getValue() !== raw.current.replace(/\r\n|\r|\n/g, model.getEOL())) {
          applyText(monaco, model, raw.current, false);
          savedAt.current = model.getAlternativeVersionId();
        }
      }
      keys = editor.onKeyDown((e) => saveKeys.editor(e, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS));
      if (monaco.KeyMod?.Alt && monaco.KeyCode?.KeyZ) {
        wrapAction = editor.addAction?.({
          id: `${APP_SLUG}.toggleWordWrap`,
          label: t('files.wordWrap'),
          keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
          run: () => setWordWrap(!wordWrapRef.current),
        });
      }
      sub = model.onDidChangeContent(() => {
        setDirty(model.getAlternativeVersionId() !== savedAt.current);
        if (isMarkdown) setContent(model.getValue());
      });
      setEditorTick((n) => n + 1);
      if (focused) editor.focus();
    })();
    // Cleanup is driven by Effect 1 on (m, pane, path) change or unmount, NOT when
    // toggling mdMode between preview / split / source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTextReady, showEditor, loadedKey, currentKey, m, pane, path]);

  // Restore saved view state once the editor host is visible and laid out.
  useLayoutEffect(() => {
    if (!isTextReady || !showEditor || !paneShown || !ed.current) return;
    if (host.current && host.current.clientHeight > 0) ed.current.editor.layout?.();
    if (pendingViewState.current) {
      const state = pendingViewState.current;
      pendingViewState.current = undefined;
      ed.current.editor.restoreViewState?.(state);
    }
  }, [isTextReady, showEditor, paneShown, editorTick, mdMode, m, pane, path]);

  // Restore Markdown preview scroll position when switching to preview/split or returning.
  useLayoutEffect(() => {
    if (!showPreview || !paneShown || !previewRef.current) return;
    previewRef.current.scrollTop = previewScrollTop.current;
  }, [showPreview, paneShown, m, pane, path]);

  useEffect(() => {
    ed.current?.editor.updateOptions({ readOnly: locked, wordWrap: wordWrap ? 'on' : 'off' });
  }, [locked, wordWrap, editorTick]);

  // When a kept hidden tab becomes visible again, silently check disk if stale.
  const wasShown = useRef(paneShown);
  useEffect(() => {
    const becameShown = paneShown && !wasShown.current;
    wasShown.current = paneShown;
    if (becameShown && isTextReady && Date.now() - lastChecked.current >= REVALIDATE_MS) {
      void checkDisk().catch(() => {});
    }
  }, [paneShown, isTextReady, checkDisk]);

  // The place the view asks for (openEditor's line, col and optional endLine /
  // endCol), once the text is shown, and again each time it is asked for (reveal).
  const place =
    typeof view.line === 'number'
      ? `${m}\n${path}\n${view.line}:${String(view.col)}:${String(view.endLine)}:${String(view.endCol)}:${String(view.reveal)}`
      : undefined;
  const revealed = useRef<string | undefined>(undefined);
  const rangeHighlight = useRef<{ clear(): void } | undefined>(undefined);
  const clearRangeSub = useRef<{ dispose(): void } | undefined>(undefined);
  const clearRangeHighlight = useCallback(() => {
    clearRangeSub.current?.dispose();
    clearRangeSub.current = undefined;
    rangeHighlight.current?.clear();
    rangeHighlight.current = undefined;
  }, []);
  // Clear range highlight when switching file/machine or unmounting.
  useEffect(() => {
    revealed.current = undefined;
    clearRangeHighlight();
    return clearRangeHighlight;
  }, [m, pane, path, clearRangeHighlight]);
  useEffect(() => {
    if (!place) {
      clearRangeHighlight();
      return;
    }
    if (revealed.current === place) return;
    // If a Markdown file is currently in Preview-only mode and the user clicked a
    // line/range link (e.g. README.md:17-20), switch to Source so the line shows.
    if (isMarkdown && mdMode === 'preview') {
      setMdMode('source');
      return;
    }
    const c = ed.current;
    if (!c || status.kind !== 'ready') return;
    revealed.current = place;
    const startLine = Math.max(1, Math.floor(Number(view.line)));
    const startCol = Math.max(1, Math.floor(Number(view.col) || 1));
    const endLine = typeof view.endLine === 'number' && view.endLine >= startLine ? Math.floor(view.endLine) : undefined;
    const endCol = typeof view.endCol === 'number' && view.endCol > 0 ? Math.floor(view.endCol) : undefined;
    revealAt(c.editor, startLine, startCol, endLine, endCol);
    clearRangeHighlight();
    if (endLine !== undefined && c.editor.createDecorationsCollection) {
      const model = c.editor.getModel();
      const maxLine = model?.getLineCount?.();
      const clampedEnd = maxLine ? Math.min(endLine, maxLine) : endLine;
      rangeHighlight.current = c.editor.createDecorationsCollection([
        {
          range: new c.monaco.Range(startLine, 1, Math.max(startLine, clampedEnd), 1),
          options: { isWholeLine: true, className: 'files-target-range' },
        },
      ]);
      clearRangeSub.current = c.editor.onDidChangeModelContent?.(() => clearRangeHighlight());
    }
  }, [place, status.kind, editorTick, isMarkdown, mdMode, view.line, view.col, view.endLine, view.endCol, clearRangeHighlight]);

  useEffect(() => {
    if (focused && paneShown && showEditor) ed.current?.editor.focus();
  }, [focused, paneShown, showEditor]);

  // When the pane's machine returns from offline/reboot/disable, reload an
  // editor stuck on an error or stale in-flight load (keeping saved view
  // state and unsaved edits) or check disk state immediately if already open.
  const checkDiskRef = useRef(checkDisk);
  checkDiskRef.current = checkDisk;
  useEffect(() => {
    const prev = prevMachine.current;
    prevMachine.current = { m, status: machineStatus };
    if (prev.m !== m || prev.status === 'ready' || machineStatus !== 'ready') return;
    if (statusRef.current.kind === 'error' || statusRef.current.kind === 'loading') {
      dropInflightFile(m, path);
      setStatus({ kind: 'loading' });
      setRetry((n) => n + 1);
    } else if (statusRef.current.kind === 'ready' || statusRef.current.kind === 'conflict') {
      if (paneShownRef.current) void checkDiskRef.current().catch(() => {});
      else lastChecked.current = 0;
    }
  }, [m, path, machineStatus]);

  // A change on disk: polled only while this pane is visible on screen (hidden
  // kept tabs pause polling and revalidate once when shown again).
  useEffect(() => {
    if (!paneShown || !isTextReady) return;
    let live = true;
    const stop = startPolling(CHECK_MS, async () => {
      if (live) await checkDisk();
    });
    return () => {
      live = false;
      stop();
    };
  }, [paneShown, isTextReady, checkDisk]);

  const changed = useQuickDiff(m, path, ed, isTextReady && showEditor, editorTick);
  const openChanges = quickDiff()?.openChanges;
  const changes =
    changed > 0 && openChanges ? (
      <button
        className="icon"
        title={t('files.openChanges', { n: changed })}
        aria-label={t('files.openChanges', { n: changed })}
        onClick={() => openChanges(m, path)}
      >
        <FileDiff />
      </button>
    ) : null;

  const switchMdMode = useCallback((next: MarkdownMode) => {
    if (ed.current) setContent(ed.current.editor.getValue());
    setMdMode(next);
  }, []);

  const mdBase = useMemo(() => ({ m, dir: parentOf(path) }), [m, path]);
  const openRelative = useCallback(
    (target: string) => {
      void openEditor(m, target, { preview: true });
    },
    [m],
  );

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
    <div
      className="files-editor"
      data-autofocus
      tabIndex={-1}
      onMouseDown={() => !focused && terms.mutate(m, (l) => L.focusPane(l, pane))}
      onFocus={(e) => {
        if (e.target === e.currentTarget && showEditor) ed.current?.editor.focus();
      }}
      onKeyDown={saveKeys.root}
    >
      <EditorBar m={m} pane={pane} view={view}>
        {dirty && (
          <span className="files-dirty" title={t('files.unsaved')} aria-label={t('files.unsaved')}>
            ●
          </span>
        )}
        {locked && <span className="tag">{t('files.readOnly')}</span>}
        <span className="spacer" />
        {isMarkdown && isTextReady && (
          <div className="files-md-modes" role="group" aria-label={t('files.markdown.modes')}>
            <button
              type="button"
              className={`icon ${mdMode === 'preview' ? 'on' : ''}`}
              title={t('files.markdown.preview')}
              aria-label={t('files.markdown.preview')}
              aria-pressed={mdMode === 'preview'}
              onClick={() => switchMdMode('preview')}
            >
              <Eye />
            </button>
            <button
              type="button"
              className={`icon ${mdMode === 'split' ? 'on' : ''}`}
              title={t('files.markdown.split')}
              aria-label={t('files.markdown.split')}
              aria-pressed={mdMode === 'split'}
              onClick={() => switchMdMode('split')}
            >
              <Columns2 />
            </button>
            <button
              type="button"
              className={`icon ${mdMode === 'source' ? 'on' : ''}`}
              title={t('files.markdown.source')}
              aria-label={t('files.markdown.source')}
              aria-pressed={mdMode === 'source'}
              onClick={() => switchMdMode('source')}
            >
              <CodeIcon />
            </button>
          </div>
        )}
        {changes}
        {isTextReady && showEditor && (
          <button
            type="button"
            className={`icon ${wordWrap ? 'on' : ''}`}
            title={`${t('files.wordWrap')} (${keyLabel('alt+z')})`}
            aria-label={t('files.wordWrap')}
            aria-pressed={wordWrap}
            onClick={() => setWordWrap(!wordWrap)}
          >
            <WrapText />
          </button>
        )}
        <button className="icon" title={t('files.revert')} aria-label={t('files.revert')} onClick={() => void reload()}>
          <RotateCcw />
        </button>
        {!readOnly && (
          <button
            className="icon"
            title={t('files.save')}
            aria-label={t('files.save')}
            disabled={saving || !isCurrentLoaded || status.kind !== 'ready' || !dirty || locked}
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
      {mixed && isTextReady && showEditor && (
        <div className="callout eol-note" role="note">
          {t(eolMode === 'readOnly' ? 'eol.readOnly' : eolMode === 'unify' ? 'eol.unify' : 'eol.keep', { name })}
        </div>
      )}
      {status.kind === 'binary' && note('files.binary')}
      {status.kind === 'tooLarge' && note('files.tooLarge')}
      {status.kind === 'notUtf8' && note('files.notUtf8')}
      {status.kind === 'isDir' && (
        <div className="files-editor-note muted">
          <p>{t('files.isDir', { name })}</p>
          <button className="btn" onClick={() => reveal(m, path)}>
            <FolderTree /> {t('files.reveal')}
          </button>
        </div>
      )}
      {status.kind === 'error' && <div className="files-editor-note error">{status.message}</div>}
      {status.kind === 'loading' && <div className="files-editor-note muted">{t('files.loading')}</div>}
      <div className={`files-editor-body ${isMarkdown && mdMode === 'split' ? 'split' : ''}`} hidden={!isTextReady}>
        <div ref={host} className="files-editor-host" hidden={!isTextReady || !showEditor} />
        {isTextReady && showPreview && (
          <div
            ref={previewRef}
            className="files-md-preview"
            onScroll={(e) => {
              previewScrollTop.current = e.currentTarget.scrollTop;
            }}
            onContextMenu={(e) => {
              const sel = window.getSelection()?.toString() ?? '';
              const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
              const rawHref = anchor?.getAttribute('href') ?? undefined;
              const webHref = rawHref ? safeLink(rawHref) : undefined;
              const entries: MenuEntry[] = [
                {
                  label: t('surface.copy'),
                  icon: <Copy />,
                  disabled: !sel,
                  run: () => void copyText(sel),
                },
              ];
              if (webHref) {
                entries.push(
                  'sep',
                  {
                    label: t('link.menuOpenUrl', { url: webHref }),
                    icon: <ExternalLink />,
                    run: () => openWebLink(webHref, m, { ask: true }),
                  },
                  { label: t('link.menuCopyUrl'), icon: <Link />, run: () => void copyText(webHref) },
                );
              }
              entries.push('sep');
              if (mdMode !== 'preview') {
                entries.push({ label: t('files.markdown.preview'), icon: <Eye />, run: () => switchMdMode('preview') });
              }
              if (mdMode !== 'split') {
                entries.push({ label: t('files.markdown.split'), icon: <Columns2 />, run: () => switchMdMode('split') });
              }
              entries.push({ label: t('files.markdown.source'), icon: <CodeIcon />, run: () => switchMdMode('source') });
              entries.push(
                'sep',
                { label: t('files.copyPath'), icon: <Copy />, run: () => void copyText(path) },
                { label: t('files.reveal'), icon: <FolderTree />, run: () => reveal(m, path) },
                ...revealEntries(m, path),
              );
              openMenu(e, entries);
            }}
          >
            <Markdown text={deferredContent} variant="document" base={mdBase} onOpenPath={openRelative} />
          </div>
        )}
      </div>
    </div>
  );
}

// The composer of a chat (Claude-Code-inspired layout):
// - Rounded input box with a left `+` menu (workspace files, images, Markdown
//   preview toggle), an auto-growing Markdown textarea with valid leading
//   slash-command highlighting, floating `/` command and `@` file menus above
//   the box, and right-aligned Stop / Steer / Send controls.
// - Bottom meta bar below the input box: project directory & Git branch on
//   the left; combined Model + Effort selector (without "More models"),
//   permission mode selector, and circular SVG context-usage ring (hover
//   details + click-to-compact) on the right.

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Clock,
  FastForward,
  FileText,
  Folder,
  GitBranch,
  Image as ImageIcon,
  ListPlus,
  LoaderCircle,
  Pencil,
  Square,
  SquareSlash,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { APP_SLUG } from '../brand';
import { FilePicker, relativePosix } from '../components/FilePicker';
import { carriesPaths, draggedPaths, takesPaths } from '../pathsDrag';
import { useDismiss } from '../components/useDismiss';
import { FileIcon } from '../fileIcons';
import { t, type MessageKey } from '../i18n';
import { Markdown } from '../markdown/Markdown';
import {
  AttachError,
  attachmentFromImage,
  fits,
  formatBytes,
  IMAGE_TYPES,
  MAX_ATTACHMENTS,
  MAX_FILE_ATTACHMENTS,
  pathFromFileUri,
  promptContent,
  readImage,
  type Attachment,
} from './attach';
import {
  ConfigSelect,
  ModelEffortSelect,
  PlusMenu,
  UsageLine,
  modeName,
  placeConfigMenu,
  type ConfigMenuPlace,
  type FullBlocked,
  type UsageLineProps,
} from './ComposerControls';
import { handleMarkdownKey } from './markdownEdit';
import {
  blocksText,
  CATEGORY_MODE,
  CATEGORY_MODEL,
  CATEGORY_THOUGHT_LEVEL,
  configOf,
  MAX_IMAGE,
  MAX_PROMPT,
  NO_CAPABILITIES,
  type ChatError,
  type ChatInfo,
  type QueuedMessage,
  type Usage,
} from './model';
import { errorText } from './parts';
import type { ChatSource, ComposerExtras, Delivery, FileSuggestion } from './source';
import type { SlashCommand } from '../plugins/chat/protocol';
import './composer.css';

export { placeConfigMenu, UsageLine, type ConfigMenuPlace, type FullBlocked, type UsageLineProps };

/** The user's unsent draft (text, pasted/picked images, file chips, and inline
 * mentions), keyed by chat (the source's id) or by source: it outlives the
 * view across tab/window switches until it is sent. */
interface ComposerDraft {
  text: string;
  attachments: Attachment[];
  attachedFiles: FileSuggestion[];
  mentions: FileSuggestion[];
}

const emptyDraft = (): ComposerDraft => ({ text: '', attachments: [], attachedFiles: [], mentions: [] });

const isEmptyDraft = (d: ComposerDraft): boolean =>
  !d.text && d.attachments.length === 0 && d.attachedFiles.length === 0 && d.mentions.length === 0;

const cloneDraft = (d: ComposerDraft): ComposerDraft => ({
  text: d.text,
  attachments: d.attachments.map((a) => ({ ...a })),
  attachedFiles: d.attachedFiles.map((f) => ({ ...f })),
  mentions: d.mentions.map((m) => ({ ...m })),
});

const draftAttachmentBytes = (d: ComposerDraft): number => d.attachments.reduce((n, a) => n + a.data.length, 0);

const drafts = new WeakMap<ChatSource, ComposerDraft>();
const namedDrafts = new Map<string, ComposerDraft>();
/** Generation counters incremented on clear() so in-flight image reads never
 * resurrect attachments after a message was sent. */
const sourceClearGen = new WeakMap<ChatSource, number>();
const namedClearGen = new Map<string, number>();
/** The most drafts kept by name, and the total base64 attachment bytes kept
 * across them so background drafts stay bounded in memory. */
const MAX_DRAFTS = 200;
const MAX_DRAFT_ATTACHMENT_BYTES = 64 << 20;

type DraftListener = (draft: ComposerDraft | null, isReply: boolean) => void;
const draftListeners = new Map<string, Set<DraftListener>>();

type DraftWireMsg = { type: 'draft'; id: string; draft: ComposerDraft | null; reply?: boolean } | { type: 'need'; id: string };

let draftBc: BroadcastChannel | null | undefined;
let draftBcName = '';

function sanitizeAttachment(v: unknown): Attachment | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const a = v as Partial<Attachment>;
  if (
    typeof a.id !== 'string' ||
    typeof a.name !== 'string' ||
    typeof a.mimeType !== 'string' ||
    typeof a.data !== 'string' ||
    typeof a.size !== 'number' ||
    !Number.isFinite(a.size)
  ) {
    return undefined;
  }
  return { id: a.id, name: a.name, mimeType: a.mimeType, data: a.data, size: a.size };
}

function sanitizeFile(v: unknown): FileSuggestion | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const f = v as Partial<FileSuggestion>;
  if (typeof f.path !== 'string' || typeof f.label !== 'string') return undefined;
  return f.isDir ? { path: f.path, label: f.label, isDir: true } : { path: f.path, label: f.label };
}

function sanitizeDraft(v: unknown): ComposerDraft | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const d = v as Partial<ComposerDraft>;
  const text = typeof d.text === 'string' ? d.text : '';
  const attachments = Array.isArray(d.attachments)
    ? d.attachments
        .map(sanitizeAttachment)
        .filter((x): x is Attachment => !!x)
        .slice(0, MAX_ATTACHMENTS)
    : [];
  const attachedFiles = Array.isArray(d.attachedFiles)
    ? d.attachedFiles
        .map(sanitizeFile)
        .filter((x): x is FileSuggestion => !!x)
        .slice(0, MAX_FILE_ATTACHMENTS)
    : [];
  const mentions = Array.isArray(d.mentions) ? d.mentions.map(sanitizeFile).filter((x): x is FileSuggestion => !!x) : [];
  return { text, attachments, attachedFiles, mentions };
}

function getDraftChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const name = `${APP_SLUG}:composer-drafts`;
  if (draftBc && draftBcName === name) return draftBc;
  if (draftBc) {
    try {
      draftBc.close();
    } catch {
      // Ignore close errors.
    }
    draftBc = null;
  }
  try {
    const ch = new BroadcastChannel(name);
    ch.onmessage = (ev: MessageEvent<unknown>) => {
      const msg = ev.data as Partial<DraftWireMsg> | null;
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !msg.id) return;
      if (msg.type === 'need') {
        const cur = namedDrafts.get(msg.id);
        if (cur && !isEmptyDraft(cur)) {
          try {
            ch.postMessage({ type: 'draft', id: msg.id, draft: cloneDraft(cur), reply: true } satisfies DraftWireMsg);
          } catch {
            // Ignore postMessage failures in restricted contexts.
          }
        }
        return;
      }
      if (msg.type === 'draft') {
        const incoming = msg.draft === null ? null : sanitizeDraft(msg.draft);
        if (incoming === undefined) return;
        const isReply = msg.reply === true;
        if (isReply) {
          const existing = namedDrafts.get(msg.id);
          if (existing && !isEmptyDraft(existing)) return;
        }
        if (incoming === null || isEmptyDraft(incoming)) {
          namedDrafts.delete(msg.id);
          bumpNamedClearGen(msg.id);
        } else {
          storeNamedDraft(msg.id, incoming);
        }
        const subs = draftListeners.get(msg.id);
        if (subs) for (const fn of subs) fn(incoming && !isEmptyDraft(incoming) ? cloneDraft(incoming) : null, isReply);
      }
    };
    draftBc = ch;
    draftBcName = name;
    return ch;
  } catch {
    draftBc = null;
    return null;
  }
}

function broadcastDraft(msg: DraftWireMsg) {
  const ch = getDraftChannel();
  if (!ch) return;
  try {
    ch.postMessage(msg);
  } catch {
    // Ignore postMessage errors (e.g. closed channel).
  }
}

function subscribeDraft(id: string, fn: DraftListener): () => void {
  getDraftChannel();
  let set = draftListeners.get(id);
  if (!set) {
    set = new Set();
    draftListeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) draftListeners.delete(id);
  };
}

function storeNamedDraft(id: string, draft: ComposerDraft) {
  namedDrafts.delete(id);
  if (isEmptyDraft(draft)) return;
  namedDrafts.set(id, cloneDraft(draft));
  let totalBytes = 0;
  for (const d of namedDrafts.values()) totalBytes += draftAttachmentBytes(d);
  while (namedDrafts.size > MAX_DRAFTS || (namedDrafts.size > 1 && totalBytes > MAX_DRAFT_ATTACHMENT_BYTES)) {
    const oldestKey = namedDrafts.keys().next().value!;
    if (oldestKey === id) break;
    const evicted = namedDrafts.get(oldestKey);
    namedDrafts.delete(oldestKey);
    if (evicted) totalBytes -= draftAttachmentBytes(evicted);
  }
}

function clearGenOf(s: ChatSource): number {
  return (s.id ? namedClearGen.get(s.id) : sourceClearGen.get(s)) ?? 0;
}

function bumpNamedClearGen(id: string) {
  const next = (namedClearGen.get(id) ?? 0) + 1;
  namedClearGen.delete(id);
  namedClearGen.set(id, next);
  if (namedClearGen.size > MAX_DRAFTS * 2) namedClearGen.delete(namedClearGen.keys().next().value!);
}

function bumpClearGen(s: ChatSource) {
  if (s.id) bumpNamedClearGen(s.id);
  else sourceClearGen.set(s, (sourceClearGen.get(s) ?? 0) + 1);
}

function draftOf(s: ChatSource): ComposerDraft {
  const d = s.id ? namedDrafts.get(s.id) : drafts.get(s);
  return d ? cloneDraft(d) : emptyDraft();
}

function keepDraft(s: ChatSource, draft: ComposerDraft, sync = true) {
  const empty = isEmptyDraft(draft);
  if (!s.id) {
    if (empty) drafts.delete(s);
    else drafts.set(s, cloneDraft(draft));
    return;
  }
  if (empty) namedDrafts.delete(s.id);
  else storeNamedDraft(s.id, draft);
  if (sync) broadcastDraft({ type: 'draft', id: s.id, draft: empty ? null : cloneDraft(draft) });
}

/** Clears cached named drafts (for tests). */
export function clearDrafts() {
  namedDrafts.clear();
  namedClearGen.clear();
  if (draftBc) {
    try {
      draftBc.close();
    } catch {
      // Ignore close errors.
    }
    draftBc = undefined;
    draftBcName = '';
  }
}

/** A field's height to fit its text (up to its CSS max-height). */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/** A new id of a message, the page's (Command.clientId). */
function newClientId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** The list the field offers at the caret: the agent's commands after a
 * `/` that begins the text, or files after an `@` that begins a word. */
export interface MenuAt {
  type: 'slash' | 'mention';
  /** Where the word the list replaces begins and ends. */
  start: number;
  end: number;
  /** What is typed of it after its mark. */
  query: string;
}

export function menuAt(text: string, caret: number): MenuAt | undefined {
  const before = text.slice(0, caret);
  const rest = (re: RegExp) => re.exec(text.slice(caret))?.[0].length ?? 0;
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) return { type: 'slash', start: 0, end: caret + rest(/^\S*/), query: slash[1] };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { type: 'mention', start: at.index + at[1].length, end: caret + rest(/^[^\s@]*/), query: at[2] };
  return undefined;
}

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  insert: string;
  mention?: FileSuggestion;
  isDir?: boolean;
  attachAsChip?: boolean;
}

/** The most items the list shows. */
const MAX_MENU = 50;

/** How long after a keystroke the files that match are asked for. */
const SUGGEST_MS = 80;

/** Parses `/compact` or `/compact <instructions>`. */
function parseCompact(text: string): { instructions?: string } | undefined {
  const m = /^\/compact(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return undefined;
  const instructions = m[1]?.trim();
  return { instructions: instructions || undefined };
}

function baseNameOf(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function parentDirOf(label: string, fullPath: string): string | undefined {
  const clean = label.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  if (i > 0) return clean.slice(0, i);
  return fullPath !== label ? fullPath : undefined;
}

function attachErrorText(e: unknown, agent: string): string {
  if (e instanceof AttachError) {
    switch (e.code) {
      case 'notImage':
        return t('conversation.attach.notImage', { name: e.file });
      case 'tooLarge':
        return t('conversation.attach.tooLarge', { name: e.file, max: formatBytes(MAX_IMAGE) });
      default:
        return t('conversation.attach.unreadable', { name: e.file });
    }
  }
  return t('conversation.attach.unreadable', { name: agent });
}

/** Ranks slash commands by match quality:
 * 0 = exact name match, 1 = prefix match, 2 = segment prefix after `:`/`-`/`_`,
 * 3 = substring match. Preserves agent order when query is empty. */
export function matchSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const seen = new Set<string>();
  const normalized: SlashCommand[] = [];
  for (const c of commands) {
    const clean = c.name.replace(/^\/+/, '');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(clean === c.name ? c : { ...c, name: clean });
  }
  const q = query.toLowerCase();
  if (!q) return normalized;

  const scored: Array<{ cmd: SlashCommand; tier: number; idx: number; order: number }> = [];
  for (let order = 0; order < normalized.length; order++) {
    const cmd = normalized[order];
    const lower = cmd.name.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;
    let tier = 3;
    if (lower === q) tier = 0;
    else if (idx === 0) tier = 1;
    else if (lower[idx - 1] === ':' || lower[idx - 1] === '-' || lower[idx - 1] === '_') tier = 2;
    scored.push({ cmd, tier, idx, order });
  }
  scored.sort((a, b) => a.tier - b.tier || a.idx - b.idx || a.cmd.name.length - b.cmd.name.length || a.order - b.order);
  return scored.map((s) => s.cmd);
}

/** Highlights the first case-insensitive occurrence of `query` inside `label`. */
function highlightMatch(label: string, query: string): ReactNode {
  if (!query) return label;
  const idx = label.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return label;
  return (
    <>
      {label.slice(0, idx)}
      <mark className="conv-menu-match">{label.slice(idx, idx + query.length)}</mark>
      {label.slice(idx + query.length)}
    </>
  );
}

/** Imperative handle for a parent to prefill the composer draft (e.g. after Rewind). */
export interface ComposerHandle {
  /** Replaces the composer text, persists it as draft, and focuses the input at end. */
  setDraft(value: string): void;
}

export interface ComposerProps extends ComposerExtras {
  source: ChatSource;
  agent: string;
  chat?: ChatInfo;
  usage?: Usage;
  queued: readonly QueuedMessage[];
  /** A turn runs. */
  working: boolean;
  /** A permission or a question waits for the user. */
  waiting: boolean;
  state?: string;
  stateError?: ChatError;
  readOnly: boolean;
  /** The machine allows full access (its setting chat.allowFullAccess):
   * without it, and read-only, the values that give it are not offered. */
  allowFull: boolean;
  /** Shows the card that waits for the user. */
  onShowWaiting(): void;
  /** Whether the conversation has the user's message of that clientId (the
   * agent took it, or it is queued). */
  delivered?(clientId: string): boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  composerRef?: RefObject<ComposerHandle | null>;
}

/** Whether a command's refusal leaves its outcome unknown: it was sent,
 * and the connection or the subscription ended before the answer came
 * (the source's error says unsure). */
const unsureOf = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { unsure?: unknown }).unsure === true;

export function Composer({
  source,
  agent,
  base,
  branch,
  activity,
  modelPicker,
  chat,
  usage,
  queued,
  working,
  waiting,
  state,
  stateError,
  readOnly,
  allowFull,
  onShowWaiting,
  delivered,
  inputRef,
  composerRef,
}: ComposerProps) {
  const caps = chat?.capabilities ?? NO_CAPABILITIES;
  const initialDraft = useRef<ComposerDraft | null>(null);
  if (initialDraft.current === null) initialDraft.current = draftOf(source);
  const draftRef = useRef<ComposerDraft>(initialDraft.current);
  const [text, setText] = useState(() => initialDraft.current!.text);
  const [attachments, setAttachments] = useState<Attachment[]>(() => initialDraft.current!.attachments);
  const [attachedFiles, setAttachedFiles] = useState<FileSuggestion[]>(() => initialDraft.current!.attachedFiles);
  const [mentions, setMentions] = useState<FileSuggestion[]>(() => initialDraft.current!.mentions);
  const [pending, setPending] = useState(false);
  const [compactPending, setCompactPending] = useState(false);
  const [steeringId, setSteeringId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerPlace, setFilePickerPlace] = useState<ConfigMenuPlace>();
  /** Why the last thing the user did was not done. */
  const [failed, setFailed] = useState<string | undefined>(undefined);
  /** The message last sent whose outcome is not known: its id, which
   * sending the same content again keeps (the host takes a message of one
   * id once), and its content. unsure: the connection ended before the
   * answer, and it shows in the conversation once the host has it. */
  const outstanding = useRef<{ clientId: string; key: string } | undefined>(undefined);
  const [unsure, setUnsure] = useState(false);
  const deliveredRef = useRef(delivered);
  useLayoutEffect(() => {
    deliveredRef.current = delivered;
  });
  const [caret, setCaret] = useState(text.length);
  /** The list the user closed (its kind and where its word begins). */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<{ query: string; items: FileSuggestion[] } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const live = useRef(true);
  const nextSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const filePopRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // Sync named drafts with peer windows (e.g. detached tab windows and docking
  // back) so pasted images and unsent text survive moving a tab across windows.
  useEffect(() => {
    const id = source.id;
    if (!id) return;
    const off = subscribeDraft(id, (incoming, isReply) => {
      if (!live.current) return;
      if (isReply && !isEmptyDraft(draftRef.current)) return;
      const next = incoming ? cloneDraft(incoming) : emptyDraft();
      draftRef.current = next;
      setText(next.text);
      setAttachments(next.attachments);
      setAttachedFiles(next.attachedFiles);
      setMentions(next.mentions);
      if (!incoming) {
        setCaret(0);
        setPreview(false);
      }
    });
    if (isEmptyDraft(draftRef.current)) broadcastDraft({ type: 'need', id });
    return off;
  }, [source.id]);

  useEffect(() => {
    if (readOnly && preview) setPreview(false);
    if (readOnly && filePickerOpen) setFilePickerOpen(false);
  }, [readOnly, preview, filePickerOpen]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    grow(el);
    if (el && backdropRef.current) backdropRef.current.scrollTop = el.scrollTop;
    if (el && nextSelection.current !== undefined) {
      el.setSelectionRange(nextSelection.current.start, nextSelection.current.end);
      setCaret(nextSelection.current.start);
      nextSelection.current = undefined;
    }
  }, [text, preview, inputRef]);

  const closeFilePicker = useCallback((returnFocus = false) => {
    setFilePickerOpen(false);
    if (returnFocus) plusBtnRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(filePickerOpen, filePopRef, () => closeFilePicker(false), plusBtnRef);

  const updateFilePickerPlace = useCallback(() => {
    const btn = plusBtnRef.current;
    if (!btn) return;
    setFilePickerPlace(
      placeConfigMenu(btn.getBoundingClientRect(), 360, { width: window.innerWidth, height: window.innerHeight }, 400, 340, 'left'),
    );
  }, []);

  useLayoutEffect(() => {
    if (!filePickerOpen) {
      setFilePickerPlace(undefined);
      return;
    }
    updateFilePickerPlace();
    window.addEventListener('resize', updateFilePickerPlace);
    window.addEventListener('scroll', updateFilePickerPlace, true);
    return () => {
      window.removeEventListener('resize', updateFilePickerPlace);
      window.removeEventListener('scroll', updateFilePickerPlace, true);
    };
  }, [filePickerOpen, updateFilePickerPlace]);

  const fail = (message: string) => {
    if (live.current) setFailed(message);
  };
  const run = (p: () => Promise<void>, fallback: MessageKey = 'conversation.commandFailed') =>
    Promise.resolve()
      .then(p)
      .catch((e: unknown) => fail(errorText(e, agent, fallback)));

  // ---- slash commands & @ mentions ----
  const allCommands = useMemo((): SlashCommand[] => {
    const list = [...(chat?.commands ?? [])];
    if (caps.compact && !list.some((c) => c.name.replace(/^\/+/, '').toLowerCase() === 'compact')) {
      list.push({ name: 'compact', description: t('conversation.command.compact') });
    }
    return list;
  }, [chat?.commands, caps.compact]);

  const knownCommands = useMemo(
    () => new Set(allCommands.map((c) => c.name.replace(/^\/+/, '').toLowerCase()).filter(Boolean)),
    [allCommands],
  );

  const validSlashToken = useMemo(() => {
    const m = /^(\/[^\s/]+)(?=\s|$)/.exec(text);
    if (!m) return undefined;
    return knownCommands.has(m[1].slice(1).toLowerCase()) ? m[1] : undefined;
  }, [text, knownCommands]);

  const at = readOnly || preview ? undefined : menuAt(text, caret);
  const menuKey = at ? `${at.type}:${at.start}` : undefined;
  const suggest = source.suggestFiles?.bind(source);
  const query = at?.type === 'mention' && suggest ? at.query : undefined;
  useEffect(() => {
    if (query === undefined || menuKey === dismissed) return;
    let current = true;
    const ac = new AbortController();
    const id = setTimeout(() => {
      suggest!(query, ac.signal).then(
        (items) => current && setFiles({ query, items: Array.isArray(items) ? items.slice(0, MAX_MENU) : [] }),
        () => current && !ac.signal.aborted && setFiles({ query, items: [] }),
      );
    }, SUGGEST_MS);
    return () => {
      current = false;
      ac.abort();
      clearTimeout(id);
    };
    // suggest is the source's: a new one comes with a new source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, menuKey, dismissed, source]);

  const menuItems = useMemo((): MenuItem[] => {
    if (!at) return [];
    if (at.type === 'mention') {
      if (!files || files.query !== at.query) return [];
      return files.items
        .filter((f) => f && typeof f.path === 'string' && typeof f.label === 'string' && f.label !== '')
        .map((f) => {
          const isDir = f.isDir === true || f.label.endsWith('/');
          const hasSpace = /\s/.test(f.label);
          const dirLabel = isDir ? (f.label.endsWith('/') ? f.label : `${f.label}/`) : f.label;
          return {
            key: f.path,
            label: dirLabel,
            detail: parentDirOf(dirLabel, f.path),
            insert: isDir ? `@${dirLabel}` : hasSpace ? '' : `@${f.label} `,
            mention: f,
            isDir,
            attachAsChip: !isDir && hasSpace,
          };
        });
    }
    return matchSlashCommands(allCommands, at.query)
      .slice(0, MAX_MENU)
      .map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint, insert: `/${c.name} ` }));
  }, [at?.type, at?.query, files, allCommands]); // eslint-disable-line react-hooks/exhaustive-deps

  const menuOpen = !!at && menuKey !== dismissed && menuItems.length > 0;
  const shown = Math.min(active, Math.max(0, menuItems.length - 1));
  useEffect(() => setActive(0), [menuKey, at?.query]);

  useEffect(() => {
    if (!menuOpen) return;
    const row = menuListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [menuOpen, shown]);

  const updateDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      const next: ComposerDraft = { ...draftRef.current, ...patch };
      draftRef.current = next;
      keepDraft(source, next);
      return next;
    },
    [source],
  );

  const change = useCallback(
    (v: string, pos?: number) => {
      setText(v);
      setFailed(undefined);
      setUnsure(false);
      if (pos !== undefined) setCaret(pos);
      // A list closed stays closed until its word ends.
      if (!menuAt(v, pos ?? v.length)) setDismissed(undefined);
      updateDraft({ text: v });
    },
    [updateDraft],
  );

  useImperativeHandle(
    composerRef,
    () => ({
      setDraft(value: string) {
        setPreview(false);
        nextSelection.current = { start: value.length, end: value.length };
        change(value, value.length);
        queueMicrotask(() => inputRef.current?.focus());
      },
    }),
    [change, inputRef],
  );

  const addFileChips = (list: FileSuggestion[]) => {
    if (!list.length) return;
    const byPath = new Map(draftRef.current.attachedFiles.map((f) => [f.path, f]));
    for (const f of list) {
      if (f.path.startsWith('/')) byPath.set(f.path, f);
    }
    let next = [...byPath.values()];
    if (next.length > MAX_FILE_ATTACHMENTS) {
      fail(t('conversation.attach.tooManyFiles', { n: MAX_FILE_ATTACHMENTS }));
      next = next.slice(0, MAX_FILE_ATTACHMENTS);
    }
    updateDraft({ attachedFiles: next });
    setAttachedFiles(next);
  };

  const replaceFileChips = (list: FileSuggestion[]) => {
    const clean = list.filter((f) => f.path.startsWith('/'));
    let next = clean;
    if (clean.length > MAX_FILE_ATTACHMENTS) {
      fail(t('conversation.attach.tooManyFiles', { n: MAX_FILE_ATTACHMENTS }));
      next = clean.slice(0, MAX_FILE_ATTACHMENTS);
    } else {
      setFailed(undefined);
    }
    updateDraft({ attachedFiles: next });
    setAttachedFiles(next);
  };

  const choose = (item: MenuItem) => {
    if (!at) return;
    const tail = item.isDir ? text.slice(at.end) : text.slice(at.end).replace(/^ /, '');
    const caretPos = at.start + item.insert.length;
    nextSelection.current = { start: caretPos, end: caretPos };
    if (item.mention) {
      if (item.attachAsChip) {
        addFileChips([item.mention]);
      } else if (!item.isDir) {
        const nextMentions = [...draftRef.current.mentions, item.mention];
        updateDraft({ mentions: nextMentions });
        setMentions(nextMentions);
      }
    }
    change(text.slice(0, at.start) + item.insert + tail, caretPos);
    if (item.isDir) setDismissed(undefined);
    inputRef.current?.focus();
  };

  // ---- attachments ----
  const addFiles = (list: File[]) => {
    if (!list.length || readOnly) return;
    if (!caps.images) return fail(t('conversation.attach.noImages', { agent }));
    const room = MAX_ATTACHMENTS - draftRef.current.attachments.length;
    if (room <= 0) return fail(t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS }));
    const target = source;
    const gen = clearGenOf(target);
    Promise.allSettled(list.slice(0, room).map(readImage)).then((results) => {
      if (clearGenOf(target) !== gen) return;
      let error: string | undefined;
      const ok: Attachment[] = [];
      for (const r of results) {
        if (r.status === 'rejected') error ??= attachErrorText(r.reason, agent);
        else ok.push(r.value);
      }
      if (list.length > room) error ??= t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS });
      const base = live.current ? draftRef.current : draftOf(target);
      // The images that keep the message within its limit.
      const out = base.attachments.slice();
      let bytes = out.reduce((n, a) => n + a.data.length, 0);
      for (const a of ok) {
        if (out.length >= MAX_ATTACHMENTS) {
          error ??= t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS });
          continue;
        }
        if (bytes + a.data.length > MAX_PROMPT - (64 << 10)) {
          error ??= t('conversation.attach.promptTooLarge', { max: formatBytes(MAX_PROMPT) });
          continue;
        }
        bytes += a.data.length;
        out.push(a);
      }
      if (!live.current) {
        if (out.length !== base.attachments.length) keepDraft(target, { ...base, attachments: out });
        return;
      }
      updateDraft({ attachments: out });
      setAttachments(out);
      setFailed(error);
    });
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const raw = Array.from(e.clipboardData?.files ?? []);
    const list = raw.length
      ? raw
      : Array.from(e.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((f): f is File => f !== null);
    if (!list.length) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    addFiles(list);
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  // Rows of the file explorer of the chat's machine attach as files, as the
  // file picker attaches them (folders too: the agent reads them where they
  // are); rows of another machine are refused.
  const takesRows = (e: DragEvent) => !readOnly && !!base?.m && takesPaths(e.dataTransfer, base.m);
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (carriesPaths(e.dataTransfer)) {
      if (!takesRows(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
      return;
    }
    if (readOnly || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = caps.images ? 'copy' : 'none';
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (carriesPaths(e.dataTransfer)) {
      if (!takesRows(e)) return;
      e.preventDefault();
      const rows = draggedPaths(e.dataTransfer, base!.m);
      if (!rows) return;
      const dirs = new Set(rows.dirs);
      const root = base!.dir || '/';
      addFileChips(
        rows.paths.map((path) =>
          dirs.has(path) ? { path, label: relativePosix(root, path), isDir: true } : { path, label: relativePosix(root, path) },
        ),
      );
      inputRef.current?.focus();
      return;
    }
    if (readOnly || !hasFiles(e)) return;
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  // ---- compacting (#9) ----
  const compacting = activity === 'compacting' || compactPending;
  const starting = state === 'starting';
  const canCompactNow = caps.compact && !readOnly && !working && !pending && !starting && !compacting && state !== 'closed';
  const compactDisabledReason = readOnly
    ? t('conversation.compact.disabledReadOnly')
    : working
      ? t('conversation.compact.disabledWorking')
      : starting
        ? t('conversation.compact.disabledStarting')
        : state === 'closed'
          ? t('conversation.compact.disabledClosed')
          : undefined;

  const runCompact = async (instructions?: string): Promise<boolean> => {
    setFailed(undefined);
    setCompactPending(true);
    try {
      await (instructions ? source.compact(instructions) : source.compact());
      return true;
    } catch (e: unknown) {
      fail(errorText(e, agent, 'conversation.commandFailed'));
      return false;
    } finally {
      if (live.current) setCompactPending(false);
    }
  };

  // ---- sending (#4) ----
  const body = text.replace(/\s+$/, '');
  const hasBody = body.trim() !== '' || attachments.length > 0 || attachedFiles.length > 0;
  const parsedCompact = caps.compact && !attachments.length && !attachedFiles.length ? parseCompact(body) : undefined;
  const compact = parsedCompact !== undefined;
  const queues = working && !compact;
  const canSend = !readOnly && !pending && !starting && hasBody && (compact ? !working : !working || caps.queue);
  const showSteerAction = working && !readOnly && !compact && (!!caps.steer || caps.queue);
  const canSteerNow = showSteerAction && !pending && !starting && hasBody;

  const clear = () => {
    bumpClearGen(source);
    const empty = emptyDraft();
    draftRef.current = empty;
    keepDraft(source, empty);
    if (!live.current) return;
    setText('');
    setCaret(0);
    setAttachments([]);
    setAttachedFiles([]);
    setMentions([]);
    setPreview(false);
  };

  const send = (delivery?: Delivery) => {
    const allowed = delivery === 'steer' || delivery === 'interrupt' ? canSteerNow : canSend;
    if (!allowed) return;
    setFailed(undefined);
    if (compact) {
      setPending(true);
      void runCompact(parsedCompact.instructions).then((ok) => {
        if (!live.current) return;
        if (ok) clear();
        setPending(false);
      });
      return;
    }
    const content = promptContent(body, attachments, mentions, attachedFiles);
    if (!fits(content)) return fail(t('conversation.attach.promptTooLarge', { max: formatBytes(MAX_PROMPT) }));
    // The same message sent again (after its outcome was not known, or a
    // refusal) keeps its id: the host takes it once.
    const key = JSON.stringify(content);
    const before = outstanding.current;
    const clientId = before && before.key === key ? before.clientId : newClientId();
    outstanding.current = { clientId, key };
    setUnsure(false);
    setPending(true);
    const done = () => {
      if (outstanding.current?.clientId === clientId) outstanding.current = undefined;
      clear();
      if (live.current) setPending(false);
    };
    const effectiveDelivery = delivery ?? (working && caps.queue ? 'queue' : undefined);
    Promise.resolve()
      .then(() => (effectiveDelivery ? source.send(content, clientId, effectiveDelivery) : source.send(content, clientId)))
      .then(done, (e: unknown) => {
        if (deliveredRef.current?.(clientId)) return done();
        if (!live.current) return;
        setPending(false);
        // Sent, but whether the host took it is not known: the draft stays
        // until the conversation shows it, or the user sends it again.
        if (unsureOf(e) && outstanding.current?.clientId === clientId) setUnsure(true);
        else fail(errorText(e, agent, 'conversation.sendFailed'));
      });
  };

  // A message whose outcome was not known is in the conversation: it was
  // taken, and the draft that was it goes.
  useEffect(() => {
    const o = outstanding.current;
    if (!o || pending || !delivered?.(o.clientId)) return;
    outstanding.current = undefined;
    setUnsure(false);
    if (JSON.stringify(promptContent(body, attachments, mentions, attachedFiles)) === o.key) clear();
    // body, attachments, mentions and attachedFiles are read when the message arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivered, pending]);

  const stop = () => run(() => source.cancel());

  // ---- queue item actions (#4) ----
  const editQueued = (q: QueuedMessage) => {
    void run(async () => {
      await source.cancelQueued(q.message);
      if (!live.current) return;
      const qText = blocksText(q.content);
      const qImages: Attachment[] = [];
      const qLinks: FileSuggestion[] = [];
      for (const b of q.content) {
        if (b.type === 'image' && typeof b.mimeType === 'string' && typeof b.data === 'string') {
          qImages.push(attachmentFromImage(b, qImages.length));
        } else if (b.type === 'resource_link') {
          const path = pathFromFileUri(b.uri);
          if (path && !qText.includes(`@${b.name}`)) qLinks.push({ path, label: b.name });
        }
      }
      if (qImages.length) {
        const nextImages = [...qImages, ...draftRef.current.attachments].slice(0, MAX_ATTACHMENTS);
        updateDraft({ attachments: nextImages });
        setAttachments(nextImages);
      }
      if (qLinks.length) addFileChips(qLinks);
      const curText = draftRef.current.text;
      const merged = qText ? (curText.trim() ? `${qText}\n\n${curText}` : qText) : curText;
      const caretPos = qText ? qText.length : curText.length;
      nextSelection.current = { start: caretPos, end: caretPos };
      setPreview(false);
      change(merged, caretPos);
      inputRef.current?.focus();
    });
  };

  const steerQueuedItem = (q: QueuedMessage) => {
    if (!source.steerQueued) return;
    const mode: 'steer' | 'interrupt' = caps.steer ? 'steer' : 'interrupt';
    setSteeringId(q.message);
    void run(() => source.steerQueued!(q.message, mode)).finally(() => {
      if (live.current) setSteeringId((cur) => (cur === q.message ? undefined : cur));
    });
  };

  const clearAllQueued = () => {
    void Promise.allSettled(queued.map((q) => source.cancelQueued(q.message))).then((results) => {
      if (!live.current) return;
      const firstErr = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (firstErr) fail(errorText(firstErr.reason, agent, 'conversation.commandFailed'));
    });
  };

  const togglePreview = () => {
    setPreview((p) => {
      const next = !p;
      if (!next) queueMicrotask(() => inputRef.current?.focus());
      return next;
    });
  };

  const onBoxKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      togglePreview();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = menuItems.length;
        setActive((shown + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        e.preventDefault();
        choose(menuItems[shown]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(menuKey);
        return;
      }
    } else if (
      e.key === 'Tab' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      at &&
      menuKey === dismissed &&
      menuItems.length > 0
    ) {
      // Pressing Tab on a dismissed `/command` or `@file` token re-opens its menu
      // instead of silently guessing or leaving the input.
      e.preventDefault();
      setDismissed(undefined);
      return;
    }
    if (e.key === 'Escape' && working && !readOnly) {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }

    // Markdown editing helpers (shortcuts, list/quote/fence continuation, Tab indent, paired wrap)
    const el = e.currentTarget;
    const md = handleMarkdownKey(el.value, el.selectionStart, el.selectionEnd, {
      key: e.key,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    });
    if (md) {
      e.preventDefault();
      nextSelection.current = { start: md.selectionStart, end: md.selectionEnd };
      change(md.text, md.selectionStart);
      return;
    }

    if (e.key !== 'Enter') return;
    // Cmd/Ctrl+Enter: force steer / interrupt-send while working, else send.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (working && !compact && showSteerAction) send(caps.steer ? 'steer' : 'interrupt');
      else send();
      return;
    }
    // Shift+Enter without Markdown continuation: the field's own new line.
    if (e.shiftKey) return;
    e.preventDefault();
    if (e.altKey) {
      const pos = el.selectionStart;
      nextSelection.current = { start: pos + 1, end: pos + 1 };
      change(el.value.slice(0, pos) + '\n' + el.value.slice(el.selectionEnd), pos + 1);
      return;
    }
    send();
  };

  const rawModel = configOf(chat, CATEGORY_MODEL);
  const model = useMemo(() => {
    if (!rawModel) return undefined;
    const allow = modelPicker?.visibleModels;
    if (!allow || allow.length === 0) return rawModel;
    const set = new Set(allow);
    return { ...rawModel, options: rawModel.options.filter((o) => set.has(o.value) || o.value === rawModel.currentValue) };
  }, [rawModel, modelPicker?.visibleModels]);
  const effort = configOf(chat, CATEGORY_THOUGHT_LEVEL);
  const mode = configOf(chat, CATEGORY_MODE);
  const setConfig = (id: string, value: string) =>
    run(async () => {
      await source.setConfig(id, value);
      if (id === rawModel?.id) modelPicker?.onModelChosen?.(value);
    });
  const fullBlocked: FullBlocked = readOnly ? 'readOnly' : allowFull ? undefined : 'off';
  const canCancelQueued = caps.cancelQueued && !readOnly;
  const canSteerQueued = !!source.steerQueued && !readOnly && (!!caps.steer || caps.cancelQueued);
  const handedOff = !!chat?.handedOff;
  const modLabel = isMac() ? '⌘' : 'Ctrl';
  const canBrowseFiles = !!(base?.m && base?.dir);
  const projectName = base?.dir ? baseNameOf(base.dir) || base.dir : undefined;
  const showMetaBar = !!(projectName || branch || model || effort || mode || usage);

  return (
    <div className="conv-composer">
      {queued.length > 0 && (
        <div className="conv-queued" role="list" aria-label={t('conversation.queued.label')}>
          <div className="conv-queued-head">
            <Clock aria-hidden />
            <span>{t('conversation.queued.heading', { n: queued.length })}</span>
            {canCancelQueued && queued.length > 1 && (
              <button type="button" className="ghost conv-queued-clear" onClick={clearAllQueued}>
                {t('conversation.queued.clearAll')}
              </button>
            )}
          </div>
          {queued.map((q) => {
            const qText = blocksText(q.content).trim();
            const images = q.content.filter((b) => b.type === 'image').length;
            const fileLinks = q.content.filter((b) => b.type === 'resource_link');
            const isSteering = steeringId === q.message;
            return (
              <div key={q.message} className="conv-queued-item" role="listitem" data-message={q.message}>
                <div className="conv-queued-body">
                  <span className="conv-queued-text" title={qText}>
                    {qText ||
                      (images > 0
                        ? t('conversation.queued.images', { n: images })
                        : t('conversation.queued.files', { n: fileLinks.length }))}
                  </span>
                  {(images > 0 || fileLinks.length > 0) && qText !== '' && (
                    <div className="conv-queued-meta">
                      {images > 0 && (
                        <span className="conv-queued-chip">
                          <ImageIcon aria-hidden />
                          <span>{t('conversation.queued.images', { n: images })}</span>
                        </span>
                      )}
                      {fileLinks.map((b, i) => (
                        <span key={`${b.uri}-${i}`} className="conv-queued-chip ellipsis" title={b.name}>
                          <FileText aria-hidden />
                          <span className="ellipsis">{baseNameOf(b.name)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="conv-queued-aside">
                  <span className="conv-queued-tag" data-steering={isSteering || undefined}>
                    {isSteering ? t('conversation.queued.steering') : t('conversation.queued.tag')}
                  </span>
                  {(canCancelQueued || canSteerQueued) && (
                    <div className="conv-queued-actions">
                      {canSteerQueued && (
                        <button
                          type="button"
                          className="ghost sm icon"
                          data-action="steer"
                          disabled={isSteering}
                          aria-label={t('conversation.queued.steer', { text: qText.slice(0, 60) })}
                          title={caps.steer ? t('conversation.queued.steerHint') : t('conversation.queued.interruptHint')}
                          onClick={() => steerQueuedItem(q)}
                        >
                          {caps.steer ? <Zap aria-hidden /> : <ArrowUp aria-hidden />}
                        </button>
                      )}
                      {canCancelQueued && (
                        <button
                          type="button"
                          className="ghost sm icon"
                          data-action="edit"
                          disabled={isSteering}
                          aria-label={t('conversation.queued.edit', { text: qText.slice(0, 60) })}
                          title={t('conversation.queued.editHint')}
                          onClick={() => editQueued(q)}
                        >
                          <Pencil aria-hidden />
                        </button>
                      )}
                      {canCancelQueued && (
                        <button
                          type="button"
                          className="ghost sm icon"
                          data-action="withdraw"
                          disabled={isSteering}
                          aria-label={t('conversation.queued.cancel', { text: qText.slice(0, 60) })}
                          title={t('conversation.queued.cancelHint')}
                          onClick={() => run(() => source.cancelQueued(q.message))}
                        >
                          <X aria-hidden />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div
        className="conv-box"
        data-drop={dragging || undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onKeyDown={onBoxKeyDown}
      >
        {menuOpen && (
          <div
            ref={menuListRef}
            id={listId}
            className="conv-menu"
            role="listbox"
            data-type={at!.type}
            aria-label={at!.type === 'slash' ? t('conversation.command.list') : t('conversation.mention.list')}
          >
            {menuItems.map((m, i) => (
              <div
                key={m.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === shown}
                className="conv-menu-item"
                data-dir={m.isDir || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(m)}
              >
                {at!.type === 'slash' ? (
                  <SquareSlash aria-hidden />
                ) : (
                  <FileIcon name={baseNameOf(m.label)} kind={m.isDir ? 'dir' : 'file'} />
                )}
                <span className="conv-menu-label">{highlightMatch(m.label, at!.query)}</span>
                {m.hint && <span className="conv-menu-hint">{m.hint}</span>}
                {m.detail && <span className="conv-menu-detail">{m.detail}</span>}
              </div>
            ))}
          </div>
        )}
        {waiting && !readOnly && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.waiting', { agent })}</span>
            <button type="button" className="conv-link" onClick={onShowWaiting}>
              {t('conversation.showWaiting')}
            </button>
          </div>
        )}
        {state === 'failed' && (
          <div className="conv-banner error" role="alert">
            <TriangleAlert aria-hidden />
            <span title={stateError?.stderr || stateError?.message}>
              {/* A chat fails as not_found when its agent's program or its
                  resumed session is missing, not as an answer elsewhere. */}
              {stateError?.code === 'not_found'
                ? t('conversation.error.start_not_found', { agent })
                : stateError?.code && stateError.code !== 'failed'
                  ? errorText(stateError, agent, 'conversation.failed')
                  : t('conversation.failed', { agent })}{' '}
              {!readOnly && t('conversation.failedResume')}
            </span>
          </div>
        )}
        {handedOff && state !== 'failed' && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.handedOff', { agent })}</span>
          </div>
        )}
        {state === 'closed' && !handedOff && (
          <div className="conv-banner" role="status">
            <span>{t('conversation.closed')}</span>
          </div>
        )}
        {unsure && failed === undefined && (
          <div className="conv-banner" role="status" data-unsure="">
            <Clock aria-hidden />
            <span>{t('conversation.sendUnsure', { agent })}</span>
          </div>
        )}
        {failed !== undefined && (
          <div className="conv-banner error" role="alert">
            <TriangleAlert aria-hidden />
            <span>{failed}</span>
            <button type="button" className="ghost sm icon" aria-label={t('conversation.dismiss')} onClick={() => setFailed(undefined)}>
              <X aria-hidden />
            </button>
          </div>
        )}
        {attachedFiles.length > 0 && (
          <div className="conv-file-chips" role="list" aria-label={t('conversation.attach.filesLabel')}>
            {attachedFiles.map((f) => (
              <span key={f.path} className="conv-file-chip" role="listitem" title={f.path}>
                <FileIcon name={baseNameOf(f.label)} kind={f.isDir ? 'dir' : 'file'} />
                <span className="conv-file-chip-label ellipsis">{f.label}</span>
                {!readOnly && (
                  <button
                    type="button"
                    className="conv-file-chip-remove"
                    aria-label={t('conversation.attach.remove', { name: f.label })}
                    onClick={() => {
                      const next = draftRef.current.attachedFiles.filter((x) => x.path !== f.path);
                      updateDraft({ attachedFiles: next });
                      setAttachedFiles(next);
                    }}
                  >
                    <X aria-hidden />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="conv-attachments" role="list" aria-label={t('conversation.attach.label')}>
            {attachments.map((a) => (
              <figure key={a.id} className="conv-attachment" role="listitem" title={`${a.name} · ${formatBytes(a.size)}`}>
                <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                {!readOnly && (
                  <button
                    type="button"
                    className="conv-attachment-remove"
                    aria-label={t('conversation.attach.remove', { name: a.name })}
                    onClick={() => {
                      const next = draftRef.current.attachments.filter((x) => x.id !== a.id);
                      updateDraft({ attachments: next });
                      setAttachments(next);
                    }}
                  >
                    <X aria-hidden />
                  </button>
                )}
              </figure>
            ))}
          </div>
        )}
        <div className="conv-input-row">
          <PlusMenu
            buttonRef={plusBtnRef}
            canBrowseFiles={canBrowseFiles}
            canImages={caps.images}
            preview={preview}
            modLabel={modLabel}
            disabled={readOnly || pending}
            onPickFiles={() => setFilePickerOpen(true)}
            onPickImages={() => picker.current?.click()}
            onTogglePreview={togglePreview}
          />
          {caps.images && (
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES.join(',')}
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          )}
          <div className="conv-field" data-valid-slash={validSlashToken || undefined}>
            {preview && (
              <div className="conv-composer-preview" role="region" aria-label={t('conversation.markdown.previewLabel')}>
                {text.trim() ? (
                  <Markdown text={text} variant="compact" base={base} className="conv-md" codeCopy={false} />
                ) : (
                  <span className="conv-composer-preview-empty">{t('conversation.markdown.previewEmpty')}</span>
                )}
              </div>
            )}
            {!preview && validSlashToken && (
              <div ref={backdropRef} className="conv-input-backdrop" aria-hidden="true">
                <span className="conv-slash-highlight">{validSlashToken}</span>
                {text.slice(validSlashToken.length)}
              </div>
            )}
            <textarea
              ref={inputRef}
              hidden={preview}
              className={pending ? 'conv-input pending' : 'conv-input'}
              rows={1}
              value={text}
              disabled={readOnly}
              readOnly={pending}
              aria-busy={pending || undefined}
              aria-label={t('conversation.composer.label', { agent })}
              aria-keyshortcuts="Enter"
              aria-autocomplete="list"
              aria-controls={menuOpen ? listId : undefined}
              aria-activedescendant={menuOpen ? `${listId}-${shown}` : undefined}
              placeholder={
                readOnly
                  ? t('conversation.composer.readOnly')
                  : working && caps.queue
                    ? t('conversation.composer.queuePlaceholder', { agent })
                    : t('conversation.composer.placeholder', { agent })
              }
              spellCheck
              onChange={(e) => change(e.target.value, e.target.selectionStart)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onScroll={(e) => {
                if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onBlur={() => setDismissed(menuKey)}
              onFocus={() => setDismissed(undefined)}
            />
          </div>
          <div className="conv-input-actions">
            {working && !readOnly && (
              <button
                type="button"
                className="sm conv-stop"
                title={t('conversation.stopHint', { agent })}
                aria-keyshortcuts="Escape"
                onClick={stop}
              >
                <Square aria-hidden />
                {t('conversation.stop')}
              </button>
            )}
            {showSteerAction && (
              <button
                type="button"
                className="ghost sm conv-steer"
                data-delivery={caps.steer ? 'steer' : 'interrupt'}
                title={t(caps.steer ? 'conversation.steerHint' : 'conversation.interruptSendHint', { key: `${modLabel}+Enter` })}
                disabled={!canSteerNow}
                onClick={() => send(caps.steer ? 'steer' : 'interrupt')}
              >
                {caps.steer ? <Zap aria-hidden /> : <FastForward aria-hidden />}
                <span>{t(caps.steer ? 'conversation.steer' : 'conversation.interruptSend')}</span>
              </button>
            )}
            <button
              type="button"
              className="primary conv-send"
              aria-label={queues ? t('conversation.queue') : t('conversation.send')}
              title={queues ? t('conversation.queueHint', { agent }) : t('conversation.sendHint')}
              disabled={!canSend}
              onClick={() => send()}
            >
              {pending ? <LoaderCircle className="conv-spin" aria-hidden /> : queues ? <ListPlus aria-hidden /> : <ArrowUp aria-hidden />}
            </button>
          </div>
        </div>
      </div>
      {showMetaBar && (
        <div className="conv-meta-bar">
          <div className="conv-meta-left">
            {projectName && (
              <span className="conv-meta-item conv-project" title={t('conversation.project.label', { path: base!.dir })}>
                <Folder aria-hidden />
                <span className="ellipsis">{projectName}</span>
              </span>
            )}
            {branch && (
              <span className="conv-meta-item conv-branch" title={t('conversation.branch.label', { branch })}>
                <GitBranch aria-hidden />
                <span className="ellipsis">{branch}</span>
              </span>
            )}
          </div>
          <div className="conv-meta-right">
            {(model || effort) && (
              <ModelEffortSelect model={model} effort={effort} disabled={readOnly} fullBlocked={fullBlocked} onSet={setConfig} />
            )}
            {mode && (
              <ConfigSelect
                option={mode}
                label={t('conversation.config.mode')}
                nameOf={modeName}
                disabled={readOnly}
                fullBlocked={fullBlocked}
                onSet={setConfig}
              />
            )}
            {usage && (
              <UsageLine
                usage={usage}
                canCompact={caps.compact}
                compactReady={canCompactNow}
                compactDisabledReason={compactDisabledReason}
                compacting={compacting}
                onCompact={(instructions) => {
                  void runCompact(instructions);
                }}
              />
            )}
          </div>
        </div>
      )}
      {filePickerOpen &&
        base &&
        createPortal(
          <div
            ref={filePopRef}
            className="conv-file-picker-popover"
            style={
              filePickerPlace
                ? {
                    left: filePickerPlace.left,
                    ...(filePickerPlace.top !== undefined ? { top: filePickerPlace.top } : { bottom: filePickerPlace.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onMouseDown={(e) => e.stopPropagation()}
          >
            <FilePicker
              m={base.m}
              rootDir={base.dir}
              selected={attachedFiles.map((f) => f.path)}
              onSelect={replaceFileChips}
              onClose={() => closeFilePicker(true)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

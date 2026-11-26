// The composer of a chat: a field that sends on Enter (Shift+Enter or
// Alt+Enter: a new line with Markdown list/quote/fence continuation),
// Markdown formatting shortcuts and Write/Preview toggle, images attached by
// pasting, dropping or picking them (each at most MAX_IMAGE bytes, the
// message at most MAX_PROMPT), workspace files named with `@` (including
// directory drill-down and space-safe chips) or browsed via FilePicker, the
// agent's commands with `/` (and compact, where the agent can), bottom-left
// agent kind badge, selectors of the model (filtered by visibleModels with
// "Manage models…"), effort and permission mode, a Slack-style queued
// messages stack (edit, steer/send-now, withdraw), explicit steer/interrupt
// controls while a turn runs, a stop button (and Escape), and a usage line
// with interactive click-to-compact context meter and session cost.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Eye,
  FastForward,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  ListPlus,
  LoaderCircle,
  Paperclip,
  Pencil,
  SlidersHorizontal,
  Square,
  SquareSlash,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { FilePicker } from '../components/FilePicker';
import { useDismiss } from '../components/useDismiss';
import { FileIcon } from '../fileIcons';
import { locale, t, type MessageKey } from '../i18n';
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
import { contextPercent, formatCost, formatTokens } from './format';
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
import type { ConfigOption, ConfigValue } from '../plugins/chat/protocol';
import './composer.css';

/** The user's text not sent yet, by chat (the source's id) or by source:
 * it outlives the view until it is sent. */
const drafts = new WeakMap<ChatSource, string>();
const namedDrafts = new Map<string, string>();
/** The most drafts kept by name. */
const MAX_DRAFTS = 200;

function draftOf(s: ChatSource): string {
  return (s.id ? namedDrafts.get(s.id) : drafts.get(s)) ?? '';
}

function keepDraft(s: ChatSource, text: string) {
  if (!s.id) {
    if (text) drafts.set(s, text);
    else drafts.delete(s);
    return;
  }
  namedDrafts.delete(s.id);
  if (!text) return;
  namedDrafts.set(s.id, text);
  if (namedDrafts.size > MAX_DRAFTS) namedDrafts.delete(namedDrafts.keys().next().value!);
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

/** A mode's name in the view's words when it is one of the host's. */
function modeName(v: ConfigValue): string {
  switch (v.value) {
    case 'default':
    case 'acceptEdits':
    case 'plan':
    case 'auto':
    case 'full':
      return t(`conversation.mode.${v.value}`);
    case 'bypassPermissions':
      return t('conversation.mode.full');
    default:
      return v.name;
  }
}

/** Why the values that give an agent full access (ConfigValue.full) are
 * not offered: the machine's settings do not allow it, or the view is
 * read-only. */
export type FullBlocked = 'off' | 'readOnly' | undefined;

export interface ConfigMenuPlace {
  placement: 'top' | 'bottom';
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Places a popover below or above its trigger button, preferring upward
 * placement when near the bottom of the viewport. */
export function placeConfigMenu(
  anchor: { left: number; top: number; right: number; bottom: number },
  wanted: number,
  view: { width: number; height: number },
  maxWidthLimit = 340,
  minWidthFloor = 160,
): ConfigMenuPlace {
  const margin = 8;
  const gap = 4;
  const availW = Math.max(0, view.width - 2 * margin);
  const minWidth = Math.min(Math.max(anchor.right - anchor.left, minWidthFloor), availW);
  const maxWidth = Math.min(maxWidthLimit, Math.max(minWidth, availW));
  const left = Math.max(margin, Math.min(anchor.left, view.width - minWidth - margin));
  const below = view.height - anchor.bottom - margin - gap;
  const above = anchor.top - margin - gap;
  if (wanted <= below || (below >= above && below >= 120)) {
    return {
      placement: 'bottom',
      left,
      minWidth,
      maxWidth,
      top: anchor.bottom + gap,
      maxHeight: Math.max(80, below),
    };
  }
  return {
    placement: 'top',
    left,
    minWidth,
    maxWidth,
    bottom: view.height - anchor.top + gap,
    maxHeight: Math.max(80, above),
  };
}

function ConfigSelect({
  option,
  label,
  nameOf,
  disabled,
  fullBlocked,
  onSet,
  footerAction,
}: {
  option: ConfigOption;
  label: string;
  nameOf?: (v: ConfigValue) => string;
  disabled: boolean;
  fullBlocked: FullBlocked;
  onSet: (id: string, value: string) => Promise<void>;
  footerAction?: { label: string; onClick(): void };
}) {
  /** The value asked for until the host took it. */
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupId = useId();

  const value = asked ?? option.currentValue;
  const values = option.options.some((o) => o.value === value) ? option.options : [{ value, name: value }, ...option.options];
  const blocked = (v: ConfigValue) => !!fullBlocked && v.full === true;
  const labelOf = (v: ConfigValue) => {
    const name = nameOf ? nameOf(v) : v.name;
    return blocked(v) ? t(fullBlocked === 'readOnly' ? 'conversation.config.fullReadOnly' : 'conversation.config.fullOff', { name }) : name;
  };
  const current = values.find((v) => v.value === value);
  const currentLabel = current ? labelOf(current) : value;
  const isDisabled = disabled || asked !== undefined;

  let title = option.description ? `${label}: ${option.description}` : label;
  if (fullBlocked === 'off' && values.some(blocked)) title += `\n${t('conversation.config.fullOffHint')}`;

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(open, menuRef, () => close(false), buttonRef);

  const enabledIndexes = useMemo(
    () => values.map((v, i) => (!blocked(v) ? i : -1)).filter((i) => i >= 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, fullBlocked],
  );

  const openMenu = (preferred?: 'first' | 'last') => {
    if (isDisabled) return;
    const curIdx = values.findIndex((v) => v.value === value && !blocked(v));
    const init =
      preferred === 'last'
        ? (enabledIndexes[enabledIndexes.length - 1] ?? 0)
        : preferred === 'first'
          ? (enabledIndexes[0] ?? 0)
          : curIdx >= 0
            ? curIdx
            : (enabledIndexes[0] ?? 0);
    setActive(init);
    setOpen(true);
  };

  useEffect(() => {
    if (isDisabled && open) setOpen(false);
  }, [isDisabled, open]);

  const updatePlace = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const estimated = Math.min(Math.max(menuRef.current?.scrollHeight ?? 0, values.length * 32 + (footerAction ? 44 : 12)), 320);
    setPlace(placeConfigMenu(btn.getBoundingClientRect(), estimated, { width: window.innerWidth, height: window.innerHeight }));
  }, [values.length, footerAction]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(undefined);
      return;
    }
    updatePlace();
    menuRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [open, updatePlace]);

  const choose = (v: ConfigValue) => {
    if (blocked(v)) return;
    close(true);
    if (v.value === value) return;
    setAsked(v.value);
    onSet(option.id, v.value).finally(() => setAsked(undefined));
  };

  const stepActive = (delta: number) => {
    if (!enabledIndexes.length) return;
    const pos = enabledIndexes.indexOf(active);
    const next = pos < 0 ? 0 : (pos + delta + enabledIndexes.length) % enabledIndexes.length;
    setActive(enabledIndexes[next]);
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepActive(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (enabledIndexes.length) setActive(enabledIndexes[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (enabledIndexes.length) setActive(enabledIndexes[enabledIndexes.length - 1]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = values[active];
      if (item && !blocked(item)) choose(item);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="conv-select"
        data-config={option.category}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={label}
        title={title}
        disabled={isDisabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
      >
        <span className="conv-select-label ellipsis">{currentLabel}</span>
        <ChevronDown className="conv-select-chevron" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={popupId}
            className="conv-select-menu"
            role="listbox"
            tabIndex={-1}
            data-config={option.category}
            data-placement={place?.placement}
            aria-label={label}
            aria-activedescendant={active >= 0 ? `${popupId}-${active}` : undefined}
            style={
              place
                ? {
                    left: place.left,
                    minWidth: place.minWidth,
                    maxWidth: place.maxWidth,
                    maxHeight: place.maxHeight,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {values.map((v, i) => {
              const isBlocked = blocked(v);
              const isSelected = v.value === value;
              const isActive = i === active && !isBlocked;
              return (
                <div
                  key={v.value}
                  id={`${popupId}-${i}`}
                  role="option"
                  data-value={v.value}
                  data-full={isBlocked ? fullBlocked : undefined}
                  aria-selected={isSelected}
                  aria-disabled={isBlocked || undefined}
                  title={v.description}
                  className={['conv-select-option', isActive && 'active', isSelected && 'selected', isBlocked && 'disabled']
                    .filter(Boolean)
                    .join(' ')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => !isBlocked && setActive(i)}
                  onClick={() => choose(v)}
                >
                  <span className="conv-select-option-text">
                    <span className="conv-select-option-label ellipsis">{labelOf(v)}</span>
                    {v.description && <span className="conv-select-option-desc ellipsis">{v.description}</span>}
                  </span>
                  {isSelected && <Check className="conv-select-option-check" aria-hidden />}
                </div>
              );
            })}
            {footerAction && (
              <div className="conv-select-footer">
                <button
                  type="button"
                  className="conv-select-manage"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    close(false);
                    footerAction.onClick();
                  }}
                >
                  <SlidersHorizontal aria-hidden />
                  <span>{footerAction.label}</span>
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export interface UsageLineProps {
  usage: Usage;
  /** Whether the agent supports manual compaction. */
  canCompact?: boolean;
  /** Whether manual compaction can run right now. */
  compactReady?: boolean;
  /** Tooltip explanation when compaction is currently unavailable. */
  compactDisabledReason?: string;
  /** True while compaction is running. */
  compacting?: boolean;
  /** Runs manual compaction, optionally with user focus instructions. */
  onCompact?(instructions?: string): Promise<void> | void;
}

/** The chat's usage: the context in use (clickable to compact when the agent
 * supports it) and the session cost so far. Quota/rate-limit windows belong
 * to the AI Usage plugin's status bar item rather than here. */
export function UsageLine({ usage, canCompact, compactReady, compactDisabledReason, compacting, onCompact }: UsageLineProps) {
  const pct = contextPercent(usage);
  const level = (p: number) => (p >= 90 ? 'high' : p >= 75 ? 'mid' : undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [place, setPlace] = useState<ConfigMenuPlace>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const instrRef = useRef<HTMLInputElement>(null);

  const closeConfirm = useCallback((returnFocus = false) => {
    setConfirmOpen(false);
    setInstructions('');
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(confirmOpen, popRef, () => closeConfirm(false), triggerRef);

  useEffect(() => {
    if ((!compactReady || compacting) && confirmOpen) closeConfirm(false);
  }, [compactReady, compacting, confirmOpen, closeConfirm]);

  const updatePlace = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    setPlace(placeConfigMenu(btn.getBoundingClientRect(), 150, { width: window.innerWidth, height: window.innerHeight }, 290, 260));
  }, []);

  useLayoutEffect(() => {
    if (!confirmOpen) {
      setPlace(undefined);
      return;
    }
    updatePlace();
    instrRef.current?.focus({ preventScroll: true });
    window.addEventListener('resize', updatePlace);
    window.addEventListener('scroll', updatePlace, true);
    return () => {
      window.removeEventListener('resize', updatePlace);
      window.removeEventListener('scroll', updatePlace, true);
    };
  }, [confirmOpen, updatePlace]);

  const runCompact = () => {
    const note = instructions.trim() || undefined;
    closeConfirm(false);
    void onCompact?.(note);
  };

  const parts = [];
  const baseCtxTitle =
    usage.size > 0
      ? t('conversation.context', { used: formatTokens(usage.used), size: formatTokens(usage.size) })
      : t('conversation.contextUsed');
  const interactive = !!(canCompact && onCompact);
  const ctxTitle = interactive
    ? `${baseCtxTitle}\n${
        compacting ? t('conversation.compact.running') : compactReady ? t('conversation.compact.clickHint') : (compactDisabledReason ?? '')
      }`.trim()
    : baseCtxTitle;

  if (pct !== undefined || usage.used > 0 || (interactive && compacting)) {
    const n = pct !== undefined ? Math.round(pct) : undefined;
    const content = compacting ? (
      <>
        <LoaderCircle className="conv-spin" aria-hidden />
        <span>{t('conversation.compact.running')}</span>
      </>
    ) : n !== undefined ? (
      <span
        className="conv-meter"
        role="meter"
        aria-label={t('conversation.contextUsed')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={n}
        title={interactive ? undefined : baseCtxTitle}
        data-level={level(pct!)}
      >
        <span className="conv-meter-bar">
          <span style={{ width: `${n}%` }} />
        </span>
        <span className="conv-meter-pct">{t('conversation.usage.context', { pct: n })}</span>
      </span>
    ) : (
      <span className="conv-usage-tokens">{t('conversation.usage.tokens', { n: formatTokens(usage.used) })}</span>
    );

    if (interactive) {
      parts.push(
        <button
          key="ctx"
          ref={triggerRef}
          type="button"
          className="conv-compact-btn"
          aria-haspopup="dialog"
          aria-expanded={confirmOpen}
          aria-busy={compacting || undefined}
          title={ctxTitle}
          disabled={!compactReady || compacting}
          onClick={() => (confirmOpen ? closeConfirm(false) : setConfirmOpen(true))}
        >
          {content}
        </button>,
      );
    } else {
      parts.push(<span key="ctx">{content}</span>);
    }
  }
  if (usage.cost)
    parts.push(
      <span key="cost" className="conv-usage-cost" title={t('conversation.usage.costTitle')}>
        {formatCost(usage.cost, locale)}
      </span>,
    );
  if (!parts.length) return null;
  return (
    <div className="conv-usage" aria-label={t('conversation.usage.label')}>
      {parts}
      {confirmOpen &&
        createPortal(
          <div
            ref={popRef}
            className="conv-compact-popover"
            role="dialog"
            aria-label={t('conversation.compact.title')}
            style={
              place
                ? {
                    left: place.left,
                    ...(place.top !== undefined ? { top: place.top } : { bottom: place.bottom }),
                  }
                : { visibility: 'hidden' }
            }
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeConfirm(true);
              }
            }}
          >
            <div className="conv-compact-title">{t('conversation.compact.title')}</div>
            <div className="conv-compact-desc">{t('conversation.compact.desc')}</div>
            <input
              ref={instrRef}
              type="text"
              className="conv-compact-input"
              value={instructions}
              placeholder={t('conversation.compact.instructions')}
              aria-label={t('conversation.compact.instructions')}
              onChange={(e) => setInstructions(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runCompact();
                }
              }}
            />
            <div className="conv-compact-actions">
              <button type="button" className="ghost sm" onClick={() => closeConfirm(true)}>
                {t('conversation.compact.cancel')}
              </button>
              <button type="button" className="primary sm" onClick={runCompact}>
                {t('conversation.compact.confirm')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
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
}

/** Whether a command's refusal leaves its outcome unknown: it was sent,
 * and the connection or the subscription ended before the answer came
 * (the source's error says unsure). */
const unsureOf = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { unsure?: unknown }).unsure === true;

export function Composer({
  source,
  agent,
  kind,
  agentIcon,
  base,
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
}: ComposerProps) {
  const caps = chat?.capabilities ?? NO_CAPABILITIES;
  const [text, setText] = useState(() => draftOf(source));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<FileSuggestion[]>([]);
  const [mentions, setMentions] = useState<FileSuggestion[]>([]);
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
  const fileBtnRef = useRef<HTMLButtonElement>(null);
  const filePopRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (readOnly && preview) setPreview(false);
    if (readOnly && filePickerOpen) setFilePickerOpen(false);
  }, [readOnly, preview, filePickerOpen]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    grow(el);
    if (el && nextSelection.current !== undefined) {
      el.setSelectionRange(nextSelection.current.start, nextSelection.current.end);
      setCaret(nextSelection.current.start);
      nextSelection.current = undefined;
    }
  }, [text, preview, inputRef]);

  const closeFilePicker = useCallback((returnFocus = false) => {
    setFilePickerOpen(false);
    if (returnFocus) fileBtnRef.current?.focus({ preventScroll: true });
  }, []);

  useDismiss(filePickerOpen, filePopRef, () => closeFilePicker(false), fileBtnRef);

  const updateFilePickerPlace = useCallback(() => {
    const btn = fileBtnRef.current;
    if (!btn) return;
    setFilePickerPlace(
      placeConfigMenu(btn.getBoundingClientRect(), 360, { width: window.innerWidth, height: window.innerHeight }, 400, 340),
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

  // ---- the list at the caret ----
  const at = readOnly || preview ? undefined : menuAt(text, caret);
  const menuKey = at ? `${at.type}:${at.start}` : undefined;
  const suggest = source.suggestFiles?.bind(source);
  const query = at?.type === 'mention' && suggest ? at.query : undefined;
  useEffect(() => {
    if (query === undefined || menuKey === dismissed) return;
    let current = true;
    const id = setTimeout(() => {
      suggest!(query).then(
        (items) => current && setFiles({ query, items: Array.isArray(items) ? items.slice(0, MAX_MENU) : [] }),
        () => current && setFiles({ query, items: [] }),
      );
    }, SUGGEST_MS);
    return () => {
      current = false;
      clearTimeout(id);
    };
    // suggest is the source's: a new one comes with a new source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, menuKey, dismissed, source]);
  const commands = chat?.commands;
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
    const all = [...(commands ?? [])];
    if (caps.compact && !all.some((c) => c.name === 'compact'))
      all.push({ name: 'compact', description: t('conversation.command.compact') });
    const q = at.query.toLowerCase();
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const within = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    return [...starts, ...within]
      .slice(0, MAX_MENU)
      .map((c) => ({ key: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint, insert: `/${c.name} ` }));
  }, [at?.type, at?.query, files, commands, caps.compact]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuOpen = !!at && menuKey !== dismissed && menuItems.length > 0;
  const shown = Math.min(active, Math.max(0, menuItems.length - 1));
  useEffect(() => setActive(0), [menuKey, at?.query]);

  const change = (v: string, pos?: number) => {
    setText(v);
    setFailed(undefined);
    setUnsure(false);
    if (pos !== undefined) setCaret(pos);
    // A list closed stays closed until its word ends.
    if (!menuAt(v, pos ?? v.length)) setDismissed(undefined);
    keepDraft(source, v);
  };

  const addFileChips = (list: FileSuggestion[]) => {
    if (!list.length) return;
    setAttachedFiles((prev) => {
      const byPath = new Map(prev.map((f) => [f.path, f]));
      for (const f of list) {
        if (f.path.startsWith('/')) byPath.set(f.path, f);
      }
      const next = [...byPath.values()];
      if (next.length > MAX_FILE_ATTACHMENTS) {
        fail(t('conversation.attach.tooManyFiles', { n: MAX_FILE_ATTACHMENTS }));
        return next.slice(0, MAX_FILE_ATTACHMENTS);
      }
      return next;
    });
  };

  const replaceFileChips = (list: FileSuggestion[]) => {
    const clean = list.filter((f) => f.path.startsWith('/'));
    if (clean.length > MAX_FILE_ATTACHMENTS) {
      fail(t('conversation.attach.tooManyFiles', { n: MAX_FILE_ATTACHMENTS }));
      setAttachedFiles(clean.slice(0, MAX_FILE_ATTACHMENTS));
    } else {
      setAttachedFiles(clean);
    }
    setFailed(undefined);
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
        setMentions((m) => [...m, item.mention!]);
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
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return fail(t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS }));
    Promise.allSettled(list.slice(0, room).map(readImage)).then((results) => {
      if (!live.current) return;
      let error: string | undefined;
      const ok: Attachment[] = [];
      for (const r of results) {
        if (r.status === 'rejected') error ??= attachErrorText(r.reason, agent);
        else ok.push(r.value);
      }
      if (list.length > room) error ??= t('conversation.attach.tooMany', { n: MAX_ATTACHMENTS });
      setAttachments((prev) => {
        // The images that keep the message within its limit.
        const out = prev.slice();
        let bytes = prev.reduce((n, a) => n + a.data.length, 0);
        for (const a of ok) {
          if (bytes + a.data.length > MAX_PROMPT - (64 << 10)) {
            error ??= t('conversation.attach.promptTooLarge', { max: formatBytes(MAX_PROMPT) });
            continue;
          }
          bytes += a.data.length;
          out.push(a);
        }
        return out;
      });
      setFailed(error);
    });
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (!list.length) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    addFiles(list);
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = caps.images ? 'copy' : 'none';
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
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
    keepDraft(source, '');
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
        setAttachments((prev) => [...qImages, ...prev].slice(0, MAX_ATTACHMENTS));
      }
      if (qLinks.length) addFileChips(qLinks);
      const merged = qText ? (text.trim() ? `${qText}\n\n${text}` : qText) : text;
      const caretPos = qText ? qText.length : text.length;
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

  const onBoxKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      setPreview((p) => {
        const next = !p;
        if (!next) queueMicrotask(() => inputRef.current?.focus());
        return next;
      });
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
  const setConfig = (id: string, value: string) => run(() => source.setConfig(id, value));
  const fullBlocked: FullBlocked = readOnly ? 'readOnly' : allowFull ? undefined : 'off';
  const canCancelQueued = caps.cancelQueued && !readOnly;
  const canSteerQueued = !!source.steerQueued && !readOnly && (!!caps.steer || caps.cancelQueued);
  const handedOff = !!chat?.handedOff;
  const modLabel = isMac() ? '⌘' : 'Ctrl';
  const canBrowseFiles = !!(base?.m && base?.dir);

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
                <FileIcon name={baseNameOf(f.label)} kind="file" />
                <span className="conv-file-chip-label ellipsis">{f.label}</span>
                {!readOnly && (
                  <button
                    type="button"
                    className="conv-file-chip-remove"
                    aria-label={t('conversation.attach.remove', { name: f.label })}
                    onClick={() => setAttachedFiles((list) => list.filter((x) => x.path !== f.path))}
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
                    onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  >
                    <X aria-hidden />
                  </button>
                )}
              </figure>
            ))}
          </div>
        )}
        <div className="conv-field">
          {menuOpen && (
            <div
              id={listId}
              className="conv-menu"
              role="listbox"
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
                  <span className="conv-menu-label">{m.label}</span>
                  {m.hint && <span className="conv-menu-hint">{m.hint}</span>}
                  {m.detail && <span className="conv-menu-detail">{m.detail}</span>}
                </div>
              ))}
            </div>
          )}
          {preview && (
            <div className="conv-composer-preview" role="region" aria-label={t('conversation.markdown.previewLabel')}>
              {text.trim() ? (
                <Markdown text={text} variant="compact" base={base} className="conv-md" codeCopy={false} />
              ) : (
                <span className="conv-composer-preview-empty">{t('conversation.markdown.previewEmpty')}</span>
              )}
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
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setDismissed(menuKey)}
            onFocus={() => setDismissed(undefined)}
          />
        </div>
        <div className="conv-foot">
          <span className="conv-agent-badge" data-kind={kind || undefined} title={agent}>
            {agentIcon && (
              <span className="conv-agent-badge-icon" aria-hidden="true">
                {agentIcon}
              </span>
            )}
            <span className="conv-agent-badge-name">{agent}</span>
          </span>
          {canBrowseFiles && (
            <button
              ref={fileBtnRef}
              type="button"
              className="ghost sm icon conv-attach-file"
              aria-label={t('conversation.attach.pickFiles')}
              aria-haspopup="dialog"
              aria-expanded={filePickerOpen}
              title={t('conversation.attach.pickFilesHint')}
              disabled={readOnly || pending}
              onClick={() => (filePickerOpen ? closeFilePicker(false) : setFilePickerOpen(true))}
            >
              <Paperclip aria-hidden />
            </button>
          )}
          {caps.images && (
            <>
              <button
                type="button"
                className="ghost sm icon conv-attach"
                aria-label={t('conversation.attach.pick')}
                title={t('conversation.attach.pickHint', { max: formatBytes(MAX_IMAGE) })}
                disabled={readOnly || pending}
                onClick={() => picker.current?.click()}
              >
                <ImagePlus aria-hidden />
              </button>
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
            </>
          )}
          {!readOnly && (
            <button
              type="button"
              className="ghost sm icon conv-preview-toggle"
              aria-label={preview ? t('conversation.markdown.edit') : t('conversation.markdown.preview')}
              aria-pressed={preview}
              title={t(preview ? 'conversation.markdown.editHint' : 'conversation.markdown.previewHint', { key: `${modLabel}+Shift+P` })}
              disabled={pending}
              onClick={() =>
                setPreview((p) => {
                  const next = !p;
                  if (!next) queueMicrotask(() => inputRef.current?.focus());
                  return next;
                })
              }
            >
              {preview ? <Pencil aria-hidden /> : <Eye aria-hidden />}
            </button>
          )}
          {model && (
            <ConfigSelect
              option={model}
              label={t('conversation.config.model')}
              disabled={readOnly}
              fullBlocked={fullBlocked}
              onSet={setConfig}
              footerAction={
                modelPicker?.onManageModels
                  ? { label: t('conversation.config.manageModels'), onClick: modelPicker.onManageModels }
                  : undefined
              }
            />
          )}
          {effort && (
            <ConfigSelect
              option={effort}
              label={t('conversation.config.effort')}
              disabled={readOnly}
              fullBlocked={fullBlocked}
              onSet={setConfig}
            />
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
          <span className="spacer" />
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
  );
}

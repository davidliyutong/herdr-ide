// Pieces the conversation view's items share: what an item may call, what
// the cards that answer the agent may do, and the blocks of a message other
// than its text. A block's members are read as text only when they are
// strings (asText): the blocks come from a machine.

import { createContext, useState } from 'react';
import { FileText, ImageIcon, LoaderCircle, Square } from 'lucide-react';
import { hasMessage, t, type MessageKey } from '../i18n';
import type { MarkdownBase } from '../markdown/links';
import { asText, ownMeta, type ContentBlock } from './model';
import type { BackgroundTask, ChatSource, PermissionReply, QuestionReply, RewindOptions } from './source';

/** What the items of a conversation may call; the same object for every
 * item, so that an item that did not change is not drawn again. */
export interface ItemContext {
  /** The agent's name for people. */
  agent: string;
  /** The machine and working directory relative Markdown links and images
   * resolve against, when the conversation belongs to a machine. */
  base?: MarkdownBase;
  /** Opens a file the agent named (a location, a link to a resource). */
  openFile?: (path: string, line?: number) => void;
  /** Opens a referenced chat (e.g. the previous chat after switching agents). */
  openChat?: (chatId: string, kind?: string) => void;
  /** Trusts the chat's folder (ChatSource.trust); absent when the source
   * cannot or the view is read-only. */
  trust?: () => Promise<void>;
  /** Takes that back (ChatSource.untrust); absent as trust is. */
  untrust?: () => Promise<void>;
}

/** The answers this page gave to the cards of a chat, by the card's item
 * id: a permission's option id ('' when dismissed), ANSWERED or SKIPPED
 * for questions. Only an answer in it is shown as the user's own ("Your
 * choice"); any other one as answered, with no claim about where: the
 * page cannot tell another window's answer from its own before a reload,
 * or from one given while it was not attached. */
export type AnsweredCards = Map<string, string>;
export const ANSWERED = 'answered';
export const SKIPPED = 'skipped';

/** The cards' answers by chat (the source's id) or by source: they outlive
 * the view (the pane moved, the chat attached again) for as long as the
 * page lives. */
const answeredBySource = new WeakMap<ChatSource, AnsweredCards>();
const answeredByName = new Map<string, AnsweredCards>();
/** The most chats, and answers of a chat, kept by name. */
const MAX_ANSWERED_CHATS = 200;
const MAX_ANSWERS = 500;

/** The answers this page gave to the cards of a source's chat. */
export function answeredOf(s: ChatSource): AnsweredCards {
  if (!s.id) {
    let a = answeredBySource.get(s);
    if (!a) answeredBySource.set(s, (a = new Map()));
    return a;
  }
  let a = answeredByName.get(s.id);
  if (a) answeredByName.delete(s.id);
  else a = new Map();
  answeredByName.set(s.id, a);
  if (answeredByName.size > MAX_ANSWERED_CHATS) answeredByName.delete(answeredByName.keys().next().value!);
  return a;
}

/** Keeps the answer this page gave to a card (undefined: none after all). */
export function keepAnswer(a: AnsweredCards, item: string, answer: string | undefined) {
  a.delete(item);
  if (answer === undefined) return;
  a.set(item, answer);
  if (a.size > MAX_ANSWERS) a.delete(a.keys().next().value!);
}

/** What the cards of permissions and questions may do: a context of its
 * own, so that a change of it (the chat stops waiting, read-only) draws
 * the cards again and no other item. */
export interface Answering {
  /** Whether a blocking card that waits may be answered: not read-only, and
   * the chat's turn still runs (an answer to a blocking card of an ended turn
   * goes nowhere). */
  open: boolean;
  /** Whether a non-blocking async question may be answered: not read-only and
   * the chat is neither closed nor failed. */
  openAsync: boolean;
  /** The items of the cards that wait (model.ts waitingItems). */
  waiting: ReadonlySet<string>;
  readOnly: boolean;
  /** The answers this page gave to the chat's cards (answeredOf). */
  answered: AnsweredCards;
  respond(permission: string, reply: PermissionReply): Promise<void>;
  answer(question: string, reply: QuestionReply): Promise<void>;
}

const nothing = () => Promise.resolve();
export const AnsweringContext = createContext<Answering>({
  open: false,
  openAsync: false,
  waiting: new Set(),
  readOnly: true,
  answered: new Map(),
  respond: nothing,
  answer: nothing,
});

/** Dynamic timeline actions & live task state kept in a context apart from
 * ItemContext so memoized agent messages do not re-render when turn state or
 * background task lists change. */
export interface TimelineActions {
  /** Native lossless rewind of an idle chat to just before the user turn at `seq`. */
  rewind?: (seq: number, opts?: RewindOptions) => Promise<void>;
  /** True when the chat is idle and writable, but the agent lacks native rewind
   * (so UI surfaces an explicit "unsupported" notice instead of a lossy reset). */
  rewindUnsupported: boolean;
  /** Whether rewind supports restoring file checkpoints. */
  rewindFiles: boolean;
  /** Prefills the composer draft (used by truncate-only Rewind). */
  prefillComposer?: (text: string) => void;
  /** External rewind target requested from the pane header turn picker. */
  rewindTarget?: { seq: number; nonce: number };
  /** Clears the active external rewind target once cancelled or completed. */
  clearRewindTarget?: () => void;
  /** Fork the conversation up to `upToSeq`. */
  fork?: (upToSeq?: number) => void | Promise<void>;
  /** Whether a full-session fork (including forking from the last user turn) is native/lossless. */
  nativeFork: boolean;
  /** Whether a mid-conversation fork (from an earlier user turn) is native/lossless. */
  nativePartialFork: boolean;
  /** Sequence number of the latest user turn in the timeline (used to tell
   * full-session fork apart from partial mid-history fork). */
  lastUserSeq?: number;
  /** Terminate a running background task or subagent by BackgroundTask.id. */
  stopTask?: (taskId: string) => Promise<void>;
  /** Authoritative live background tasks indexed by toolCallId (from ChatInfo.tasks). */
  tasksByToolCall: ReadonlyMap<string, BackgroundTask>;
  /** Agent message item ids (`message:agent:item:<key>`) already covered by an
   * interactive QuestionItem card so inline follow-up questions are not duplicated. */
  questionSourceItems: ReadonlySet<string>;
}

const EMPTY_TASKS: ReadonlyMap<string, BackgroundTask> = new Map();
const EMPTY_STRINGS: ReadonlySet<string> = new Set();

export const TimelineActionsContext = createContext<TimelineActions>({
  rewindUnsupported: false,
  rewindFiles: false,
  nativeFork: false,
  nativePartialFork: false,
  tasksByToolCall: EMPTY_TASKS,
  questionSourceItems: EMPTY_STRINGS,
});

/** Why a command was not taken, in words: by the code of the source's
 * error (chatproto's codes, the hub's), else in general. */
export function errorText(e: unknown, agent: string, fallback: MessageKey): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  const key = `conversation.error.${typeof code === 'string' ? code : ''}`;
  return hasMessage(key) ? t(key, { agent }) : t(fallback, { agent });
}

// An image block is drawn when it is a raster image in base64 (as a data
// URL, which loads nothing from elsewhere) and not too large.
const RASTER = /^image\/(?:png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_IMAGE = 8 << 20;

/** The path of a file:// URI, or undefined. */
function filePath(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  try {
    const u = new URL(uri);
    return u.protocol === 'file:' && u.pathname ? decodeURIComponent(u.pathname) : undefined;
  } catch {
    return undefined;
  }
}

function Chip({ icon, label, title, onClick }: { icon: 'image' | 'file'; label: string; title?: string; onClick?: () => void }) {
  const Icon = icon === 'image' ? ImageIcon : FileText;
  const body = (
    <>
      <Icon aria-hidden />
      <span>{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="conv-chip" title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="conv-chip" title={title}>
      {body}
    </span>
  );
}

/** The blocks of a message that are not text: images, links to resources,
 * embedded resources, and the mark of an image the machine left out
 * (a text block marked image). Text is the caller's. */
export function Blocks({ blocks, ctx }: { blocks: readonly ContentBlock[]; ctx: ItemContext }) {
  const out = blocks.flatMap((b, i) => {
    switch (b.type) {
      case 'image': {
        const type = asText(b.mimeType);
        const data = asText(b.data);
        if (type && RASTER.test(type) && data !== undefined && data.length < MAX_IMAGE && BASE64.test(data))
          return [<img key={i} className="conv-image" src={`data:${type};base64,${data}`} alt={t('conversation.image')} />];
        return [<Chip key={i} icon="image" label={t('conversation.image')} />];
      }
      case 'text':
        return ownMeta(b)?.image === true ? [<Chip key={i} icon="image" label={t('conversation.image')} />] : [];
      case 'resource_link': {
        const uri = asText(b.uri);
        const label = asText(b.title) || asText(b.name) || uri;
        if (!label) return [];
        const path = filePath(uri);
        const open = path && ctx.openFile;
        return [<Chip key={i} icon="file" label={label} title={uri} onClick={open ? () => open(path) : undefined} />];
      }
      case 'resource': {
        const res: unknown = b.resource;
        const uri = typeof res === 'object' && res !== null ? asText((res as { uri?: unknown }).uri) : undefined;
        return uri ? [<Chip key={i} icon="file" label={uri} title={uri} />] : [];
      }
      default:
        return [];
    }
  });
  return out.length ? <div className="conv-chips">{out}</div> : null;
}

/** Whether a block's text was cut short on its machine. */
export const isShortened = (b: ContentBlock) => ownMeta(b)?.truncated === true;

/** The note under text that was cut short. */
export function Shortened() {
  return <div className="conv-note">{t('conversation.truncated')}</div>;
}

/** A duration in milliseconds formatted concisely: "450ms", "3.2s", "1m 12s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)}s`;
  }
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Inline button to terminate a running background task or subagent (#10). */
export function TaskStopButton({
  taskId,
  name,
  agent,
  stopTask,
  onError,
}: {
  taskId: string;
  name?: string;
  agent: string;
  stopTask: (taskId: string) => Promise<void>;
  onError?: (msg: string | undefined) => void;
}) {
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const label = name ? t('conversation.task.stopNamed', { name }) : t('conversation.task.stop');
  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (stopping) return;
    setStopping(true);
    setFailed(undefined);
    onError?.(undefined);
    stopTask(taskId).then(
      () => setStopping(false),
      (err: unknown) => {
        setStopping(false);
        const msg = errorText(err, agent, 'conversation.commandFailed');
        setFailed(msg);
        onError?.(msg);
      },
    );
  };
  return (
    <button
      type="button"
      className="conv-task-stop"
      aria-label={label}
      title={failed ?? (stopping ? t('conversation.task.stopping') : label)}
      disabled={stopping}
      onClick={stop}
    >
      {stopping ? <LoaderCircle className="conv-spin" aria-hidden /> : <Square aria-hidden />}
      <span>{stopping ? t('conversation.task.stopping') : t('conversation.task.stop')}</span>
    </button>
  );
}

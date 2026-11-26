// Pieces the conversation view's items share: what an item may call, what
// the cards that answer the agent may do, and the blocks of a message other
// than its text. A block's members are read as text only when they are
// strings (asText): the blocks come from a machine.

import { createContext } from 'react';
import { FileText, ImageIcon } from 'lucide-react';
import { hasMessage, t, type MessageKey } from '../i18n';
import { asText, ownMeta, type ContentBlock } from './model';
import type { ChatSource, PermissionReply, QuestionReply } from './source';

/** What the items of a conversation may call; the same object for every
 * item, so that an item that did not change is not drawn again. */
export interface ItemContext {
  /** The agent's name for people. */
  agent: string;
  /** Opens a file the agent named (a location, a link to a resource). */
  openFile?: (path: string, line?: number) => void;
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
  /** Whether a card that waits may be answered: not read-only, and the
   * chat's turn still runs (an answer to a card of an ended turn goes
   * nowhere). */
  open: boolean;
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
  waiting: new Set(),
  readOnly: true,
  answered: new Map(),
  respond: nothing,
  answer: nothing,
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

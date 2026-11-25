// What the host makes of events and prompts before they are stored: an
// event cut to fit the journal (fit), an agent's standard error cut to its
// end (capStderr), answers to secret questions masked, a prompt's content
// checked and its title.
import { Notice, noticeMethod } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';

/** Joins the start and the end of a string that was cut, as the
 * transcripts' cut tool output does. */
export const ELISION = '\n…\n';

/** Stands for each answer to a secret question in the journal and on the
 * connections: the agent gets the answer, nothing keeps it. */
export const SECRET_MASK = '••••••';

/** The session updates of a tool call, whose strings a stored event cuts. */
const TOOL_UPDATES = new Set(['tool_call', 'tool_call_update']);

/** v as one line without its newline (chatproto's line); null for what is
 * no JSON. */
export function lineOf(v: unknown): string | null {
  try {
    return chat.line(v).slice(0, -1);
  } catch {
    return null;
  }
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Whether ev is about a tool call: a permission, or a session update of
 * one. */
function isToolCall(ev: chat.Event): boolean {
  if (ev.t === chat.EventType.Permission) return true;
  if (ev.t !== chat.EventType.Update) return false;
  const kind = (ev.update as { sessionUpdate?: unknown } | null)?.sessionUpdate;
  return typeof kind === 'string' && TOOL_UPDATES.has(kind);
}

/** s without its middle: its first and last end bytes of UTF-8, at
 * characters' starts, joined by the elision. */
export function cutMiddle(s: string, end: number): string {
  const b = Buffer.from(s, 'utf8');
  let i = end;
  while (i > 0 && (b[i]! & 0xc0) === 0x80) i--;
  let j = b.length - end;
  while (j < b.length && (b[j]! & 0xc0) === 0x80) j++;
  return b.subarray(0, i).toString('utf8') + ELISION + b.subarray(j).toString('utf8');
}

/** v with every string longer than twice TOOL_OUTPUT_END (and the elision)
 * cut to its first and last TOOL_OUTPUT_END bytes; changed tells whether
 * one was. */
function cutValue(v: unknown): { v: unknown; changed: boolean } {
  if (typeof v === 'string') {
    if (bytes(v) <= 2 * chat.TOOL_OUTPUT_END + bytes(ELISION)) return { v, changed: false };
    return { v: cutMiddle(v, chat.TOOL_OUTPUT_END), changed: true };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = cutValue(x);
      changed ||= r.changed;
      return r.v;
    });
    return { v: changed ? out : v, changed };
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = cutValue(x);
      changed ||= r.changed;
      out[k] = r.v;
    }
    return { v: changed ? out : v, changed };
  }
  return { v, changed: false };
}

/** raw with its long strings cut (cutValue); raw itself when its JSON is
 * short or nothing was cut. */
export function cutStrings(raw: unknown): unknown {
  if (raw === undefined) return raw;
  const l = lineOf(raw);
  if (l === null || bytes(l) <= 2 * chat.TOOL_OUTPUT_END) return raw;
  return cutValue(raw).v;
}

/** The stored form of ev and its line (without the newline): ev itself when
 * its line is at most MAX_EVENT bytes. A longer tool call (a tool call
 * update, a permission) has each of its strings longer than twice
 * TOOL_OUTPUT_END cut to that many bytes at each end; anything else, and a
 * tool call still too long after that, becomes a notice that it was left out
 * (skipped, with the bytes it had and its type), under the same item. null
 * for an event that is no JSON. */
export function fit(ev: chat.Event): { ev: chat.Event; line: string } | null {
  const l = lineOf(ev);
  if (l === null) return null;
  const n = bytes(l);
  if (n <= chat.MAX_EVENT) return { ev, line: l };
  if (isToolCall(ev)) {
    const cut: chat.Event = { ...ev };
    if (ev.update !== undefined) cut.update = cutStrings(ev.update);
    if (ev.toolCall !== undefined) cut.toolCall = cutStrings(ev.toolCall);
    const c = lineOf(cut);
    if (c !== null && bytes(c) <= chat.MAX_EVENT) return { ev: cut, line: c };
  }
  const skipped: chat.Event = {
    ...(ev.seq ? { seq: ev.seq } : {}),
    t: chat.EventType.Notice,
    ...(ev.at ? { at: ev.at } : {}),
    ...(ev.item ? { item: ev.item } : {}),
    ...(ev.parent ? { parent: ev.parent } : {}),
    method: noticeMethod(Notice.Skipped),
    params: { bytes: n, t: ev.t },
  };
  return { ev: skipped, line: lineOf(skipped)! };
}

/** e with at most MAX_STDERR bytes of the agent's standard error, its end;
 * e itself when it has no more. */
export function capStderr<E extends chat.ChatError | undefined>(e: E): E {
  if (!e?.stderr) return e;
  const b = Buffer.from(e.stderr, 'utf8');
  if (b.length <= chat.MAX_STDERR) return e;
  let i = b.length - chat.MAX_STDERR;
  while (i < b.length && (b[i]! & 0xc0) === 0x80) i++;
  return { ...e, stderr: b.subarray(i).toString('utf8') };
}

/** Whether ev carries an agent's standard error. */
export const hasStderr = (ev: chat.Event): boolean => !!ev.error?.stderr || !!ev.chat?.error?.stderr;

/** The answers as they are stored: those to a secret question each
 * replaced by SECRET_MASK. */
export function masked(qs: readonly chat.Question[], answers: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, vs] of Object.entries(answers)) out[id] = qs.some((q) => q.id === id && q.secret) ? vs.map(() => SECRET_MASK) : vs;
  return out;
}

/** A UTF-16 surrogate without its pair: no UTF-8 can hold it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** s with each lone surrogate U+FFFD, as Go's ToValidUTF8 makes of bytes
 * that are no UTF-8. */
export const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\uFFFD');

/** Whether s holds no lone surrogate (UTF-8 can hold it). */
export const isWellFormed = (s: string): boolean => !new RegExp(LONE_SURROGATE.source).test(s);

/** s cut to n characters, its control characters spaces. */
export function clip(s: string, n: number): string {
  const chars = Array.from(wellFormed(s).replace(/[\u0000-\u001f\u007f]/g, ' '));
  return chars.length <= n ? chars.join('') : chars.slice(0, n).join('');
}

/** The most characters of a title a chat takes from a prompt. */
export const TITLE_RUNES = 80;
/** ... and from its agent or a client. */
export const AGENT_TITLE_RUNES = 200;

/** The title a prompt gives a chat: the first line of its first text block
 * that has one. */
export function promptTitle(content: readonly unknown[]): string {
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown } | null;
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    for (const l of block.text.split('\n')) {
      const t = l.trim();
      if (t) return clip(t, TITLE_RUNES);
    }
  }
  return '';
}

/** The characters of base64. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Checks a prompt's content blocks: text, image (at most MAX_IMAGE bytes,
 * base64) and resource_link, at most MAX_PROMPT bytes in all. Throws a
 * ChatProtoError; tells whether there is an image. */
export function checkContent(content: unknown): boolean {
  const refuse = (code: string, message: string) => new chat.ChatProtoError({ code, message });
  if (!Array.isArray(content) || content.length === 0) throw refuse(chat.Code.BadRequest, 'a prompt without content');
  let size = 0;
  for (const b of content) size += bytes(lineOf(b) ?? '');
  if (size > chat.MAX_PROMPT) throw refuse(chat.Code.TooLarge, 'a prompt of more than 8 MiB');
  let images = false;
  for (const b of content) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw refuse(chat.Code.BadRequest, 'content is not an array of content blocks');
    const block = b as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown; uri?: unknown };
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') throw refuse(chat.Code.BadRequest, 'a text block without text');
        break;
      case 'image': {
        images = true;
        if (typeof block.mimeType !== 'string' || !block.mimeType.startsWith('image/'))
          throw refuse(chat.Code.BadRequest, 'an image block without an image type');
        const data = typeof block.data === 'string' ? block.data : '';
        if (Math.floor((data.length * 3) / 4) > chat.MAX_IMAGE + 2) throw refuse(chat.Code.TooLarge, 'an image of more than 5 MiB');
        if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data))
          throw refuse(chat.Code.BadRequest, "an image block's data is not base64");
        const n = Buffer.from(data, 'base64').length;
        if (n === 0) throw refuse(chat.Code.BadRequest, "an image block's data is not base64");
        if (n > chat.MAX_IMAGE) throw refuse(chat.Code.TooLarge, 'an image of more than 5 MiB');
        break;
      }
      case 'resource_link':
        if (typeof block.uri !== 'string' || block.uri === '') throw refuse(chat.Code.BadRequest, 'a resource link without a uri');
        break;
      default:
        throw refuse(chat.Code.BadRequest, 'a content block of another type than text, image or resource_link');
    }
  }
  return images;
}

/** Checks answers to questions: each names a question, its options by
 * label, or the user's own words where the question allows them, one for a
 * question that is not multiple choice. Throws a ChatProtoError. */
export function checkAnswers(qs: readonly chat.Question[], answers: unknown): Record<string, string[]> {
  const refuse = (code: string, message: string) => new chat.ChatProtoError({ code, message });
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length === 0)
    throw refuse(chat.Code.BadRequest, 'no answers');
  let size = 0;
  for (const [id, vs] of Object.entries(answers as Record<string, unknown>)) {
    const q = qs.find((x) => x.id === id);
    if (!q) throw refuse(chat.Code.BadRequest, 'an answer to no question of it');
    if (!Array.isArray(vs) || vs.length === 0 || (!q.multiSelect && vs.length > 1))
      throw refuse(chat.Code.BadRequest, 'not as many answers as the question takes');
    for (const v of vs) {
      if (typeof v !== 'string' || v === '' || !isWellFormed(v)) throw refuse(chat.Code.BadRequest, 'not an option of the question');
      size += bytes(v);
      const known = (q.options ?? []).some((o) => o.label === v);
      if (!known && !q.allowOther) throw refuse(chat.Code.BadRequest, 'not an option of the question');
    }
  }
  if (size > MAX_ANSWER_BYTES) throw refuse(chat.Code.TooLarge, 'answers of more than 64 KiB');
  return answers as Record<string, string[]>;
}

/** The most bytes of a question's answers. */
export const MAX_ANSWER_BYTES = 64 << 10;

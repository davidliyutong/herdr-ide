// What the user attaches to a message: images, read in the page and sent
// as ACP image blocks (base64), within the chat host's limits (an image of
// at most MAX_IMAGE bytes, a prompt of at most MAX_PROMPT bytes of JSON);
// and the content blocks of a message: its images, the files it names with
// @ (resource_link), its text.
import { MAX_IMAGE, MAX_PROMPT, type ContentBlock } from './model';
import type { FileSuggestion } from './source';

/** The image types the view attaches (and draws). */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The most images a message takes. */
export const MAX_ATTACHMENTS = 20;

export interface Attachment {
  /** The view's own id of it. */
  id: string;
  name: string;
  mimeType: string;
  /** Its bytes in base64. */
  data: string;
  /** Its size in bytes. */
  size: number;
}

/** Why a file was not attached: not an image of a type the view takes,
 * larger than MAX_IMAGE, or unreadable. */
export type AttachRefusal = 'notImage' | 'tooLarge' | 'unreadable';

export class AttachError extends Error {
  constructor(
    readonly code: AttachRefusal,
    readonly file: string,
  ) {
    super(`${code}: ${file}`);
  }
}

let nextId = 0;

/** A file as an attachment; rejects with an AttachError. */
export function readImage(file: File): Promise<Attachment> {
  if (!IMAGE_TYPES.includes(file.type)) return Promise.reject(new AttachError('notImage', file.name));
  if (file.size > MAX_IMAGE) return Promise.reject(new AttachError('tooLarge', file.name));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new AttachError('unreadable', file.name));
    r.onload = () => {
      const url = typeof r.result === 'string' ? r.result : '';
      const comma = url.indexOf(',');
      if (!url.startsWith('data:') || comma < 0) return reject(new AttachError('unreadable', file.name));
      resolve({ id: `a${++nextId}`, name: file.name || 'image', mimeType: file.type, data: url.slice(comma + 1), size: file.size });
    };
    r.readAsDataURL(file);
  });
}

/** A file URI of an absolute POSIX path. */
export function fileUri(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

/** The content blocks of a message: its images first, the files it still
 * names (each @label in the text, an absolute path) as links, its text
 * last. */
export function promptContent(text: string, attachments: readonly Attachment[], mentions: readonly FileSuggestion[]): ContentBlock[] {
  const out: ContentBlock[] = attachments.map((a) => ({ type: 'image', mimeType: a.mimeType, data: a.data }));
  const seen = new Set<string>();
  for (const m of mentions) {
    if (seen.has(m.path) || !m.path.startsWith('/') || !text.includes(`@${m.label}`)) continue;
    seen.add(m.path);
    out.push({ type: 'resource_link', uri: fileUri(m.path), name: m.label });
  }
  if (text.trim()) out.push({ type: 'text', text });
  return out;
}

/** The bytes of the content's JSON, as the host counts them. */
export function promptBytes(content: readonly ContentBlock[]): number {
  return new TextEncoder().encode(JSON.stringify(content)).length;
}

/** Whether a message of that content keeps to MAX_PROMPT. */
export const fits = (content: readonly ContentBlock[]) => promptBytes(content) <= MAX_PROMPT;

/** The size of a file for people: 5 MB, 820 KB. */
export function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${Math.round((n / (1 << 20)) * 10) / 10} MB`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} KB`;
  return `${n} B`;
}

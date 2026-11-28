// What the user attaches to a message: images, read in the page and sent
// as ACP image blocks (base64), within the chat host's limits (an image of
// at most MAX_IMAGE bytes, a prompt of at most MAX_PROMPT bytes of JSON);
// and the content blocks of a message: its images, attached local files
// (picked via FilePicker or @ with spaces), files named inline with @
// (resource_link), and its text.
import { MAX_IMAGE, MAX_PROMPT, type ContentBlock } from './model';
import type { FileSuggestion } from './source';

/** The image types the view attaches (and draws). */
export const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The most images a message takes. */
export const MAX_ATTACHMENTS = 20;

/** The most local file chips a message takes. */
export const MAX_FILE_ATTACHMENTS = 50;

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

/** Reconstructs an Attachment from an ACP image ContentBlock (e.g. when moving
 * a queued message back into the composer to edit). */
export function attachmentFromImage(block: { mimeType: string; data: string }, index = 0): Attachment {
  const rawExt = block.mimeType.split('/')[1]?.toLowerCase() || 'png';
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  const pad = block.data.endsWith('==') ? 2 : block.data.endsWith('=') ? 1 : 0;
  const size = Math.max(0, Math.floor((block.data.length * 3) / 4) - pad);
  return {
    id: `a${++nextId}`,
    name: `image-${index + 1}.${ext}`,
    mimeType: block.mimeType,
    data: block.data,
    size,
  };
}

/** A file URI of an absolute POSIX path. */
export function fileUri(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

/** Decodes a file:// URI back to an absolute POSIX path (undefined otherwise). */
export function pathFromFileUri(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    const raw = uri.slice('file://'.length);
    const decoded = raw.split('/').map(decodeURIComponent).join('/');
    return decoded.startsWith('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** The content blocks of a message: its images first, explicitly attached
 * local files and files still named inline (@label in the text, absolute
 * path) as resource_link blocks (deduplicated by path), its text last. */
export function promptContent(
  text: string,
  attachments: readonly Attachment[],
  mentions: readonly FileSuggestion[],
  files: readonly FileSuggestion[] = [],
): ContentBlock[] {
  const out: ContentBlock[] = attachments.map((a) => ({ type: 'image', mimeType: a.mimeType, data: a.data }));
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path) || !f.path.startsWith('/')) continue;
    seen.add(f.path);
    out.push({ type: 'resource_link', uri: fileUri(f.path), name: f.label });
  }
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

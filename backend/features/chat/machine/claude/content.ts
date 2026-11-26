// A prompt's ACP content blocks as the content of Claude Code's user
// message: the images first, then one text block, as the SDK's clients
// send them. The text joins the text blocks and names the files of
// resource links as @ mentions, which Claude Code reads itself.
import { posix } from 'node:path';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';

/** The media types of images the API takes. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A text content block. */
export const textBlock = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });

/** A ChatProtoError of code bad_request, its message the adapter's. */
export const badRequest = (msg: string): ChatProtoError => new ChatProtoError({ code: Code.BadRequest, message: 'claude: ' + msg });

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The content of the user message of a prompt's blocks; throws
 * bad_request for a block that is no prompt's (another type, an image of
 * another kind or without base64 data, an empty prompt). */
export function claudeContent(blocks: readonly unknown[], cwd: string): Obj[] {
  const images: Obj[] = [];
  let text = '';
  let mentioned = false;
  const add = (s: string, mention: boolean) => {
    if (text.length > 0) text += mention || mentioned ? ' ' : '\n\n';
    text += s;
    mentioned = mention;
  };
  const image = (mime: string, data: string) => {
    if (!IMAGE_TYPES.has(mime)) throw badRequest('an image of type ' + mime);
    if (data === '') throw badRequest('an image without data');
    if (!BASE64.test(data)) throw badRequest('an image whose data is not base64');
    images.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
  };
  for (const b of blocks) {
    if (!isObj(b)) throw badRequest('a content block that is no object');
    switch (b.type) {
      case 'text':
        if (str(b.text) !== '') add(str(b.text), false);
        break;
      case 'image':
        image(str(b.mimeType), str(b.data));
        break;
      case 'resource_link':
        if (str(b.uri) === '') throw badRequest('a resource link without its uri');
        add(mention(str(b.uri), cwd), true);
        break;
      case 'resource': {
        const r = b.resource;
        if (!isObj(r)) throw badRequest('a resource without its content');
        if (str(r.text) !== '') add(str(r.text), false);
        else if (str(r.mimeType).startsWith('image/')) image(str(r.mimeType), str(r.blob));
        else throw badRequest('a resource of type ' + str(r.mimeType));
        break;
      }
      default:
        throw badRequest('a content block of type ' + str(b.type));
    }
  }
  if (images.length === 0 && text.length === 0) throw badRequest('an empty prompt');
  return text.length > 0 ? [...images, textBlock(text)] : images;
}

/** How a prompt names the resource at uri: a file as Claude Code's @
 * mention (relative to cwd when it is inside, in quotes when it has
 * spaces), anything else as its uri. */
export function mention(uri: string, cwd: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return uri;
  }
  if (u.protocol !== 'file:') return uri;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return uri;
  }
  if (!posix.isAbsolute(p)) return uri;
  p = posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const base = cwd.replace(/\/+$/, '') + '/';
  if (p.startsWith(base) && p.length > base.length) p = p.slice(base.length);
  if (/[ \t"]/.test(p)) return '@"' + p.replaceAll('"', '\\"') + '"';
  return '@' + p;
}

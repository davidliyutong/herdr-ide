// What a link or an image of rendered Markdown may point to. The text is not
// trusted (a file of a machine, later a model's answer), so every URL passes
// here and anything not named is refused.

import { fileUrl } from '../lib/files';
import { safeWebUrl } from '../lib/webUrl';

/** Where relative references of a document resolve: the machine and the
 * directory of the document. */
export interface MarkdownBase {
  m: string;
  dir: string;
}

// Browsers drop tabs, newlines and other controls and leading spaces from a
// URL before reading its scheme (`java\nscript:` is `javascript:`), so the
// scheme is read from the text cleaned the same way.
const dropped = /[\p{Cc}\p{Cf}\s]/gu;
const schemeOf = (href: string): string | undefined => /^([a-z][a-z0-9+.-]*):/i.exec(href.replace(dropped, ''))?.[1]?.toLowerCase();

/** The URL (as the browser will resolve it) when the href is an absolute
 * `http://` or `https://` URL or a `mailto:` one that does not lead to the
 * page's own origin; anything else (other schemes, `http:/x`, `http:x`,
 * protocol-relative `//host`, paths, fragments) gives undefined. Relative
 * references are `relativePath`'s. */
export function safeLink(href: string): string | undefined {
  return safeWebUrl(href);
}

/** The file path a relative reference names from directory dir, normalized
 * (`.` and `..` resolved, never above `/`), without its fragment or query;
 * undefined for anything that is not a relative reference (a scheme, a path
 * from the root, a fragment only, `//host`). */
export function relativePath(href: string, dir: string): string | undefined {
  if (schemeOf(href) !== undefined) return undefined;
  const ref = href.replace(dropped, (c) => (c === ' ' ? c : '')).replace(/[#?].*$/s, '');
  if (!ref || ref.startsWith('/') || ref.startsWith('#')) return undefined;
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    /* not percent-encoded text: used as written */
  }
  const out: string[] = [];
  for (const seg of [...dir.split('/'), ...decoded.split('/')]) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

const dataImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]*={0,2}$/i;

/** The URL an `<img>` may load: a base64 `data:` image of a raster type or a
 * `blob:` URL as written, a relative reference as the file route of the
 * base's machine; undefined for the rest. A remote image would tell its
 * server who reads the text, and a path from the root (`/api/...`) would let
 * the text make the page send requests to the hub. */
export function imageSource(src: string, base?: MarkdownBase): string | undefined {
  if (dataImage.test(src)) return src;
  if (/^blob:/i.test(src)) return src;
  if (!base) return undefined;
  const p = relativePath(src, base.dir);
  return p === undefined ? undefined : fileUrl(base.m, p);
}

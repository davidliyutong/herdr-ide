// What a link or an image of rendered Markdown may point to. The text is not
// trusted (a file of a machine, a coding agent's message), so every URL passes
// here and anything not named is refused.

import { fileUrl } from '../lib/files';
import { safeWebUrl } from '../lib/webUrl';

/** Whether a file path is a Markdown document (.md, .mdx, .markdown, …). */
export const isMarkdownPath = (path: string): boolean => /\.(?:md|mdx|markdown|mdown|mkd|mkdn|mdwn)$/i.test(path);

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

/** Whether src is a safe base64-encoded raster data: image URL. */
export function isSafeRasterDataUrl(src: string): boolean {
  return dataImage.test(src);
}

/** The URL an `<img>` may load: a base64 `data:` image of a raster type or a
 * `blob:` URL as written, a relative reference as the file route of the
 * base's machine; undefined for the rest. A remote image would tell its
 * server who reads the text, and a path from the root (`/api/...`) would let
 * the text make the page send requests to the hub. */
export function imageSource(src: string, base?: MarkdownBase): string | undefined {
  if (isSafeRasterDataUrl(src)) return src;
  if (/^blob:/i.test(src)) return src;
  if (!base) return undefined;
  const p = relativePath(src, base.dir);
  return p === undefined ? undefined : fileUrl(base.m, p);
}

/** Validates an image URL returned by a caller-provided `resolveImage` hook so
 * unsafe schemes (`javascript:`, `vbscript:`, SVG/HTML `data:`, protocol-
 * relative, remote `http(s):`) can never reach `<img src>`. */
export function isSafeResolvedImage(url: string): boolean {
  const s = schemeOf(url);
  if (s === undefined) return (url.startsWith('/') || url.startsWith('./')) && !url.startsWith('//');
  if (s === 'data') return isSafeRasterDataUrl(url);
  return s === 'blob';
}

const MAX_IMAGE_DIM = 4096;

/** Parses an HTML `width` or `height` attribute into a bounded positive pixel
 * number or safe percentage (`1%`–`100%`). Anything else is dropped. */
export function parseImageDimension(raw: unknown): { attr?: number; pct?: string } {
  if (typeof raw === 'number') {
    const n = Math.round(raw);
    return Number.isFinite(n) && n >= 1 && n <= MAX_IMAGE_DIM ? { attr: n } : {};
  }
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  const px = /^(\d{1,4})(?:px)?$/i.exec(trimmed);
  if (px) {
    const n = Number.parseInt(px[1], 10);
    return n >= 1 && n <= MAX_IMAGE_DIM ? { attr: n } : {};
  }
  const pct = /^(\d{1,3})%$/.exec(trimmed);
  if (pct) {
    const n = Number.parseInt(pct[1], 10);
    return n >= 1 && n <= 100 ? { pct: `${n}%` } : {};
  }
  return {};
}

// Which addresses a text of another origin (a document, a program's output)
// may make the page open. Both Markdown links and terminal links pass here.

// Browsers drop tabs, newlines and other controls from a URL before reading
// it (`java\nscript:` is `javascript:`), so the text is read cleaned the
// same way.
const dropped = /[\p{Cc}\p{Cf}\s]/gu;

/** The URL as the browser will resolve it, when it is an absolute `http://`
 * or `https://` URL, or a `mailto:` one; undefined for the rest. `http:/x`
 * and `http:x` are relative references in a browser (they resolve against
 * the page), so only a scheme followed by `//` counts. A URL on the page's
 * own origin is refused too: a text must not lead to the UI's own routes
 * (`/api/...`), whatever way it spells them. */
export function safeWebUrl(href: string): string | undefined {
  const clean = href.replace(dropped, '');
  const mail = /^mailto:/i.test(clean);
  if (!mail && !/^https?:\/\//i.test(clean)) return undefined;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (mail ? u.protocol !== 'mailto:' : (u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin === globalThis.location?.origin)
    return undefined;
  return u.href;
}

// The URLs an operator gives the core to download from (--npm-registry,
// --code-server-url), which the machines get on their command lines, and
// what messages and logs say of a URL. A URL's user information, query and
// fragment are where credentials go (https://user:token@mirror/,
// ?access_token=…): a URL a machine is given has none, since its command
// line is visible to every local user (/proc/<pid>/cmdline), and a message
// shows a URL by its origin and path only, since errors reach every page
// and the log.

/** Why s is no URL the core downloads from or has a machine download from:
 * one of http or https with a host, without user information, query or
 * fragment; "" when it is. Placeholders ({version}) may stand in its path. */
export function downloadURLRefusal(s: string): string {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'not an http or https URL';
  if (u.hostname === '') return 'no host';
  if (u.username !== '' || u.password !== '') return 'it has user information (credentials)';
  if (u.search !== '' || s.includes('?')) return 'it has a query';
  if (u.hash !== '' || s.includes('#')) return 'it has a fragment';
  return '';
}

/** url by its origin and path only: without user information, query or
 * fragment. What cannot be read as a URL shows as its scheme only. */
export function shownURL(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin === 'null') return `${u.protocol}//…`;
    return u.origin + u.pathname;
  } catch {
    const m = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
    return m ? `${m[1]}//…` : '…';
  }
}

/** Each http(s) URL in text as shownURL shows it; the punctuation that ends
 * a sentence or a parenthesis after it stays. */
export const redactURLs = (text: string): string =>
  text.replace(/\bhttps?:\/\/[^\s"'<>`]+/gi, (m) => {
    const tail = /[.,:;!?)]+$/.exec(m)?.[0] ?? '';
    return shownURL(m.slice(0, m.length - tail.length)) + tail;
  });

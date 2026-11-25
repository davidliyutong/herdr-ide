// The desktop app's cookie never crosses the proxy (SECURITY.md). It held
// the token of the app's launch while the app ran the hub as a child; the
// app's hub runs in process now and tells its windows apart without a
// cookie (hosts/electron), so none is set any more. One left from an
// earlier version is still neither passed to code-server nor set by it.
import { SLUG } from '#shared/lib/brand.ts';

/** The cookie that carries the desktop app's token. */
export const DESKTOP_COOKIE = `${SLUG}-desktop`;

const nameOf = (cookie: string) => {
  const i = cookie.indexOf('=');
  return (i < 0 ? cookie : cookie.slice(0, i)).trim();
};

/** A request's Cookie header without the desktop app's cookie, the others
 * kept in order; null when none is left. Cookies are separated by ";"; a
 * header the runtime joined from several lines has ", " between them,
 * where a cookie of that name is removed too (a cookie's value holds no
 * comma, RFC 6265). */
export function stripDesktopCookie(header: string | null): string | null {
  if (header === null) return null;
  const kept: string[] = [];
  for (const raw of header.split(';')) {
    let part = raw.trim();
    if (part.includes(',')) {
      part = part
        .split(',')
        .filter((p) => nameOf(p) !== DESKTOP_COOKIE)
        .join(',')
        .trim();
    }
    if (part === '' || nameOf(part) === DESKTOP_COOKIE) continue;
    kept.push(part);
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

/** Whether a Set-Cookie line of code-server's may pass: not one naming the
 * desktop app's cookie, which would replace or shadow the launch's token. */
export const keepSetCookie = (line: string): boolean => nameOf(line) !== DESKTOP_COOKIE;

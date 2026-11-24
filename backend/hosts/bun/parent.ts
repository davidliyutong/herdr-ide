// The launcher's side of --parent-stdio: its hello on stdin, and the
// desktop app's cookie that tells its windows' requests apart.
import { timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { SLUG } from '#shared/lib/brand.ts';
import { Reader } from '#shared/lib/streamio.ts';

/** The cookie that carries the desktop app's token of its launch (set by
 * the app as HttpOnly, SameSite=Strict, host-only for the core's origin
 * in its own session, so every request of its windows carries it). */
export const DESKTOP_COOKIE = `${SLUG}-desktop`;

/** Bounds the hello line. */
const MAX_HELLO = 4096;

/** A token the launcher made of random bytes, which a cookie carries as it
 * is. */
const token = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const hello = z
  .object({ desktop_token: token.optional(), verify_key: token.optional() })
  .refine((h) => !h.verify_key || h.verify_key !== h.desktop_token, 'the verify key equals the token');

/** Reads the launcher's hello, a JSON object on one line: the desktop
 * app's token of this launch and the key with which its shell signs that
 * the user answered a prompt of the system. stdin, unlike the environment,
 * is inherited by nothing the core starts. The rest of stdin stays unread
 * (its end stops the core). */
export async function readHello(stdin: Readable): Promise<{ token: string; verifyKey: string }> {
  const r = new Reader(stdin);
  let line: string;
  try {
    line = await r.line(MAX_HELLO);
  } catch (e) {
    throw new Error(`launcher hello: ${(e as Error).message}`);
  }
  // What follows the hello is only watched for its end.
  r.release().resume();
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    throw new Error(`launcher hello: ${(e as Error).message}`);
  }
  const h = hello.safeParse(raw);
  if (!h.success) throw new Error(`launcher hello: malformed ${h.error.issues[0]?.path.join('.') || 'hello'}`);
  return { token: h.data.desktop_token ?? '', verifyKey: h.data.verify_key ?? '' };
}

/** Whether a request carries the desktop app's token in one of its cookies
 * named DESKTOP_COOKIE (a script may add cookies of the same name, for
 * another path, which come first). Without a token every client is a
 * browser. */
export function desktopClient(headers: Headers, desktopToken: string): boolean {
  if (!desktopToken) return false;
  const want = Buffer.from(desktopToken);
  let found = false;
  for (const part of (headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== DESKTOP_COOKIE) continue;
    const got = Buffer.from(part.slice(i + 1).trim());
    if (got.length === want.length && timingSafeEqual(got, want)) found = true;
  }
  return found;
}

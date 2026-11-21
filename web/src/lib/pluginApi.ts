// What the plugins' requests to the core share (plugins/*/api.ts): a
// failure that carries the core's error code, an answer read as JSON
// whatever the status, the fetch options of a JSON body, and a failure's
// text looked up by its code. What differs per plugin stays an option of
// its own module: the failure's class, special statuses, headers.

import { hasMessage, t } from '../i18n';

/** A failure with the code the core or the machine gave; each plugin has
 * its own class of it (FilesError, GitError, VaultError, BrowserError). */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a failed answer's JSON may hold. */
export interface AnswerBody {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/** An answer's JSON as it is (an ok answer's may be a list or null); {}
 * when it has none (the status says it). */
export async function jsonBody(r: Response): Promise<AnswerBody> {
  try {
    return (await r.json()) as AnswerBody;
  } catch {
    return {};
  }
}

/** The code of a failed answer: the body's, or the status as http_NNN. */
export const failureCode = (r: Response, j: AnswerBody): string => j.error ?? `http_${r.status}`;

/** The answer's JSON, or the failure `fail` makes of an answer that is
 * not ok (from its status and what its body holds). */
export async function answer<T>(r: Response, fail: (r: Response, j: AnswerBody) => Error): Promise<T> {
  const j = await jsonBody(r);
  if (!r.ok) throw fail(r, j);
  return j as T;
}

/** A `fail` for answer: the plugin's error with the body's code and
 * message, the status and its text when the body has none. */
export const failureOf =
  (make: (code: string, message: string) => Error) =>
  (r: Response, j: AnswerBody): Error =>
    make(failureCode(r, j), j.message ?? r.statusText);

/** The fetch options of a request with a JSON body (none: no body and no
 * Content-Type), with the caller's other headers. */
export function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  if (body === undefined) return { method, headers, body: undefined };
  return { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

/** A function that says a failure as the user reads it: the message
 * `${prefix}.${code}` of a failure of the plugin's class when there is
 * one. special answers for codes with a text of their own, detail may add
 * to a found text, and fallback says what has no message (default: the
 * failure's own message, or its code). */
export function makeErrorText<E extends PluginError>(
  type: abstract new (...args: never[]) => E,
  prefix: string,
  o: { special?: (e: E) => string | undefined; detail?: (e: E, text: string) => string; fallback?: (e: unknown) => string } = {},
): (e: unknown) => string {
  return (e) => {
    if (e instanceof type) {
      const own = o.special?.(e);
      if (own !== undefined) return own;
      const k = `${prefix}.${e.code}`;
      if (hasMessage(k)) return o.detail ? o.detail(e, t(k)) : t(k);
      return o.fallback ? o.fallback(e) : e.message || e.code;
    }
    return o.fallback ? o.fallback(e) : e instanceof Error ? e.message : String(e);
  };
}

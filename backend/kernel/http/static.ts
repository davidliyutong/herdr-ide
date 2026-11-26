// The web UI's files, and the app shell for any other path that is not the
// API's (client-side routes). Every page gets the policy that keeps
// scripts on our origin and the page out of other sites' frames.
import type { Hono } from 'hono';
import { getMimeType } from 'hono/utils/mime';
import { SLUG } from '#shared/lib/brand.ts';
import { Fail } from '../fail.ts';
import type { Files } from '../payloads.ts';
import type { Env } from './env.ts';
import { appCSP } from './guard.ts';

/** The path below the root: cleaned of dot segments, without the leading
 * slash; "" for the root. */
export function cleanPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Serves files (the built web UI) for GET and HEAD of any path no other
 * route took; null files answers that the UI is not built in. */
export function serveUI(app: Hono<Env>, files: Files | null): void {
  app.on(['GET', 'HEAD'], '*', async (c) => {
    let p: string;
    try {
      p = cleanPath(decodeURIComponent(c.req.path));
    } catch {
      throw new Fail('not_found', 404);
    }
    // An API path no route took is not a page of the UI.
    if (p === 'api' || p.startsWith('api/')) throw new Fail('not_found', 404, `no route for ${c.req.method} ${c.req.path}`);
    const index = files ? await files.get('index.html') : null;
    if (!files || !index) return c.text(`${SLUG}: the web UI is not built into this binary; run scripts/build.sh\n`);
    c.header('Content-Security-Policy', appCSP(c.req.header('Host') ?? '', c.var.client === 'desktop'));
    let name = p === '' ? 'index.html' : p;
    let body = name === 'index.html' ? index : await files.get(name);
    if (!body) {
      // Client-side routes fall back to the app shell.
      body = index;
      name = 'index.html';
    }
    c.header('Cache-Control', name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    c.header('Content-Type', getMimeType(name) ?? 'application/octet-stream');
    c.header('Content-Length', String(body.length));
    if (c.req.method === 'HEAD') return c.body(null);
    return c.body(body as Uint8Array<ArrayBuffer>);
  });
}

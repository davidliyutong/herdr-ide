// The core's HTTP front: Hono, the same `Request → Response` under Bun.serve
// and behind the desktop app's protocol handler. Every request passes the
// guard (guard.ts); errors are Fails (../fail.ts) answered as
// {error, message}; routes that change state are `mutating`: refused in
// read-only mode and audited with their outcome.
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';
import { SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { whoOf, type Audit, type AuditFields } from '../audit.ts';
import { Fail, failOf, readOnly, unknownMachine } from '../fail.ts';
import type { Machine } from '../machines/machine.ts';
import { SECURITY_HEADERS, sameHost, type Guard, type RequestFacts } from './guard.ts';
import type { Ctx, Env } from './env.ts';

export interface HttpOptions {
  guard: Guard;
  audit: Audit;
  readOnly: boolean;
  /** The header naming the authenticated user (--user-header). */
  userHeader?: string;
  logger: Logger;
  /** The machine of an id in a path. */
  machine: (id: string) => Machine | undefined;
}

/** The facts of a request the guard looks at. */
export const factsOf = (c: Ctx): RequestFacts => ({
  method: c.req.method,
  host: c.req.header('Host') ?? new URL(c.req.url).host,
  headers: c.req.raw.headers,
  remote: c.env.remote,
});

/** Sets the security headers on an answer; a Response of another origin
 * (a proxied one) has immutable headers and is copied first. */
function secure(c: Ctx): void {
  const set = () => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
  };
  try {
    set();
  } catch {
    if (c.res.status < 200) return; // an upgrade's answer, which the host consumes
    c.res = new Response(c.res.body, c.res);
    set();
  }
}

export class Http {
  readonly app = new Hono<Env>();
  readonly options: HttpOptions;

  constructor(o: HttpOptions) {
    this.options = o;
    const { app } = this;
    app.use(async (c, next) => {
      const facts = factsOf(c);
      const who = whoOf(facts.headers, facts.remote, o.userHeader);
      const refused = o.guard.check(facts);
      if (refused) {
        if (refused === 'proxy_secret') o.audit.log(who, 'denied.proxy_secret', { path: c.req.path });
        const [code, why] = {
          proxy_secret: ['proxy_secret', 'missing or wrong proxy secret'],
          host: ['host_not_allowed', 'host not allowed (add --allowed-origin)'],
          origin: ['origin_not_allowed', 'origin not allowed'],
        }[refused];
        c.header('Cache-Control', 'no-store');
        c.res = c.json(new Fail(code, 403, `${SLUG}: ${why}`).body(), 403);
        secure(c);
        return;
      }
      c.set('client', c.env.desktop ? 'desktop' : 'browser');
      c.set('sameHost', sameHost(facts));
      c.set('trustedOrigin', o.guard.trustedOrigin(facts));
      c.set('who', who);
      c.set('audit', {});
      await next();
      secure(c);
    });
    app.onError((err, c) => {
      const f = failOf(err);
      // The core's own failures; a machine's or a program's (502, 503,
      // 504) are answers, not faults of the core.
      if (f.status === 500) o.logger(`${c.req.method} ${c.req.path}: ${f.message}`);
      c.header('Cache-Control', 'no-store');
      return c.json(f.body(), f.status as 400);
    });
    app.notFound((c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(new Fail('not_found', 404, `no route for ${c.req.method} ${c.req.path}`).body(), 404);
    });
  }

  /** Records an event in the audit log for a request. */
  audit(c: Ctx, event: string, fields?: AuditFields): void {
    this.options.audit.log(c.var.who, event, fields);
  }

  /** A route that changes state: refused in read-only mode, then audited as
   * event once the handler answered, with what it acted on (c.var.audit),
   * the path's parameters and how it ended (status; error, its code). */
  mutating(event: string | ((c: Ctx) => string), base: AuditFields = {}): MiddlewareHandler<Env> {
    return createMiddleware<Env>(async (c, next) => {
      if (this.options.readOnly) throw readOnly();
      await next();
      const fields: AuditFields = { ...base };
      if (c.var.machine) fields.machine = c.var.machine.id;
      // The path's parameters; a machine's id is its machine field.
      for (const [k, v] of Object.entries(c.req.param() as Record<string, string>))
        if (v && !(k in fields) && !(k === 'id' && c.var.machine)) fields[k] = v;
      for (const [k, v] of Object.entries(c.var.audit)) if (!(k in fields)) fields[k] = v;
      const status = c.res.status;
      fields.status = status;
      if (status >= 400) fields.error = c.error ? failOf(c.error).code : await codeOf(c.res);
      this.audit(c, typeof event === 'string' ? (c.var.event ?? event) : event(c), fields);
    });
  }

  /** Refuses a request in read-only mode. */
  readonly writable: MiddlewareHandler<Env> = createMiddleware<Env>(async (_c, next) => {
    if (this.options.readOnly) throw readOnly();
    await next();
  });

  /** Resolves the machine of the path's :id (c.var.machine). */
  readonly machine: MiddlewareHandler<Env> = createMiddleware<Env>(async (c, next) => {
    const m = this.options.machine(c.req.param('id') ?? '');
    if (!m) throw unknownMachine();
    c.set('machine', m);
    await next();
  });
}

/** The error code of an answer that a handler wrote itself. */
async function codeOf(res: Response): Promise<string> {
  try {
    const j = (await res.clone().json()) as { error?: unknown };
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch {
    // not JSON
  }
  return 'failed';
}

/** The body of a request, at most limit bytes. */
export async function readBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > limit) throw new Fail('too_large', 413, `request body over ${limit} bytes`);
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      throw new Fail('too_large', 413, `request body over ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Validates a request's JSON body of at most limit bytes (1 MiB) against
 * schema; c.req.valid('json') is then typed. A body that does not parse or
 * match fails with code (bad_request). */
export function jsonBody<S extends z.ZodType>(schema: S, opts: { limit?: number; code?: string } = {}) {
  const code = opts.code ?? 'bad_request';
  return createMiddleware<Env, string, { in: { json: z.input<S> }; out: { json: z.output<S> } }>(async (c, next) => {
    const bytes = await readBody(c.req.raw, opts.limit ?? 1 << 20);
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (e) {
      throw new Fail(code, 400, `invalid JSON: ${(e as Error).message}`);
    }
    const r = schema.safeParse(raw);
    if (!r.success) throw new Fail(code, 400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    c.req.addValidatedData('json', r.data as object);
    await next();
  });
}

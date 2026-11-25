// Helpers of the machine side's tests, never used by the product: a home
// of a test's own (never the user's ~/.claude, ~/.codex or keychain), the
// machine as the readers see it at a fixed clock, fake providers on
// loopback, and fake programs (security, ps, lsof, agy) as scripts.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PROGRAMS, DEFAULT_URLS, Memo, USAGE_TIMING, type UsageEnv, type Urls } from '../machine/env.ts';

/** The tests' clock: 2026-11-16 12:00 UTC. */
export const TEST_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const testNowSec = TEST_NOW / 1000;

const homes: string[] = [];

/** A new temporary home (short, below /tmp), removed by removeHomes. */
export function tempHome(): string {
  const h = realpathSync(mkdtempSync('/tmp/uh-'));
  homes.push(h);
  return h;
}

export function removeHomes(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 3 });
}

/** Writes content to path, making its directory. */
export function write(path: string, content: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
}

/** A script at path that runs body with sh. */
export function script(path: string, body: string): string {
  write(path, `#!/bin/sh\n${body}\n`, 0o700);
  chmodSync(path, 0o700);
  return path;
}

/** An unsigned JWT with claims. */
export function jwt(claims: Record<string, unknown>): string {
  const enc = (s: string) => Buffer.from(s).toString('base64url');
  return `${enc('{"alg":"none"}')}.${enc(JSON.stringify(claims))}.sig`;
}

/** A fake of the providers' hosts: replies by path, the headers and
 * bodies of the requests each got. */
export class FakeAPI {
  readonly replies = new Map<string, (req: Request) => Response | Promise<Response>>();
  readonly headers = new Map<string, Headers>();
  readonly bodies = new Map<string, string>();
  readonly hits = new Map<string, number>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        this.headers.set(path, req.headers);
        this.bodies.set(path, await req.text());
        this.hits.set(path, (this.hits.get(path) ?? 0) + 1);
        const h = this.replies.get(path);
        return h ? h(req) : new Response('not found', { status: 404 });
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  get port(): number {
    return this.server.port!;
  }

  json(path: string, body: string): void {
    this.replies.set(path, () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  }

  status(path: string, code: number, headers: Record<string, string> = {}): void {
    this.replies.set(path, () => new Response(null, { status: code, headers }));
  }

  header(path: string, key: string): string {
    return this.headers.get(path)?.get(key) ?? '';
  }

  asked(path: string): boolean {
    return this.headers.has(path);
  }

  forget(): void {
    this.headers.clear();
    this.bodies.clear();
    this.hits.clear();
  }

  stop(): void {
    this.server.stop(true);
  }

  /** The endpoints on this server. */
  urls(): Urls {
    const u = this.url;
    return {
      claudeUsage: `${u}/api/oauth/usage`,
      claudeProfile: `${u}/api/oauth/profile`,
      codexUsage: `${u}/backend-api/wham/usage`,
      grokBilling: `${u}/v1/billing?format=credits`,
      grokSettings: `${u}/v1/settings`,
      kimiUsage: `${u}/coding/v1/usages`,
      kimiToken: `${u}/api/oauth/token`,
      deepseekBalance: `${u}/user/balance`,
    };
  }
}

/** The machine as the readers see it in a test: home, its data directory
 * home/.app, no environment, Linux, this user, the tests' clock, programs
 * that are not there and endpoints that answer nothing (or api's). */
export function testEnv(home: string, o: Partial<UsageEnv> & { api?: FakeAPI } = {}): UsageEnv {
  const { api, ...rest } = o;
  return {
    home,
    base: join(home, '.app'),
    env: {},
    platform: 'linux',
    uid: process.getuid?.() ?? -1,
    now: () => TEST_NOW,
    urls: api
      ? api.urls()
      : { ...DEFAULT_URLS, ...Object.fromEntries(Object.keys(DEFAULT_URLS).map((k) => [k, 'http://127.0.0.1:1/none'])) },
    // Fake programs may start slowly on a loaded machine (a new script is
    // assessed on its first run on macOS): their limits are generous.
    t: { ...USAGE_TIMING, kimiLockWaitMs: 300, kimiLockRetryMs: 50, kimiBackoffMs: 0, keychainMs: 30_000, psMs: 30_000, agyMs: 30_000 },
    programs: {
      ...DEFAULT_PROGRAMS,
      security: join(home, 'no-security'),
      ps: join(home, 'no-ps'),
      lsof: join(home, 'no-lsof'),
      extraPath: [],
    },
    procRoot: join(home, 'proc'),
    memo: new Memo(),
    signal: new AbortController().signal,
    ...rest,
  };
}

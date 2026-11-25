// Where the core takes a TypeScript machine executable from (sources.ts):
// the operator's directory, the cache, its own copy, a download through
// the environment's proxy; each checked against the build's digests
// before it is cached or used. The executables here are fakes with
// digests of their own; nothing leaves this host (the "release" is served
// by a proxy on loopback).
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { machineAsset } from './builds.ts';
import { deployCode } from './errors.ts';
import { CACHE_RETENTION_MS, resolveMachine } from './sources.ts';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'src-'));
  dirs.push(d);
  return d;
};
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const KEY = 'linux-amd64';
const EXE = Buffer.from('#!/bin/sh\necho a machine build\n');
const GZ = gzipSync(EXE);
const build = (url?: string) => ({ key: KEY, digest: sha256(EXE), gzDigest: sha256(GZ), ...(url ? { url } : {}) });
const asset = machineAsset(KEY);

describe("the operator's directory", () => {
  test('is used first: the release asset or the executable; each checked', async () => {
    for (const [name, data] of [
      [`${asset}.gz`, GZ],
      [asset, EXE],
    ] as const) {
      const dir = temp();
      writeFileSync(join(dir, name), data);
      expect(gunzipSync(await resolveMachine(build(), { dir, cacheDir: temp() }))).toEqual(EXE);
    }
  });

  test('a tampered file is refused, and says so when nothing else has the build', async () => {
    const dir = temp();
    writeFileSync(join(dir, `${asset}.gz`), gzipSync(Buffer.from('tampered')));
    writeFileSync(join(dir, asset), Buffer.from('tampered too'));
    const e = await resolveMachine(build(), { dir, cacheDir: temp() }).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain(`${asset}.gz refused`);
    expect((e as Error).message).toContain(`${asset} refused`);
  });
});

describe('the cache and the own copy', () => {
  test('the cache is used before the network; a tampered file in it is removed', async () => {
    const cacheDir = temp();
    const file = join(cacheDir, `${asset}-${sha256(EXE).slice(0, 16)}.gz`);
    writeFileSync(file, GZ);
    // A release nothing answers on: the cache must not need it.
    expect(gunzipSync(await resolveMachine(build('http://127.0.0.1:9/x.gz'), { cacheDir }))).toEqual(EXE);
    writeFileSync(file, gzipSync(Buffer.from('tampered')));
    const e = await resolveMachine(build(), { cacheDir }).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect(existsSync(file)).toBe(false);
  });

  test('keeps what was used in the last 14 days', async () => {
    const cacheDir = temp();
    const old = join(cacheDir, `${machineAsset('darwin-arm64')}-0000000000000000.gz`);
    writeFileSync(old, GZ);
    const past = new Date(Date.now() - CACHE_RETENTION_MS - 60_000);
    utimesSync(old, past, past);
    await resolveMachine(build(), { cacheDir, own: async () => GZ });
    expect(existsSync(old)).toBe(false);
  });

  test("the core's own copy, checked", async () => {
    expect(gunzipSync(await resolveMachine(build(), { cacheDir: temp(), own: async () => GZ }))).toEqual(EXE);
    const e = await resolveMachine(build(), { cacheDir: temp(), own: async () => gzipSync(Buffer.from('x')) }).catch((x) => x as Error);
    expect((e as Error).message).toContain("the core's own copy refused");
  });
});

describe('the download', () => {
  /** A proxy on loopback that answers http://releases.test/… with body. */
  async function proxy(body: Buffer) {
    let hits = 0;
    const srv = createServer((req, res) => {
      hits++;
      if (!req.url?.startsWith('http://releases.test/')) return void res.writeHead(502).end();
      res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, hits: () => hits, close: () => srv.close() };
  }

  async function withProxy<T>(url: string, f: () => Promise<T>): Promise<T> {
    const keys = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HTTP_PROXY = process.env.http_proxy = url;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    try {
      return await f();
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }

  test("goes through the environment's proxy, is checked, then cached, and not asked again", async () => {
    const p = await proxy(GZ);
    try {
      const cacheDir = temp();
      const url = `http://releases.test/v1/${asset}.gz`;
      expect(gunzipSync(await withProxy(p.url, () => resolveMachine(build(url), { cacheDir })))).toEqual(EXE);
      expect(p.hits()).toBe(1);
      await withProxy(p.url, () => resolveMachine(build(url), { cacheDir }));
      expect(p.hits()).toBe(1);
      expect(readFileSync(join(cacheDir, `${asset}-${sha256(EXE).slice(0, 16)}.gz`))).toEqual(GZ);
    } finally {
      p.close();
    }
  });

  test('an asset that is not the build is refused before anything is cached', async () => {
    for (const body of [gzipSync(Buffer.from('another build')), Buffer.from('not gzip')]) {
      const p = await proxy(body);
      try {
        const cacheDir = temp();
        const e = await withProxy(p.url, () => resolveMachine(build(`http://releases.test/${asset}.gz`), { cacheDir })).catch(
          (x) => x as Error,
        );
        expect(deployCode(e)).toBe('build_unavailable');
        expect((e as Error).message).toContain("is not the build's asset");
        expect(existsSync(join(cacheDir, `${asset}-${sha256(EXE).slice(0, 16)}.gz`))).toBe(false);
      } finally {
        p.close();
      }
    }
  });

  test('offline, or a build of no release: build_unavailable, saying what to do', async () => {
    const e = await withProxy('http://127.0.0.1:9', () =>
      resolveMachine(build(`http://releases.test/${asset}.gz`), { dir: temp(), cacheDir: temp() }),
    ).catch((x) => x as Error);
    expect(deployCode(e)).toBe('build_unavailable');
    expect((e as Error).message).toContain('--agent-dir');
    const n = await resolveMachine(build(), { cacheDir: temp() }).catch((x) => x as Error);
    expect((n as Error).message).toContain('no release');
  });
});

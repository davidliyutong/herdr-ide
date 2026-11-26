// Helpers of the tests of the Agent SDK's way to the machines, never used
// by the product: npm tarballs made in the test (a package/ directory, as
// the registry's are) with the pin that trusts them, and a registry on
// loopback that serves them. No test fetches the real SDK: its tarball is
// Anthropic's, and the tests run offline.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import type { NpmTarball } from '../claudesdk.ts';

/** A module that stands in for the SDK's entry: a query() that says so. */
export const FAKE_ENTRY = "export const query = () => 'the fake SDK';\nexport const marker = 'fake-sdk';\n";

export interface FakeSdk {
  /** The tarball's path and bytes, and the pin that trusts it. */
  file: string;
  bytes: Buffer;
  pin: NpmTarball;
}

/** An npm tarball of name@version in dir: package.json, the entry (entry,
 * else FAKE_ENTRY), a license, a readme, and files besides that are not to
 * be unpacked; link adds the entry as a link to it instead. */
export async function fakeSdk(
  dir: string,
  o: { version?: string; entry?: string; extra?: Record<string, string>; link?: string } = {},
): Promise<FakeSdk> {
  const version = o.version ?? '9.9.9';
  const file = `fake-sdk-${version}.tgz`;
  const src = join(dir, `src-${version}`);
  const pkg = join(src, 'package');
  mkdirSync(pkg, { recursive: true });
  const entry = o.entry ?? FAKE_ENTRY;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fake/sdk', version, type: 'module', main: 'sdk.mjs' }));
  writeFileSync(join(pkg, 'LICENSE.md'), 'The fake SDK of the tests.\n');
  writeFileSync(join(pkg, 'README.md'), '# fake\n');
  if (o.link) symlinkSync(o.link, join(pkg, 'sdk.mjs'));
  else writeFileSync(join(pkg, 'sdk.mjs'), entry);
  for (const [name, text] of Object.entries(o.extra ?? { 'core.mjs': 'export {};\n', 'sdk.d.ts': 'export {};\n' }))
    writeFileSync(join(pkg, name), text);
  const out = join(dir, file);
  await create({ gzip: true, cwd: src, file: out, portable: true }, ['package']);
  const bytes = readFileSync(out);
  return {
    file: out,
    bytes,
    pin: {
      name: '@fake/sdk',
      version,
      file,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      entry: 'sdk.mjs',
      entrySha256: createHash('sha256').update(entry).digest('hex'),
      files: ['package.json', 'sdk.mjs', 'LICENSE.md', 'README.md'],
    },
  };
}

/** A registry on loopback: GET /<name>/-/<file> answers what files holds
 * for file; refuse turns away the requests it takes (by their user agent),
 * hang answers them with a body that never ends, hits counts the requests
 * by user agent. */
export function fakeRegistry(o: { files: Map<string, Buffer>; refuse?: (ua: string) => boolean; hang?: (ua: string) => boolean }) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const ua = req.headers.get('user-agent') ?? '';
      hits.push(ua);
      if (o.refuse?.(ua)) return new Response('refused', { status: 403 });
      if (o.hang?.(ua))
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([0x1f]));
            },
          }),
        );
      const name = new URL(req.url).pathname.split('/-/')[1] ?? '';
      const b = o.files.get(name);
      return b ? new Response(b) : new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

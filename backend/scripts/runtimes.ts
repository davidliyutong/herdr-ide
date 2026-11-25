// Fetches the Bun runtimes a core that embeds the TypeScript machine side
// carries (kernel/machines/transport/runtimes.ts: the release pinned by the
// archives' SHA-256): for each platform, the release archive, checked,
// its executable gzip-compressed into DIR as bun-<os>-<arch>.gz (the
// layout backend/scripts/build.ts --runtimes embeds). Downloaded archives
// are kept in --cache, checked again on each use.
//
//   bun scripts/runtimes.ts --out DIR [--cache DIR] [os/arch...]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { EMBEDDED_RUNTIMES, RUNTIMES, archiveURL, extractBun, runtimeFile } from '#kernel/machines/transport/runtimes.ts';

const { values: o, positionals } = parseArgs({
  options: { out: { type: 'string' }, cache: { type: 'string', default: '' } },
  allowPositionals: true,
});
if (!o.out) throw new Error('--out is required');
const platforms = positionals.length ? positionals : [...EMBEDDED_RUNTIMES];
mkdirSync(o.out, { recursive: true });
for (const key of platforms) {
  const a = RUNTIMES[key];
  if (!a) throw new Error(`no Bun runtime for ${key} (${Object.keys(RUNTIMES).join(', ')})`);
  const cached = o.cache ? join(o.cache, `${a.name}.zip`) : '';
  let zip: Buffer;
  if (cached && existsSync(cached)) zip = readFileSync(cached);
  else {
    const res = await fetch(archiveURL(a));
    if (!res.ok) throw new Error(`${archiveURL(a)}: ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
    if (cached) {
      mkdirSync(o.cache, { recursive: true });
      writeFileSync(`${cached}.tmp`, zip);
      renameSync(`${cached}.tmp`, cached);
    }
  }
  const bun = await extractBun(zip, a);
  const out = join(o.out, runtimeFile(key).slice('runtime/'.length));
  writeFileSync(`${out}.tmp`, gzipSync(bun, { level: 9 }));
  renameSync(`${out}.tmp`, out);
  console.log(`${key}: ${a.name} ${(bun.length / 2 ** 20).toFixed(1)} MiB, ${out}`);
}

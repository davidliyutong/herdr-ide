// Embedded archive lazy reader (hosts/bun/payloads.ts): reads each entry on
// demand, deduplicates concurrent reads when cached, drops misses from cache so
// unknown paths cannot grow memory, and rejects glob/traversal paths.
import { describe, expect, test } from 'bun:test';
import { archiveFiles } from './payloads.ts';

function fakeArchive(entries: Record<string, string>) {
  const calls: string[] = [];
  const archive = {
    async files(glob?: string) {
      calls.push(glob ?? '');
      const out = new Map<string, File>();
      if (glob && Object.hasOwn(entries, glob)) {
        out.set(glob, new File([entries[glob]!], glob));
      }
      return out;
    },
  };
  return { archive, calls };
}

describe('archiveFiles', () => {
  test('reads lazily on demand and caches hits without caching misses', async () => {
    const { archive, calls } = fakeArchive({
      'web/index.html': '<!doctype html>',
      'web/assets/app.js': 'console.log(1)',
      'web/assets/monaco.js': 'heavy',
    });
    const ui = archiveFiles(archive, { prefix: 'web/', cache: true });
    expect(calls).toEqual([]);

    const html = await ui.get('index.html');
    expect(new TextDecoder().decode(html!)).toBe('<!doctype html>');
    expect(calls).toEqual(['web/index.html']);

    // Second read hits cache; unrequested heavy assets are never touched.
    const html2 = await ui.get('index.html');
    expect(new TextDecoder().decode(html2!)).toBe('<!doctype html>');
    expect(calls).toEqual(['web/index.html']);

    // Missing paths return null and are not retained in the cache.
    expect(await ui.get('missing-1')).toBeNull();
    expect(await ui.get('missing-1')).toBeNull();
    expect(calls).toEqual(['web/index.html', 'web/missing-1', 'web/missing-1']);
  });

  test('deduplicates concurrent in-flight reads for the same path', async () => {
    let lookups = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const archive = {
      async files(glob?: string) {
        lookups++;
        await gate;
        const out = new Map<string, File>();
        if (glob === 'web/index.html') out.set(glob, new File(['ok'], glob));
        return out;
      },
    };
    const ui = archiveFiles(archive, { prefix: 'web/', cache: true });
    const p1 = ui.get('index.html');
    const p2 = ui.get('index.html');
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(lookups).toBe(1);
    expect(new TextDecoder().decode(a!)).toBe('ok');
    expect(new TextDecoder().decode(b!)).toBe('ok');
  });

  test('rejects glob metacharacters, negation, and path traversal without touching the archive', async () => {
    const { archive, calls } = fakeArchive({ 'web/index.html': 'ok', secret: 'no' });
    const ui = archiveFiles(archive, { prefix: 'web/', cache: true });
    for (const bad of [
      '',
      '*',
      'index.*',
      'index.htm?',
      '[a-z]',
      '{a,b}',
      '!secret',
      '!web/index.html',
      '+(index.html)',
      '@(a|b)',
      '../secret',
      'a/../index.html',
      'a//b',
      '/index.html',
      'a\\b',
      'a\0b',
    ]) {
      expect(await ui.get(bad), bad).toBeNull();
    }
    expect(calls).toEqual([]);

    // Against a real Bun.Archive, negation cannot expand to enumerate other entries.
    const real = archiveFiles(new Bun.Archive({ 'web/index.html': 'ok', secret: 's' }));
    expect(await real.get('!secret')).toBeNull();
    expect(new TextDecoder().decode((await real.get('web/index.html'))!)).toBe('ok');
  });
});

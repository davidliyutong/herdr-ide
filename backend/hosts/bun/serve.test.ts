// serve's refusal of download URLs that would put credentials on the
// machines' command lines and in the errors pages see.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { urlFlagsRefusal } from './serve.ts';

describe('serve', () => {
  test('--npm-registry and --code-server-url hold no user information, query or fragment', () => {
    expect(urlFlagsRefusal({})).toBe('');
    expect(urlFlagsRefusal({ 'npm-registry': '', 'code-server-url': undefined })).toBe('');
    expect(
      urlFlagsRefusal({
        'npm-registry': 'https://npm.example/registry/',
        'code-server-url': 'https://mirror.example/code-server/v{version}/{file}',
      }),
    ).toBe('');
    for (const flag of ['npm-registry', 'code-server-url'])
      for (const url of ['https://u:p@mirror.example/npm', 'https://mirror.example/npm?x', 'https://mirror.example/npm#y', 'ftp://m/x']) {
        const why = urlFlagsRefusal({ [flag]: url });
        expect(why).toStartWith(`--${flag}: `);
        expect(why).toContain('--seed-dir');
        // The refusal does not repeat what may be a secret.
        expect(why).not.toContain('u:p');
      }
  });

  // The executable refuses to start with one, before it opens anything.
  test('the hub does not start with credentials in a download URL', () => {
    const home = mkdtempSync(join(tmpdir(), 'serve-url-'));
    try {
      for (const args of [
        ['--npm-registry', 'https://u:p@mirror.example/npm'],
        ['--npm-registry', 'https://mirror.example/npm?token=x'],
        ['--npm-registry', 'https://mirror.example/npm#y'],
        ['--code-server-url', 'https://u:p@mirror.example/v{version}/{file}'],
      ]) {
        const r = spawnSync(process.execPath, [join(import.meta.dir, 'main.ts'), 'serve', '--instance', 'e2e-serve-url', ...args], {
          env: { PATH: process.env.PATH ?? '', HOME: home },
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect([args[1], r.status]).toEqual([args[1], 1]);
        expect(r.stderr).toContain(`${args[0]}: `);
        expect(r.stderr).not.toContain('u:p');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as brand from './brand.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';

const tsConst = (src: string, name: string) => {
  const v = new RegExp(`export const ${name} = '([^']*)'`).exec(src)?.[1];
  if (v === undefined) throw new Error(`const ${name} not found`);
  return v;
};

// The web UI and the VS Code extension cannot import these constants:
// their copies agree with them.
test('the copies of the names agree', () => {
  expect(brand.ENV_PREFIX).toBe(brand.SLUG.toUpperCase().replaceAll('-', '_') + '_');
  const web = readFileSync(join(REPO_ROOT, 'web/src/brand.ts'), 'utf8');
  expect([tsConst(web, 'APP_NAME'), tsConst(web, 'APP_SLUG'), tsConst(web, 'APP_DOMAIN')]).toEqual([brand.NAME, brand.SLUG, brand.DOMAIN]);
  const extDir = join(REPO_ROOT, 'extensions', brand.BRIDGE_EXT);
  const ext = readFileSync(join(extDir, 'src', 'brand.ts'), 'utf8');
  expect([tsConst(ext, 'DATA_DIR'), tsConst(ext, 'ENV_PREFIX'), tsConst(ext, 'SLUG')]).toEqual([
    brand.DATA_DIR_NAME,
    brand.ENV_PREFIX,
    brand.SLUG,
  ]);
  const pkg = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8')) as { name: string; publisher: string };
  expect([pkg.name, pkg.publisher]).toEqual([brand.BRIDGE_EXT, brand.SLUG]);
});

test('instances', () => {
  expect(brand.dataDir('')).toBe(`.${brand.SLUG}`);
  expect(brand.dataDir('dev')).toBe(`.${brand.SLUG}-dev`);
  expect(brand.validInstance('')).toBe(true);
  expect(brand.validInstance('e2e-1a2b')).toBe(true);
  expect(brand.validInstance('Dev')).toBe(false);
  expect(brand.validInstance('a/b')).toBe(false);
  expect(brand.validInstance('x'.repeat(33))).toBe(false);
});

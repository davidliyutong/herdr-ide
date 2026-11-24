import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as brand from './brand.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';

// The Go program's names, while it exists: both must agree.
test('the names are internal/brand’s', () => {
  const go = readFileSync(join(REPO_ROOT, 'internal/brand/brand.go'), 'utf8');
  const constant = (name: string) => go.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  expect(brand.NAME).toBe(constant('Name')!);
  expect(brand.SLUG).toBe(constant('Slug')!);
  expect(brand.DOMAIN).toBe(constant('Domain')!);
  expect(brand.ENV_PREFIX).toBe(constant('EnvPrefix')!);
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

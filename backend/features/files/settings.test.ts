import { expect, test } from 'bun:test';
import { validate } from '#kernel/config/settings/index.ts';
import { DEFAULT_EXCLUDE, excludeProblem, settings, wellFormed } from './settings.ts';

test('exclude patterns', () => {
  for (const ok of [DEFAULT_EXCLUDE, ['**/node_modules', '*.pyc', '[Tt]humbs.db', '?.tmp', '\\*', '[^a-z]x', '[a\\]]'], []])
    expect([ok, excludeProblem(ok)]).toEqual([ok, undefined]);
  for (const bad of [
    [''],
    ['**/'],
    ['a/b'],
    ['src/**/x'],
    ['[a'],
    ['[]'],
    ['[a-]'],
    ['x\\'],
    ['x'.repeat(201)],
    Array<string>(101).fill('a'),
  ])
    expect([bad.slice(0, 2), excludeProblem(bad)]).not.toEqual([bad.slice(0, 2), undefined]);
  // Through the setting's own check.
  const exclude = settings.settings!['files.exclude'];
  expect(validate(exclude, ['[a'])).toEqual({ ok: false, why: 'not a pattern: [a' });
  expect(validate(exclude, ['node_modules'])).toEqual({ ok: true, value: ['node_modules'] });
});

test('patterns as Go path.Match parses them', () => {
  const cases: Record<string, boolean> = {
    '*': true,
    'a?c': true,
    '[abc]': true,
    '[^abc]': true,
    '[a-c]': true,
    '[a-c\\-]': true,
    '[]a]': false,
    '[^]': false,
    '[a-': false,
    '[\\': false,
    '\\[': true,
    '[*]': true,
    ']': true,
    '-': true,
  };
  for (const [p, want] of Object.entries(cases)) expect([p, wellFormed(p)]).toEqual([p, want]);
});

// Every setting is in the feature's section, which names the feature.
test('settings section', () => {
  for (const [key, s] of Object.entries(settings.settings ?? {})) expect([key, s.section]).toEqual([key, 'files']);
  expect(settings.sections).toEqual([{ id: 'files', order: 66, plugin: 'files' }]);
});

test('files.openLinks defaults to editor and accepts vscode', () => {
  const openLinks = settings.settings!['files.openLinks'];
  expect(openLinks.default).toBe('editor');
  expect(validate(openLinks, 'editor')).toEqual({ ok: true, value: 'editor' });
  expect(validate(openLinks, 'vscode')).toEqual({ ok: true, value: 'vscode' });
  expect(validate(openLinks, 'invalid').ok).toBe(false);
});

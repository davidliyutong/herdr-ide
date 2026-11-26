// Git repositories for the tests, made with the instance's own home (its
// .gitconfig), never the user's.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Instance } from './instance';

export function gitConfig(inst: Instance) {
  writeFileSync(
    join(inst.home, '.gitconfig'),
    [
      '[user]',
      '\tname = E2E',
      '\temail = e2e@example.com',
      '[init]',
      '\tdefaultBranch = main',
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
}

export function git(inst: Instance, cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { HOME: inst.home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
  });
}

/** A repository with one commit of the files given. */
export function repo(inst: Instance, dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  git(inst, dir, 'init', '-q');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(inst, dir, 'add', '-A');
  git(inst, dir, 'commit', '-q', '-m', 'initial');
}

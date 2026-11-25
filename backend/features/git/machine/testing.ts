// Helpers of the Git feature's machine side's tests: an agent serving it on
// a home of its own, whose runs of git see that home (so its global
// configuration) and nothing of the user's, the tests' own runs of git for
// their setup (no system or global configuration), and calls of its
// actions through the core's call.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Fail } from '#shared/lib/fail.ts';
import { call } from '#kernel/agent.ts';
import { cleanEnv } from '#machine/env.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import { gitMachine, type GitMachineOptions } from '../machine.ts';
import { gitProtocol, type Params } from '../protocol.ts';

/** The environment of the tests' own runs of git: no system or global
 * configuration, fixed dates, the test's home. */
export const setupEnv = (home: string): Record<string, string> => ({
  ...cleanEnv(),
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
});

export const hasGit = spawnSync('git', ['--version']).status === 0;

/** Runs git in dir for a test's setup; its output, trimmed. */
export function sh(home: string, dir: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, env: setupEnv(home), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return `${r.stdout}`.trim();
}

export function write(p: string, s: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
}

/** An executable script at p. */
export function script(p: string, body: string): string {
  write(p, `#!/bin/sh\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

export interface GitRig {
  r: Rig;
  home: string;
  /** Runs git in dir for the test's setup. */
  sh(dir: string, ...args: string[]): string;
  /** A repository with one commit (a.txt) on main, at home/name. */
  newRepo(name?: string): string;
  /** Runs an action, its result as the core reads it. */
  call(action: string, p: Params): Promise<any>;
  /** The code an action fails with. */
  fails(action: string, p: Params): Promise<string>;
  close(): Promise<void>;
}

/** An agent serving the Git feature, its git runs seeing the rig's home. */
export async function gitRig(o: GitMachineOptions = {}): Promise<GitRig> {
  let home = '';
  const side = gitMachine({
    environ: () => ({ ...cleanEnv(), HOME: home, XDG_CONFIG_HOME: join(home, '.config') }),
    ...o,
  });
  const r = await rig({ features: [side] });
  home = r.home;
  const m = machineOf(r.session);
  const g: GitRig = {
    r,
    home,
    sh: (dir, ...args) => sh(home, dir, ...args),
    newRepo(name = 'repo') {
      const dir = join(home, name);
      mkdirSync(dir);
      const real = realpathSync(dir);
      g.sh(real, 'init', '-q', '-b', 'main');
      g.sh(real, 'config', 'user.name', 'Tester');
      g.sh(real, 'config', 'user.email', 'tester@example.com');
      g.sh(real, 'config', 'commit.gpgsign', 'false');
      write(join(real, 'a.txt'), 'one\ntwo\nthree\n');
      g.sh(real, 'add', 'a.txt');
      g.sh(real, 'commit', '-q', '-m', 'first');
      return real;
    },
    call: (action, p) => call(m, gitProtocol, action as keyof typeof gitProtocol.actions, p),
    async fails(action, p) {
      try {
        await g.call(action, p);
      } catch (e) {
        if (e instanceof Fail) return e.code;
        throw e;
      }
      throw new Error(`${action} succeeded`);
    },
    close: () => r.close(),
  };
  return g;
}

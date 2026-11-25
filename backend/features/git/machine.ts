// The Git feature's machine side (docs/features/31-git.md): the actions of
// protocol.ts, each run in a repository's top level (repo finds it from any
// directory) by running git with an argument vector of its own
// (machine/run.ts): no shell, no option or flag from the request, paths as
// literal pathspecs after "--", revisions and names checked before use
// (machine/check.ts). git never asks for credentials or an editor; a fetch,
// pull or push that would need a password fails with auth_required. Reads
// take 15 s at most, changes 120 s, after which git's process group is
// killed, as it is when the hub gives up on the action; at most MAX_RUNS
// run at once on the machine, another waits briefly and fails with busy.
import { defineMachine, type ActionContext, type Handlers } from '#machine/feature.ts';
import { READS, WRITES, gitProtocol, type Params, type Read, type Write } from './protocol.ts';
import { branches, diffStat, log, readBlob, repoInfo, show, stashes, status, tags, watch, type GitState } from './machine/read.ts';
import { openRepo, type GitContext, type Repo } from './machine/repo.ts';
import { GIT_TIMING, MAX_RUNS, Slots, execGit, findGit, type GitTiming } from './machine/run.ts';
import { change } from './machine/write.ts';

export interface GitMachineOptions {
  timing?: Partial<GitTiming>;
  /** The git executable; null when there is none (PATH's git). */
  git?: () => string | null;
  /** The environment git's runs start from (the agent's, ctx.environ). */
  environ?: () => Record<string, string>;
  /** The runs of git at once. */
  maxRuns?: number;
}

export function gitMachine(o: GitMachineOptions = {}) {
  return defineMachine(gitProtocol, () => {
    const timing: GitTiming = { ...GIT_TIMING, ...o.timing };
    const slots = new Slots(o.maxRuns ?? MAX_RUNS);
    const state: GitState = { noIgnoredMode: false };
    const runner = { timing, slots, git: o.git ?? (() => findGit()) };
    const contextOf = (ctx: ActionContext): GitContext => {
      const environ = o.environ ?? ctx.environ;
      return {
        run: (dir, read, rn) => execGit(runner, environ(), dir, read, rn, ctx.signal),
        expand: (p) => ctx.expand(p),
      };
    };
    const reads: Record<Exclude<Read, 'repo'>, (r: Repo, p: Params) => unknown> = {
      status: (r) => status(r, state),
      log: (r, p) => log(r, p),
      show: (r, p) => show(r, p),
      blob: (r, p) => readBlob(r, p),
      branches: (r) => branches(r),
      tags: (r) => tags(r),
      stashes: (r) => stashes(r),
      diffStat: (r) => diffStat(r),
      watch: (r) => watch(r.root),
    };
    const actions: Record<string, (p: Params, ctx: ActionContext) => unknown> = {
      repo: (p, ctx) => repoInfo(contextOf(ctx), p.path),
    };
    for (const action of READS)
      if (action !== 'repo') actions[action] = async (p, ctx) => reads[action](await openRepo(contextOf(ctx), p.repo, true), p);
    for (const action of WRITES)
      actions[action] = async (p, ctx) => change(await openRepo(contextOf(ctx), p.repo, false), action as Write, p, timing.changeMs);
    return { actions: actions as unknown as Handlers<typeof gitProtocol> };
  });
}

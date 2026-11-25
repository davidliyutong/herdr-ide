// The Git feature's changes: each a sequence of runs of git whose argument
// vectors are built here from checked values; the first that fails ends
// the change. Paths (stage, unstage, discard) are literal pathspecs after
// "--", over several runs when there are many; revisions and names never
// start with "-" and no option is taken from the request.
import { Fail } from '#shared/lib/fail.ts';
import type { Params, Write } from '../protocol.ts';
import { FULL_HASH, MAX_PATHS, badParams, cleanPaths, pathArgs, plainName } from './check.ts';
import type { Repo } from './repo.ts';
import { text } from './repo.ts';
import type { Run } from './run.ts';

/** Bounds a patch or a commit message. */
export const MAX_PATCH = 4 << 20;

/** Runs a change: what git printed (at most 4000 characters). changeMs is
 * the timeout of each of its runs. */
export async function change(r: Repo, action: Write, p: Params, changeMs: number): Promise<{ output?: string }> {
  let out = '';
  for (const rn of await runsOf(r, action, p)) {
    const res = await r.git({ ...rn, timeoutMs: rn.timeoutMs ?? changeMs });
    if (out.length < 4000) out += `${text(res.out)}\n${text(res.err)}`.trim() + '\n';
  }
  let s = out.trim();
  if (s.length > 4000) s = s.slice(0, 4000) + '…';
  return s ? { output: s } : {};
}

const paths = (ps: string[] | undefined): string[] => {
  const c = cleanPaths(ps);
  if (c.length === 0) throw badParams('no paths');
  return c;
};

const runs = (args: readonly string[], ps: readonly string[]): Run[] => pathArgs(args, ps).map((a) => ({ args: a }));

/** The runs of a change. */
export async function runsOf(r: Repo, action: Write, p: Params): Promise<Run[]> {
  switch (action) {
    case 'stage':
      if (p.all)
        // The tracked files' changes only, while untracked files are shown
        // apart; or all.
        return [{ args: p.tracked ? ['add', '--update'] : ['add', '--all'] }];
      return runs(['add', '--all'], paths(p.paths));
    case 'unstage': {
      const ps = p.all ? [] : paths(p.paths);
      if (!(await r.hasHead())) {
        // Before the first commit nothing is in HEAD to restore: the index
        // loses the paths (-f also those changed since they were staged;
        // the working tree keeps them).
        if (p.all) return [{ args: ['rm', '--cached', '-r', '-f', '-q', '--', '.'] }];
        return runs(['rm', '--cached', '-r', '-f', '-q'], ps);
      }
      if (p.all) return [{ args: ['reset', '-q', 'HEAD', '--'] }];
      return runs(['restore', '--staged'], ps);
    }
    case 'discard': {
      const tracked = cleanPaths(p.paths);
      const untracked = cleanPaths(p.untracked);
      if (tracked.length + untracked.length === 0) throw badParams('no paths');
      if (tracked.length + untracked.length > MAX_PATHS) throw badParams(`at most ${MAX_PATHS} paths`);
      // clean removes untracked files only, never a tracked one (nor an
      // untracked repository: that needs a second -f).
      return [...runs(['clean', '-f', '-q'], untracked), ...runs(['restore', '--worktree'], tracked)];
    }
  }
  return [await argv(r, action, p)];
}

/** The operations in progress an abort or continue acts on, and git's
 * command of each. */
const OPERATIONS = new Map([
  ['merge', 'merge'],
  ['rebase', 'rebase'],
  ['cherryPick', 'cherry-pick'],
  ['revert', 'revert'],
]);

const RESET_MODES = new Map([
  ['soft', '--soft'],
  ['mixed', '--mixed'],
  ['hard', '--hard'],
]);

/** HEAD, or the checked revision at. */
const atOf = (r: Repo, at: string | undefined): Promise<string> => (at ? r.rev(at) : Promise.resolve('HEAD'));

/** The run of a change without paths. */
async function argv(r: Repo, action: Write, p: Params): Promise<Run> {
  switch (action) {
    case 'applyPatch': {
      const patch = p.patch ?? '';
      if (patch === '' || Buffer.byteLength(patch) > MAX_PATCH) throw badParams(`no patch or a patch over ${MAX_PATCH} bytes`);
      return {
        args: ['apply', '--whitespace=nowarn', ...(p.cached ? ['--cached'] : []), ...(p.reverse ? ['--reverse'] : []), '-'],
        stdin: patch,
      };
    }
    case 'commit': {
      const message = p.message ?? '';
      if (Buffer.byteLength(message) > MAX_PATCH) throw badParams('message too long');
      // The message is the user's as typed: whitespace is tidied, lines
      // starting with "#" are kept (no editor added comments).
      const args = ['commit', '--cleanup=whitespace', ...(p.amend ? ['--amend'] : []), ...(p.signoff ? ['--signoff'] : [])];
      if (message.trim() === '') {
        if (!p.amend) throw new Fail('empty_message', 400, 'no commit message');
        // Amending without a message keeps the commit's own.
        return { args: [...args, '--no-edit'] };
      }
      return { args: [...args, '--file=-'], stdin: message };
    }
    case 'checkout': {
      if (p.rev) return { args: ['checkout', '--detach', await r.rev(p.rev), '--'] };
      const name = p.name ?? '';
      plainName(name);
      await r.refExists(`refs/heads/${name}`);
      return { args: ['checkout', name, '--'] };
    }
    case 'branchCreate': {
      const name = await r.newName('heads', p.name);
      const at = await atOf(r, p.at);
      return { args: p.checkout ? ['checkout', '-b', name, at, '--'] : ['branch', name, at] };
    }
    case 'branchDelete': {
      const name = p.name ?? '';
      plainName(name);
      if (p.remote) return { args: ['push', await r.remote(p.remote), '--delete', `refs/heads/${name}`] };
      await r.refExists(`refs/heads/${name}`);
      return { args: ['branch', p.force ? '-D' : '-d', name] };
    }
    case 'branchRename': {
      const name = p.name ?? '';
      plainName(name);
      await r.refExists(`refs/heads/${name}`);
      return { args: ['branch', '-m', name, await r.newName('heads', p.to)] };
    }
    case 'merge':
      return { args: ['merge', '--no-edit', ...(p.noFF ? ['--no-ff'] : []), await r.rev(p.ref)] };
    case 'rebase':
      return { args: ['rebase', await r.rev(p.onto)] };
    case 'abort':
    case 'continue': {
      const sub = OPERATIONS.get(p.op ?? '');
      if (!sub) throw badParams(`unknown operation ${JSON.stringify(p.op ?? '')}`);
      return { args: [sub, `--${action}`] };
    }
    case 'cherryPick':
    case 'revert': {
      const rev = await r.rev(p.rev);
      const args = action === 'revert' ? ['revert', '--no-edit'] : ['cherry-pick'];
      if ((p.parent ?? 0) > 0) args.push('--mainline', String(p.parent));
      return { args: [...args, rev] };
    }
    case 'reset': {
      const mode = RESET_MODES.get(p.mode ?? '');
      if (!mode) throw badParams(`unknown mode ${JSON.stringify(p.mode ?? '')}`);
      return { args: ['reset', '-q', mode, await r.rev(p.rev), '--'] };
    }
    case 'tagCreate': {
      const name = await r.newName('tags', p.name);
      const at = await atOf(r, p.at);
      const message = p.message ?? '';
      if (message.trim() !== '') {
        if (Buffer.byteLength(message) > MAX_PATCH) throw badParams('message too long');
        return { args: ['tag', '--annotate', '--file=-', name, at], stdin: message };
      }
      return { args: ['tag', name, at] };
    }
    case 'tagDelete': {
      const name = p.name ?? '';
      plainName(name);
      if (p.remote) return { args: ['push', await r.remote(p.remote), '--delete', `refs/tags/${name}`] };
      await r.refExists(`refs/tags/${name}`);
      return { args: ['tag', '-d', name] };
    }
    case 'stashPush': {
      const args = ['stash', 'push', ...(p.includeUntracked ? ['--include-untracked'] : [])];
      const m = (p.message ?? '').trim();
      if (m !== '') {
        if (m.includes('\0') || Buffer.byteLength(m) > 4096) throw badParams('bad message');
        args.push(`--message=${m}`);
      }
      return { args };
    }
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop': {
      const index = p.index ?? 0;
      if (index < 0 || index > 100000) throw badParams('bad stash index');
      if (!FULL_HASH.test(p.hash ?? '')) throw badParams('no stash commit');
      // The entry is the one the UI showed: a stash pushed or dropped
      // meanwhile renumbers them.
      const entry = `stash@{${index}}`;
      const res = await r.git({ args: ['rev-parse', '-q', '--verify', entry], ok: [1, 128] });
      if (res.code !== 0 || text(res.out).trim().toLowerCase() !== (p.hash ?? '').toLowerCase())
        throw new Fail('stale', 409, `${entry} is not ${p.hash}`);
      return { args: ['stash', action.slice('stash'.length).toLowerCase(), entry] };
    }
    case 'fetch': {
      const args = ['fetch', ...(p.prune ? ['--prune'] : [])];
      if (!p.remote || p.all) return { args: [...args, '--all'] };
      return { args: [...args, await r.remote(p.remote)] };
    }
    case 'pull': {
      // As the user's configuration says (pull.rebase, pull.ff) unless asked
      // to rebase; branches that diverged without one fail with diverged.
      // From the upstream, or from a remote's branch named by its full ref.
      const args = ['pull', ...(p.rebase ? ['--rebase'] : [])];
      if (!p.remote) {
        if (p.branch) throw badParams('a branch needs a remote');
        return { args };
      }
      const remote = await r.remote(p.remote);
      if (!p.branch) return { args: [...args, remote] };
      return { args: [...args, remote, `refs/heads/${await r.newName('heads', p.branch)}`] };
    }
    case 'push': {
      const args = ['push', ...(p.forceWithLease ? ['--force-with-lease'] : [])];
      if (!p.remote) {
        if (p.branch || p.tag || p.setUpstream) throw badParams('a branch or tag needs a remote');
        return { args };
      }
      const remote = await r.remote(p.remote);
      if (p.tag) {
        plainName(p.tag);
        await r.refExists(`refs/tags/${p.tag}`);
        return { args: [...args, remote, `refs/tags/${p.tag}`] };
      }
      if (p.branch) {
        plainName(p.branch);
        await r.refExists(`refs/heads/${p.branch}`);
        return { args: [...args, ...(p.setUpstream ? ['--set-upstream'] : []), remote, `refs/heads/${p.branch}:refs/heads/${p.branch}`] };
      }
      return { args: [...args, remote] };
    }
  }
  throw badParams(`unknown action ${JSON.stringify(action)}`);
}

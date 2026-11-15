# 31 · Git

## Context

Coding agents in the terminals change repositories all day; looking at
what they changed, staging part of it, committing and moving between
branches is most of the review. VS Code panes ([05](05-vscode-panes.md))
have Source Control and the Git Graph extension, but code-server takes a
while to start on each machine and a pane's worth of room, and its
diffs live in another window's state. The right sidebar of plugins
([27](27-plugins.md)) has room for VS Code's Source Control view, and
Monaco ([28](28-file-explorer.md)) brings VS Code's diff editor into a
pane of its own.

## Goals / non-goals

Goals: VS Code's Source Control and the Git Graph extension in one, for the
repository of the focused pane's directory on any machine: the branch with
ahead/behind and fetch, pull, push; staging and unstaging files and
selected ranges; discarding; commits (amend, Cmd/Ctrl+Enter); the graph
of every branch with ref badges, search, a branch filter, a commit's
details and files, comparing two commits, and the actions of its context
menus (checkout, branches, tags, merge, rebase, cherry-pick, revert,
reset, stashes); diffs in Monaco with the working tree's side editable; the
file explorer's colors for changed files.

Non-goals: an interactive rebase, conflict resolution with three panes
(conflicted files open in the diff pane and the editor), credentials typed
in the UI (fetch, pull and push use what git has: credential helpers, SSH
keys and agents), submodule management, blame, line history.

## Design

**Plugin** `git`: on by default (`plugins.git.enabled`), a panel of the
right sidebar (**Show Source Control**, `view.panel.git`, Ctrl+Shift+G as
in VS Code, in the desktop app), the pane kinds `graph` and `diff`, and
**Show Git Graph** (`git.graph`, no default key) for the focused pane's
repository. The web side is `web/src/plugins/git`, the core's
`internal/plugins/git`, the machine's `internal/agent/plugin/git`.

**Machine side.** Every action runs the `git` executable with an argument
vector the agent builds: no shell, no option from the request.

- The repository is its top level (`repo` finds it from a directory with
  `rev-parse --show-toplevel`, and the top levels of repositories it is
  nested in); other actions refuse a directory without `.git`
  (`not_a_repo`). Paths are relative to the top level, never absolute, with
  no `.` or `..` elements, and come after `--`; they are literal
  (`GIT_LITERAL_PATHSPECS=1`), so `:(glob)…` names a file, not a pattern.
  The stash's actions keep pathspec magic for git's own use (they take no
  paths).
- Revisions and names never start with `-` and have none of the
  characters git gives a meaning (`~ ^ : ? * [ \`, spaces, `..`, `@{`); a
  revision is a hash (4–64 hex digits) or a name `rev-parse --verify`
  resolves to a commit; an existing branch or tag must exist
  (`show-ref --verify`), a new one pass `check-ref-format`; a remote must be
  one of `git remote`'s.
- The environment is the agent's (`Env.Environ`) without git's variables
  that point elsewhere (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_CONFIG_*`…) or ask for credentials (`GIT_ASKPASS`, `SSH_ASKPASS`),
  with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_EDITOR=true` (a merge or rebase takes its default message),
  `GIT_PAGER=cat`, and `GIT_OPTIONAL_LOCKS=0` for reads. git runs in a
  session of its own (no terminal to prompt on) with standard input from
  the request or empty. A fetch, pull or push that needs credentials git
  does not have fails, and its message is classified `auth_required`; the
  UI says to run it in a terminal or set up a helper or key.
- Time: reads 15 s, changes (network, hooks of a commit) 120 s; then, or
  when the core closes the request's stream, git's process group is
  killed. Output: 32 MiB per run (`too_large`), files 8 MiB, the status
  20 000 entries, patches and messages 4 MiB.
- Failures carry codes: `git_missing` (no git on the machine),
  `not_a_repo`, `bad_ref`, `bad_params`, `not_found`, `auth_required`,
  `conflicts` (a merge, rebase, cherry-pick, revert or stash that stopped on
  conflicts), `timeout`, `too_large`, `git_failed` with git's message.

| Read | What it answers |
| --- | --- |
| `repo` | `?path=` a directory: top level, git directories, branch (or detached) and HEAD, upstream with ahead/behind, an operation in progress (`merge`, `rebase`, `cherryPick`, `revert`), remotes, enclosing repositories. |
| `status` | `status --porcelain=v2 -z --branch --untracked-files=all`: files with the index's and the working tree's letters, renames with their old path, conflicts, untracked files; branch, upstream, ahead/behind. |
| `log` | `log --date-order` of the branches, tags and HEAD (with `remotes=1` the remote branches; `branch=` names some instead), pages of 300 (at most 1000, `skip=`): hash, parents, author, e-mail, date, subject; with the first page the refs (`for-each-ref`, tags peeled), the stashes, HEAD and its branch. |
| `show` | `rev=` a commit's message and committer and its files (status, lines added and deleted, binary) against its parent `parent=` (1 by default; the empty tree for a root commit), or with `rev2=` the files between two commits. |
| `blob` | `path=` at `source=`: `worktree` (with its size and modification time), `index` (stage 0), `head`, or a revision (with `parent=`: its parent's); `exists`, `binary` (a NUL in the first 8000 bytes or not UTF-8), `tooLarge` over 8 MiB. |
| `branches`, `tags`, `stashes` | Local and remote branches with upstream and ahead/behind; tags with their commit and whether annotated; stashes with their base. |
| `diffStat` | Lines added and deleted per file in the working tree and in the index. |
| `watch` | A token of the modification times of the index, `HEAD`, the operation's files, `logs/HEAD`, `packed-refs`, `FETCH_HEAD` and `refs/` (at most 4000 entries) in the git directory and the common one, found without running git (a `.git` file names a worktree's or submodule's directory, its `commondir` the common one). |

| Change | git |
| --- | --- |
| `stage` | `add --all -- <paths>` (`all`: `add --all`) |
| `unstage` | `restore --staged -- <paths>`; before the first commit `rm --cached -r`; `all`: `reset -q HEAD --` |
| `applyPatch` | `apply [--cached] [--reverse] -` with the patch on standard input |
| `discard` | `restore --worktree -- <paths>`; untracked files `clean -f -- <paths>`, which removes nothing tracked |
| `commit` | `commit --cleanup=strip [--amend] [--signoff] --file=-` with the message on standard input (`--no-edit` for an amend without one) |
| `checkout` | `checkout <branch> --` or `checkout --detach <commit> --` |
| `branchCreate`, `branchRename`, `branchDelete` | `branch <name> <at>` or `checkout -b <name> <at> --`; `branch -m`; `branch -d`/`-D`, or `push <remote> --delete refs/heads/<name>` |
| `merge`, `rebase` | `merge --no-edit [--no-ff] <ref>`; `rebase <onto>` (not interactive) |
| `abort`, `continue` | `merge`, `rebase`, `cherry-pick` or `revert` with `--abort`/`--continue` |
| `cherryPick`, `revert` | `cherry-pick [--mainline N] <commit>`, `revert --no-edit [--mainline N] <commit>` |
| `reset` | `reset -q --soft`/`--mixed`/`--hard <commit> --` |
| `tagCreate`, `tagDelete` | `tag <name> <at>` or `tag --annotate --file=- <name> <at>`; `tag -d`, or `push <remote> --delete refs/tags/<name>` |
| `stashPush`, `stashApply`, `stashPop`, `stashDrop` | `stash push [--include-untracked] [--message=…]`; `stash apply`/`pop`/`drop stash@{N}` |
| `fetch`, `pull`, `push` | `fetch [--prune] <remote>` or `--all`; `pull --rebase`/`--no-rebase`; `push [--force-with-lease] [--set-upstream] <remote> refs/heads/<b>:refs/heads/<b>` or `refs/tags/<t>`, or `push` to the upstream |

**Core side.** Reads are `GET /api/m/{id}/p/git/<action>` with their
parameters in the query; changes `POST /api/m/{id}/p/git/<action>` with a
JSON body (at most 5 MiB), mutating: refused in read-only mode, audited as
`git.<action>`. The core forwards to the agent's `plugin` op and passes
the answer through.

**Panel** (`GitPanel.tsx`), as VS Code's Source Control view:

- The repository of the focused pane's directory (a terminal's, a VS Code
  pane's folder, the workspace's), kept while another pane (a diff, the
  graph) has the focus; a picker when the directory is in nested
  repositories.
- The branch (or the detached commit) with a sync button (`behind↓ ahead↑`:
  pull, then push) or **Publish Branch** without an upstream, Pull and
  Push; More: Fetch (all remotes, pruned), Pull (Rebase), Force Push (with
  lease), Create Branch, Stash Changes, tree or list.
- A banner while a merge, rebase, cherry-pick or revert is in progress, with
  Abort and Continue.
- The commit box: Cmd/Ctrl+Enter or **Commit**; **Amend last commit**.
  With nothing staged it offers to stage everything and commit. The text
  typed is kept per repository while the panel is hidden.
- **Merge Changes**, **Staged Changes**, **Changes** (untracked files
  among them, `U`) with counts, as a list (the folder beside the name) or a
  tree (folders with a single folder joined). Rows show the status letter
  in its color; a click opens the diff, the row's buttons open the file
  (the explorer's editor), discard (after asking; untracked files are
  deleted) and stage or unstage; group headers stage, unstage or discard
  all. The context menu has the same.
- **Stashes** (apply, pop, drop) and **Recent Commits**: the last 12 with
  their lanes; a click opens the graph.
- While shown and the page visible, the panel asks `watch` every 2 s and
  reads `repo` and `status` again when the token moved, at least every
  10 s (changes of the working tree do not move it), and after every
  change it makes (`state.ts`). Panes showing the repository share this.

**Graph pane** (`GraphPane.tsx`, `{view: {plugin: 'git', kind: 'graph',
repo}}`, one per repository):

- Lanes (`graph.ts`, a pure function): commits in date order, each in the
  first lane waiting for it (else a free or new one); other lanes waiting
  for it end in its dot; its first parent continues the lane, other parents
  join the lane waiting for them or open one. Lanes keep their place while
  they live and are reused once free; colors cycle through eight. Each row
  is an SVG of its lines from the top to the dot and from the dot to the
  bottom.
- Rows: the working tree's changes on top (a hollow dot on HEAD), the
  commits, and the stashes (square dots) above the first older commit,
  never below their base. Badges: the current branch (bold), branches,
  remote branches (when shown), tags, HEAD when detached. Columns: the
  description, date, author, short hash. Only the rows in view are drawn;
  the next page loads near the end.
- A search box dims what does not match (subject, author, e-mail, hash
  prefix), Enter and the arrows go to the next and previous match. A branch
  filter shows one branch's history; **Remote branches** turns them off.
- A click opens the commit's details under it: hash, parents (a merge's
  parent chooses what its files are compared with), author, committer,
  message, and its files with lines added and deleted; a file opens the
  diff against the parent. Cmd/Ctrl-click on another commit compares the
  two (files between them; a file opens its diff); the working tree's row
  lists the changed files.
- Context menus: a commit: Check Out (detached), Create Branch Here, Create
  Tag Here, Merge into the current branch, Cherry-pick, Revert (a merge
  against its first parent), Reset the current branch to it (soft, mixed,
  hard, after asking), Compare with HEAD, copy hash or subject. A branch:
  check out (double click too), merge into the current one, rebase the
  current one onto it, rename, delete (asked again to force one not
  merged), push to `origin` (or the first remote) with upstream. A remote
  branch: check out as a local branch that tracks it, merge, fetch its
  remote, delete it on the remote. A tag: delete, push. A stash: apply, pop,
  drop.

**Diff pane** (`DiffPane.tsx`, `{view: {plugin: 'git', kind: 'diff', repo,
path, mode, rev?, rev2?, orig?, parent?}}`; the same file and mode reuse
their pane):

| Mode | Left | Right |
| --- | --- | --- |
| `worktree` | the index (HEAD for a conflicted file, nothing for an untracked one) | the working tree, editable |
| `staged` | HEAD (at the old path of a rename) | the index |
| `commit` | the commit's parent | the commit |
| `compare` | one commit | another |

- Monaco's diff editor (`createDiffEditor`): side by side or inline,
  unchanged regions collapsed (a toggle), previous and next change, the
  number of changes. Binary files and files over 8 MiB are not shown.
- In `worktree` mode the right side saves with ⌘S (Ctrl+S) or the toolbar
  through the file explorer's save (`POST …/p/files/write`), with the size
  and modification time `blob` gave: a file changed meanwhile is not
  overwritten (a toast offers to load it again).
- **Stage File**, **Stage Selected Ranges**, **Discard Selected Ranges**
  (`worktree`); **Unstage File**, **Unstage Selected Ranges** (`staged`).
  The selected ranges become a unified patch (`patch.ts`) from Monaco's
  line changes the selection touches, sent to `applyPatch`: staging goes
  forward from the index (`--cached`), changes selected on the right side
  cut to the selected lines (as VS Code does: the change's old lines go,
  the selected new lines come); unstaging goes backward from the index
  (`--cached`), discarding backward from the working tree; those take whole
  changes. Context lines (3) come from the side the patch applies to, so
  it applies whatever else differs; a last line without a newline gets
  git's marker. Discarding ranges asks first and needs the text saved.
- When the repository changes, both sides are read again; unsaved text
  stays.

**File explorer decorations** (`decorations.ts`): with the panel or a pane
following a repository, the explorer colors its changed files (conflicts,
deletions, modifications, renames, additions, untracked) with their letter,
and their folders with the most pressing change inside.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A library (go-git, libgit2) on machines instead of the executable | The agent would carry another implementation of git with its own gaps (hooks, credential helpers, worktrees, config); the user's git is what their terminals use. |
| A generic "run git with these arguments" route | Every request could pass options (`--upload-pack`, `-c`, `--exec`) that run programs; actions with argument vectors built on the machine keep what runs in the agent's code. |
| Pushing changes from a watcher on machines | A watcher per repository needs an owner and limits; one stat of a few files every 2 s while the panel is shown costs less and stops with it. |
| Typing credentials into the UI | Passwords and passphrases would cross the core; the terminal next to the panel is where git can ask. |
| Using VS Code's Source Control and Git Graph only | They stay ([05](05-vscode-panes.md)); code-server per machine is slow to start and large for a look at a diff. |
| Lanes computed on the machine | The graph changes with filters and pages in the browser; a pure function there is testable with vectors. |

## Failure modes

- No git on the machine: every action fails with `git_missing`, the panel
  says so.
- A directory outside repositories: the panel says so; actions on a path
  that is not a top level fail with `not_a_repo`.
- A remote that needs credentials git does not have: `auth_required`, and
  the toast says to run the command in a terminal.
- A merge, rebase, cherry-pick, revert or stash apply with conflicts:
  `conflicts`, the files appear under Merge Changes and the banner offers
  Abort and Continue.
- git hanging (a hook, a slow remote): killed after its timeout
  (`timeout`); when the browser goes away the core closes the stream and
  the agent kills it.
- A patch that no longer applies (the file changed after the diff loaded):
  `git_failed` with git's message; the pane reads both sides again.
- Machine offline: requests fail with `offline`; the panel shows the error
  and the polls try again.
- An older agent during an upgrade: actions fail with `unknown_plugin`.
- The plugin turned off: its routes answer `404 plugin_disabled`, the panel
  is gone and its panes say the plugin is off.

## Security

git runs with the user's permissions in their repositories, as in a
terminal; what the plugin adds is a way to reach it from the browser:

- Fixed argument vectors per action, no shell, no option from the request;
  paths after `--` and literal; revisions and names checked (no leading
  `-`, no special characters, existing refs and remotes resolved, new names
  through `check-ref-format`). `TestArgvRefusesOptions` holds injections
  (`--upload-pack=…`, `--exec=…`, `-f`, `..`) refused.
- No credential prompts: no terminal, no askpass programs, `GIT_TERMINAL_PROMPT=0`;
  a fetch, pull or push that needs credentials fails (`auth_required`).
- Every change is a mutating route: refused in read-only mode, audited as
  `git.<action>`, behind the core's Origin/Host checks; reads change
  nothing (`GIT_OPTIONAL_LOCKS=0`).
- Bounded: timeouts with the process group killed, output, files, patches
  and messages capped.

## Testing

- `internal/agent/plugin/git/git_test.go` (HOME in a temporary directory,
  `GIT_CONFIG_NOSYSTEM=1`, user name and e-mail set in each repository):
  name and path checks, options refused in every change's arguments, each
  read on a repository with a merge, a rename, a tag, a stash, staged,
  modified, untracked and binary files; a conflict (state, unmerged status,
  abort), a detached HEAD, a linked worktree (`.git` file, `watch`), nested
  repositories and one without commits; each change (patches with
  `--cached` and `--reverse`, discards, commits with the message on
  standard input, branches, tags, stashes, cherry-pick, revert, merge,
  reset, rebase); push, fetch and pull with a bare repository; a remote
  that asks for a password (`auth_required`); timeouts and output limits
  with a fake git; the environment; literal paths; the shared range
  patches applied with `git apply`.
- `internal/agent/plugins_git_test.go`: the core's routes are the agent's
  actions, reads as reads.
- `internal/plugins/git/git_test.go`: routes (reads GET, changes mutating
  and audited), the read's query; `TestMutatingRoutesAreGuarded`
  (`internal/server`) checks them.
- `design/testdata/git/range-patches.json`: range patches (additions,
  deletions, parts of changes, ranges over several hunks, unstaging,
  discarding, the last line without a newline), run by
  `web/src/__tests__/gitPatch.test.ts` and applied with git by the Go test.
- `web/src/__tests__/gitGraph.test.ts`: lanes (linear, branch and merge,
  octopus, parallel branches, reused lanes, parents off the page, joins),
  rows with the working tree and stashes, badges, search.
- `web/src/__tests__/gitPanel.test.ts`, `gitGraphPane.test.ts`,
  `gitDiff.test.ts` (Monaco replaced): groups and tree, decorations, the
  panel's actions and commit box, read-only mode; the graph's rows,
  details, compare and menus; the diff's sides per mode, range patches
  sent, saves.

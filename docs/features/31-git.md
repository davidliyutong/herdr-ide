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
  (`not_a_repo`). A directory reached through a link to a directory gets
  the top level spelled through that link, as the explorer and editors
  show it (the directory without git's `--show-prefix`, when that is the
  same directory as git's physical top level; else git's). Paths are
  relative to the top level, never absolute, with no `.` or `..`
  elements (a trailing `/` names a directory, as the status lists an
  untracked repository inside this one), and come after `--`; each is
  literal (git's `:(literal)` magic), so `:(glob)…` or `*.txt` names a
  file, not a pattern. The literal reading is per path, not
  `GIT_LITERAL_PATHSPECS`, which hooks would inherit (a pre-commit hook's
  `git diff --cached -- '*.txt'` matches as in a terminal). A change with
  many paths runs git several times, each with at most 96 KiB of them (a
  command line has a limit of its length); a change takes at most 20 000
  paths, as many as a status lists.
- Revisions and names never start with `-` and have none of the
  characters git gives a meaning (`~ ^ : ? * [ \`, spaces, `..`, `@{`); a
  revision is a hash (4–64 hex digits) or a name `rev-parse --verify`
  resolves to a commit; an existing branch or tag must exist
  (`show-ref --verify`), a new one pass `check-ref-format`; a remote must be
  one of `git remote`'s.
- The environment is the agent's (`Env.Environ`) without any of git's
  `GIT_*` variables except `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`,
  `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (so none points git at another
  repository, configuration, attributes source or program: `GIT_DIR`,
  `GIT_CONFIG_*`, `GIT_ATTR_SOURCE`, `GIT_EXEC_PATH`, `GIT_TRACE*`…), without
  `SSH_ASKPASS` and the locale (`LANG`, `LANGUAGE`, `LC_ALL`), and with
  `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_EDITOR=true` (a merge or rebase takes its default message),
  `GIT_PAGER=cat`, `GIT_MERGE_AUTOEDIT=no` and `GIT_OPTIONAL_LOCKS=0` for
  reads. git runs in a
  session of its own (no terminal to prompt on) with standard input from
  the request or empty. A fetch, pull or push that needs credentials git
  does not have fails, and its message is classified `auth_required`; the
  UI says to run it in a terminal or set up a helper or key.
- Configuration: every run sets `gc.autoDetach=false` and
  `maintenance.autoDetach=false`, so automatic maintenance a change starts
  runs inside the run (its process group, its timeout) instead of in the
  background. Reads also set `core.fsmonitor=false`,
  `core.untrackedCache=false`, `maintenance.auto=false` and `gc.auto=0`, and
  their diffs `--no-ext-diff --no-textconv`: looking at a repository runs no
  file system monitor hook or daemon and no textconv driver it configures.
  Clean filters (`filter.<name>.clean` of the repository's attributes) still
  run when `status` or `diffStat` compare a changed file of the working
  tree, as a git-aware shell prompt runs them.
- Time: reads 15 s, changes (network, hooks of a commit) 120 s; then, or
  when the core closes the request's stream, git's process group is
  killed. A run whose git exited while a program it started (a hook's
  background job) still holds its output ends 2 s later with git's result;
  that program, the user's, keeps running. At most 8 runs at once per
  machine; another waits up to 3 s for one to end, then fails with `busy`.
  Output: 32 MiB per run (`too_large`), files 8 MiB, the status 20 000
  entries, patches and messages 4 MiB.
- Failures carry codes: `git_missing` (no git on the machine),
  `not_a_repo`, `bad_ref`, `bad_params`, `not_found` (also a repository
  directory gone), `auth_required`, `conflicts` (a merge, rebase,
  cherry-pick, revert or stash that stopped on conflicts), `diverged` (a
  pull into a branch that diverged from its upstream without `pull.rebase`
  or `pull.ff` saying how), `stale` (a stash entry that is no longer the
  one shown), `timeout`, `too_large`, `busy`, `failed` (git did not start,
  such as an argument list over the system's limit), `git_failed` with
  git's message.

| Read | What it answers |
| --- | --- |
| `repo` | `?path=` a directory: top level, git directories, branch (or detached) and HEAD, upstream with ahead/behind, an operation in progress (`merge`, `rebase`, `cherryPick`, `revert`), remotes, enclosing repositories. |
| `status` | `status --porcelain=v2 -z --branch --untracked-files=all`: files with the index's and the working tree's letters, renames with their old path, conflicts, untracked files; branch, upstream, ahead/behind. A file whose working tree side differs from the index (and an untracked or conflicted one) has that file's modification time and size (`lstat`, nothing read), which move when it is edited again while its letters stay. |
| `log` | `log --date-order` of the branches, tags and HEAD (with `remotes=1` the remote branches; `branch=` names some instead; on a branch without commits yet, the other branches' commits), pages of 300 (at most 1000, `skip=`): hash, parents, author, e-mail, date, subject; with the first page the refs (`for-each-ref`, tags peeled), the stashes, HEAD and its branch. |
| `show` | `rev=` a commit's message and committer and its files (status, lines added and deleted, binary) against its parent `parent=` (1 by default; the empty tree for a root commit), or with `rev2=` the files between two commits. |
| `blob` | `path=` at `source=`: `worktree` (with its size and modification time; a link is answered as its target, a path through a directory link that leads out of the repository does not exist, FIFOs and devices are not read), `index` (stage 0), `head`, or a revision (with `parent=`: its parent's); `exists`, `binary` (a NUL in the first 8000 bytes or not UTF-8), `tooLarge` over 8 MiB. |
| `branches`, `tags`, `stashes` | Local and remote branches with upstream and ahead/behind; tags with their commit and whether annotated; stashes with their base. |
| `diffStat` | Lines added and deleted per file in the working tree and in the index. |
| `watch` | Tokens of modification times and sizes in the git directory and the common one, found without running git (a `.git` file names a worktree's or submodule's directory, its `commondir` the common one): `refs` of `HEAD`, `logs/HEAD`, `packed-refs`, the stash's log, `refs/` (at most 4000 entries) and, for refs in reftable, the contents of `reftable/tables.list`; `config` of `config` and `config.worktree`; `token` of those and the index, the operation's files and `FETCH_HEAD`. |

| Change | git |
| --- | --- |
| `stage` | `add --all -- <paths>` (`all`: `add --all`) |
| `unstage` | `restore --staged -- <paths>`; before the first commit `rm --cached -r -f` (the working tree keeps the files); `all`: `reset -q HEAD --` |
| `applyPatch` | `apply [--cached] [--reverse] -` with the patch on standard input |
| `discard` | `restore --worktree -- <paths>`; untracked files `clean -f -- <paths>`, which removes nothing tracked (nor a repository inside this one, which needs a second `-f`) |
| `commit` | `commit --cleanup=whitespace [--amend] [--signoff] --file=-` with the message on standard input, as typed (lines starting with `#` are kept; `--no-edit` for an amend without one) |
| `checkout` | `checkout <branch> --` or `checkout --detach <commit> --` |
| `branchCreate`, `branchRename`, `branchDelete` | `branch <name> <at>` or `checkout -b <name> <at> --`; `branch -m`; `branch -d`/`-D`, or `push <remote> --delete refs/heads/<name>` |
| `merge`, `rebase` | `merge --no-edit [--no-ff] <ref>`; `rebase <onto>` (not interactive) |
| `abort`, `continue` | `merge`, `rebase`, `cherry-pick` or `revert` with `--abort`/`--continue` |
| `cherryPick`, `revert` | `cherry-pick [--mainline N] <commit>`, `revert --no-edit [--mainline N] <commit>` |
| `reset` | `reset -q --soft`/`--mixed`/`--hard <commit> --` |
| `tagCreate`, `tagDelete` | `tag <name> <at>` or `tag --annotate --file=- <name> <at>`; `tag -d`, or `push <remote> --delete refs/tags/<name>` |
| `stashPush`, `stashApply`, `stashPop`, `stashDrop` | `stash push [--include-untracked] [--message=…]`; `stash apply`/`pop`/`drop stash@{N}` with `index` N and `hash` the entry's commit, after `rev-parse --verify stash@{N}` gave that commit (a stash pushed or dropped meanwhile renumbers them: `stale`) |
| `fetch`, `pull`, `push` | `fetch [--prune] <remote>` or `--all`; `pull` as the user's `pull.rebase` and `pull.ff` say, or `pull --rebase`; `push [--force-with-lease] [--set-upstream] <remote> refs/heads/<b>:refs/heads/<b>` or `refs/tags/<t>`, or `push` to the upstream |

**Core side.** Reads are `GET /api/m/{id}/p/git/<action>` with their
parameters in the query; changes `POST /api/m/{id}/p/git/<action>` with a
JSON body (at most 5 MiB), mutating: refused in read-only mode, audited as
`git.<action>` when it arrives and as `git.<action>.done` when it ended,
with what it acted on (`repo`, `rev`, `rev2`, `ref`, `onto`, `name`, `to`,
`at`, `remote`, `branch`, `tag`, `mode`, `op`, `hash`), the flags `force`,
`forceWithLease`, `amend` and `all`, the number of paths, `ok` and the
failure's `code`; never a patch or a message. The core forwards to the agent's `plugin` op and passes
the answer through.

**Panel** (`GitPanel.tsx`), as VS Code's Source Control view:

- The repository of the focused pane's directory (a terminal's, a VS Code
  pane's folder, the workspace's), kept while another pane (a diff, the
  graph) has the focus; a picker when the directory is in nested
  repositories. A directory in no repository is remembered until
  **Refresh**; a failure that says nothing about it (offline, busy,
  timeout) is shown and the directory asked again 10 s later. What the
  panel holds for a repository (the Amend box, the history, the stashes)
  is its own: another repository starts afresh.
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
  deleted) and stage or unstage (a rename with its old path, so its
  deletion does not stay staged); group headers stage, unstage or discard
  all: **Unstage All** and, without conflicts, **Stage All** name no paths
  (`reset`, `add --all`); with conflicts Stage All names the Changes'
  paths, so conflicts are not marked resolved. The context menu has the
  same.
- **Stashes** (apply, pop, drop), each named by its index and commit;
  none are shown when they could not be read.
- **History** (`History.tsx`), docked at the bottom of the panel as VS
  Code's Source Control Graph: its heading stays at the bottom while it is
  collapsed; expanded, the list grows upward from it, as high as its top
  edge is dragged (both kept per browser). It holds every commit of the
  branches, newest first, with the graph's lanes (as wide as the rows in
  view need), the branches and tags at each commit in their lane's color
  (the current branch filled) and how long ago it was; pages of 200 load as
  the list scrolls and only the rows in view are drawn. A page goes on
  from where the machine's pages ended and is appended without commits
  already there; when the list is read again (as many commits as were
  loaded, at most 1000), a page asked for the earlier list is dropped, and
  a page that failed stops the paging until then. A click shows the
  commit's files under it, the lanes running through (a file opens its
  diff against the first parent); the context menu copies the hash or
  opens the graph pane.
- While shown and the page visible, the panel asks `watch` every 2 s and
  reads `status` (which has the branch, upstream and ahead/behind) when
  the token moved, at least every 10 s (changes of the working tree do
  not move it), and after every change it makes; `repo` (remotes, git
  directories) first and when the configuration token moved (`state.ts`).
  A read that took over 2 s is not repeated by the polls for five times
  as long, and one that timed out (or found git busy) waits 20 s, then
  twice as long each time, at most 5 minutes; a change still reads at
  once. A change gets a read that starts after it (not one already
  running), and the tokens it sees become the polls' own. Readers follow
  what they show: the history, the graph and the stashes read again when
  the refs token moved; diffs of the working tree and the index when any
  token moved, a working tree diff also when its file's entry in the
  status (letters, modification time, size) changed; a commit's or a
  compare's diff never. Panes showing the repository share this.

**Graph pane** (`GraphPane.tsx`, `{view: {plugin: 'git', kind: 'graph',
repo}}`, one per repository, in a tab of its own: it is as wide as Git
Graph's editor; `actions.openView` with `tab`):

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
  the next page loads near the end, as the history's (a page of another
  filter's or an earlier list is dropped, none appended twice).
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
their pane, and a change of the working tree or the index opened from
Source Control takes over any such pane without unsaved edits, as VS
Code's preview editor does, so going through the changes keeps one pane):

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
  overwritten (a toast offers to load it again). Unsaved text keeps the
  size and time of the version it was edited from when the repository
  changes and the left side is read again.
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
  Before staging or discarding ranges the working tree's file is read: if
  it is no longer the version the right side was read from, nothing is
  applied and the sides are read again (with unsaved text, a toast offers
  to load it again). **Unstage File** of a rename names its old path too.
- When the repository changes (see the panel's polls), both sides are
  read again; unsaved text stays. Only the latest read is shown: an
  earlier one (another file's after a quick switch) is dropped.
- Unsaved text also stays while the pane is not drawn (another tab,
  workspace or machine shown, another pane zoomed): closing asks about it,
  Save saves it against the file as it was when the edits began, and the
  pane takes it back when drawn again ([27](27-plugins.md)).

**Colors**: lanes take the design tokens' chart hues (`--ds-chart-*`, in
an order that keeps neighbors apart), status letters and names VS Code's
Git decoration colors (`--ds-git-*`), additions and deletions of a diff's
counts the same added and deleted colors, an operation in progress
(merge, rebase) a warning bar ([24](24-design-tokens.md)).

**File explorer decorations** (`decorations.ts`, `follow.ts`): the
explorer colors the changed files of the repositories followed (conflicts,
deletions, modifications, renames, additions, untracked) with their letter,
and their folders with the most pressing change inside, in VS Code's Git
decoration colors (`--ds-git-*`, [24](24-design-tokens.md)). Besides the
panel's and the panes' repositories, the plugin follows those of the
directories the explorer shows while it is open (its root and the expanded
ones; [28](28-file-explorer.md)): the repository of a directory is asked
once (`repo`) and remembered, a directory in none for a minute (a failure
that says nothing about it is not remembered: the directory is asked
again 10 s later while shown), and each is watched as the panel's are
while a directory of it is shown and the plugin is on (turning it off
stops these watches, on starts them again).

**Quick diff** (`follow.ts`): the plugin gives the file explorer's editor
the index's text of a file (`blob` with `source=index`), read again when
the index or HEAD changed (any watch token moved), so the editor's gutter
marks the lines that differ
from it, as VS Code's; untracked files have none. The repository of a file
an editor shows is watched while it is shown. **Open Changes** opens the
file's working tree diff.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A library (go-git, libgit2) on machines instead of the executable | The agent would carry another implementation of git with its own gaps (hooks, credential helpers, worktrees, config); the user's git is what their terminals use. |
| A generic "run git with these arguments" route | Every request could pass options (`--upload-pack`, `-c`, `--exec`) that run programs; actions with argument vectors built on the machine keep what runs in the agent's code. |
| Pushing changes from a watcher on machines | A watcher per repository needs an owner and limits; one stat of a few files every 2 s while the panel is shown costs less and stops with it. |
| Typing credentials into the UI | Passwords and passphrases would cross the core; the terminal next to the panel is where git can ask. |
| Using VS Code's Source Control and Git Graph only | They stay ([05](05-vscode-panes.md)); code-server per machine is slow to start and large for a look at a diff. |
| The latest commits only in the panel, the rest in the graph pane | Looking back a little further meant leaving the panel; the history docked at the bottom scrolls through every commit and the graph pane stays for filters, search and comparisons. |
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
- A pull into a branch that diverged from its upstream, without
  `pull.rebase` or `pull.ff` in git's configuration: `diverged`, and the
  toast says to use Pull (Rebase) or set one; with one set, the pull does
  what it says.
- git hanging (a hook, a slow remote): killed after its timeout
  (`timeout`); when the browser goes away the core closes the stream and
  the agent kills it.
- A repository whose status is slow (a very large working tree): the polls
  read it less often (five times as long as it took; after a timeout 20 s,
  doubling up to 5 minutes) instead of every 10 s.
- Many runs at once (several pages, a slow remote): beyond 8 a run waits
  up to 3 s, then fails with `busy` and the panel's next poll tries again.
- Many paths (Discard All of thousands of files): split over runs of git;
  a run that fails ends the change, the runs before it stay done.
- A stash pushed or dropped elsewhere after the list was read: the
  action fails with `stale` and acts on nothing; the list is read again.
- An untracked repository inside this one (listed as `dir/`): it can be
  staged (as git adds one, a gitlink) and unstaged; discarding it deletes
  nothing (`git clean -f` skips repositories).
- A hook that leaves a program in the background holding git's output:
  the run ends 2 s after git exited, with git's result.
- A patch that no longer applies (the file changed after the diff loaded):
  `git_failed` with git's message; the pane reads both sides again.
- Machine offline: requests fail with `offline`; the panel shows the error
  and the polls try again (a directory whose repository was being asked
  is asked again 10 s later, not taken as outside repositories).
- An older agent during an upgrade: actions fail with `unknown_plugin`.
- The plugin turned off: its routes answer `404 plugin_disabled`, the panel
  is gone and its panes say the plugin is off.

## Security

git runs with the user's permissions in their repositories, as in a
terminal; what the plugin adds is a way to reach it from the browser:

- Fixed argument vectors per action, no shell, no option from the request;
  paths after `--` and literal (`:(literal)` per path); revisions and
  names checked (no leading `-`, no special characters, existing refs and
  remotes resolved, new names through `check-ref-format`).
  `TestArgvRefusesOptions` holds injections (`--upload-pack=…`, `--exec=…`,
  `-f`, `..`) refused.
- No credential prompts: no terminal, no askpass programs, `GIT_TERMINAL_PROMPT=0`;
  a fetch, pull or push that needs credentials fails (`auth_required`).
- Every change is a mutating route: refused in read-only mode, audited as
  `git.<action>` and `git.<action>.done` (its targets and flags, never its
  patch or message), behind the core's Origin/Host checks; reads change
  nothing (`GIT_OPTIONAL_LOCKS=0`) and run no file system monitor, textconv
  driver or maintenance from the repository's configuration; its clean
  filters, like a shell prompt's `git status`, still run (also for a
  read-only viewer).
- The working tree's files are read inside the repository only: a
  directory link out of it is not followed, the file is opened without
  following a link or blocking on a FIFO.
- Bounded: timeouts with the process group killed, at most 8 runs at once,
  output, files, patches and messages capped.

## Testing

- `internal/agent/plugin/git/git_test.go` (HOME in a temporary directory,
  user name and e-mail set in each repository):
  name and path checks (a trailing `/` kept), options refused in every
  change's arguments, each read on a repository with a merge, a rename, a
  tag, a stash, staged, modified, untracked and binary files; a conflict
  (state, unmerged status, abort), a detached HEAD, a linked worktree
  (`.git` file, `watch`), nested repositories, one without commits
  (unstaging a file changed after it was staged) and an untracked one
  inside another (`dir/` staged, unstaged, not deleted); the log on a
  branch without commits (`TestLogUnbornBranch`); a top level through a
  link (`TestLogicalRoot`); the watch's tokens, also with refs in reftable
  (`TestWatch`); the status's times and sizes (`TestStatusStamps`); each
  change (patches with `--cached` and `--reverse`, discards, unstaging a
  rename with both paths, commits with the message on standard input and
  lines starting with `#` kept, branches, tags, stashes named by their
  commit and `stale` after the list changed, cherry-pick, revert, merge,
  reset, rebase); thousands of paths over several runs (`TestPathRuns`,
  `TestManyPaths`); push, fetch and pull with a bare repository, a pull of
  diverged branches (`diverged`, then rebased by `pull.rebase`); a remote
  that asks for a password (`auth_required`); timeouts and output limits
  with a fake git, a background child holding git's output (also one in a
  session of its own), the limit of runs (`busy`), runs that cannot start
  (`TestStartError`); the environment; reads with a file system monitor
  and a textconv driver configured (`TestReadsRunNoMonitor`); a link to `/`
  in the working tree (`TestWorktreeBlobLinks`); literal paths, and a
  pre-commit hook whose glob pathspecs match (`TestLiteralPaths`); the
  shared range patches applied with `git apply`.
- `internal/agent/plugins_git_test.go`: the core's routes are the agent's
  actions, reads as reads.
- `internal/plugins/git/git_test.go`: routes (reads GET, changes mutating
  and audited), the read's query, a change's audit record
  (`TestChangeAudit`); `TestMutatingRoutesAreGuarded`
  (`internal/server`) checks them.
- `design/testdata/git/range-patches.json`: range patches (additions,
  deletions, parts of changes, ranges over several hunks, unstaging,
  discarding, the last line without a newline), run by
  `web/src/__tests__/gitPatch.test.ts` and applied with git by the Go test.
- `web/src/__tests__/gitGraph.test.ts`: lanes (linear, branch and merge,
  octopus, parallel branches, reused lanes, parents off the page, joins),
  rows with the working tree and stashes, badges, search, pages appended
  without commits already there.
- `web/src/__tests__/gitPanel.test.ts`, `gitGraphPane.test.ts`,
  `gitDiff.test.ts` (Monaco replaced): groups and tree, decorations, the
  panel's actions (Stage All and Unstage All without paths, with
  conflicts by paths, a rename unstaged with its old path, stashes by
  their commit) and commit box, the Amend box per repository, read-only
  mode, a history page of an earlier list dropped; the graph's rows,
  details, compare and menus, a page of another filter dropped; the diff's
  sides per mode, range patches sent, saves (also of unsaved text after
  the repository changed, against the version it was edited from), a fast
  switch of files, a file edited again read again, ranges not applied to
  a file changed on disk.
- `web/src/__tests__/gitState.test.ts` (time faked): which reads the
  watch's tokens start (the status, the info, the diffs' and the log's
  versions), backing off after timeouts, a change's read starting after
  it, failures not remembered as "no repository" (the panel's and the
  explorer's), the explorer's watches stopped while the plugin is off.

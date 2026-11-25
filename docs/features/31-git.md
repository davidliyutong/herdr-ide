# 31 · Git

## Context

Coding agents change repositories all day; reviewing what they changed, staging part of it, committing and switching branches is most of the review. VS Code panes ([05](05-vscode-panes.md)) have Source Control and Git Graph, but code-server is slow to start on each machine and takes a pane's worth of room. The plugin sidebar ([27](27-plugins.md)) has room for a Source Control view, and Monaco ([28](28-file-explorer.md)) brings VS Code's diff editor into a pane.

## Goals / non-goals

Goals: VS Code's Source Control and the Git Graph extension in one, for the repository of the focused pane's directory on any machine:

- branch with ahead/behind, a searchable branch picker, fetch/pull/push with one or several remotes;
- staging, unstaging and discarding files and selected ranges; commits (amend);
- a graph of all or chosen branches with badges, search, commit details, comparisons and Git Graph's context menu actions (checkout, branches, tags, merge, rebase, cherry-pick, revert, reset, stashes);
- diffs in Monaco with the working tree editable, files with mixed line endings kept intact;
- Git colors in the file explorer.

Non-goals: interactive rebase, three-way conflict resolution (conflicted files open in the diff pane and the editor), credentials typed in the UI (git uses its own credential helpers, SSH keys and agents), submodule management, blame, line history.

## Design

**Plugin** `git`, on by default (`plugins.git.enabled`): a right-sidebar panel (**Show Source Control**, `view.panel.git`, Ctrl+Shift+G in the desktop app), the pane kinds `graph` and `diff`, and **Show Git Graph** (`git.graph`). Code: `web/src/plugins/git`, `backend/features/git` (hub), `backend/features/git/machine.ts` (machine).

### Machine side

Every action runs the `git` executable with an argument vector the agent builds: no shell and no option taken from the request. A library (go-git, libgit2) was rejected: the user's git is what their terminals use, with its hooks, credential helpers, worktrees and configuration.

- **Repository and paths.** Actions name the repository's top level (`repo` finds it from a directory, with the repositories it is nested in, `parents`, and the submodules and repositories nested inside it, `nested`, by a bounded breadth-first scan that follows no links and skips `node_modules`); others refuse a directory without `.git` (`not_a_repo`). A top level reached through a directory link keeps that spelling, as the explorer shows it. Paths are relative to the top level, without `.` or `..`, come after `--`, and are literal per path (`:(literal)`, not `GIT_LITERAL_PATHSPECS`, which hooks would inherit). Many paths are split over several runs of at most 96 KiB of arguments; a change takes at most 20 000 paths.
- **Revisions and names** never start with `-` and contain none of git's special characters; a revision is a hash or a name that resolves to a commit, existing refs must exist (`show-ref --verify`), new names pass `check-ref-format`, a remote must be one of `git remote`'s.
- **Environment**: the agent's, without `GIT_*` variables except `GIT_SSH*`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (so nothing points git at another repository, configuration or program), without `SSH_ASKPASS` and the locale; with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`, `GIT_EDITOR=true` and `GIT_SEQUENCE_EDITOR=true` (default messages), `GIT_PAGER=cat`, `GIT_MERGE_AUTOEDIT=no`, and `GIT_OPTIONAL_LOCKS=0` for reads. git runs in a session of its own with no terminal, so a fetch, pull or push that needs credentials fails (`auth_required`) and the UI says to run it in a terminal.
- **Configuration**: every run sets `gc.autoDetach=false` and `maintenance.autoDetach=false`, so maintenance a change starts stays in the run's process group and timeout. Reads also disable the file system monitor, the untracked cache and automatic maintenance, and diff with `--no-ext-diff --no-textconv`. Clean filters still run when `status` compares a changed file, as a shell prompt's `git status` does.
- **Bounds**: reads 15 s, changes 120 s; then, or when the hub closes the request's stream, git's process group is killed. A run whose git exited while a background child still holds its output ends 2 s later. At most 8 runs per machine; another waits up to 3 s, then fails with `busy`. Output 32 MiB per run, files 8 MiB, status 20 000 entries, patches and messages 4 MiB.
- **Failure codes**: `git_missing`, `not_a_repo`, `bad_ref`, `bad_params`, `not_found`, `auth_required`, `conflicts`, `diverged` (pull into a diverged branch without `pull.rebase`/`pull.ff`), `stale` (a stash entry renumbered since it was listed), `timeout`, `too_large`, `busy`, `failed` (git did not start), `git_failed` with git's message.

Reads:

| Read | Answers |
| --- | --- |
| `repo` | Top level, git directories, branch and HEAD, upstream with ahead/behind, an operation in progress, remotes with fetch URLs (user information, query and fragment stripped, since tokens live there), enclosing (`parents`) and nested repositories or submodules (`nested`). |
| `status` | `status --porcelain=v2 --untracked-files=all --ignored=matching`: changes, renames, conflicts, branch and upstream; ignored paths apart (an ignored directory as one entry, at most 20 000); `lstat` size and time of changed files so a re-edit is noticed. git before 2.16 is asked without `--ignored=matching`. |
| `log` | `log --date-order` of branches, tags and HEAD (optionally remote branches, or named refs), pages of up to 1000; with the first page the refs, stashes and HEAD. |
| `show` | A commit's message and files against a parent, or the files between two commits. |
| `blob` | A file at the working tree, index, HEAD or a revision; `binary` and `tooLarge` (8 MiB) flags. The working tree is read inside the repository only: no link out of it, no FIFOs or devices. |
| `branches`, `tags`, `stashes` | With last commits, upstreams and ahead/behind (up to 300 tracked branches). |
| `diffStat` | Lines added and deleted per file. |
| `watch` | Tokens from stats of the git directory (HEAD, refs, packed refs, reftable list, index, config, operation files, `FETCH_HEAD`), found without running git. |

Changes:

| Change | git |
| --- | --- |
| `stage`, `unstage` | `add --all` (or `--update`) / `restore --staged` (`rm --cached` before the first commit, `reset` for all) |
| `applyPatch` | `apply [--cached] [--reverse] -`, the patch on standard input |
| `discard` | `restore --worktree`; untracked files `clean -f` (never a nested repository) |
| `commit` | `commit --cleanup=whitespace [--amend] [--signoff] --file=-` |
| `checkout`, `branch*`, `tag*` | checkout a branch or detached; create, rename, delete (also on a remote) |
| `merge`, `rebase`, `cherryPick`, `revert`, `reset`, `abort`, `continue` | non-interactive forms |
| `stash*` | push, apply, pop, drop; an entry is named by index and commit, checked before acting (`stale`) |
| `fetch`, `pull`, `push` | to a named remote and `refs/heads/<b>` or the upstream; `--prune`, `--rebase`, `--force-with-lease`, `--set-upstream` |

A generic "run git with these arguments" route was rejected: options such as `--upload-pack`, `-c` or `--exec` run programs. Building the vector on the machine keeps what runs in the agent's code.

### Hub side

Reads are `GET /api/m/{id}/p/git/<action>`; changes are `POST /api/m/{id}/p/git/<action>` with a JSON body (at most 5 MiB). Changes are mutating routes: refused in read-only mode and audited as `git.<action>` and `git.<action>.done` with their targets, flags, path count and result, never a patch or a message. The hub forwards to the agent's `plugin` op.

### Panel

`GitPanel.tsx`, laid out as VS Code's Source Control view.

- **Which repository.** The one of the focused pane's directory (a terminal's, a VS Code folder, an editor's or preview's file, a diff's or the graph's repository), kept while a pane without a directory has the focus in the same workspace and machine (`gitRecentDir`); a picker when repositories are nested, whose submodule and nested rows offer **Open Repository**. A `cd` inside the repository changes nothing. The panel never shows another machine's or workspace's repository, and never asks one machine about another's directory. What it shows (selection, collapsed folders, draft message, Amend, scroll positions, the opened commit) is kept per repository in page memory (`memory.ts`) and restored.
- **Sync.** The branch button opens the branch picker (`pickers.tsx`: branches with upstream state, remote branches, tags, create and detach entries). Sync, Publish, Pull, Push, Fetch and their *From…/To…* variants: nothing picks a remote silently; without an upstream the user picks one when there are several. `git.confirmSync` asks before pulling or pushing. A **Remotes** section lists remotes with redacted URLs.
- **Automatic fetch** (`git.autoFetch` minutes, 0 by default) fetches all remotes while the panel shows the repository, the page is visible and the UI is not read-only. It is off by default because a fetch runs the programs the repository's configuration names (`core.sshCommand`, `uploadpack`, credential helpers) without a click.
- **Changes.** Merge, Staged, Changes and (with `git.untrackedChanges` = `separate`) Untracked sections, as a list or tree (`git.changesView`), drawn and navigated like the file explorer's rows (multi-selection, keys, type-ahead) and with its file context menu entries. Actions apply to the selection. Stage All and Unstage All name no paths, except with conflicts, where Stage All names the changed paths so conflicts are not marked resolved. Discarding asks first, then closes the panes showing those files, asking about unsaved text first.
- A banner with Abort and Continue during a merge, rebase, cherry-pick or revert; a commit box (Cmd/Ctrl+Enter, Amend); a **Stashes** section.
- **History**, docked at the bottom like VS Code's Source Control Graph: every commit with lanes and badges, paged as it scrolls, a click shows the commit's files.

**Refresh.** A watcher on the machine was rejected: it needs an owner, limits and an inotify watch per directory. Instead, while something shows the repository and the page is visible, the page polls `watch` (a few stats) and reads `status` when a token moved, and at least every 10 s (working tree edits do not move tokens). For 30 s after activity (a token moved, a UI change, input in the page, a terminal in the repository ending a command or an agent turn) the pace is 1 s for `watch` and 2 s for `status`; a terminal event or the page regaining focus triggers a read 250 ms later. Each read delays the next poll by five times its duration; timeouts back off from 20 s to 5 minutes. Views re-read only what they depend on (refs token → history, graph, stashes; any token or the file's status entry → working tree diffs). Constants: `state.ts`.

### Graph pane

`GraphPane.tsx`, one per repository in a tab of its own.

- Lanes are computed in the browser by a pure function (`graph.ts`): filters and pages change in the browser, and a pure function is testable with vectors. Commits in date order, first parent continues the lane, freed lanes are reused, eight colors.
- Rows: working tree changes on top, commits, stashes above their first older commit; badges for branches, remote branches, tags and a detached HEAD; paged by `git.graphPageSize` (300).
- Search dims what does not match. A branch filter (several refs by full name, at most 100, kept per repository in the browser) limits the log.
- A click opens the commit's details (`GraphDetail.tsx`); Cmd/Ctrl-click compares two commits. Context menus for commits, branches, remote branches, tags and stashes carry Git Graph's actions; a reset asks first, and deleting an unmerged branch asks again before forcing.

### Diff pane

`DiffPane.tsx`. Diffs open as tabs of the workspace; one opened from Source Control replaces another unedited diff, as VS Code's preview editor does.

| Mode | Left | Right |
| --- | --- | --- |
| `worktree` | index (HEAD for a conflict, empty for untracked) | working tree, editable |
| `staged` | HEAD | index |
| `commit` | parent | commit |
| `compare` | one commit | another |

- Monaco's diff editor, side by side or inline. Binary files and files over 8 MiB are not shown.
- The working tree side saves through the file explorer's write with the size and modification time `blob` returned, so a file changed meanwhile is never overwritten. Unsaved text survives re-reads and the pane being hidden ([27](27-plugins.md)).
- **Stage/Unstage/Discard Selected Ranges** build a unified patch (`patch.ts`) from the line changes the selection touches and send it to `applyPatch`; context lines come from the side the patch applies to. Before applying, the file is re-read; if it changed, nothing is applied.
- **Mixed line endings.** Monaco gives a model one line ending, so saves and patches would rewrite lines. `git.mixedLineEndings` (shared with the explorer's editor):
  - `keep` (default): a save keeps each line's own ending (`web/src/eol.ts`, a line diff against the text as read); range patches are built from the bytes. Files with lone CRs get whole-file staging only.
  - `unify`: Monaco's behavior; patches may not apply.
  - `readOnly`: the working tree side is read-only, whole-file staging only.

### Settings and colors

Settings › Plugins › Git (`backend/features/git/settings.ts`): `git.mixedLineEndings`, `git.changesView`, `git.untrackedChanges`, `git.autoFetch`, `git.confirmSync`, `git.graphPageSize`. See [reference.md](../reference.md) for values.

Lanes use the chart hues, status letters VS Code's Git decoration colors (`--ds-git-*`), an operation in progress a warning bar ([24](24-design-tokens.md)).

### File explorer integration

- **Decorations** (`decorations.ts`, `follow.ts`): changed files and their folders in Git colors; ignored paths muted; the `.git` directory, which git never lists, uncolored as in VS Code. The plugin follows the repositories of the directories the explorer shows and watches them as the panel does while shown and while the plugin is on.
- **Quick diff**: the editor's gutter marks lines that differ from the index (`blob` with `source=index`); **Open Changes** opens the working tree diff.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| go-git or libgit2 on machines | Another git with its own gaps (hooks, credential helpers, worktrees, config); the user's git is what their terminals use. |
| A generic "run git with these arguments" route | Options (`--upload-pack`, `-c`, `--exec`) run programs; argument vectors built on the machine keep what runs in the agent's code. |
| A watcher on machines pushing changes | Needs an owner, limits and an inotify watch per directory; a few stats per second while shown stop with the view, and terminal events say when to look at once. |
| Credentials typed into the UI | Secrets would cross the hub; the terminal next to the panel is where git can ask. |
| VS Code's Source Control and Git Graph only | They stay ([05](05-vscode-panes.md)), but code-server is slow and large for a look at a diff. |
| Lanes computed on the machine | Filters and pages change in the browser; a pure function there is testable with vectors. |

## Failure modes

- No git: `git_missing`, the panel says so.
- Credentials missing: `auth_required`; the toast says to run the command in a terminal.
- Conflicts: `conflicts`; files appear under Merge Changes and the banner offers Abort and Continue.
- Diverged pull without `pull.rebase`/`pull.ff`: `diverged`; the toast suggests Pull (Rebase).
- A hanging git (hook, slow remote): killed at its timeout or when the browser goes away.
- Slow status on a huge tree: the polls back off instead of piling up.
- More than 20 000 ignored files: the rest are not muted. git before 2.16: nothing is muted.
- Many paths: split over runs; a failing run ends the change, earlier runs stay done.
- A patch that no longer applies: `git_failed`; both sides are re-read.
- Machine offline: requests fail with `offline` and the polls retry; a failure is never remembered as "no repository".
- Older agent during an upgrade: `unknown_plugin`. Plugin off: `404 plugin_disabled`.

## Security

git runs with the user's permissions in their repositories, as in a terminal; the plugin adds a way to reach it from the browser:

- Fixed argument vectors per action, no shell, no option from the request; literal paths after `--`; revisions, names and remotes checked (`TestArgvRefusesOptions`).
- No credential prompts: no terminal, no askpass, `GIT_TERMINAL_PROMPT=0`.
- Changes are mutating routes: refused in read-only mode, audited without patch or message, behind the hub's Origin/Host checks.
- Reads change nothing (`GIT_OPTIONAL_LOCKS=0`) and run no fsmonitor hook, textconv driver or maintenance from the repository's configuration; clean filters still run, as with a shell prompt's `git status`, also for a read-only viewer.
- `git.autoFetch` (off by default, never in read-only mode) fetches without a click, running the programs the repository's configuration names for a fetch.
- Working tree files are read inside the repository only, without following links out of it or blocking on a FIFO.
- Bounded: timeouts kill the process group, at most 8 runs at once, output and inputs capped.

## Testing

- `backend/features/git/machine.test.ts`, `machine/check.test.ts`, `machine/run.test.ts`: argument checks and refused options, every read and change against real repositories (merges, renames, conflicts, worktrees, nested repositories and submodules (bounded scan, no links followed), unborn repositories, reftable, stashes), remotes with a bare repository (URL redaction, `diverged`, `auth_required`), timeouts, output limits (a single read that crosses the limit keeps its prefix) and `busy` with a fake git, literal paths with hooks, reads with a monitor and textconv configured, ignored paths.
- `backend/features/git/git.test.ts`: routes, audit records (`change audit`), settings, the guards (`checkGuarded`).
- `spec/vectors/git/range-patches.json`: range patch vectors, run by `web/src/__tests__/gitPatch.test.ts` and applied with git by `backend/features/git/machine.test.ts`.
- Web: `gitGraph.test.ts` (lanes, rows, pages), `gitPanel.test.ts`, `gitGraphPane.test.ts`, `gitDiff.test.ts` (panel actions, pickers, remotes, graph menus and filter, diff modes, saves, mixed line endings), `eol.test.ts`, `gitDiscard.test.ts`, `gitState.test.ts` (poll pace and back-off), `gitPanelMemory.test.ts` (which repository is shown, restored view state).

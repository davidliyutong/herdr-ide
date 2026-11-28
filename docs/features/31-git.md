# 31 · Git

## Context

Reviewing what coding agents changed, staging part of it, committing and switching branches is most of the review. VS Code panes ([05](05-vscode-panes.md)) have Source Control and Git Graph, but code-server is slow to start and takes a pane's room; the plugin sidebar ([27](27-plugins.md)) and Monaco's diff editor ([28](28-file-explorer.md)) do it lighter.

## Goals / non-goals

Goals: VS Code's Source Control and the Git Graph extension in one, for the repository of the focused pane's directory on any machine: branches, fetch/pull/push, staging and discarding files and selected ranges, commits, a graph with Git Graph's actions (merge, rebase, cherry-pick, revert, reset, tags, stashes), diffs in Monaco with the working tree editable, Git colors in the file explorer.

Non-goals: interactive rebase, three-way conflict resolution, credentials typed in the UI, submodule management, blame.

## Design

Plugin `git`, on by default: a right-sidebar panel (`view.panel.git`), the pane kinds `graph` (`git.graph`) and `diff`. Code: `web/src/plugins/git`, `backend/features/git/hub.ts`, `backend/features/git/machine.ts` and `machine/`. Settings (`git.*`) and the reads and changes are listed in [reference.md](../reference.md).

### Machine side

- Every action runs the user's `git` (`machine/run.ts`), whose hooks, credential helpers and configuration their terminals use, with an argument vector the agent builds: no shell, no option from the request. Paths come after `--` as literal pathspecs (`:(literal)`, not `GIT_LITERAL_PATHSPECS`, which hooks would inherit); revisions, ref names and remotes are checked (`machine/check.ts`).
- The environment drops `GIT_*` variables (except ssh and author/committer ones) and askpass, so nothing points git at another repository, configuration or program. git runs without a terminal and `GIT_TERMINAL_PROMPT=0`, so an action that needs credentials fails with `auth_required` and the UI says to run it in a terminal.
- Reads change nothing (`GIT_OPTIONAL_LOCKS=0`) and run no file system monitor, textconv, external diff or maintenance; clean filters still run, as with a shell prompt's `git status`. `blob` reads the working tree inside the repository only. `watch` returns tokens from stats of the git directory, without running git.
- Bounds: a timeout per run (process group killed then, or when the hub closes the request), a limit of runs per machine (`busy`), capped output and inputs.

### Hub side

Reads are `GET /api/m/{id}/p/git/<action>`, changes `POST` with a JSON body, forwarded to the agent's `plugin` op. Changes are mutating routes, refused read-only and audited as `git.<action>` and `git.<action>.done` with targets and path count, never a patch or message. Identical reads within a short time share one run; any change through the hub drops them.

### Panel

`GitPanel.tsx`, laid out as VS Code's Source Control view.

- The repository is the focused pane's directory's, kept while a pane without one has the focus; a picker when repositories are nested; never another machine's or workspace's. View state is kept per repository (`memory.ts`).
- Sync, Pull, Push and Fetch never pick a remote silently. `git.autoFetch` is off by default because a fetch runs programs the repository's configuration names without a click.
- Stage, unstage and discard update optimistically, serialized per repository and reconciled with `status`; Stage All names the changed paths when there are conflicts, so conflicts are not marked resolved. Discarding asks, then closes panes showing those files.
- Refresh (`state.ts`), without a watcher on the machine: while the repository is shown and the page visible, the page polls `watch`, reads `status` when a token moved and at least periodically (working tree edits move none); activity, including a terminal there ending a command or an agent turn, speeds it up, slow reads push it apart.

### Graph and diff panes

- `GraphPane.tsx`: lanes computed in the browser by a pure function (`graph.ts`), since filters and pages change there, testable on its own (`gitGraph.test.ts`); paged commits with badges, search, a branch filter, details (`GraphDetail.tsx`), comparisons and Git Graph's context menus.
- `DiffPane.tsx`: Monaco's diff editor in modes `worktree` (editable), `staged`, `commit` and `compare`. The working tree side saves through the file explorer's write with the size and time `blob` returned, so a file changed meanwhile is never overwritten. Selected ranges become a unified patch (`patch.ts`) for `applyPatch`, applied only if the file is unchanged.
- `git.mixedLineEndings` (shared with the explorer's editor): `keep` saves each line with its own ending (`web/src/eol.ts`) and builds range patches from the bytes; `unify` is Monaco's behavior; `readOnly` locks the working tree side.
- The explorer's colors (`decorations.ts`, `follow.ts`) cover the repositories of the directories it shows; its editor's quick diff compares with the index.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| go-git or libgit2 on machines | Another git with its own gaps (hooks, credential helpers, worktrees, config). |
| A generic "run git with these arguments" route | Options such as `--upload-pack`, `-c` or `--exec` run programs. |
| A watcher on machines pushing changes | Needs an owner and limits; polling stops with the view, terminal events say when to look. |
| Credentials typed into the UI | Secrets would cross the hub; the terminal beside the panel is where git can ask. |

## Failure modes

- No git: `git_missing`. Missing credentials: `auth_required`. Diverged pull: `diverged`, the toast suggests Pull (Rebase).
- Conflicts: files under Merge Changes, a banner offers Abort and Continue.
- A hanging git (hook, slow remote): killed at its timeout or when the browser goes away; slow status backs the polls off.
- A range patch git refuses: `git_failed`, both sides re-read.
- Machine offline: polls retry; a failure is never remembered as "no repository".

## Security

git runs with the user's permissions, as in a terminal; [SECURITY.md](../../SECURITY.md) ("Git from the browser") lists the guardrails above: fixed argument vectors, literal paths, checked names, no prompts, audited mutating routes, reads that run nothing the repository configures except clean filters (also for a read-only viewer), bounds. `git.autoFetch` is the one way a fetch's configured programs run without a click.

## Testing

- `backend/features/git/machine.test.ts`, `machine/check.test.ts`, `machine/run.test.ts`: argument checks, every action against real repositories, a fake git for timeouts and limits, hooks, monitor and textconv configuration.
- `backend/features/git/git.test.ts`: routes, audit, guards.
- `spec/vectors/git/range-patches.json`, run by `web/src/__tests__/gitPatch.test.ts` and applied with git by `machine.test.ts`; `web/src/__tests__/git*.test.ts`, `eol.test.ts`.

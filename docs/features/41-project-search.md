# 41 · Project Search

## Context

Finding where a name is used across a project otherwise takes a VS Code pane or `grep -rn` in a terminal; the file explorer ([28](28-file-explorer.md)) filters names, not contents. The files are on remote machines, so the search runs there and only its result crosses the ssh link.

## Goals / non-goals

- A **Search** panel in the right sidebar, as VS Code's search view: Match Case, Match Whole Word, regular expressions, include and exclude globs, results by file opening at the match; the folder follows the focused pane, as the explorer's and the Git panel's do, or is typed in.
- Fast with ripgrep, working without it; bounded in time, matches and result size; never writing on the machine.
- Non-goals: replacing across files, searching file names, indexing, several machines at once, multi-line matches.

## Design

Plugin `search`: `web/src/plugins/search`, `backend/features/search/hub.ts` (`POST /api/m/{id}/p/search/search`, [reference.md](../reference.md#plugins)), `backend/features/search/machine.ts` and `machine/`.

### Machine side

The action `search` checks its parameters (`dir` expanded as the explorer's paths are) and runs one of two engines with the same result shape:

- **ripgrep** (`machine/rg.ts`): `rg` on the agent's `PATH`, else the copy a code-server the agent installed ships. It runs with `--json --no-config`, the query after `--`, globs as `--glob=<value>`, in a session of its own whose process group is killed when the search ends; it respects ignore files, skips binary files and follows no links.
- **The walker** (`machine/walk.ts`) otherwise: regular files up to a size limit, opened without blocking, binary ones skipped, no links followed; the query is a regular expression in RE2's syntax (re2js; ripgrep's own engine is of the same family: no backreferences or lookaround, which are refused as `bad_regex`) or quoted text, matched in time linear in the text, as are the include and exclude globs, so no query or pattern can stall the node; only the top-level `.gitignore` is honored.

Both skip version control folders and `node_modules` and read globs alike (`machine/glob.ts`). A result lists files by path with their matching lines, a bounded preview and match ranges in UTF-16 code units, as Monaco counts them (`machine/excerpt.ts`). A search stops at `maxResults` matches, a time limit or (the walker) a number of files, answering what it found with `truncated`, `reason` and the `engine` that ran. Searches per machine are limited (`busy` beyond); closing the hub's stream stops one.

The hub's route only reads: it is not mutating, so read-only mode searches and nothing is audited. A search the machine does not answer in time is `504 timeout`.

### Web UI

`SearchPanel.tsx` searches after a pause in typing, at once on Enter, and each new search aborts the one in flight (`state.ts`), so only the last answer is shown. The folder comes from the explorer's `followedDir` and `recentDirectory`. Results are windowed tree rows (`components/tree/TreeRow`); the status line gives counts, why the search stopped early and the engine. Opening a line (`openMatch`) goes through `actions.openPath`, as a terminal's path does ([06](06-quick-look-and-files.md)): by default the explorer's editor at the line and column.

## Alternatives considered

- **`grep -rn` or `git grep`**: `grep` differs between GNU and BSD and has no structured output; `git grep` only searches repositories.
- **Downloading ripgrep to machines**: another pinned artifact per platform for a tool many machines have; the walker covers the rest and says so.
- **Streaming results**: a bounded JSON result arrives within the search's time.

## Failure modes

- No ripgrep: the walker runs and the status line says so (large files and nested `.gitignore` files are not taken into account).
- A slow tree or too many matches: what was found is shown, marked incomplete.
- A refused regular expression or glob (`bad_regex`, `bad_glob`), or a folder that is not there: the message is shown, nothing searched.
- Machine offline or not answering, or too many searches: `offline`, `timeout` or `busy`, shown as messages.

## Security

A search reads what the agent's user can read and writes nothing. ripgrep runs without a shell, with the query and patterns as values, never options, and without a configuration file (`--no-config`, `RIPGREP_CONFIG_PATH` removed), so no preprocessor (`--pre`) or other option comes from the request or the machine. The walker, which runs in the node that serves the terminals, matches queries and globs with RE2 (re2js), in linear time: a read-only user's search cannot hold its thread. See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/search/machine.test.ts`: the same searches with the walker and, where `rg` is installed, ripgrep; recorded `--json` output; globs, previews, limits, parameter checks; expressions and globs that backtrack catastrophically in JavaScript finish quickly in the walker, and backreferences and lookaround are refused.
- `backend/features/search/search.test.ts`: the route, read-only, an offline machine, the timeout.
- `web/src/__tests__/search.test.ts` (rows, params, the followed folder, aborting, opening a match); `filesEditor.test.ts` (the editor at the requested line).

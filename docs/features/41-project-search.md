# 41 · Project Search

## Context

Finding where a name is used across a project meant opening a VS Code pane
(off by default, a code-server per machine) or typing `grep -rn` in a
terminal and copying paths out of its output. The file explorer
([28](28-file-explorer.md)) filters the names it shows, not what files
hold. The machines are remote: the search has to run where the files are,
and only its result crosses the ssh link.

## Goals / non-goals

- A **Search** panel in the right sidebar, as VS Code's search view: a
  query with Match Case, Match Whole Word and Use Regular Expression; files
  to include and to exclude as comma-separated globs; the results by file
  with each matching line and its matches marked; a click (or Enter) opens
  the file at the match's line and column.
- The folder searched follows the focused terminal or VS Code pane, as the
  file explorer and the Git panel do, and can be typed in instead.
- Fast on large trees where the machine has ripgrep; working without it.
- Bounded: a search ends after a time limit, stops after a number of
  matches, and returns a result of bounded size; it never writes on the
  machine.
- Non-goals: replacing text across files (VS Code panes do that), searching
  file names (the explorer's filter and VS Code's Quick Open), indexing,
  searching several machines at once, multi-line matches.

## Design

### Machine side (`internal/agent/plugin/search`)

The plugin `search` has one action, `search`, with `dir`, `query`, `regex`,
`caseSensitive`, `wholeWord`, `include`, `exclude` and `maxResults`
(`internal/agent/plugins_search.go` registers it). `dir` is expanded as the
explorer's paths are (`~`, relative to home) and must be a directory
(`not_found`, `not_dir`, `denied`); the query is one line of 1 to 2000
bytes; the patterns at most 4000 bytes, 100 of each.

Two engines give the same result shape:

- **ripgrep** when the machine has it: `rg` on the agent's `PATH`, else the
  copy a code-server the agent installed ships
  (`~/.<slug>/code-server/<version>/lib/vscode/node_modules/@vscode/ripgrep-universal/bin/<os>-<arch>/rg`
  or `@vscode/ripgrep/bin/rg`, the newest version first). It runs with
  `--json --no-config --hidden --max-filesize 4M`, `--ignore-case` or
  `--case-sensitive`, `--fixed-strings` unless the query is a regular
  expression, `--word-regexp` for whole words, the globs as `--glob=<value>`,
  then `--`, the query and `.` with the directory as its working
  directory. It respects `.gitignore`, `.ignore` and `.rgignore` as
  ripgrep does, skips binary files and does not follow links. Its output
  is read line by line (a line over 16 MiB, a match in a huge one-line
  file, is skipped); `match` messages become results, text that is not
  UTF-8 (ripgrep's `bytes`) is decoded with replacement characters. ripgrep
  exiting with code 2 after printing nothing means the query or a glob was
  refused: `bad_regex` or `bad_glob` with ripgrep's message.
- **The walker** (`walk.go`) otherwise: Go's `filepath.WalkDir` (no links
  followed), regular files of at most 1 MiB, opened without blocking and
  checked to still be regular files (a FIFO swapped in is not read), a NUL
  byte in the first 8 KiB makes a file binary and skipped, at most 100 000
  files read. The query is a Go regular expression (RE2), or the literal
  text quoted (`regexp.QuoteMeta`); `(?i)` unless Match Case; whole words
  are matches with no letter, digit or `_` right before or after them. Of
  ignore files it reads the top-level `.gitignore` of the folder searched
  (its patterns, without negations) as excludes. A regular expression Go
  refuses is `bad_regex`.

Both skip the folders `.git`, `.hg`, `.svn`, `.bzr`, `.jj`, `CVS` and
`node_modules` (as VS Code's `search.exclude` does node_modules). The
include and exclude patterns mean the same in both (`glob.go`): a pattern
without `/` matches the name of a file or of a folder on its path (`*.ts`,
`lib`), one with `/` the path below the folder searched or a folder's path
on it (`src/lib`, `docs/**/*.md`; a leading `/` or `./` is dropped); `**`
any folders, `*` any characters but `/`, `?` one, `[…]` a class, `{a,b}`
alternatives (commas inside braces do not split patterns). A file is
searched when it matches an include (or there is none) and neither it nor
a folder on its path matches an exclude. ripgrep gets the skipped folders,
then each include as `p` and `**/p/**` (or `/p` and `/p/**` with a `/`),
then the excludes as `!p`; later globs win.

A result lists the files (sorted by path, relative to the folder with `/`)
with their matching lines: the line number, the first match's column, a
preview and the matches in it. A preview is at most 250 characters around
the first match, without leading blanks, with `…` where it was cut; the
column and the ranges count UTF-16 code units, as Monaco and the browser's
strings do (`excerpt.go`). Several matches on a line are one row and count
each. A search stops after `maxResults` matches (2000 unless asked, at most
5000), after 30 s, or after 100 000 files (the walker), and answers what it
found with `truncated` and `reason` (`max_results`, `timeout`,
`max_files`); `engine` says which engine ran (`rg`, `builtin`). At most 4
searches run at once per machine; a fifth waits up to 3 s, then fails with
`busy`. The search ends as soon as the core closes the stream
(`plugin.UntilClosed`): ripgrep runs in a session of its own, and its
process group is killed then, at the time limit and once enough matches
were read.

### Core side (`backend/features/search`)

`POST /api/m/{id}/p/search/search` takes the parameters as JSON (at most
16 KiB), checks them as the agent does, and answers the agent's result. It
reads only, so it is not a mutating route: read-only mode searches, and
nothing is audited. The core waits 45 s (the agent's 30 s and the
transfer); past that the answer is 504 `timeout`. A search the browser
abandons ends the request, which closes the agent's stream and stops the
search on the machine.

### Web UI (`web/src/plugins/search`)

`SearchPanel.tsx` is the panel (`view.panel.search`, ⌘⇧F in the desktop app
on macOS; other systems keep Ctrl+Shift+F for Find in the terminal and have
no default key). The query field has the three toggles; the row below is
the folder searched (the home directory shown as `~`) with a button that
goes back to following the focused pane's folder (`followedDir` and
`recentDirectory` of the file explorer, kept while another pane has the
focus, as the Git panel does) and the toggle of the include and exclude
fields. Typing searches 300 ms after the last key, Enter at once, and a
change of an option or of the folder followed searches again; a search
already shown or in flight with the same parameters is not sent again.
Each new search aborts the one in flight (`AbortController`), so only the
last one's answer is shown (`state.ts`). The state (query, options,
folder, result, collapsed files) lives in a store and stays while the
panel is away.

The result is drawn as tree rows, windowed (`components/tree/TreeRow`,
`lib/windowed`): a file's row with its icon, name, folder and match count,
collapsible; its lines with the matches marked. ↑ and ↓ move between rows
(↓ from the query field goes to the list, ↑ from its first row back),
← and → collapse and expand a file, Enter or a click opens a line, Space
toggles a file, Escape goes back to the query (and in it clears the query).
The status line says how many results in how many files, why the search
stopped early, and which engine ran; a failure shows its message (for a
regular expression, the engine's reason).

Opening a line (`openMatch`) uses VS Code's pane at the line and column
while the VS Code plugin is on (`actions.openInCode`), else the file
explorer's editor as a preview (`openEditor` with `line` and `col`), else
Quick Look. The editor's view takes `line`, `col` and `reveal` (the time it
was asked); `EditorPane.tsx` puts the cursor there and shows the line in
the middle (`revealAt`) once the text is shown, and again for each new
`reveal`, so the same match opens at its place after the user scrolled
away.

## Alternatives considered

- **`grep -rn` or `git grep` on the machine.** `grep` differs between GNU
  and BSD (options, binary detection, encodings) and has no structured
  output; `git grep` only searches repositories. ripgrep's `--json` is one
  format on every system, and the walker covers machines without it.
- **Downloading ripgrep to machines.** Another pinned artifact per
  platform, uploads, retention and checksums for a tool many machines
  already have (on `PATH`, or inside code-server). The walker is fast
  enough for the projects a panel searches, and says it is the one running.
- **Streaming results as they come.** The core's plugin routes answer JSON;
  a bounded result of 2000 matches is under 1 MB and arrives within the
  search's time. Streaming would add a protocol for little gain at that
  size.
- **Searching through VS Code.** It needs the VS Code plugin and a
  code-server running for the folder; the panel works without either.

## Failure modes

- **No ripgrep:** the walker runs and the status line says so (files over
  1 MiB and nested `.gitignore` files are not taken into account).
- **A slow tree** (network file systems, huge folders): the search stops
  after 30 s with what it found and says the results are incomplete.
- **Too many matches:** the first `maxResults` are shown with a note to
  refine the search.
- **A refused regular expression or glob:** the field is marked and the
  engine's message is shown; nothing is searched.
- **The folder typed does not exist or is not a folder:** `not_found`,
  `not_dir`, shown as messages; the next valid folder searches again.
- **The machine is offline or does not answer:** `offline` (409),
  `transport` (502) or `timeout` (504), shown as messages.
- **Many searches at once:** `busy` after 3 s; typing cancels the previous
  search, so one panel never holds more than one.

## Security

A search reads files the agent's user can read, as the core's file routes
do; it writes nothing. ripgrep is a program found on the machine: it runs
without a shell, with an argument vector built by the agent (the query and
patterns are values after `--` or of `--glob=`, never options), without a
configuration file (`--no-config`, `RIPGREP_CONFIG_PATH` removed from its
environment), so no preprocessor (`--pre`) or other option can come from
the request or the machine's configuration. It runs in its own session and
process group, killed when the search ends. The walker does not follow
links and opens files without blocking. See [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agent/plugin/search/search_test.go`: the same searches with the
  walker and, where the machine running the tests has `rg`, with ripgrep
  (literal, case, whole word, regular expression, include and exclude
  globs, braces, hidden files, skipped folders, binary files, the match
  limit); the walker's `.gitignore`, size limit, FIFOs and links; the time
  limit; parameter checks; the handler; ripgrep's recorded `--json` output
  (text, bytes, non-match messages, broken and over-long lines, UTF-16
  columns); previews; globs; finding code-server's ripgrep; its
  environment.
- `backend/features/search/search.test.ts`: the route (not mutating;
  `checkGuarded` lists it as allowed in read-only mode), parameter checks,
  an offline machine, the timeout.
- `web/src/__tests__/search.test.ts`: the rows of a result, the params
  sent, the panel searching the focused terminal's folder after the pause
  with the matches marked, a new search aborting the one in flight, a
  refused regular expression's message, opening a line in the editor at
  its line and column.
- `web/src/__tests__/filesEditor.test.ts`: the editor shows the line and
  column its view asks for, again for a new request.

# 20 · Find in panes

## Context

Panes are herdr's cell grid painted on a canvas
([03](03-pane-rendering-and-input.md)): there is no DOM text for the
browser's find, and ⌘F found nothing in a pane's output. The browser also
holds only the rows shown; the scrollback stays in herdr, which renders the
view at the position the pane is scrolled to. herdr 0.9.5 has its own
search over a pane's text, used by its copy mode: `pane.copy_search`
returns matches in absolute rows, the same coordinates as selections
(row 0 is the oldest line kept), and the position of the current match
among all of them.

## Goals / non-goals

Goals: find text in a pane's output, the scrollback included, from the
keyboard or the pane's menu; step through matches from the newest up and
back down; see every match on the rows shown and the current one stronger;
also in read-only mode.

Non-goals: regular expressions or options for case and whole words (herdr
searches literal text with smart case); finding across panes or tabs;
finding in the programs' own buffers (a pager or editor on the alternate
screen shows only its screen: its own search finds the rest).

## Design

- **Opening.** ⌘F on macOS, Ctrl+Shift+F elsewhere (Ctrl+F is readline's
  and other programs' forward key), in a pane or with the focus elsewhere
  in the page outside dialogs, and **Find…** in the pane's text menu, open
  the find bar on the pane's top right corner (`web/src/components/FindBar.tsx`).
  Keys are checked before the keymap in `SurfaceController.onKeyDown`, so
  the key never reaches the pane; keys typed in VS Code stay VS Code's. In
  the desktop app ⌘F is no menu shortcut and reaches the page. A selection
  of one line (up to 200 characters) in the pane becomes the query;
  otherwise the last query stays and is selected. The key in an open bar
  selects its text.
- **Searching** (`web/src/surface/find.ts`). Typing searches 120 ms after
  the last key, from the end backward: the newest match is current. Enter
  goes to the next older match, Shift+Enter (and the buttons) to the next
  newer one; both wrap around. herdr searches literal text, case-sensitive
  only when the query has a capital letter, across soft wraps but not hard
  line ends, and returns at most 1024 matches around the current one with
  the exact total, which the bar shows as "n of total".
- **Content revision.** `pane.copy_search` applies to a content revision
  and answers `stale_content` once the pane's text changed. The browser
  reads the revision right before searching with `pane.copy_motion`
  (`next_word_start` from row 0, which only reads and never fails) and
  tries the pair again, up to 8 times with a growing pause, while output
  changes it in between. A pane printing continuously all that time shows
  that its output keeps changing; Enter tries again.
- **Showing matches** (`web/src/surface/controller.ts`, `paint.ts`). The
  matches become column ranges per absolute row; a row shown at view row
  `y` is absolute row `max_offset_from_bottom - offset_from_bottom + y`
  ([03](03-pane-rendering-and-input.md)). Highlights carry a kind, so a
  cell's background is the selection's over the current match's over other
  matches' (amber, dimmer on dark themes). The current match is scrolled
  into the middle of the view with `pane.scroll` when it is not shown; a
  read-only page does not scroll, since the position is every client's.
  New output leaves the highlights on their rows until the next search.
- **Closing.** Escape or the close button drops the highlights and gives
  the pane its keys back. A closed pane takes its bar with it; another tab
  hides it until the pane is shown again.
- **Read-only mode.** `pane.copy_search` and `pane.copy_motion` count as
  reads (`machines.IsReadOnlyMethod`), which also spares them the snapshot
  refresh that follows calls changing herdr's state.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Search the rows the browser has | Only the visible rows; the scrollback is herdr's. |
| Read the whole scrollback (`pane.read`) and search it in the browser | Megabytes per search over the machine's connection, and the text has no cell coordinates to highlight or scroll to (wide characters, soft wraps). |
| Ctrl+F on every system | Programs use it (readline's forward character, less, editors). |
| Get the revision from the pane's surface stream | It changes with every update; the core would have to forward it with every patch, and it would be as stale by the time the search arrives. |
| herdr's own copy mode | A mode of herdr's terminal client: its prompt and highlights are drawn by that client, not in the surfaces the browser gets. |

## Failure modes

- Output changing between the two requests for more than 8 attempts (a
  pane printing continuously over a slow connection): the bar says so and
  Enter tries again.
- The scrollback dropped its oldest lines since the search: absolute rows
  shift and highlights are off by those lines until the next search.
- A pager or editor on the alternate screen: only its screen is searched.
- More than 1024 matches: only those around the current one are
  highlighted; the count and stepping cover all of them.

## Testing

`web/src/__tests__/find.test.ts` covers the find key per system, mapping
matches (also across a soft wrap) to columns, highlight priority when
painting, scrolling a match into the middle of the view and not on the
alternate screen or in read-only mode, reading the revision and retrying
on `stale_content`, stepping with previous matches, typing pauses and the
find bar's keys. `web/src/__tests__/input.test.ts` and `testdata/keys.json`
cover the key not reaching the pane, `surfaceSelect.test.ts` the menu item
with the selection as the query, and `internal/machines/machines_test.go`
and `internal/server/server_test.go` the read-only methods. herdr's
semantics (absolute rows shared with `pane.selection.read` and the scroll
position, the last cell included in a match, wrapping, the alternate
screen, `stale_content`) were checked against herdr 0.9.5 in an isolated
session.

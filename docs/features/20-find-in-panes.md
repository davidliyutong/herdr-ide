# 20 · Find in panes

## Context

Panes are herdr's cell grid painted on a canvas
([03](03-pane-rendering-and-input.md)): there is no DOM text for the
browser's find, and ⌘F found nothing in a pane's output. The browser also
holds only the rows shown; the scrollback stays in herdr, which renders the
view at the position the pane is scrolled to.

herdr 0.9.5 has a search of its own, used by its copy mode:
`pane.copy_search` returns matches in absolute rows, the same coordinates
as selections (row 0 is the oldest line kept). It searches literal text
only, case-sensitive exactly when the query has a capital letter, with no
option to change either, and it applies to a content revision that the
caller must read first (`pane.copy_motion`), so a pane whose output keeps
changing makes the pair fail and be retried, each try two round trips over
the machine's connection.

## Goals / non-goals

Goals: find text in a pane's output, the scrollback included, from the
keyboard or the pane's menu; regular expressions, matching case and whole
words as options; step through matches from the newest up and back down;
see every match on the rows shown and the current one stronger; work on
busy panes and slow connections; also in read-only mode.

Non-goals: finding across panes or tabs; finding in the programs' own
buffers (a pager or editor on the alternate screen shows only its screen:
its own search finds the rest); replacing text.

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
- **Options.** Three toggles in the query field, as in VS Code: match case
  (Alt+C), whole word (Alt+W) and regular expression (Alt+R); on macOS
  Option and ⌘⌥ with the letter, read from the key's code so Option's
  characters (ç, ∑, ®) are not typed instead. The keys work in the bar
  only: the bar keeps its keys from the pane and the keymap. Without match
  case the search ignores case, whatever the query's capitals. Whole word
  needs no letter, digit or underscore right before a match that starts
  with one, and none right after one that ends with one, in any script.
  Regular expressions are Go's RE2 syntax, matched per line of output (`^`
  and `$` are its ends); an invalid one turns the field red and the bar
  says so, with the parser's message as the tooltip. The options are kept
  in the browser's storage.
- **Searching next to herdr** (`internal/panefind`, agent op `pane.find`,
  `POST /api/m/{id}/find`). The browser sends the query, the options, the
  direction, the current match and the pane's width; the machine's agent
  reads the pane's text from herdr on that machine and answers with the
  matches, shaped like `pane.copy_search`'s answer: at most 1024 matches
  around the current one, the total and the current one's position. Every
  request to herdr stays on the machine; a search crosses the connection
  once, carrying only matches.
  - *Size.* `pane.get` gives the rows (scrollback plus view). herdr reports
    no column count, so the agent checks the browser's width with two
    one-cell `pane.selection.read`s (the last column exists, the next does
    not) and otherwise finds it by doubling and halving.
  - *Text.* One `pane.selection.read` from the oldest row to the last cell.
    herdr answers it under its terminal's lock, so the text is one
    consistent state even while output keeps arriving: no content revision
    and no retries (only a read refused because the pane shrank in between
    is tried again, up to 4 times). Rows written after the read are not
    searched. A scrollback larger than 4 Mi cells is searched from its
    newest rows back.
  - *Cells.* The text has one line per line of output, soft-wrapped rows
    joined and trailing blanks trimmed. The agent lays each line out again
    in the pane's width the way the terminal did: grapheme cluster by
    cluster (`github.com/rivo/uniseg`), one or two cells each, a wide one
    that does not fit a row's end starting the next row, zero-width ones on
    the cell before. Lines of ASCII skip the clusters. The resulting cells
    equal `pane.copy_search`'s for CJK, emoji with modifiers, flags, ZWJ
    sequences and combining marks (`TestIntegrationPaneFind`).
  - *Matching.* Go's `regexp` (RE2) runs in time linear in the text, so no
    query can make a search slow; a literal query is quoted, case is
    ignored with `(?i)`. Empty matches are skipped. Counting stops at
    100 000 matches; the bar then shows "100000+".
  - *Current match.* As herdr picks it: forward, the first match starting
    after the current one; backward, the last ending before it; wrapping
    around at either end.
- **The browser** (`web/src/surface/find.ts`). Typing searches 150 ms after
  the last key, from the end backward: the newest match is current. Enter
  goes to the next older match, Shift+Enter (and the buttons) to the next
  newer one, wrapping around; changing an option searches again from the
  newest. A step to a match among those of the last answer happens at once
  in the browser; 400 ms after stepping pauses, one search in the
  background (backward from right after the current match) brings the
  count and positions up to date and keeps that match. A step beyond the
  answer's 1024 matches asks the core; further steps wait for its answer
  and continue from it, so fast Enter presses are never lost. A new query
  or option aborts the request in flight, which closes the agent's stream
  and stops its work, and drops the queued steps; an answer that arrives
  anyway is dropped.
- **Showing matches** (`web/src/surface/controller.ts`, `paint.ts`). The
  matches become column ranges per absolute row once per answer; a paint
  looks up only the rows shown. A row shown at view row `y` is absolute
  row `max_offset_from_bottom - offset_from_bottom + y`
  ([03](03-pane-rendering-and-input.md)). Highlights carry a kind, so a
  cell's background is the selection's over the current match's over other
  matches' (amber, dimmer on dark themes). The current match is scrolled
  into the middle of the view with `pane.scroll` when it is not shown; a
  read-only page does not scroll, since the position is every client's.
  New output leaves the highlights on their rows until the next search.
- **Closing.** Escape or the close button drops the highlights and gives
  the pane its keys back; the options stay. A closed pane takes its bar
  with it; another tab hides it until the pane is shown again.
- **Read-only mode.** Searching only reads, so the endpoint is open to
  read-only pages; the agent calls only `pane.get` and
  `pane.selection.read`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| herdr's `pane.copy_search` (the first version) | Literal and smart case only; a revision read before each search, retried while output changes, two round trips per try over the machine's connection. |
| Use `pane.copy_search` for plain queries and the agent's search for the options | Two paths that can disagree; the agent's search finds the same cells and works on busy panes. |
| Search in the browser | The scrollback (megabytes) would cross the machine's connection for every search, and JavaScript's backtracking regular expressions can take exponential time on a crafted pattern. |
| Search in the core | The same text transfer from the machine; the agent is next to herdr. |
| Read the text row by row to know the wraps | One request per row; herdr has no request for row boundaries, and laying the text out again gives the same cells. |
| Search the rows the browser has | Only the visible rows; the scrollback is herdr's. |
| Ctrl+F on every system | Programs use it (readline's forward character, less, editors). |
| Alt+C/W/R also in the pane | Option keys type characters and Alt keys are the programs' in a terminal. |
| herdr's own copy mode | A mode of herdr's terminal client: its prompt and highlights are drawn by that client, not in the surfaces the browser gets. |

## Failure modes

- A grapheme cluster whose width the terminal decides differently from
  Unicode's (an unusual emoji sequence, a program that changed the width
  mode): matches after it on its line are a cell off, or the line's later
  rows by one row. Other lines are unaffected.
- The pane's size changing while it is read: the read is tried again; a
  pane that keeps resizing makes the bar say it keeps changing (Enter tries
  again).
- The scrollback dropped its oldest lines since the search: absolute rows
  shift and highlights are off by those lines until the next search.
- A pager or editor on the alternate screen: only its screen is searched.
- More than 1024 matches: only those around the current one are
  highlighted; the count and stepping cover all of them up to 100 000.
- An agent from before this op answers "unknown op": the bar says find
  failed until the machine reconnects with the current agent.

## Security

The endpoint reads text the page could read already (`pane.read` is
allowed to every page); it writes nothing on the machine. The query is at
most 4096 bytes, RE2 bounds the matching time by the text's length, the
text by 4 Mi cells, the answer by 1024 matches, and the agent's work by 20
seconds and by the browser's request, whose end stops it.

## Testing

`internal/panefind/search_test.go` covers the options, laying text out
(wraps, wide characters at a row's end, grapheme clusters, combining
marks, empty lines), choosing the current match, the window and the count
limit, reading a pane through a fake herdr (width hints right and wrong, a
pane that shrinks, unknown panes, invalid expressions) and finding the
width. `TestIntegrationPaneFind` (`make it`) compares the agent's matches
with `pane.copy_search`'s on text with CJK, emoji, flags, ZWJ sequences
and combining marks, and checks the options against a real herdr.
`internal/server/find_test.go` covers the endpoint in read-only mode and
its error codes. `web/src/__tests__/find.test.ts` covers the find key and
option keys per system, mapping matches (also across a soft wrap) to
columns, highlight priority when painting, scrolling a match into the
middle of the view and not on the alternate screen or in read-only mode,
the request, stepping within the answer and the background refresh,
steps beyond it waiting for each other, typing pauses, cancelling a
superseded search, invalid expressions, remembering options and the find
bar's keys and buttons. `web/src/__tests__/input.test.ts` and
`testdata/keys.json` cover the find key not reaching the pane, and
`surfaceSelect.test.ts` the menu item with the selection as the query.

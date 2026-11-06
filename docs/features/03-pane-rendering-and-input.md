# 03 · Pane rendering and input

## Context

Each pane must feel like a native terminal: Chinese input methods, mouse in
TUIs (vim, htop, coding agents), scrollback, paste, Shift+Enter for agent
prompts, correct wide characters, the clipboard (OSC 52) and colors that
match the UI's theme. herdr already emulates every pane's terminal; through
its endpoint protocol ([18](18-endpoint-surfaces.md)) it renders the shown
tab into one cell grid at the browser's size, and it encodes keys and mouse
events for each pane's own modes.

## Goals / non-goals

Goals: draw herdr's grid without a second terminal emulator; send input as
herdr's own client does, so that every key reaches a program in the
encoding the program negotiated; selections that never leave their pane.

Non-goals: local scrollback search (scrollback lives in herdr), terminal
graphics (kitty images are not requested), herdr popups (their title is
received, the popup itself is not drawn).

## Design

**Rendering** (`web/src/surface/`)

- `protocol.ts` decodes the core's binary surface messages (complete
  surfaces and patches: row moves, changed spans, cursor) and `grid.ts`
  keeps the grid, moving rows with herdr's own swap order and marking the
  rows that changed. Row moves (scrolling) are kept for the painter, which
  copies the moved rows on the canvas (`drawImage` of the canvas on itself)
  and paints only the rows a move uncovers; a row not yet painted takes its
  stale pixels along, so both its places are painted.
- `paint.ts` repaints dirty rows on one canvas per tab, at whole device
  pixels per cell: backgrounds, text in the bundled terminal font, bold,
  dim, italic, underline styles, strikethrough, reverse and hidden cells,
  the cursor (block, underline, bar; hollow without focus) and the
  selection. herdr sends no widths: a wide symbol covers the next cell,
  which is not drawn: herdr leaves it with the default style, and the wide
  symbol's background and reverse video span both columns, as in herdr's
  own renderer. A symbol is wide by herdr's unicode-width rules
  (`width.ts`: East Asian Wide and Fullwidth, emoji presentation, flags) or
  when the next cell is the empty spacer herdr puts after a wide character
  in pane content (`Grid.width`), so grapheme clusters the table does not
  know still take the columns herdr gave them.
  Box-drawing and block characters are drawn as shapes, so borders join at
  any cell size. Text is clipped to its row; only symbols that may be wider
  than their cells (not printable ASCII, wide, or italic) are clipped to
  their cells, and the font is set once per style: a complete repaint of a
  220 × 60 grid at ratio 2 takes about 10 ms of script time in Chromium
  instead of 28 ms with a clip per symbol.
- The controller paints only rows that changed: rows herdr changed, rows a
  move uncovers, and rows whose selection highlight differs from the one
  they were painted with (it remembers each row's highlight and moves it
  with copied rows). Moving the pointer during a selection therefore paints
  one or two rows, not the whole tab. Pane metadata is applied when it
  arrives, before the patch the core sends after it, so a scroll and its
  highlight are painted in the same frame.
- Colors use herdr's packing (named, palette index, true color) resolved
  against the UI theme's palette (`colors.ts`, `terminal/options.ts`).
- The cell size comes from the terminal font's metrics (5% more than its
  line height); the grid that fits the tab area, and the cell size in
  device pixels, is the size herdr renders. The cell is measured again when
  the device pixel ratio changes (a `resolution` media query on the ratio it
  was measured at): moving the window to a display with another pixel
  density, or zooming the page, keeps the text's size in CSS pixels and
  sends herdr the new grid. Positions over the canvas (headers, input
  method, mouse) convert with the ratio the cell was measured at, so they
  match the canvas until it is measured again.
- Every pane has a header with its own buttons. A header
  (`components/PaneHeader.tsx`) sits over the top border row herdr draws for
  a pane (between `rect` and `inner_rect`): the pane's agent state, title,
  agent and folder, then its buttons (`components/PaneActions.tsx`): program
  windows ([14](14-gui-windows.md)), VS Code, changes and Git Graph of the
  folder, split right / down, zoom or restore, and close. They act on that
  pane, whichever pane has the focus, and a press on one leaves keyboard
  focus in the terminal. Clicking the title renames the pane, right-clicking
  the header opens the pane's menu, dragging it moves the pane, a click
  focuses the pane. herdr draws the border row for every pane of a split
  tab, a zoomed one included.
- A pane without a border row (a lone pane, unless herdr draws outer
  borders) gets the same header as a toolbar between the tab bar and the
  grid (`components/PaneToolbar.tsx`), for the focused pane: it is outside
  herdr's grid, so the grid is one bar shorter. The toolbar is shown while
  the shown surface has such a pane, before herdr rendered the tab when it
  has a single pane; splitting the lone pane hides it, closing all but one
  pane shows it again, and the grid is resized with the layout change.
  Read-only browsers see titles, folders and program windows without the
  other buttons.
- Nothing is drawn over a pane's terminal: buttons sit only on border rows
  and above the grid, so they never cover what a program shows (Claude
  Code's diffs reach the pane's top right corner).
- Narrow headers keep one row: they drop the folder, the agent, the VS Code
  buttons, the split buttons, the title and zoom, in this order (the dropped
  commands stay in the pane's menu and key bindings); the close button
  stays. The toolbar does the same with its own widths. Neither clips, so
  the program windows' menu can hang below them; over the grid, a header
  with that menu open is raised above the other headers, and in a narrow
  toolbar the menu opens rightwards.

**Input mapping** (`surface/input.ts`, `surface/controller.ts`)

| Browser event | Sent to herdr (`ClientShellPaneInput`) |
| --- | --- |
| keydown | `Key` with code, modifiers, the text it types, and the shifted alternate for letters; herdr encodes it for the pane (legacy, application cursor and keypad, kitty keyboard protocol, modifyOtherKeys) |
| keyup of a key that types no text | `Key` release (herdr encodes it only for programs that asked for release events) |
| IME composition end, other text input | `TextCommit` |
| paste | `Paste` with newlines as CR and ESC and other controls removed (by the core too); herdr brackets it if the program enabled bracketed paste |
| wheel | `Mouse` scroll with a line count; herdr routes it to the program or to its scrollback |
| mouse down/drag/up in a pane whose program reports the mouse (without Shift) | `Mouse` with the cell inside the pane |
| focus and blur of the pane surface | `ClientShellFocus` (focus events for programs that ask) |
| ⌘ shortcuts | left to the browser (copy, paste) |
| prefix key | app keymap ([04](04-layout-and-keyboard.md)) |

Text goes to the pane that has the UI's focus; herdr's focused pane follows
it ([18](18-endpoint-surfaces.md)).

While an input method composes, its text (pinyin such as `zi fu`) is shown
underlined over the cells at the cursor, in the terminal font and colors;
the hidden textarea that receives it also sits at the cursor, so the
candidate window opens there. herdr receives only the committed text.

**Key routing** (`surface/keys.ts`)

Every keydown in the surface passes through `routeKey`, with three outcomes:
the app keymap consumes it, it goes to the pane as a key event, or the
browser keeps it (⌘ shortcuts, IME composition, dead keys). Consumed events
are cancelled, so no keypress or input event follows them.

The events per key are pinned in `web/src/__tests__/testdata/keys.json`,
which two tests share:

- `web/src/__tests__/input.test.ts` drives the real `SurfaceController` and
  keymap with the browser's event order and compares the events each row
  sends.
- `TestIntegrationKeyParity` (`make it`) sends each row's events through
  herdr's endpoint to a raw reader in legacy, application cursor/keypad and
  kitty (disambiguate) modes and compares the bytes herdr writes with the
  row's `bytes`.

What the table records about herdr 0.9.5:

- Shift+Enter is CR in a legacy pane, like Enter, and `CSI 13;2u` once a
  program enables the kitty keyboard protocol, which Claude Code and Codex
  turn into a newline; in a legacy pane Alt+Enter (ESC CR) does.
- Application cursor mode gets SS3 arrows, Home and End, as in herdr's own
  client.
- herdr encodes no bytes for a Backspace key event without Ctrl; like
  herdr's own client, the browser sends DEL (ESC DEL with Alt) as text.
- PageUp and PageDown without modifiers scroll herdr's scrollback outside
  the alternate screen and application modes.

**Selections** (`surface/selection.ts`)

- A drag in a pane whose program does not report the mouse (or any drag
  with Shift) selects text in that pane only, in herdr's absolute rows (row
  0 is the oldest line kept; the first visible row is
  `max_offset_from_bottom - offset_from_bottom`, from the pane's scroll
  metrics in the surface). Double click selects a word, triple click a line,
  Shift+click extends.
- A drag held past the top or bottom edge scrolls the pane with
  `pane.scroll`. The speed is set by time, not by herdr's replies (over ssh
  each one takes a round trip): 20 lines per second at the edge, 20 more for
  each row's height further away, times up to four the longer the drag is
  held (×2 after 2 s, ×4 after 6 s; a pane at the bottom of the window
  leaves little room below it), at most 2000. One request is in flight at a
  time, at most every 40 ms; the lines owed meanwhile (at most half a
  second's worth) go in the next request, which starts from the offset
  herdr last reported (its reply, or newer metadata). herdr clamps the
  offset. The selection's end and highlight follow the rows when the
  scrolled surface arrives.
- On release `pane.selection.read` returns the text (both end cells
  included, soft-wrapped lines joined as herdr does). Copying puts that
  text on the clipboard; a copy before it arrived copies the visible part
  and writes the whole text when it arrives.

**Links** (`terminal/links.ts`)

With ⌘/Ctrl held, OSC 8 hyperlinks of the grid (`http`, `https` and
`mailto` targets only) and URLs or paths found in the pane's text are
underlined; a click opens URLs in a new tab and paths in
Quick Look or VS Code ([06](06-quick-look-and-files.md)). A row whose text
reaches the pane's last column goes on in the next row after its
indentation, so a path the terminal or a program (Claude Code, Codex)
wrapped is one link, underlined on each of its rows.

**Context menu**

A right click on a pane opens its menu, also where the pane's program
reports the mouse: programs get the left and middle buttons and the wheel,
never the right button, and a right press keeps the selection (the page's
or the program's). On macOS Ctrl+click is a right click too, except the
Ctrl+click that opens a link. The menu has **Copy** (the selection, as
⌘/Ctrl+C copies it; without one, the text the pane's program last copied
from its own selection, see below), **Paste** (not in read-only mode, and
only where the browser offers the clipboard API: localhost, HTTPS or the
desktop app), and for a URL or path, opening and copying it. The link is the one under the
pointer; over the selection, the selection's text when it is one URL or
path (line breaks and the indentation after them dropped), so a path wrapped
in a way detection does not join can be selected and opened. Path items
name the file, which shows a path cut short.

**Clipboard and bell**

OSC 52 from a pane program (up to 1 MiB) reaches the owning browser, not in
read-only mode. Programs that select text themselves (Claude Code, Codex,
tmux, vim with the mouse) copy it this way, so what the browser does is a
setting (`programClipboard`, terminal section,
[13](13-settings-and-appearance.md)):

- **Automatic** (default): a copy that arrives within 10 s of this
  browser's last key, text, paste or button press in a pane goes on the
  clipboard at once, and a toast says what was copied (length and start,
  2 s). Pane output is not trusted, so a copy without such input, or one the
  browser refuses (no permission, page not focused, Safari and Firefox
  outside a user gesture), shows the **Ask** toast instead.
- **Ask**: a toast shows the text's length and start, and only its
  **Copy** button writes the clipboard (the click is also the gesture
  browsers want); it closes after 5 s, and nothing is copied unless the
  button was clicked.
- **Off**: programs' copies are ignored.

The 10 s count from any key, text, paste or button press this browser sent
to any pane, including text VS Code sends to an agent; herdr does not say
which pane copied, so a program in another pane or tab of the shown machine
can copy within them too. A new clipboard toast replaces the previous one,
so programs that copy on every selection leave no pile of toasts.

A copy that passed the automatic gate (also one the browser then refused)
is kept for its machine: with no selection of the page, the pane menu's
**Copy** and ⌘/Ctrl+C copy it, with the same toast. It ends with the next
key, text, paste or press of the left or middle button in a pane (which
ends the program's selection too), when this browser loses the session,
and after 2 minutes. Copies shown with **Ask** are never kept. A bell
flashes the surface's edge.

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js per pane fed by `herdr terminal session` frames | The previous design. The stream drops keyboard-protocol and mouse modes, OSC 52, bell and kitty graphics and cannot report the browser's colors, so the browser guessed key encodings, selections spilled into neighbouring panes and programs saw another theme's colors; xterm.js also re-emulated what herdr had already emulated. |
| One canvas per pane | herdr renders a whole tab into one grid with its borders and split lines; one canvas keeps herdr's layout exact and needs no per-pane geometry. |
| Pane headers above each pane (taller than a cell row) | The grid would have to be stretched between headers: cells would no longer line up with herdr's coordinates for mouse and splits. |
| One toolbar per tab acting on the focused pane, headers without buttons (the previous design) | A pane's commands were away from the pane and needed a click into it first; in split tabs the same commands were in two places. |
| A close button over each pane's top right corner, shown on hover (the previous design) | It covered the program's own output there (Claude Code's diffs) and invited closing a pane by accident. |
| Programs' clipboard writes always behind a **Copy** button (the previous design) | Agents copy their own selections this way, so every selection needed a second click; the button stays for writes not following the user's input. |
| Right clicks to programs that report the mouse (the previous design) | Left no menu, so no Copy or Paste, in Claude Code and other agents, which hardly use the right button. |
| WebGL text rendering | Canvas 2D repaints only dirty rows and handles fonts, fallback glyphs and ligature-free monospace text well enough; it also works where WebGL is unavailable. |

## Failure modes

- **Surface lost** (connection dropped, herdr restarted) → an overlay says
  so and the core reconnects ([18](18-endpoint-surfaces.md)); the first
  surface after reconnecting is complete.
- **A patch for an older generation** (a new connection's surface is
  already shown) → dropped by generation number.
- **The browser refuses a program's copy** (no clipboard permission, page
  not focused, no user gesture) → the toast with a **Copy** button is shown
  instead; dismissed, the text is not copied, as in a terminal without
  clipboard permission.
- **Output arrives while a selection is shown** → at the live bottom new
  lines move the text under the highlight until the next scroll; the copied
  text is the range read at release.
- **`pane.selection.read` fails** → copying falls back to the visible part.
- **herdr answers `pane.scroll` slowly** (a distant machine) → the view
  moves in larger steps at the same speed; the selection follows what is
  shown.
- **The window moves to a display with another pixel density** → the cell
  is measured again and herdr renders the new grid; until then the canvas
  keeps its CSS size, scaled by the browser.

## Testing

`web/src/__tests__/surface.test.ts` (binary messages from the Go encoder's
pinned vectors in `testdata/surface.json`, grid moves and generations,
widths, colors, selections in absolute rows and the read range, key events,
paste filtering, links); the key contract above (`input.test.ts`,
`TestIntegrationKeyParity`); `web/src/__tests__/paneToolbar.test.ts` (the
toolbar's buttons act on the focused pane, disabled outside the shown tab,
rename and menu, read-only; a header's buttons act on its own pane and keep
the terminal's focus; when the toolbar is shown);
`input.test.ts` (a press on a button over the grid reaches no program; the
right button opens the menu in a pane whose program reports the mouse and
sends it nothing, and Copy copies the program's copy until the next key);
`clipToast.test.ts` (automatic copies after input, asking otherwise or when
the browser refuses, `ask` and `off`, one toast at a time, which copies are
kept for the menu, for which machine and how long);
`surfaceDpr.test.ts` (a device pixel ratio change measures the cell again);
`surfaceSelect.test.ts` (a selection drag paints only the rows whose
highlight changed, moved rows are copied, and the scroll past an edge keeps
its speed while herdr is slow to answer).
Headers with buttons on split and zoomed panes, the toolbar of a lone
pane, the narrow-width steps, an automatic copy of a program's OSC 52 and
the menu in a pane reporting the mouse were checked in Chromium against a
dev herdr session. Rendering, headers over borders, IME, vim
mouse, wheel, selections and copying, tab switches, takeover between two
tabs and host colors (OSC 11 answered with the theme's background) were
checked in Chromium against a dev herdr session.

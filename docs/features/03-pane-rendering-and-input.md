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
- Each tab has one toolbar (`components/PaneToolbar.tsx`), a single row
  between the tab bar and herdr's grid whatever the number of panes. It
  shows the focused pane's agent state, title, agent and folder and its
  buttons: program windows ([14](14-gui-windows.md)), VS Code, changes and
  Git Graph of the folder, split right / down, zoom and close. It is also
  the focused pane's header: clicking the title renames the pane,
  right-clicking opens the pane's menu, dragging moves the pane. It is
  outside herdr's grid, so the grid is just one bar shorter, and it stays
  while the tab is shown (buttons disabled while no pane of the tab is
  focused), so focus changes never resize the grid. Read-only browsers see
  the title, folder and program windows without the other buttons.
- In a narrow workspace the toolbar keeps one row: it drops the folder and
  agent, then shrinks the buttons, then drops the VS Code buttons, the title
  and the split buttons (the dropped commands stay in its menu and key
  bindings). It clips nothing, so the program windows' menu can hang below
  it; when narrow, that menu opens rightwards.
- Pane headers (`components/PaneHeader.tsx`) sit over the top border row
  herdr draws for each pane (between `rect` and `inner_rect`) with the
  pane's agent state, title, agent and folder, and no buttons; clicking one
  focuses its pane, and it renames, drags and has a menu like the toolbar.
  A pane without a border row (a lone pane, unless herdr draws outer
  borders) has no header: the toolbar shows the same.
- Every pane has a round close button at its top right corner, shown only
  while the pointer is over the pane (`PaneCloseButton`, placed by
  `SurfaceView`): at the right end of the border row, where the header
  leaves room for it, or just inside the corner of a pane without one.
  Closing a pane is the one command kept on the pane itself, since the
  toolbar's buttons act on the focused pane only. Hidden, it lets clicks
  through to the terminal; the surface controller ignores mouse presses on
  buttons, so a click on it never reaches the program under it. It closes
  like the toolbar (asking while an agent works) and leaves keyboard focus
  in the terminal. Read-only browsers do not show it.

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
`mailto` targets only) and URLs or paths found in the row's text are
underlined; a click opens URLs in a new tab and paths in
Quick Look or VS Code ([06](06-quick-look-and-files.md)).

**Clipboard and bell**

OSC 52 from a pane program (up to 1 MiB) reaches the owning browser, not in
read-only mode. Pane output is not trusted, so a toast shows the text's
length and start and only its **Copy** button writes the clipboard; the click
is also the user gesture browsers want. The toast closes after 5 s, so
programs that copy often (agent CLIs on every selection) leave no pile of
toasts; nothing is copied unless the button was clicked. A bell flashes the surface's edge.

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js per pane fed by `herdr terminal session` frames | The previous design. The stream drops keyboard-protocol and mouse modes, OSC 52, bell and kitty graphics and cannot report the browser's colors, so the browser guessed key encodings, selections spilled into neighbouring panes and programs saw another theme's colors; xterm.js also re-emulated what herdr had already emulated. |
| One canvas per pane | herdr renders a whole tab into one grid with its borders and split lines; one canvas keeps herdr's layout exact and needs no per-pane geometry. |
| Pane headers above each pane (taller than a cell row) | The grid would have to be stretched between headers: cells would no longer line up with herdr's coordinates for mouse and splits. |
| WebGL text rendering | Canvas 2D repaints only dirty rows and handles fonts, fallback glyphs and ligature-free monospace text well enough; it also works where WebGL is unavailable. |

## Failure modes

- **Surface lost** (connection dropped, herdr restarted) → an overlay says
  so and the core reconnects ([18](18-endpoint-surfaces.md)); the first
  surface after reconnecting is complete.
- **A patch for an older generation** (a new connection's surface is
  already shown) → dropped by generation number.
- **Clipboard toast dismissed** → the program's text is not copied, as in a
  terminal without clipboard permission.
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
rename and menu, read-only, headers without buttons, the close button);
`input.test.ts` (a press on a button over the grid reaches no program);
`surfaceDpr.test.ts` (a device pixel ratio change measures the cell again);
`surfaceSelect.test.ts` (a selection drag paints only the rows whose
highlight changed, moved rows are copied, and the scroll past an edge keeps
its speed while herdr is slow to answer).
The toolbar's narrow-width steps and the close button were checked in
Chromium. Rendering, headers over borders, IME, vim
mouse, wheel, selections and copying, tab switches, takeover between two
tabs and host colors (OSC 11 answered with the theme's background) were
checked in Chromium against a dev herdr session.

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
  rows that changed.
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
  any cell size.
- Colors use herdr's packing (named, palette index, true color) resolved
  against the UI theme's palette (`colors.ts`, `terminal/options.ts`).
- The cell size comes from the terminal font's metrics (5% more than its
  line height); the grid that fits the tab area, and the cell size in
  device pixels, is the size herdr renders.
- Pane headers (`components/PaneHeader.tsx`) sit over the top border row
  herdr draws for each pane (between `rect` and `inner_rect`). A pane
  without a border row (a lone pane, unless herdr draws outer borders) gets
  a floating header at its top right that shows on hover.

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
  `pane.scroll` every 40 ms, 1 line per step at the edge and up to 15 further
  away; herdr clamps the offset. The highlight follows the rows as the view
  moves.
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

## Testing

`web/src/__tests__/surface.test.ts` (binary messages from the Go encoder's
pinned vectors in `testdata/surface.json`, grid moves and generations,
widths, colors, selections in absolute rows and the read range, key events,
paste filtering, links); the key contract above (`input.test.ts`,
`TestIntegrationKeyParity`). Rendering, headers over borders, IME, vim
mouse, wheel, selections and copying, tab switches, takeover between two
tabs and host colors (OSC 11 answered with the theme's background) were
checked in Chromium against a dev herdr session.

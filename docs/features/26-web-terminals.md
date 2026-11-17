# 26 · Web terminals

## Context

The terminal core ([21](21-terminal-core.md)) hands each viewer a terminal's
raw output and takes the bytes the viewer's own terminal encodes
([22](22-terminal-protocol.md)): the browser UI (also what the desktop app
shows) emulates the terminals it shows. It needs an emulator that parses
output, keeps scrollback, encodes keys and mouse events and answers
programs as a desktop terminal does, so that programs behave in a pane as
they do there.

## Goals / non-goals

Goals: Ghostty's terminal emulation, from a pinned commit; every
`terminal.*` setting honoured; a terminal that keeps up with
programs flooding output, with the page's memory bounded; keys, mouse,
pastes and focus encoded for the modes the program asked for (legacy,
application cursor and keypad, kitty keyboard protocol, modifyOtherKeys,
SGR mouse…); input methods, dead keys, AltGr and Option as Meta;
selections, find, links and the programs' clipboard writes in the page;
builds without zig.

Non-goals: images in terminals (Ghostty's kitty graphics are not built for
WebAssembly); finding by regular expression or whole words; ligatures.

## Design

**Module** (`scripts/fetch-ghostty-vt.sh`, `web/src/vt/`). Ghostty's
terminal library, libghostty-vt, built as WebAssembly from commit
`cf5519b22f91`: `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`
with the features the page uses (render state, input encoders, selections,
colors, the formatter, search and grid references). The module
(`ghostty-vt.wasm`, 797 KB, 250 KB compressed, no imports) and Ghostty's
MIT license are committed with the module's SHA-256
(`ghostty-vt.wasm.sha256`), so builds and CI need no zig; `make check`
compares the module with the digest, and `make vt-wasm` builds it again
(zig 0.17; `GHOSTTY_SRC` names a checkout, else the commit is cloned into
`web/.deps/`). The build is reproducible: two builds, one with an empty
cache, gave the recorded digest. The license goes into the bundle's
`licenses.md` beside the font's (`web/vite.config.ts`).

**Loading** (`vt/module.ts`). The page compiles the module once
(`instantiateStreaming`, else from its bytes). Struct layouts and enum
values come from the library's own type description (`ghostty_type_json`),
so no offset is written in JavaScript; structs passed by value are passed
as pointers, the memory's views are taken again after every call (it may
grow), and handles come from `ghostty_wasm_alloc_opaque`. The library calls
back through function-table indices, and a JavaScript function cannot be put
into a table: the page builds a small WebAssembly module that imports its
functions and exports them with the callbacks' signatures, grows the
library's table and puts them there. One set of callbacks serves every
terminal, which they find by the terminal's handle.

**Emulator** (`vt/terminal.ts`). One per attached terminal. The settings
become its options: the theme's colors (the 16 of `terminal.colors.*`, the
other 240 the standard cube and grays), `terminal.scrollback` as lines
(and 2 KiB a line as the byte bound), `terminal.cursorStyle` and `terminal.cursorBlink` as the cursor a
program's reset returns to, `terminal.boldIsBright`; grapheme clusters take
the width Unicode gives them (mode 2027 on, as in Ghostty's application).
Callbacks: the terminal's answers to programs (device attributes, cursor
position, colors, modes, size reports) go back as automatic input, bells,
titles, clipboard writes (OSC 52), the color scheme query (`CSI ? 996 n`,
from the theme) and synchronized output (mode 2026: the screen is drawn
when the program lets go, after 1 s at the latest). The terminal core answers the color, color scheme, device attribute
and size queries itself and keeps them from the page, from the display
facts the pane sends it (the theme's foreground, background and cursor,
the cell size; [22](22-terminal-protocol.md)), so the emulator's answers
are for queries the core passes on. A frame of the screen is
read from the render state: only rows that changed, each row's cells in one
call (codepoint, width, style id, hyperlink), a style read once per style
id in the row and resolved through the palette, grapheme clusters, the
row's selected columns and whether it wraps; then the cursor and colors.

**Renderer** (`vt/renderer.ts`, `vt/atlas.ts`). `drawRow`, a pure function,
works out a row's background per cell and its glyphs: text with bold and
italic, faint at half opacity, inverse, invisible, wide characters over two
cells, box-drawing and block characters drawn as shapes so borders join at
any size, the five underline styles (in their own color), strikethrough
and overline, the cursor (block, bar, underline; a hollow box without the
focus; nothing in the blink's off phase), the selection (the setting's
color) over the current find match over other matches. Only rows that
changed are worked out again.

- WebGL2 draws the whole frame each time: a texture of one texel per cell
  for the backgrounds and one instanced quad per glyph from a glyph atlas,
  tinted in the shader; glyphs with colors of their own (emoji) keep them.
  The atlas is a canvas the glyphs are drawn into once, in the terminal
  font (the browser falls back for characters it lacks), at the device
  pixel ratio; it doubles when full (up to 4096 pixels square), then starts
  over.
- Canvas 2D, where WebGL2 is not available or its context was lost (a GPU
  reset, too many contexts), paints the rows that changed with glyphs the
  same atlas keeps per color. `?renderer=canvas` in the page's address
  chooses it.
- The cell is the width of "W" in the terminal font and its line height
  times `terminal.lineHeight`, in whole device pixels; it is measured again
  when the font, its size or the pixel ratio changes (another display, page
  zoom, the desktop app's zoom), which resizes the terminal. A zoom changes
  the pane's size and the pixel ratio at once, and the pane may see the new
  size first: a size measured at another ratio than the cells' measures the
  cells again before the grid.

**Input** (`vt/input.ts`). A key becomes the encoder's key event: the
physical key (`KeyboardEvent.code`), the modifiers, those the layout used
for the text (Shift for `A`), the text it types without Ctrl or Alt and its
character without Shift (the physical key's on a US layout where the
layout's is unknown, so Ctrl+С on a Russian layout is Ctrl+C). The encoder
reads the terminal's modes before every key, so each key reaches the
program in the encoding it asked for; the key table
(`web/src/__tests__/testdata/vt-keys.json`) pins the bytes. Cmd shortcuts,
input method composition and dead keys stay with the browser: their text
arrives as input events and goes to the program as UTF-8. On macOS Option
types its characters unless `terminal.optionIsMeta` is on (Ghostty's
Option-as-Alt); AltGr types characters on other systems. Releases reach
programs that asked for them. Pastes are bracketed when the program asked,
with unsafe control characters replaced and, unbracketed, newlines as
returns. Focus changes are reported to programs that asked (mode 1004).

**In the page** (`vt/pane.ts`, `components/TerminalView.tsx`,
`components/Workspace.tsx`)

- The selected tab's panes are placed by their shares of the tab's split
  tree, each a header ([04](04-layout-and-keyboard.md)) above its terminal;
  a pane keeps its terminal while the tree around it changes. Dragging a
  split's handle sets its ratio in the layout document.
- A terminal attaches once its grid is known, with `terminal.scrollback`
  lines of history (a read-only page observes and follows the terminal's
  size instead). Output goes into the emulator and the next animation frame
  draws it; the bytes drawn are then acknowledged, which returns the core's
  credit: a program floods at the speed the page draws, and a page that
  falls far behind gets a fresh paint ([22](22-terminal-protocol.md)). A
  new attach (after a reconnect) starts a new emulator, which the first
  paint fills. A program's end shows how it ended; its pane goes when the
  core reports it ([22](22-terminal-protocol.md)).
- A pane's size follows its element; a new grid resizes the emulator and
  the terminal. The focused pane has the keyboard; focus and blur go to the
  core (a turn an agent ended is seen when its terminal has the focus,
  [25](25-agent-detection.md)) and, when asked for, to the program.
- Mouse: where the program asked for mouse events (and Shift is not held,
  and the page is not read-only), presses, releases and moves with a button
  go to it, encoded at the pixel position; moves without a button go to
  programs that track every motion. The right button opens the pane's text
  menu instead. Elsewhere the left button selects: Ghostty's gesture state
  machine (a click, a double click for a word, a triple click for a line);
  held past the top or bottom edge it scrolls the
  scrollback; `terminal.copyOnSelect` copies at release; typing ends the
  selection. The wheel goes to programs tracking the mouse as wheel
  buttons, to programs on the alternate screen as arrow keys (Ghostty's
  alternate scroll), and otherwise scrolls the scrollback; typing returns
  to the bottom. A scrollbar shows over a terminal with scrollback.
- Text of the selection is Ghostty's formatter's: soft-wrapped lines
  joined, trailing blanks trimmed. ⌘C/Ctrl+C in the browser's copy event
  and the menu's **Copy** copy it; without one, the text a program copied
  from its own selection (below).
- Links: with ⌘/Ctrl held, OSC 8 hyperlinks (`http`, `https`, `mailto`) and
  URLs or paths in the text are underlined, also a path wrapped over
  several rows (`terminal/links.ts`); a click opens URLs in a new tab and
  paths in a preview or VS Code pane of the terminal's workspace
  ([06](06-quick-look-and-files.md)).
  Formulas under the resting pointer are shown typeset
  ([19](19-formulas-in-panes.md)).
- The text menu (right click) has **Copy**, **Paste** (where the browser
  offers the clipboard API), **Find…**, the URL or path under the pointer
  or selected, and downloads ([06](06-quick-look-and-files.md)).
- Files pasted or dropped on a terminal are pasted as their paths, uploaded
  first when they are not on the terminal's machine (`drop.ts`,
  [06](06-quick-look-and-files.md)).
- Bell: `terminal.bell` flashes the pane, beeps or does nothing.
- Programs' clipboard writes (OSC 52, up to Ghostty's limit;
  `vt/clipboard.ts`), by `terminal.programClipboard`: **Automatic** copies
  at once when the write arrives within 10 s of this page's last key, text,
  paste or button press in a terminal, or of the release of a button the
  program tracks (a program copies what was dragged over at the release,
  however long the drag took), and the browser allows it, with a
  toast saying what was copied; otherwise, or when the browser refuses, a
  toast offers **Copy** (5 s). **Ask** always asks; **Off** ignores them. A
  copy that passed the automatic gate is kept for the menu's **Copy** and
  ⌘C for 2 minutes or until the next key or button press in a terminal.
  Reading the clipboard (OSC 52 `?`) is not answered.
- Which programs copy this way is theirs to decide. Claude Code writes
  OSC 52 for its selection. Codex writes the clipboard of the machine it
  runs on and adds OSC 52 only where it finds a multiplexer or an ssh
  session (`SSH_CONNECTION`), so the terminals of ssh machines carry the
  agent's ssh session ([21](21-terminal-core.md), `terminal.sshEnv`); on
  the local machine its own copy is already the user's clipboard when the
  page runs there. Codex copies on release unless its `copy_on_select` is
  off; its `auto` copies in a terminal that says it is Ghostty without a
  version, which is what herdr-core tells every program
  (`TERM_PROGRAM=ghostty`, [21](21-terminal-core.md)), whatever terminal
  the core was started from.
- Find (`vt/find.ts`, `components/FindBar.tsx`): the `find.open` binding
  (⌘F on macOS, Ctrl+Shift+F elsewhere in browsers) or **Find…** in the
  menu opens a bar at the terminal's top right corner, with a one-line
  selection as the query. The emulator searches its screen and scrollback
  for the text, ASCII letters in either case; the newest match is current
  after typing, Enter (or `find.next`) goes to the next older one and
  Shift+Enter (or `find.previous`) to the next newer one, wrapping around;
  the view scrolls to the current match. Matches on the screen are
  highlighted, the current one stronger, and kept current as output
  arrives. Escape closes the bar and gives the terminal its keys back.

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js | Its own parsing, key encodings and quirks; Ghostty's library brings a desktop terminal's emulation, key, mouse and paste encoders, selections, search and formatter to the page. |
| A cell grid rendered on the machine (the previous design) | Needs a renderer on every machine; one browser owned the session at a time; scrollback, selections and find were a round trip each. |
| Reading the screen from the terminal core (`terminal.read`) instead of emulating | A request per change, no scrollback in the page, and the page could not answer programs or encode keys for their modes. |
| A small zig or C module of our own linking the library with JavaScript imports | Needs zig in every build; the trampoline module gives the library's callbacks without changing the library. |
| Polling the emulator for replies, titles and bells after each write | Replies would be late and ordered differently from Ghostty's, and events between two polls could be lost. |
| Canvas 2D only | Every glyph costs a draw call on the CPU; a full screen of a busy program at a high pixel ratio takes milliseconds per frame. |
| One canvas per tab | The panes' layout would have to be drawn in the canvas; with a canvas per pane the split tree stays HTML and a pane keeps its terminal while the tree changes. |
| Keeping the terminals of hidden tabs attached | Every hidden terminal's output would cross the connection and be emulated; attaching again brings the screen and its history. |
| Building the module in CI | CI would need zig and Ghostty's dependencies; the build is reproducible, so the committed module's digest is checked instead. |
| Regular expressions and whole words in find (the previous design) | The emulator's search finds text; regular expressions would need a search of the agent's over the terminal's text. |

## Failure modes

- **The module does not load** (an old browser without WebAssembly, a CSP
  that refuses it) → terminals stay empty; the core's CSP allows it
  (`'wasm-unsafe-eval'`).
- **No WebGL2, or its context lost** → Canvas 2D, slower for large busy
  screens.
- **The page draws slower than a program writes** → the core stops sending
  at 256 KiB unacknowledged; 4 MiB behind it sends a new paint and the
  page skips the backlog.
- **The connection drops** → streams end with `disconnected`; terminals
  attach again when it is back, with a new paint.
- **The terminal font loads late** → terminals draw with the fallbacks and
  are measured again when it arrives, which resizes them.
- **A character the font and its fallbacks draw wider than its cells**
  (some symbols) → clipped to its cells and a third of a cell beyond.
- **The emulator and the terminal core disagree about a character's width**
  → the cursor is off on that row until the program redraws it.
- **A program writes the clipboard without the user's input** → it is
  offered, not copied.

## Security

The CSP of the UI allows compiling WebAssembly (`'wasm-unsafe-eval'`), not
`eval` or inline scripts; the module is served from the core like the
page's scripts. Programs' clipboard writes follow the setting above and
reads are refused; only `http`, `https` and `mailto` hyperlinks open. See
[SECURITY.md](../../SECURITY.md).

## Testing

`web/src/__tests__/vt.test.ts` loads the module in Node: the trampoline,
layouts, text into cells with colors and attributes, bold as bright, wide
characters and grapheme clusters, reflow on resize, answers through the
callbacks (device attributes, cursor position, colors, the color scheme),
bells and titles, OSC 52, the cursor, scrolling the scrollback, selections
by gesture and their text, find, hyperlinks; the mouse, paste and focus
encoders; every row of the key table in legacy, application and kitty
modes; and `drawRow` (colors, inverse, invisible, faint, wide characters,
shapes, underline styles, highlights, cursor styles, links and formulas).
`terms.test.ts` (the layout document's reading and writing, other clients'
versions, ended programs, terminals asked for early, attention order),
`termOptions.test.ts` (the terminal settings as the emulator's options,
the font stack before and after the bundled font loads, the colors'
contrast), `clipToast.test.ts`, `paneHeader.test.ts`, `menus.test.ts`,
`desktop.test.ts` (closing at once, terminals ending after the time to undo), `drop.test.ts`,
`codePanes.test.ts` (paths from a terminal opened in panes beside it). In
headless Chromium against a dev core: a shell
with colors, 256 and true colors, box drawing, CJK and emoji; typing; vim
(alternate screen, application cursor keys, mouse); resizing; splits, new
tabs and workspaces; find; selection and copy; the wheel in the
scrollback; font size and a palette color changed live; WebGL and Canvas 2D
(WebGL disabled, pixel ratio 2); an agent's states in the sidebar; and a
flood of 200 000 lines without a dropped frame.

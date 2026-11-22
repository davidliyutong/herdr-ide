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
  program's end shows how it ended; its pane goes when the
  core reports it ([22](22-terminal-protocol.md)), unless the terminal
  ended with its core and is started again
  ([33](33-workspace-restore.md)). A pane whose program ended stays
  closed only while its terminal does: when the terminal's record is live
  again with another pid than the program whose stream ended (the
  terminal core started a new shell at a kept terminal's address after a
  stop or a restart; `TerminalView` hands the record's pid to
  `TermPane.setProgram`), the pane drops the notice of the end and
  attaches again, which brings back the saved output and the agent
  ([36](36-terminal-history.md), [33](33-workspace-restore.md)); a
  terminal that finished, or still runs the program that ended, stays
  closed.
- A stream that ends with `disconnected` is attached again, with a new
  emulator that the first paint fills and whose view goes back where it
  was scrolled (below): when the page's connection to the
  core is back, and, since a machine or its terminal core going away ends
  its streams while that connection stays, whenever the machine's
  terminals are there again (the snapshot its backend sends;
  `TermModel.onTerminals` in `state/terms.ts`, `onConnection` in
  `TerminalView`). An attach the core refuses (a terminal whose shell
  herdr-core is starting again answers unavailable for a moment,
  [33](33-workspace-restore.md)) is tried again up to 5 times, 1.5 s
  apart (`ATTACH_RETRIES`, `ATTACH_RETRY_MS` in `vt/pane.ts`), and after
  those once more each time the connection or the machine's terminals
  come back.
- The first paint of an attach is not drawn piecemeal. The screen and its
  history come as output like any other, in as many frames as their size
  and the stream's credit make of them, and the protocol has no mark for
  the paint's end; drawn as it came, the history ran past before the
  screen stood, which showed when turning to a busy agent. The paint
  comes in bulk (on a local core one of 374 KB came as 23 frames of
  16 KiB within 2 ms), so after an attach nothing is drawn until the bulk
  pauses (`PAINT_QUIET_MS`, `PAINT_QUIET_LONG_MS`, `PAINT_MAX_MS`,
  `PAINT_BULK`, `PAINT_ONE_CREDIT` in `vt/pane.ts`):
  - a frame of at least 4096 bytes is bulk and puts the paint's end off:
    to 40 ms after it while the paint is at most 192 KiB (it fits the
    credit and comes at once), to 250 ms after it once the paint is
    larger (its next part waits for the credit returned);
  - a smaller frame is a program's own output (an agent at work writes a
    spinner every few tens of milliseconds) and never puts the end off:
    the paint ends 40 ms after it, or sooner if it was to end sooner;
  - 600 ms after the attach the screen is drawn, whatever has come, for a
    program that writes in bulk without a pause.

  Meanwhile the emulator takes the output and its bytes are acknowledged
  at once, so the rest of the paint is not held back, and a bell in the
  history painted does not ring.
- The terminals shown last stay in the page while another tab, workspace
  or machine is shown (`keptPanes.ts`, `TabView` in
  `components/Workspace.tsx`): as many as the setting
  `performance.keptTerminals` says besides the ones shown (12 by default,
  0 to 64, 0 keeps none; [13](13-settings-and-appearance.md)), the latest
  first, each still mounted and attached, hidden, at the place and size it
  had. A kept terminal's emulator takes the output; it draws nothing,
  measures nothing (it keeps the grid it had, so the terminal is not
  resized), shows no formula and rings no bell (`TerminalView`'s `shown`,
  `TermPane.setShown`). It also gives up what it draws with: its renderer
  is disposed, which hands back the WebGL context (a page has about 16)
  and the glyph atlas's texture, and its canvas is replaced by one of no
  size. A kept terminal thus costs a stream and an emulator with its
  scrollback, and the terminals holding a context are the ones shown.
  The emulator is the cost: measured in Chromium on a local core, 4
  terminals of 127 columns with a full scrollback of 10 000 lines grew
  the emulators' WebAssembly memory from 0.4 MB to 47 MB, about 11 MB
  each, and an idle terminal with little history takes a small fraction
  of that. WebAssembly memory is reused, not returned, after an emulator
  is disposed.
  Output that arrives while a terminal is hidden goes into its emulator
  and is acknowledged at once, without being drawn, so a hidden terminal
  keeps up with its program ([22](22-terminal-protocol.md)). Coming back to it shows it at once,
  where the user had scrolled it: it gets a new renderer and is measured
  and drawn again, with no new attach. A terminal shown longer ago than
  the ones kept, or one whose pane closed, is unmounted and detached;
  shown again, it attaches again with a new emulator, is painted anew and
  scrolled where it was (below). The kept terminals are the page's own,
  by machine and address, and are forgotten with the page.
- A plugin may draw over a shown terminal's pane, in a layer below the
  pane's header that takes none of the terminal's room (a surface,
  [27](27-plugins.md); the agents plugin's conversation,
  [35](35-agent-native-view.md)). What surfaces cover of a terminal is the
  strongest of what each says as the pane is rendered and what each sets
  while mounted (`state/covers.ts`): all of it, a part (the terminal is
  drawn under it as usual) or nothing. A terminal covered all is like a
  kept one in that it draws nothing, shows no formula, rings no bell and
  gives up its renderer, and like a shown one in that it is laid out at
  its pane's size: it measures its grid, attaches with it (the first time
  too), follows the pane's size and takes its output, acknowledged at
  once (`TermPane.setShown(shown, covered)`, `TerminalView`'s `covered`).
  It has neither the pane's focus nor a stop of the Tab key; one covered
  while it has the keyboard hands it to the surface that takes the pane's
  focus. Text pasted or typed into the pane still reaches the terminal. A
  pane going from kept to covered makes no renderer on the way; kept
  panes draw no surface.
- A terminal may have a prelude (`state/preludes.ts`): output of the
  terminal from before its program was replaced, which the terminal
  history plugin gives ([36](36-terminal-history.md)). Each new emulator
  of the pane gets it before the first byte of its stream, written at the
  grid its snapshot was painted at (from the history list and the read's
  headers, at most 1000 by 500; else at the pane's grid): its bytes; then
  a complete reset (`PRELUDE_RESET` in `vt/pane.ts`), since the bytes are
  a program's output and as untrusted: CAN, an OSC 8 hyperlink closed, the
  main screen (`ESC[?1049l` and the older forms; a program's alternate
  screen is not kept), a soft reset and plain styles on both screens, the
  kitty keyboard flags popped and cleared on both screens,
  modifyOtherKeys off, normal cursor and keypad keys, mouse, focus,
  bracketed-paste, color-scheme and in-band size reports off, no
  synchronized output held, reverse video and LNM off, and the palette,
  foreground, background and cursor colors and the cursor style of the
  settings, so that no mode, color or link the bytes set reaches the live
  terminal, also when the core sends no first paint; then its note, dim,
  on the line below the last row with something on it (a character or a
  background), also when the output's cursor was above it; and as many
  newlines as that grid has rows, which move every row up to that one into
  the scrollback, the cursor left at the top of the blank screen. The
  emulator then goes back to the pane's grid (an observer's follows the
  core's resize), so every saved line stays in the scrollback. The first
  paint clears only the screen ([21](21-terminal-core.md)), so the prelude
  stays above the terminal's own history in the same scrollback, found by
  find and selected and copied as the rest. While it is written nothing
  the emulator answers (device attributes, cursor and mode reports, color
  and size queries) is sent to the program, and titles, clipboard writes,
  bells and synchronized-output holds are dropped. A prelude that
  appears, changes or goes while the pane is attached makes it attach
  again once its changes paused for 50 ms (the core keeps the program's
  stream meanwhile; the program sees nothing); one attaching checks again
  once attached. While the pane attaches again for a prelude, what is
  typed or pasted waits (up to 64 KiB, `SEND_QUEUE_MAX`) and is sent on the
  new stream; it is dropped if that attach fails or the pane goes.
  Preludes live in the page's memory, at most 2 MiB each, by machine and
  address.
- Leaving a terminal does not resize it. A pane that is unmounted
  detaches, and a page that closes leaves, but the core keeps
  the stream of a terminal's last viewer attached to the terminal core,
  unread, until the terminal's next viewer has attached
  ([22](22-terminal-protocol.md)). The terminal therefore keeps the size
  its pane had instead of getting herdr-core's headless size (200x120 by
  default, [21](21-terminal-core.md)) while no page shows it, and the
  pane that attaches next, of the same size, resizes nothing and gets an
  exact first paint. This is for full-screen programs (Claude Code, which
  draws on the alternate screen and scrolls its transcript itself; Codex):
  laid out for 200x120 at a detach and for the pane again at the next
  attach, Claude Code lost its own scroll position, and the first paint
  showed the 200x120 layout until the program drew again. The size is
  kept while a page is subscribed to the machine's terminals; 10 s after
  the last one left, the core's connection to the terminal core closes
  and the terminals get the headless size.
- The place a terminal was scrolled to outlives its emulator
  (`vt/scrollMemory.ts`; `TermPane.noteScroll`, `restoreScroll` and
  `frameText` in `vt/pane.ts`). A pane that is unmounted, or attached
  again after its machine or the connection was away, gets a new
  emulator, which the first paint fills at the end. Before the old
  emulator goes, the pane notes the place: the text of the first 3 rows
  shown (`ANCHOR_ROWS`) and the scrollbar's numbers, which give the
  distance from the end. A terminal at the end, or on the alternate
  screen (whose program draws it again and has no history), notes
  nothing and forgets a place noted before. When the first paint is in,
  the rows are looked for in the new emulator: in the screen at the same
  distance from the end first, then upward a screen at a time, the
  nearest rows first, through at most 200 screens (`MAX_SCREENS`) or to
  the top; the view
  goes where they are, else as far from the end as it was. Rows that are
  all blank are no mark, and the distance alone is used. The places are
  kept in the page's memory, by machine and address, for at most 200
  terminals (`MAX_REMEMBERED`; the ones noted longest ago go first), and
  each is used once.
- A pane's size follows its element; a new grid resizes the emulator and
  the terminal. The focused pane has the keyboard; focus and blur go to the
  core (a turn an agent ended is seen when its terminal has the focus,
  [25](25-agent-detection.md)) and, when asked for, to the program. A
  pane that has the keyboard when it attaches anew tells the program so
  again at the end of the first paint, when the paint brought mode 1004:
  the program was told of the loss when the pane before lost the focus
  or let go of its stream, and the new emulator knows the mode only from
  the paint.
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
| Keeping every terminal of hidden tabs, workspaces and machines attached | The streams and the emulators with their scrollback would grow with every terminal ever shown; the ones shown last, as many as the setting says, cover going back and forth between the tabs in use. |
| A fixed number of kept terminals (6, the previous design) | What a kept terminal costs is memory, an emulator with up to `terminal.scrollback` lines, and how much of it there is to spend differs per computer; the number is a setting, with 0 for none. |
| Kept terminals keeping their renderers (the previous design) | Every renderer holds a WebGL context and a page has about 16: the kept terminals and the ones shown together reach that, and the browser then takes a context from a terminal, which draws with Canvas 2D from then on. A hidden terminal draws nothing, so it holds none. |
| Detaching every terminal that is not shown (the previous design) | Every return attached again: the pane stayed empty until the screen and its history were painted anew, the selection went with the emulator, and the place the user had scrolled to was lost then; it is found again now, by its text, for the terminals beyond the ones kept. |
| Keeping a terminal's size by passing the pane's as `size` with `terminal.run` | herdr-core uses it only until the terminal's first viewer attaches; a terminal whose viewers left gets the headless size whatever it was started with. |
| The page holding a hidden stream of no size on each terminal it does not show, to keep the size | What herdr-core does with a viewer of no size is not part of its API; the stream of the viewer that left is a viewer as herdr-core describes them. |
| Writing the size into `headless` of herdr-core's `config.toml` | The file is the user's own, shared with their other herdr-core sessions; herdr-ide never writes it. |
| Closing the last viewer's stream and letting the next attach resize the terminal (the previous design) | The terminal was 200x120 between two viewers: a full-screen program was laid out twice around every detach and attach, lost its own scroll position and was first painted in the wrong layout. |
| Finding the place scrolled to by its row number from the top | The paint's history is the terminal core's, which may be cut at the top where the page's was not: a paint brought 2870 rows where the page's emulator had 3003. |
| Finding the place by its distance from the end alone | The program writes while its terminal is away, which moves the place up: with 100 rows written meanwhile the view came back 105 rows off by its number and exactly by its text. The distance is where the search starts, and what is used when the rows are not found. |
| Drawing the first paint as it arrives (the previous design) | The history ran past before the screen stood, for as long as the paint took to cross the connection; on a local core, where a paint arrives within milliseconds, one frame of the middle of the history was still drawn before the screen. |
| Every frame putting the first paint's end off (the first version of the rule, with 1.5 s as the latest) | An agent at work writes a small frame every few tens of milliseconds, and each started the wait again: the pane of a working Codex stayed blank until the latest time. Only bulk puts the end off now, and the latest time is 600 ms. |
| Waiting for a mark that ends the first paint | The terminal protocol has none: the paint is output like any other, so the page takes a pause in the output for its end. |
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
  attach again when it is back, the kept ones too, with a new paint,
  scrolled where they were.
- **A machine or its terminal core goes away while the page's connection
  stays** → its streams end with `disconnected`; its terminals, shown and
  kept, attach again when the machine's terminals are there again, with a
  new paint, scrolled where they were. The streams the core kept went
  with its connection, so the terminals had the headless size meanwhile
  and are resized once.
- **No page is connected to a machine's terminals for 10 s** (every page
  closed, the core started again) → its terminals get herdr-core's
  headless size; the next pane resizes its terminal once, and a
  full-screen program lays itself out again.
- **A pane attaches with another size than the terminal has** (another
  window, another font size) → the terminal is resized once, as between
  two pages.
- **The page is loaded anew** → the places terminals were scrolled to are
  forgotten with the page; its terminals are painted at the end.
- **The rows noted are not found** (they scrolled out of the terminal
  core's history, or a pane of another width wraps them otherwise) → the
  view goes as far from the end as it was, to the top of a history
  shorter than that.
- **The same three rows occur more than once** (a program repeating its
  output) → the view goes to the ones found first: in the screen at the
  place's distance from the end, else the nearest above it.
- **More than 200 terminals were left scrolled up** → the places noted
  longest ago are forgotten; those terminals are painted at the end.
- **The core refuses an attach** → it is tried again 5 times, 1.5 s
  apart, then once at each return of the connection or of the machine's
  terminals; the pane is empty meanwhile.
- **A program writes in bulk without a pause while its terminal attaches**
  → the screen is drawn 600 ms after the attach, whatever has arrived by
  then.
- **The page shows no tab** (a machine whose layout is not read yet, a
  workspace without tabs) → the kept terminals are unmounted with the
  tab's panes, detached and forgotten; each attaches again when it is
  next shown.
- **The output pauses in the middle of the first paint** (a slow
  connection) → the part that came is drawn, and the rest as it comes.
- **The terminal font loads late** → terminals draw with the fallbacks and
  are measured again when it arrives, which resizes them.
- **A character the font and its fallbacks draw wider than its cells**
  (some symbols) → clipped to its cells and a third of a cell beyond.
- **The emulator and the terminal core disagree about a character's width**
  → the cursor is off on that row until the program redraws it.
- **A program writes the clipboard without the user's input** → it is
  offered, not copied.
- **A prelude of another grid size** (the terminal was captured at another
  width or height) → written at its own grid, every saved line kept. One
  whose grid is not known or beyond 1000 by 500 is written at the pane's
  grid, where on a taller pane the lines right above the saved screen are
  lost.
- **Input while the pane attaches again for a prelude** (a few tens of
  milliseconds) → it waits for the new stream, but is encoded by the new
  emulator before the first paint brought the program's modes: a paste
  then is not bracketed, and keys are encoded as a new terminal's.
- **The terminal core stops and starts again while a page is open** → the
  panes of kept terminals show that their program ended, then attach again
  once the core started a new shell at their addresses, without a reload.
- **A plugin's surface fails while drawing** → its error shows in its
  place with **Try Again**, and the rest of the page goes on; a surface
  whose `covers` throws covers nothing.

## Security

The CSP of the UI allows compiling WebAssembly (`'wasm-unsafe-eval'`), not
`eval` or inline scripts; the module is served from the core like the
page's scripts. Programs' clipboard writes follow the setting above and
reads are refused; only `http`, `https` and `mailto` hyperlinks open. The
rows noted for the place a terminal was scrolled to are text of its screen
held in the page's memory only, neither stored nor sent; so is a
prelude, written into the emulator as untrusted output, with its answers,
titles, clipboard writes, bells and synchronized-output holds dropped and
a complete reset after it. The stream the core keeps for a terminal's size
belongs to no client. See
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
`keptPanes.test.ts` (the terminals shown before kept, the latest first,
not the ones shown; one that closed and those shown longest ago dropped;
fewer kept with a smaller limit and none with 0),
`scrollMemory.test.ts` (a terminal scrolled up noted by its first rows
and taken once, none noted at the end; the terminals noted longest ago
forgotten beyond the bound; the rows found at once in the same history,
above the place after the program wrote, and in a history cut at the
top; the distance from the end when the rows are gone, wrap otherwise or
are blank),
`perf.test.tsx` (the terminals shown and kept and the ones holding a
WebGL context counted, [13](13-settings-and-appearance.md)),
`terms.test.ts` (the layout document's reading and writing, other clients'
versions, ended programs, terminals asked for early, attention order),
`termPane.test.ts` (a covered terminal attaching with its pane's grid,
following its size and drawing nothing, drawn again without a new attach,
a kept one never attached staying so; a prelude written before the
stream's first byte and kept above the first paint, of an alternate
screen, with and without its note, its answers dropped, one that comes
while attached or attaching making one new attach, one painted at
another grid (24 rows into 50, 50 into 24, other widths) keeping every
saved line, an observer's saved lines kept through the core's resize
before its first paint, hostile
output leaving none of its state to the live terminal with and without a
first paint, every mode flipped on both screens brought back to a new
emulator's, input kept while it attaches again, at most 64 KiB, dropped
when that attach fails or the pane goes; a pane whose program ended
attaching again once when the terminal has another program, staying
closed while it is finished or runs the program that ended),
`terminalViewProgram.test.tsx` (the record's program handed to the pane
while live, the notice of the end taken away when it has another),
`surfaces.test.ts` and `surfaceFocus.test.ts` (surfaces drawn over the
terminal, the strongest cover, owners, the pane's focus and keyboard
going to the surface),
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
flood of 200 000 lines without a dropped frame. With Claude Code 2.1.329
on a dev core and `performance.keptTerminals` 0, so that its pane was
unmounted when another tab was shown: the terminal's record stayed 127x38
and Claude Code's view came back at the same rows at three positions, one
of which went to the end before. The core's side is tested in
`internal/server/term_test.go` ([22](22-terminal-protocol.md)).

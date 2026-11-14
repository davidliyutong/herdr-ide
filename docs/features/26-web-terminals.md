# 26 · Web terminals

## Context

The terminal core ([21](21-terminal-core.md)) hands each viewer a terminal's
raw output and takes the bytes the viewer's own terminal encodes
([22](22-terminal-protocol.md)): every client emulates the terminals it
shows. The macOS application does this with Ghostty
([23](23-macos-application.md)). The browser UI (also what the desktop app
shows) needs an emulator too, one that parses, keeps scrollback, encodes
keys and mouse events and answers programs the same way, so that a program
behaves alike in both clients. This document describes that emulator and
its renderer; the browser's panes still come from herdr
([03](03-pane-rendering-and-input.md)).

## Goals / non-goals

Goals: the emulator the macOS application uses, from the same Ghostty
commit; every `terminal.*` setting honoured; a terminal that keeps up with
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
`cf5519b22f91` (the macOS application's, `scripts/fetch-ghostty.sh`):
`zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`
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
(and 2 KiB a line as the byte bound, as the macOS application gives
Ghostty), `terminal.cursorStyle` and `terminal.cursorBlink` as the cursor a
program's reset returns to, `terminal.boldIsBright`; grapheme clusters take
the width Unicode gives them (mode 2027 on, as in Ghostty's application).
Callbacks: the terminal's answers to programs (device attributes, cursor
position, colors, modes, size reports) go back as automatic input, bells,
titles, clipboard writes (OSC 52), the color scheme query (`CSI ? 996 n`,
from the theme) and synchronized output (mode 2026: the screen is drawn
when the program lets go, after 1 s at the latest). A frame of the screen is
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
  zoom), which resizes the terminal.

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

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js | A second emulator beside the macOS application's, with its own parsing, key encodings and quirks; programs would behave differently in the two clients. |
| Reading the screen from the terminal core (`terminal.read`) instead of emulating | A request per change, no scrollback in the page, and the page could not answer programs or encode keys for their modes. |
| A small zig or C module of our own linking the library with JavaScript imports | Needs zig in every build; the trampoline module gives the library's callbacks without changing the library. |
| Polling the emulator for replies, titles and bells after each write | Replies would be late and ordered differently from Ghostty's, and events between two polls could be lost. |
| Canvas 2D only | Every glyph costs a draw call on the CPU; a full screen of a busy program at a high pixel ratio takes milliseconds per frame. |
| One canvas per tab | The panes' layout would have to be drawn in the canvas; with a canvas per pane the split tree stays HTML and a pane keeps its terminal while the tree changes. |
| Building the module in CI | CI would need zig and Ghostty's dependencies; the build is reproducible, so the committed module's digest is checked instead. |

## Failure modes

- **The module does not load** (an old browser without WebAssembly, a CSP
  that refuses it) → no terminal can be shown; the core's CSP allows it
  (`'wasm-unsafe-eval'`).
- **No WebGL2, or its context lost** → Canvas 2D, slower for large busy
  screens.
- **The terminal font loads late** → terminals draw with the fallbacks and
  are measured again when it arrives.
- **A character the font and its fallbacks draw wider than its cells**
  (some symbols) → clipped to its cells and a third of a cell beyond.

## Security

The CSP of the UI allows compiling WebAssembly (`'wasm-unsafe-eval'`), not
`eval` or inline scripts; the module is served from the core like the
page's scripts. See [SECURITY.md](../../SECURITY.md).

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

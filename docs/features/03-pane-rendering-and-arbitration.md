# 03 · Pane rendering and arbitration

## Context

Each pane must feel like a native terminal: Chinese input methods, mouse in
TUIs (vim, htop, coding agents), scrollback, paste, Shift+Enter for agent
prompts, correct wide characters. herdr renders panes itself and sends ANSI
frames ([01](01-herdr-integration.md)). The web UI may be open in several
browsers at once (desk, laptop, tablet), while herdr allows one controller
per pane whose size becomes the PTY size.

## Goals / non-goals

Goals: one xterm.js per visible pane; input, mouse and scroll routed to the
application exactly as herdr would; several browsers viewing the same pane
without fighting over its size or corrupting the screen.

Non-goals: local scrollback search (scrollback lives in herdr), terminal
graphics protocols (dropped by the stream).

## Design

**Rendering** (`web/src/terminal/TermController.ts`)

- xterm.js 6 with WebGL (DOM fallback), Unicode 11 widths, `scrollback: 0`.
  herdr positions every wide character explicitly, so width tables never
  drift.
- Binary frames `[sid][flags][cols][rows][ANSI]` are written as-is. A stream
  `open` event resets the terminal; a frame of a different size resizes it
  first.

**Input mapping**

| Browser event | Sent to herdr |
| --- | --- |
| `onData` / `onBinary` | `terminal.input` (text or base64 bytes) |
| paste | wrapped in bracketed-paste markers; herdr re-pastes according to the pane's own mode |
| Shift+Enter | `ESC CR` (newline in Claude Code and similar prompts) |
| wheel | `terminal.scroll` with cell position and modifiers; herdr routes it to the app or to its scrollback |
| mouse down/drag/up | `terminal.mouse`; herdr drops it unless the app enabled mouse reporting |
| Alt/Option-drag | local selection only |
| ⌘ shortcuts | left to the browser (copy, paste) |
| prefix key | app keymap ([04](04-layout-and-keyboard.md)) |

**Arbitration** (`internal/server/arbiter.go`)

- Per pane, the core tracks viewers (browser, stream id, container size,
  last activity) and one controller.
- A joining viewer becomes controller if there is none; otherwise it opens an
  **observe** stream at the controller's size and the UI scales it down to
  fit.
- Typing, clicking or scrolling in an observed pane sends `claim`: the
  claimant opens a control stream with takeover at its own size, the previous
  controller and other observers reopen observe streams at the new size. The
  UI queues the input that triggered the claim and replays it once control is
  granted.
- When the controller leaves, the most recently active viewer takes over.
- A takeover from outside the core (another core, the herdr CLI) turns the
  viewer into an observer with a notice code.
- Every switch opens a fresh stream, which starts with a full frame; frames
  from superseded streams are dropped by generation number.
- `resize` from the controller is forwarded to herdr outside the global lock
  so a stalled machine cannot freeze other panes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| One shared control stream fanned out to all browsers | Frames are diffs; a late joiner cannot render without a full frame, and replay logs or forced redraws (resize jiggle) disturb applications. |
| Every browser takes over on attach | Browsers fight; panes resize back and forth. |
| xterm.js scrollback | Frames redraw the viewport; local scrollback would fill with duplicates. herdr's scrollback is the source of truth. |
| ghostty-web instead of xterm.js | Promising, but xterm.js is mature in Chromium and WebKit and herdr already does the emulation. |

## Failure modes

- **Pane gone or stream error** → overlay with herdr's reason and a reconnect
  button.
- **Browser send queue overflow** (a client far behind) → the core drops that
  WebSocket; the client reconnects and reattaches with fresh full frames.
- **Browser reconnects** → all panes reattach; pending API requests are
  rejected and never replayed.

## Testing

`internal/server` tests (guards, allowlist) and the integration test for
stream semantics; the arbiter flow (join, claim, resize, leave) was exercised
with scripted WebSocket clients against a dev herdr session. Interactive
behavior (IME, vim mouse, scrollback) was verified in Chrome.

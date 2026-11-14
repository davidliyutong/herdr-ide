# 23 · macOS application

## Context

The browser UI draws every pane on a 2D canvas from cells the core
forwards, inside Electron on the desktop
([16](16-desktop-packaging.md)). Drawing is bound to one JavaScript thread
and a software text path. Ghostty's renderer draws a terminal grid on the
GPU with Metal, and its library builds for macOS; libghostty-spm packages
it for Swift with a backend whose bytes the host supplies, which is what
the core's terminal protocol delivers ([22](22-terminal-protocol.md)).

Facts the design relies on (libghostty-spm 2.2.2026111302, Ghostty at
`cf5519b22f91`):

- `InMemoryTerminalSession` takes output with `receive`, hands the bytes
  the terminal produces (keys encoded for the program's modes, pastes,
  mouse reports, answers to queries) to a `write` closure, and reports its
  grid to a `resize` closure. It does not tell a person's input from the
  terminal's own answers.
- One `TerminalController` holds the configuration of every surface; a
  `TerminalTheme` has a light and a dark variant that follow the system.
- SwiftPM's generated accessors look for a package's resource bundle at
  the root of the main bundle; Xcode's look in its resources.
- Fed 13 MB of output from a herdr-core on the same machine, a surface
  showed the end after 0.47 s.

## Goals / non-goals

Goals: terminals drawn by the GPU; the terminals of every machine the core
knows; workspaces, tabs and split panes that every client of a machine
shares; the same design language as the web UI (neutral greys, color only
for state, dense rows); English and Chinese.

Non-goals: the browser UI's file
browser, uploads and downloads, and its settings of the browser itself
(appearance, shortcuts); starting program windows from terminals of the
terminal core, which get no virtual display; Linux and Windows.

## Design

**TermKit** (`macos/Sources/TermKit`, no UI).

- `CoreSocket` is a `URLSessionWebSocketTask` to the core that reconnects
  after 0.5 s, doubling to 8 s; the two clients below are built on it.
- `TermConnection` is the client of `/api/v1/term`. It subscribes again
  after reconnecting; calls waiting fail with `unavailable` and open
  streams close with `disconnected`. A stream's delegate is registered when
  `attached` arrives, before the next message is read.
- `EventConnection` is the client of the event channel `/ws`, as the
  browser UI is. It decodes `machines`, `machine`, `gui`, `settings` and
  `keybindings` and ignores every other message; after reconnecting the
  core sends the whole state again.
- `TerminalStore` keeps each machine's backend state and terminal records
  from `backend`, `snapshot` and `event`, applying events as the core does.
- `Layout` is the machine's layout document, version 2
  ([22](22-terminal-protocol.md)): workspaces, each with tabs, each a tree
  whose leaves are terminals and whose splits have an axis and a ratio, as
  values with the document's operations; `JSONValue` holds the fields of a
  newer client so they are written back.
- `CoreProcess` starts the core from the bundle as the Electron shell does
  (`--parent-stdio`, instance `desktop`), but on `127.0.0.1:0`, and reads
  the URL from the core's ready line.

**App** (`macos/Sources/App`, AppKit).

- `AppModel` follows the machines and their program windows from the
  event channel's messages and subscribes to the machine the user selects,
  for the window's life: the first subscription makes the core install and
  start that machine's terminal core, so a machine nobody turned to gets
  none, and its row lists no terminals. It loads a machine's layout when
  its snapshot arrives, dropping terminals that no longer live; a layout
  without workspaces gets one named with the word for a workspace in the
  user's language. A terminal asked for while a machine's terminals or its
  layout are not ready opens when they are. Changes are written with
  `doc.set` and the version last read, one write at a time; a conflict or
  a `doc` event with another version loads the document again, so the
  arrangement another client made wins.
- A new terminal is the machine's shell (`terminal.run` without a
  command). A new tab starts in its workspace's directory, else in the
  directory of the focused terminal's foreground program; a split starts in
  the focused terminal's directory, else in the workspace's. Closing a
  terminal kills its program; a terminal that finishes or is removed leaves
  the layout, and a finished one is removed from the core.
- **Workspaces.** A new workspace (⌘N, or the machine's menu in the
  sidebar) asks for a name and a working directory, both optional (without
  a name it is called after its directory), selects it and opens a
  terminal there. Renaming (a double click on its row, or its menu) asks
  for the name; its menu also moves it up or down; closing removes the
  workspace and kills its terminals after asking, as the web UI does. The
  last workspace closed is replaced by an empty one. **Next / previous
  workspace** (`ctrl+b )` / `(`) cycle through the machine's workspaces,
  **Switch workspace** (`ctrl+b w`) opens the palette with every machine's
  workspaces, numbered.
- **Folders** dropped on the sidebar or on the Dock icon
  (`CFBundleDocumentTypes` for folders, `macos/xcode/Info.plist`) become
  workspaces on the local machine, one each, named after the folder; they
  wait up to 30 s for the local machine's terminals. Files that are not
  folders are skipped with a note.
- **Tabs.** A click selects a tab, a double click renames it (an empty
  name shows its terminal's title again), dragging moves it within the
  bar, and its menu renames, opens a terminal beside, moves left or right
  and closes it.
- **Panes** have a header: the agent's status dot, the pane's name (the
  `name` label, set by a double click or the header's menu) or terminal
  title, its directory, and buttons for VS Code, split right and down,
  zoom and close. Dragging the header onto another pane swaps the two
  (middle) or places the pane on that side (edges); onto a tab, beside
  that tab's focused terminal; onto the plus button, into a new tab
  (`Layout.drop`, `DragTracker`). **Zoom** (`ctrl+b z`) shows the focused
  pane alone in this window until zoomed again or the pane leaves the tab.
  **Focus left / right / up / down** (`ctrl+b h` `l` `k` `j`) move to the
  pane whose centre is nearest on that side (`Layout.neighbor`, the same
  rule as the web UI's, run on the vectors of `design/testdata/layout`).
- **Closing** a pane or a tab asks first when a program runs in front of
  a terminal's shell (`Activity.runningProgram`: the foreground process is
  not the shell itself, or an agent was detected), naming the programs;
  Cancel is the default button.
- **Command palette** (`ctrl+b space`, View menu): a sheet with a field and
  the commands this application runs with their keys and every
  workspace; ↑ ↓ choose, Return runs, Escape closes (`fuzzyMatch`).
- `TerminalPane` owns one Ghostty surface and one stream. It attaches when
  the surface first reports its grid, sends later grids as `resize`,
  passes output to the surface and acknowledges it, and writes the
  surface's bytes as input. Panes are kept by terminal, so a terminal
  keeps its surface and scrollback while the arrangement changes; a pane
  attaches again when the connection returns, and the first paint's reset
  redraws it.
- The window: a sidebar of machines, their workspaces (the selected one in
  bold, its directory) and live terminals (status dot from the agent the
  core detected there, else from the program's own report
  ([25](25-agent-detection.md)), working directory; those of no workspace
  under the machine; a machine's row counts the terminals that wait:
  blocked, or a turn that ended unseen), the windows of programs under
  the terminal they run in (or their machine), and for a remote machine's
  terminal **Enable Program Windows Here**, which types the display's
  variables into its shell or offers the command to copy when a program
  runs there ([14](14-gui-windows.md)),
  a tab bar of the selected workspace under a transparent title bar, and
  the selected tab's panes with draggable dividers. A workspace's row
  selects it, its plus button opens a terminal in it, and its menu creates
  terminals and renames or closes it. A machine's row shows why its terminals are unavailable,
  also for machines the window is not subscribed to (the machine state's
  `hc`), and its button opens a terminal, or signs in, retries or enables
  the machine when it is not connected.
- **Machines** (`MachineDialogs`, as the web UI's
  [02](02-multi-machine-transport.md)). **Add Machine…** (Shell menu, the
  sidebar's menus) asks for an ssh target and a name, checks the target as
  the core does (`Machine.validTarget`) and sends `POST /api/machines`;
  refusals name the core's code (`machine.error.*`). A machine added here
  that turns `auth_required` within two minutes gets its **login window**:
  a Ghostty terminal of this Mac fed by the core's PTY
  (`GET /api/m/{id}/auth?cols=&rows=`, `LoginWindow`), started with the
  surface's size; it closes when the machine connects or goes, and closing
  it ends the login. A machine's menu also signs in, retries the connection
  (`{"t": "retry"}` on the event channel), enables or disables it
  (`PUT /api/m/{id}/enabled`, disabling asks), renames
  (`PUT /api/m/{id}/label`) and removes an ssh machine after asking
  (`DELETE /api/m/{id}`: nothing on the machine is deleted), and starts,
  restarts or stops its terminal core (`POST /api/m/{id}/hc/{action}`;
  restarting and stopping ask; a refusal shows the core's code as a
  sentence). None of these show while the core is read-only.
- `Theme` holds the colors, in light
  and dark, and the metrics, whose values are the design tokens shared with
  the web UI ([24](24-design-tokens.md)); terminals use the web UI's
  default 16-color palette.
- **Find** (⌘F, ⌘G, ⇧⌘G). Ghostty searches the surface's screen and
  scrollback and marks the matches; the pane's find bar drives it with the
  binding actions `start_search`, `search:<text>`, `navigate_search:next`
  and `previous`, `end_search`, and shows the count and position Ghostty
  reports. A pane attaches with 10000 lines of history, so earlier output
  can be scrolled to and found.
- **Links**. A ⌘-click on a web or mail link opens it in its application.
  Anything else Ghostty found is taken as a path: `TerminalPath` drops a
  trailing `:line:column`, keeps absolute and `~` paths and joins others to
  the directory of the terminal's foreground program.
- **Quick Look** (`QuickLook.swift`). The path is fetched with
  `GET /api/m/<machine>/file` into a directory of its own in the
  temporary directory (0700; emptied before each preview and at quit) and
  shown in the system's Quick Look panel, which previews what macOS can:
  images, PDF, media, text, source code, archives. Files over 512 MiB,
  folders and missing files are reported in a sheet.
- **VS Code** (⌘J, `WebPanel.swift`). A panel takes half of the room
  beside the terminals and shows the core's code-server page
  (`/m/<machine>/code/?folder=…`) for the directory of the focused
  terminal in a `WKWebView`; the proxy's own page prepares code-server.
  The page is addressed as `localhost`, a secure context, which VS Code's
  web views need. The three most recently shown folders stay loaded. Only
  the core's origin loads in the panel; other links open in the browser.
  While a page has the keyboard, the terminal commands of the menu are
  off, so their keys reach VS Code.
- **Settings** (⌘,, `Settings.swift`). A window built from the core's
  definitions (`GET /api/settings`): a menu for a choice, a field for
  text, written with `PUT /api/settings` and read back. Names,
  descriptions and options are the web UI's strings for the same keys;
  per-machine values are set in the browser UI.
- **Program windows** (`GuiWindows.swift`). The event channel's `gui`
  messages list the windows on the machines' virtual displays
  ([14](14-gui-windows.md)); they appear under their machine in the
  sidebar, and one opens in a window of its own whose web view shows the
  core's page for it (frames, video, input). A window closes when its
  program's window goes.
- Menu: the application's (settings, keyboard shortcuts), Shell (new
  terminal, splits, workspaces, rename tab, close terminal or tab), Edit
  (copy, paste, find), View (palette, switch workspace, sidebar, VS Code,
  zoom, next and previous tab, workspace and pane, focus on a side) and
  Window. Each item shows the first single-stroke key the keybindings give
  its command; ⌘N, like the terminal commands, is off while VS Code has
  the keyboard, and the workspace commands wait for the machine's layout.
  A terminal with the keyboard takes the keys Ghostty binds before the
  menu sees them, and Ghostty binds most of these by default (new tab,
  splits, close, find, its own settings); the controller's configuration
  unbinds every key of the menu (`TerminalControllerBox.menuKeys`), so they
  reach the menu. A search Ghostty starts by itself shows the find bar as
  well.

**Building** (`scripts/fetch-ghostty.sh`, `scripts/macos-app.sh`,
`macos/xcode/project.yml`). `make macos-build` and `make macos-test` fetch
the pinned renderer into `macos/.deps/` (verified, see Security) and run
SwiftPM, which is how the package is developed and tested. `make macos-app`
builds the application that ships:

1. `scripts/build.sh` builds the core for this machine's architecture.
2. XcodeGen writes the Xcode project from `project.yml`: an application
   target over the same sources, with `TermKit` and Ghostty's package as
   local packages, the product name, bundle identifier
   (`dev.<slug>.mac`) and version from `internal/brand` and `VERSION`.
3. `xcodebuild` builds it unsigned. Xcode puts the packages' resource
   bundles and the localized strings into `Contents/Resources`
   (`Bundle.app` is the package's bundle under SwiftPM and the main bundle
   under Xcode).
4. The script adds the core to `Contents/Resources/bin` and the licenses,
   signs the core and then the bundle with the
   hardened runtime, and checks the result with
   `codesign --verify --deep --strict`. `SIGN_IDENTITY` names a Developer
   ID certificate; without it the signature is ad hoc, like the Electron
   application's. With `NOTARY_PROFILE` (a `notarytool` keychain profile)
   the bundle is notarized and the ticket stapled.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Ghostty's renderer through upstream's embedding API | Upstream surfaces start their own child process; no public call feeds a surface bytes. |
| libghostty-vt with a Metal renderer of our own | A stable API, but glyph atlases, font fallback, shaping, wide characters and images would be ours to write and keep. |
| A GPU renderer inside the Electron application | Keeps the web UI's process model and JavaScript thread between the bytes and the GPU; it is the browser UI's renderer, not a native one. |
| Assembling the bundle from SwiftPM's build | SwiftPM's resource accessors look for resource bundles at the root of the application bundle, which code signing does not seal: the bundle could not be signed as a whole. |
| A checked-in Xcode project | A generated file that conflicts on every change of the file list; `project.yml` is a few lines and the project is rebuilt from it. |
| Signing inside the Xcode build | The core is added after the build; a signature made before it would not cover it. |
| A universal application | The core inside is built for one architecture; an application that starts on the other and finds no core helps nobody. |
| Letting SwiftPM download the binary framework | The download is outside the build's verification and stalled in practice; the script checks a pinned digest. |
| The layout in the application's preferences | Each machine's arrangement would differ per client and be lost with the application's data; the terminal core keeps it beside the terminals it arranges. |
| Layout writes that overwrite | Two clients arranging the same machine would silently undo each other; versions make the later one read first. |
| Keeping a closed pane's program running | Programs nobody sees would accumulate in the terminal core; a terminal started elsewhere stays reachable from the sidebar. |
| A find of our own over `terminal.read` | The core's text has no cell positions to mark; Ghostty already searches what it draws and scrolls to the match. |
| The browser UI's Quick Look in a web view | The system's panel previews more kinds of files and behaves like every other application's. |
| A native editor instead of VS Code | VS Code with its extensions, on the machine, is the feature; the proxy and the bridge extension already serve it. |
| Subscribing to every machine at launch | Every connected machine would get a terminal core that outlives the application, used or not. |
| Polling `GET /api/machines` and `GET /api/gui` | A change shows up to 3 s late and every poll transfers every machine's state; `/ws` pushes each change once. |
| Opening a terminal into a layout not read yet | The document read afterwards would replace the layout and leave the terminal in no workspace; the terminal waits for the layout instead. |

## Failure modes

- **Bundled core missing, exiting or silent for 30 s** → an alert names
  it and the application quits; a core that ends later does the same.
- **Connection to the core lost** → panes keep their contents; the
  connection returns with backoff and panes attach again.
- **A machine's terminal backend not ready** → the empty state and the
  machine's row say why (the core's code, translated).
- **A menu shortcut bound in Ghostty** (a key added to the menu but not
  to `menuKeys`) → the terminal takes it and nothing happens; the debug
  action `key:cmd+<key>` logs whether the view or the menu handled a key.
- **A path that is not a file** (a word Ghostty took for one) → the
  sheet says it does not exist.
- **code-server cannot start** → the proxy's page in the panel shows the
  phase that failed and offers to retry.
- **A setting the core rejects** → a sheet names it and the window shows
  the core's value again.
- **Read-only core** → settings are shown disabled; the VS Code page is
  refused by the core.
- **Layout document from a newer client** → its unknown fields and nodes
  are kept; parts that cannot be read are left out, and terminals they held
  stay reachable from the sidebar.
- **Event connection lost** → machines and program windows keep their last
  state until it returns with backoff.
- **XcodeGen missing** → `make macos-app` says so (`brew install
  xcodegen`); development builds and tests do not need it.
- **No signing certificate** → the bundle is signed ad hoc: it runs where
  it was built, and elsewhere after the user allows it.
- **Xcode not selected** → `scripts/macos-app.sh` uses
  `/Applications/Xcode.app` when the active developer directory is the
  command line tools.

## Security

See the row for the macOS application in
[SECURITY.md](../../SECURITY.md).

## Testing

`macos/Tests/TermKitTests` (`make macos-test`): the running-program rule,
the attention list and its order, the reactions to agents' states, where
text sent from VS Code goes, the palette's matching, paths as terminals print
them (line suffixes, `~`, relative, `file:` URLs, other schemes) and the
names of their local copies, frame encoding and slices,
terminal names, the store's snapshots and every event kind (detected
agents and the count of terminals that wait included), the event
channel's messages (a machine's terminal core state, a window's terminal), every layout vector of `design/testdata/layout`
([22](22-terminal-protocol.md)), the core's arguments, environment and
ready line, a missing core, and the localization checks of
[12](12-internationalization.md). `internal/brand/brand_test.go` keeps
`Brand.swift` in step. The window is
exercised by hand with the development aids of debug builds
(`HERDR_IDE_ACTIONS`, `HERDR_IDE_SNAPSHOT`, see
[reference](../reference.md#environment-variables)) against
`make dev-core`.

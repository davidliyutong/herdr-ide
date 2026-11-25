# Changelog

All notable changes are documented here, newest version first, and the
project uses [Semantic Versioning](https://semver.org/). A version's changes
are one list without subsections, written when the version is released from
the pull requests merged since the previous one. Versions up to 0.3.0 group
theirs under Added, Changed and Fixed, after
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.5.0] - 2026-11-22

- **Breaking:** VS Code is off by default. Enable it under **Settings →
  Plugins** separately for the desktop app and for browsers; browsers
  first ask you to accept that VS Code's extensions and webviews can
  access every connected machine through the page. Turning it off closes
  its open views for that kind of client and prevents new installations
  and starts; its panes stay in the layout for when it is enabled again.

- **Breaking:** pages on another loopback host or port can no longer
  connect to the server unless their origin is explicitly allowed with
  `--allowed-origin`. Custom frontends and reverse proxies must use the
  server's own host and port or an allowed origin.

- **Breaking:** custom `--agent-dir` overrides now take
  `herdr-ide-<os>-<arch>` executables. Custom launchers using
  `--parent-stdio` must send a JSON hello line before waiting for
  readiness (`{}` when no desktop identity is needed).

- Plugins have a sidebar on the right, their own settings pages and
  switches under **Settings → Plugins**. Drag a panel's button or title
  into the workspace to split it beside another pane or give it a tab,
  or use **Open in Pane**; **Move to Sidebar** takes it back. Uploads,
  downloads, program windows and VS Code can be turned off there too.

- **Explorer** follows the focused terminal's directory on each machine:
  file-type icons, filtering, hidden files, excluded names, sorting,
  creating files and folders, rename, cut, copy, paste, drag to move and
  **Move to Trash**. Select several files to act on them together. Drop
  files or folders from your computer, or use **Upload Files…** and
  **Upload Folder…**, to upload their structure with choices for names
  already taken; drag files out to download them. The local machine also
  offers to reveal a file in its file manager.

- Files open in an editor tab without starting VS Code: a click reuses
  the preview editor, a double click or an edit keeps it, and **Open to
  the Side** splits beside the focused pane. Saves check for changes on
  the machine and preserve links, ownership, permissions and mixed line
  endings; files changed elsewhere offer to reload or keep editing.
  Unsaved text stays while switching tabs, workspaces or machines, and
  deleted files keep their text with a struck-through title. `cmd+s`
  (`ctrl+s` elsewhere) saves the editor that has the keyboard.

- **Source Control** works without VS Code: staged, unstaged, untracked
  and merge changes as a list or tree, actions on several files or
  folders, commits and amend, branch creation and checkout, stashes,
  fetch, pull, push and synchronization. Search branches and repositories
  with the keyboard; when several remotes exist, operations use the
  branch's upstream or ask which remote to use. Changed files are
  colored and ignored files muted in **Explorer**, and editors mark
  changed lines in their gutter with **Open Changes**.

- **Show Git Graph** opens the repository's history in its own tab, with
  branch and tag lanes, search, filters for several branches, a commit's
  files and menus for checkout, branches, tags, merge, rebase,
  cherry-pick, revert and reset. History is also docked in **Source
  Control**. Diffs open side by side or inline, let you edit the working
  file and stage, unstage or discard selected ranges; unsaved edits are
  checked before discarded files' editors close.

- **Variable Vault** keeps encrypted API keys and environment variables
  for coding agents on every machine. Choose which machines may read
  each variable; other requests ask you to allow once, always or deny.
  Connect Claude Code, Codex and other MCP clients from the panel's setup
  guide, or let a command use variables without returning their values
  to the model. Every read is logged with its requester. Unlock with a
  passphrase, then use Touch ID, Windows Hello or a browser authenticator
  during its remembered period; **Verify every Allow** verifies each
  approval, and trusted apps can be exempted per machine. The vault locks
  after an hour without use by default, with a countdown and a choice for
  this unlock. Export and import variables in encrypted files, previewing
  conflicts and choosing which machines and variables to keep.

- **AI Usage** shows Claude, Codex, Grok, Antigravity, Kimi Code and
  DeepSeek accounts across machines, merging shared accounts: limits,
  reset countdowns, pace, credits, balances and provider incidents, with
  configurable alerts that do not repeat for the same period. **Spend**
  and **Tokens** show local usage by day, model, project and machine,
  including Antigravity, Kimi Code and OpenCode sessions; spend estimates
  use API prices, with **Your prices** for overrides and unpriced models
  still counted in tokens. Choose refresh intervals and providers in its
  settings. Kimi Code's sign-in is renewed when needed, except in
  read-only mode.

- **Browser** panes open development servers on a machine's localhost
  through port forwards when the client runs on the server's computer.
  **Ports** lists listening ports and stops forwards; forwards are opened
  by your action and end when unused. `cmd`/`ctrl`-click a localhost link
  in a terminal to open it in a new browser tab of the workspace; document
  links ask before making a new forward. The desktop app can also browse
  other web addresses. The new-tab button's menu chooses terminal,
  browser and other enabled pane types.

- **System Monitor** shows live CPU, memory, swap, per-GPU utilization
  and memory, temperatures, power, network throughput, disk activity and
  mounted disks for Linux and macOS machines. Hover or click its status
  bar item, or hold `cmd` (`ctrl`/Meta elsewhere) while hovering a machine
  in the sidebar. **Task Manager** has searchable, sortable process trees
  and flat lists, process details, and actions to terminate, force kill,
  pause or resume a process; it can also open as a pane or tab.

- Program windows use a GPU-backed display where a Linux machine has
  Xwayland and an accessible GPU, so OpenGL and Vulkan programs such as
  Isaac Sim can render on it; other machines keep Xvfb. **Follow
  CUDA_VISIBLE_DEVICES**, off by default, lets programs on machines with
  several NVIDIA GPUs show their windows from the GPU their launch
  command selects.

- Workspaces, tabs and splits come back after a machine or its terminal
  service restarts, with shells in their directories. Claude Code and
  Codex resume the directory's latest conversation in their panes;
  other programs return to shells. Recovery works with several browsers
  open and when the app was closed during the restart.

- Closing panes, tabs and workspaces acts at once with **Undo Close**
  (`cmd+z` in the desktop app on macOS), keeping their programs running
  until the undo time expires. **Settings → Panes and Tabs → Undo close
  for** adjusts it from 3 to 120 seconds (5 by default). Unsaved edits
  still ask before closing; quitting the desktop app lists the files
  with **Show**, **Save All**, **Don't Save** and **Cancel**.

- **Pin Tab** keeps a tab first and protects it from middle-click,
  **Close Other Tabs** and **Close Tabs to the Right**. Drag a whole tab
  onto another tab's pane to combine them into a split; resting on a tab
  while dragging shows it. Panes and panels dropped on the tab bar's
  empty space open in a new tab. **Go Back** and **Go Forward**
  (`cmd+[` and `cmd+]` in the desktop app on macOS) revisit focused panes.

- Select several machines, workspaces or tabs with `cmd`/`ctrl`-click or
  Shift to reorder, move, close, enable or disable them together. Their
  lists, pane headers, agent inbox and transfer panels work from the
  keyboard, including rename and context menus; dragging near the
  sidebar's edge scrolls to rows out of view. **Close Other Workspaces**
  and the tab-closing commands act on groups with one undo.

- Workspace dialogs check the folder on the machine while you type,
  explain invalid folders and resolve `~` and relative paths before
  saving. A folder is optional for a new workspace; without one, new
  terminals start in the focused terminal's directory.

- Terminals shown recently stay attached in the background, so switching
  tabs returns to their current output and remembered scroll position.
  Switching tabs keeps full-screen programs at their size. **Settings →
  Performance** controls how many terminals stay attached, shows app and
  server resource use and counts the terminals shown or kept. The cursor is a
  thin bar by default, with adjustable **Cursor thickness**, and input
  method composition no longer triggers app shortcuts.

- New SSH terminals let programs recognize that the clipboard is remote,
  so selecting in Codex copies through the terminal automatically; long
  mouse selections also copy without an extra prompt. Agent turns already
  seen stay seen after restarting the app, avoiding repeated completion
  notifications.

- Code in editors, diffs and previews is colored in about 125 languages,
  including Makefiles, TOML, Dockerfiles and scripts without extensions.
  Markdown previews render tables, task lists and formulas and open
  relative file links. Editors can scroll beyond the last line and no
  longer flag ordinary Chinese punctuation as confusable characters.

- Settings, menus and the command palette have searchable choices,
  highlighted matches and keyboard navigation through long lists;
  settings pages fit narrow windows with a page picker. **Color theme**
  chooses the interface's accent from blue, VS Code blue, teal, violet,
  rose, amber and graphite, with consistent controls and text sizes.
  **Customize Status Bar** or its right-click menu shows or hides widgets,
  kept per browser; hovering uploads, downloads or AI usage shows their
  panel or a compact summary.

- VS Code keeps its own keyboard shortcuts: `cmd+w` closes an editor,
  then the pane when no editor remains. **Give the Keyboard Back**
  (`ctrl+b` on macOS, `ctrl+alt+shift+b` elsewhere) returns focus to the
  pane header; **Open in VS Code** from there returns to the pane focused
  before it.

- Desktop app on macOS: the window buttons sit inside the sidebar or tab
  header, with no separate title bar. Their placement follows interface
  size, zoom and full-screen changes.

## [0.4.0] - 2026-11-16

- **Breaking:** herdr is no longer used or shipped. Each machine's
  terminals now live in a terminal core of herdr-ide's own (herdr-core),
  which the binary carries for Linux and macOS on amd64 and arm64 and
  installs on a machine the first time its terminals are shown; the
  browser emulates every terminal itself with Ghostty's terminal library
  (WebGL, Canvas 2D without it). Programs keep running when the browser
  closes or the core stops. Terminals, workspaces and tabs of herdr
  sessions are not carried over (they keep running in herdr); herdr's
  saved SSH machines, browser preferences and the desktop app's shortcut
  settings are imported once (see "Migrating from versions that used
  herdr" in the deployment guide). **Manage herdr**, **Restart herdr…**
  and the `herdr` subcommand are gone; a machine's menu has
  **Troubleshooting** ▸ **Start Terminal Service**, **Restart Terminal
  Service…** and **Stop Terminal Service…**. The `--local-session` and
  `--remote-session` flags are removed. Which coding agent runs in a
  terminal and whether it works, waits or is done is still recognized
  with herdr's rules.

- **Breaking:** the `ctrl+b` prefix chords are gone. `ctrl+b` and every
  key that is not a default reach the program in the terminal; the
  commands are in the menus, context menus, pane headers and the command
  palette (`cmd+shift+p` on macOS, `ctrl+shift+p` on Windows and Linux in
  the desktop app, `cmd+k` in a browser on macOS). Chords can be bound
  again. In the desktop app `cmd+w` closes the focused pane, not the tab,
  and closes a workspace that has no tab left; the app also gets the keys
  of Terminal.app, iTerm, Chrome and VS Code on macOS (`cmd+1`…`cmd+9`,
  `cmd+shift+w`, `cmd+alt+arrows`, `ctrl+tab`…) and safe `ctrl+shift`,
  `ctrl+tab` and `alt+digit` keys elsewhere. Held keys repeat opening,
  closing and stepping commands.

- **Add Machine…**, **Rename Machine** and **Remove Machine…** in the
  sidebar's menus. Right-click the sidebar's free space (or use the
  command palette) to add an SSH machine: pick a host of your
  `~/.ssh/config` from the list or type any ssh destination OpenSSH
  accepts, and a label; a password or host key is asked for in a
  terminal, and the machine appears and connects without restarting.
  Targets holding whitespace, control or shell characters (`$`, `;`,
  `|`…) are refused; such a machine already saved is listed in error,
  never connected, and can be renamed or removed. Rename a machine in
  place by a double click; machines can be reordered by dragging.

- An uploads panel for pasted and dropped files, opened from the status
  bar: each upload's progress, speed and time left, **Cancel** for running
  and waiting uploads (a cancelled upload leaves nothing on the machine),
  and the history of the last 50 finished uploads in this browser, which
  can be previewed or have their path copied.

- With the theme set to **System**, the panes stayed dark after switching
  from **Dark** in the desktop app (and did not follow a later change of the
  system's theme) while the rest of the UI turned light.

- Disabled machines are folded in the sidebar; open one, or use its menu,
  to enable it.

- Closing a tab or a pane no longer asks when each of its terminals only
  has a shell waiting at its prompt; otherwise it asks and names the
  programs that would end, also when they are not agents (`vim`, a build,
  `ssh`).

- Formulas: rest the pointer on a LaTeX formula in a pane (`$…$`,
  `$$…$$`, `\(…\)`, `\[…\]`, also as agents' markdown renderers print
  them, without some backslashes) to see it typeset by KaTeX in a
  popover, with a button that copies its source. The popover stays while
  the pointer moves towards it across the rows of other formulas. KaTeX
  loads the first time a formula is shown; **Settings → Terminal →
  Formula preview** turns it off.

- Program windows: a machine that is disabled, removed or disconnected no
  longer leaves its display's error (or its windows) in the status bar;
  the settings show its display as not connected. A display error can be
  dismissed; it shows again only after the display recovered and failed
  anew.

- Settings and keyboard shortcuts are kept by the core in two JSON files
  that can also be edited by hand, the same in every browser and the
  desktop app. **Settings** is laid out as VS Code's: search, a scope
  bar for the user's settings and each machine's own (a machine's menu
  has **Machine Settings…**), a reset menu per setting, and a
  **Keyboard Shortcuts** page that records, removes and resets keys and
  names conflicts. New terminal settings: font (picked from the
  monospace fonts installed, with a preview), line height, cursor style
  and blink, scrollback (up to 100,000 lines), copy on select, bell, bold
  as bright, and color schemes per theme (Dracula, Nord, Solarized, One,
  Gruvbox, Tomorrow…) with your own colors on top. The desktop app's
  `--desktop-*-key` flags are replaced by keybindings.

- Notification sounds, system notifications and the Dock/taskbar badge
  each have their own switch under **Settings → Notifications**.

- The desktop app runs on Windows (x64 setup) and Linux (AppImage and
  deb, x64 and arm64) as well as macOS. On Windows it reaches SSH
  machines with keys from the ssh agent; the local machine needs Linux
  or macOS.

- Desktop app: **Zoom In**, **Zoom Out** and **Reset Zoom** (`cmd+=`,
  `cmd+-`, `cmd+0`; `ctrl` on Windows and Linux) zoom the interface, also
  from dialogs and VS Code, and are kept as a setting. Menu items carry
  the commands' names and keys and are disabled when they cannot run;
  the menus add **Add Machine…**, **Go to Agent Needing Attention** and
  full screen, and the **Window** menu is macOS's.

- Desktop app on macOS: **Settings → Terminal → Permissions** shows
  whether terminals and the app have Full Disk Access, opens System
  Settings, shows herdr-core in Finder to add it, and says what to restart
  afterwards (**Restart Terminal Service…** or **Quit and Reopen…**). The
  command palette has **Open Full Disk Access Settings…**.

- VS Code is a pane like a terminal instead of a side panel: **Open in
  VS Code** (pane header, pane menu, command palette, `cmd+j` in the
  desktop app) opens a folder as a tab of the workspace or selects its
  VS Code pane; changes and Git Graph open beside the pane they come
  from, and a `path:line` clicked in a terminal opens in the workspace's
  VS Code pane, else beside the terminal; media opens in a preview pane.
  VS Code panes split, move, maximize and survive restarts without
  reloading. **Send to Agent** goes to an agent of the VS Code pane's own
  workspace. VS Code is shown with VSCodium's logo. The
  `layout.panelPosition` setting is dropped.

- Downloads: right-click in a pane to download the path under the
  pointer, or **Download files…** to choose several files and folders of
  the pane's directory; VS Code's explorer gets **Download (folders as
  zip)**. Folders arrive as zip archives streamed from the machine. A
  downloads panel in the status bar shows each download's progress, speed
  and result, and cancels or repeats it. In the desktop app, code-server's
  own **Download…** of folders and of files over 32 MB works (it failed
  silently).

- Find: `cmd+f` (`ctrl+shift+f` on Windows and Linux, so `ctrl+f` stays
  with the program) or **Find…** in a pane's menu finds text in the
  pane's scrollback, highlights every match on screen and shows "n of
  N"; Enter and Shift+Enter step to older and newer matches.

- Workspaces: **Edit Workspace…** changes a workspace's name and folder
  (without a folder, new tabs start in the focused pane's); a workspace
  without a name of its own is shown with its folder's name. Move a pane
  to another workspace of its machine by dropping it on the workspace in
  the sidebar or with **Move to Workspace** (also into a new one). Tabs
  the user has not named show their number, and agents are named by
  workspace and tab ("website · 2") in the inbox, palette and
  notifications.

- Layout: drag the sidebar's edge to resize it; split handles are easier
  to grab and a double click shares the space equally; tabs, workspaces,
  pane titles and machines rename in place by a double click; a middle
  click closes a tab; rows have a ⋯ menu; pane buttons are larger and
  shown on the focused or pointed pane, moving into a menu when the
  header is narrow; status bar panels have a close button. The command
  palette ranks word starts first and leaves out what cannot run.

- The machines a browser or the desktop app showed are shown again when
  it reopens, each once it is connected.

## [0.3.0] - 2026-11-08

### Added

- **Manage herdr** and the new **Restart herdr…** work for SSH machines:
  start, stop or restart a machine's herdr server from its context menu,
  without an ssh terminal. A machine that rebooted stays *degraded* because
  its herdr server is gone and **Retry** only reconnects the agent; its
  status block now offers **Manage herdr** to start the server again.

- Program windows that keep changing (a simulator, a rotating 3D plot) are
  sent as video: H.264 through NVENC on NVIDIA GPUs or VA-API on Intel and
  AMD GPUs, else VP8 on the CPU, decoded in the browser with WebCodecs; once
  a window settles it is sent again as an exact picture. On by default
  (`gui-video`, also per machine in the settings). The core brings the
  encoder for linux/amd64 and linux/arm64 machines and pushes it to them;
  without WebCodecs (plain HTTP on a LAN) or when encoding fails, windows
  are sent as pictures. Measured with the MuJoCo viewer: 58 frames per
  second at 1.7 Mbit/s, against 29 pictures at 30 Mbit/s before, and 58
  instead of 8 on a 10 Mbit/s link.
- Program windows: `#stats` at the end of a program window's address shows
  frame statistics: what the machine spent capturing and encoding, the
  frames and bytes the browser received and how long it took to decode and
  draw them, and the time from capture to the picture being drawn.
- Desktop app: drag folders from Finder onto the sidebar or the app's Dock
  icon to create a workspace for each on the local machine. A drop on the
  Dock icon also launches the app, and the workspaces appear once the local
  machine is connected.
- Files dragged onto a pane are pasted as their paths. Files not on the
  pane's machine are uploaded into the pane's directory there first, under
  their own names (`-1`, `-2`… when taken; nothing is replaced); in the
  desktop app, files dropped on a pane of the local machine are pasted where
  they are. The pane shows what a drop does while files are over it.
  Before, only pasting files uploaded them, and a file dropped on the page
  replaced it in a browser.
- Right-clicking a pane opens a menu to copy the selection, paste, and
  preview, open in VS Code or copy the path (or URL) under the pointer or
  selected, also in programs that report the mouse such as Claude Code
  (programs no longer get the right button). Without a selection of the
  page, Copy (and ⌘/Ctrl+C) copies what the pane's program copied from its
  own selection. Before, the desktop app showed no menu at all.
- Every pane of a split tab has its own buttons in its header: program
  windows, VS Code, changes, Git Graph, split right / down, zoom and close,
  acting on that pane. The toolbar above the panes is shown only for a lone
  pane, as its header. Nothing is drawn over a pane's terminal any more.
- Setting **Programs copying to the clipboard** (terminal section):
  automatic, ask or off.
- Right-click a machine in the sidebar to disable or enable it (a disabled
  machine also has an **Enable** button). The choice is saved by herdr-ide
  (`machines.json` beside its settings) over herdr's saved machines and
  applies at once; disabling a connected machine asks first and keeps its
  panes running in herdr.
- Desktop app: `cmd+,` and **Settings…** in the app menu open the settings,
  `cmd+n` (File → New Workspace) creates a workspace, and `cmd+j` (View →
  Show or Hide VS Code) hides the VS Code panel or shows the last one again,
  also from inside VS Code (`desktop-settings-key`,
  `desktop-new-workspace-key`, `desktop-toggle-code-key`, changeable under
  Settings → Shortcuts; VS Code keeps its own `cmd+,` and `cmd+n`). The
  Tab menu is now the File menu.
- `make desktop-install` builds the macOS app and installs it into
  `/Applications`, quitting and reopening a running copy.

### Changed

- Program windows are captured through shared memory and encoded on
  several cores: a 1706×960 window takes about 4 ms to capture and encode
  as JPEG instead of 15–17 ms. How much a window may have on its way follows
  the connection (about twice what it delivers in a round trip) instead of
  three frames. The MuJoCo viewer's pictures are drawn at 48 whole windows
  per second instead of 29, 36 ms instead of 46 ms after capture; on a link
  they fill, they arrive as before.
- A program's copy (OSC 52) goes on the clipboard at once when it follows
  your own key or click in a pane within 10 s, such as selecting text in
  Claude Code, with a short toast saying what was copied; other copies, or
  ones the browser refuses, still wait for the toast's **Copy** button.
  Before, every copy needed that click.
- Pasted files' paths reach the pane as a paste instead of typed text, the
  way a terminal delivers dropped files.
- A tab is shown when it is pressed, not when the click is released, and a
  drag (of a tab, workspace or pane) starts only after the pointer moved on
  the screen. In macOS full screen the menu bar sliding down moved the page
  under the pointer, so clicking a tab often started reordering it instead.
- Clicking "Display on … failed" in the status bar shows the error, how it
  is retried, and buttons to copy it or open the settings; before, the error
  was only in a tooltip.

### Fixed

- Machines no longer stay *degraded* on slow or congested links: herdr
  drops an API connection whose request has not arrived within 5 s, and the
  core now sends the request with the stream instead of after the agent's
  reply, which could queue behind pane surfaces and program windows.
- **Retry** on a *degraded* machine reconnects it; before, it did nothing
  while the agent stayed connected. Read-only browsers cannot retry, and a
  session younger than 5 s is kept.
- After the network changed or the computer slept, a machine reconnects
  without waiting a minute for the old ssh connection: the core tells an
  ssh control master whose connection stopped answering to take no new
  sessions, so the next connection opens a new one.
- The panes of a machine that reconnects (after a network loss, or when it
  is enabled again) show again within seconds, instead of after the
  surface's reconnect backoff of up to 16 s.
- Stopping herdr's server on a machine no longer leaves its virtual
  display (Xvfb) running for six hours: the display lasts while the server
  runs, programs use it or the core is connected, and ends a minute after.
- Moving the window to a display with another pixel density (for example
  from a Retina screen to a 1x external monitor) no longer changes the
  terminal text's size: the cell is measured again for the new display.
- Selecting text by dragging is smooth, also while the drag scrolls past a
  pane's edge: only rows whose highlight changed are painted, scrolled rows
  are copied on the canvas instead of painted again, text is painted about
  three times faster, and scrolling past the edge keeps its speed (and
  speeds up while held) however long herdr takes to answer.
- The desktop app's title bar follows the UI's theme: a dark UI on a light
  macOS no longer has a white title bar.
- A path or URL wrapped over several rows, by the terminal or by a program
  such as Claude Code, is one link: ⌘/Ctrl+click opened only the part on
  the row under the pointer.

## [0.2.0] - 2026-11-01

### Changed

- Panes are drawn from the cell grid herdr renders through its endpoint
  protocol (generation 1, on herdr's client socket) instead of one
  `herdr terminal session` and one xterm.js terminal per pane. herdr encodes
  keys and mouse events for each pane's modes (application cursor keys,
  kitty keyboard protocol, mouse reporting), sends focus events, and
  answers programs' color queries with the UI theme's colors; OSC 52 from
  programs offers a **Copy** button for 5 s (pane output never writes the
  clipboard by itself) and the bell flashes the pane area. Selections stay inside their pane. Pane headers sit on the top
  border herdr draws. Requires herdr 0.9.5 or newer on every machine.
- One browser tab uses the session at a time, like a KVM console: another
  tab can take it over and the previous one says so. This replaces the
  control/observe arbitration of panes between browsers. A read-only
  browser never takes the session from a writable one.

### Added

- Each tab has one toolbar above its panes, a single row however many panes
  it has, with the focused pane's title and folder and buttons for program
  windows, VS Code, the repository's changes, Git Graph, split, zoom and
  close. Its title renames the pane, it has the pane's menu and drags the
  pane. Pane headers no longer carry buttons, and a lone pane, which has no
  border row since panes are drawn from herdr's grid, no longer gets a
  header that shows on hover. In narrow workspaces the toolbar drops the
  folder, the title and less used buttons instead of overflowing.
- Desktop app: `cmd+t` opens a tab and `cmd+w` closes the current tab after
  asking (`ctrl+shift+t` / `ctrl+shift+w` on other systems). While VS Code
  has focus, both keys stay VS Code's (`cmd+w` closes the editor). Keys
  follow the keyboard layout's characters, so `cmd+z` on AZERTY stays undo.
  They are core settings (`--desktop-new-tab-key`, `--desktop-close-tab-key`),
  recorded or removed under **Settings → Shortcuts**, and shown in the new
  **Tab** menu. Browsers are unchanged.
- Release archives for Linux/macOS on amd64/arm64 include herdr 0.9.5
  (verified at build time against pinned SHA-256 digests) with its license
  and dependency notices. The local machine uses it when no herdr is
  installed; it keeps herdr's usual configuration, sessions and machines.
  SSH machines still use their own herdr.
- `herdr-ide herdr [args]` runs the included herdr with the arguments and
  environment unchanged.
- **Manage herdr** (context menu of the local machine): start, stop and
  restart the local herdr server, and check for and install herdr updates for
  the application's copy of herdr through herdr's own updater, without a
  terminal. The server is never started automatically; local herdr
  installations of the user's are not updated.
- **Update herdr** for SSH machines (context menu, and a hint when a
  machine's herdr is older than the local one) runs herdr's own
  `herdr --remote` in a terminal, where herdr asks before installing its
  version there or replacing a running server.
- Terminal-pane app icon shared by the desktop and browser, with editable
  SVG sources, small-size artwork and a multi-resolution macOS ICNS for
  the app and DMG; regenerate with `make desktop-icons`.
- macOS Electron packaging: `make desktop-app` and `make desktop-dmg`
  produce an ad-hoc signed `.app` and a drag-to-Applications DMG for arm64
  or x64. The sandboxed desktop shell owns its bundled core, preserves the
  web UI and supports internal program/VS Code windows and external links.
  The app includes the bundled herdr and its notices. GitHub releases attach
  arm64 and x64 DMGs, covered by `SHA256SUMS` and build provenance like the
  archives; CI no longer uploads DMGs from `main`.
- `--parent-stdio` reports core readiness as JSON and stops on parent-pipe
  EOF; `make dev-desktop` uses the isolated development session and instance.
- Ignored `.worktrees/` directory for branch workspaces.
- **Terminal font weight** setting (regular or medium; medium comes close to
  Ghostty's `font-thicken`).
- **Notification sounds**: the browser plays a chime when an agent needs
  input and another when it finishes (not while its pane is on screen in a
  focused window), as herdr does in its own client. On by default with
  **Silent agents** (`droid` by default) in the new Notifications section of
  the settings. With several browsers open, only the one used most recently
  plays them. The sounds are synthesized; the desktop app's main window
  allows them without a prior click.

### Changed

- Terminals draw with JetBrains Mono 2.304, shipped in the UI (SIL Open Font
  License, listed in `licenses.md`), instead of the first monospace font a
  system happens to have (often SF Mono or Menlo), and rows are a little
  taller. The dark terminal palette is now GitHub Dark Default: brighter text
  and colors made for its background; black and dim text were nearly
  invisible before.

### Fixed

- The **Authenticate…** and **Update herdr** terminals could end before
  showing the command's last output (for example ssh's final error): the
  core now forwards what is left in the terminal before closing it.
- `make it` no longer leaves workspaces in the isolated `herdr-ide-it`
  session, where herdr restored them (each with a shell) on every later run:
  the test closes the workspaces it creates and deletes the session before
  and after the run.

## [0.1.0] - 2026-10-31

### Added

- Program windows: windows of programs on remote Linux machines (matplotlib,
  MuJoCo, …) open in browser windows, one per program window, with mouse and
  keyboard. New panes get a virtual display; Xvfb is fetched in user space
  with `apt-get download` when missing; VirtualGL renders OpenGL on the GPU
  (`vglrun`, or every program with `--gui-gpu=all`). Settings `--gui` and
  `--gui-gpu`, also per remote machine in the settings dialog, which shows
  each machine's display state. Panes opened before can be caught up
  ("Enable in open panes", or the palette for the focused pane): shells at
  their prompt get the variables typed in.
- Core settings can be defined per machine: the settings file keeps
  per-machine values, `PUT /api/settings` takes `machine`.
- A page loaded before the core was replaced offers to reload.
- `--remote-session`: use an isolated herdr session on remote machines
  (development and tests).
- Web IDE for herdr: workspaces, tabs and split layouts from herdr's socket
  API; one xterm.js terminal per pane fed by herdr terminal-session streams;
  herdr-compatible prefix keymap and command palette.
- Multiple machines from herdr's saved SSH machines, through a static agent
  (linux/macOS, amd64/arm64) uploaded automatically and multiplexed over one
  ssh session; interactive ssh authentication in the browser.
- Control/observe arbitration of panes across several browsers.
- VS Code panels via code-server per machine with Git Graph and a bridge
  extension (open files at a line, diffs, Git Graph, send code to agents).
- Preview of images, GIFs, video, audio, PDF, text and directories from
  terminal paths; uploads of pasted and dropped files.
- Agent inbox, notifications and starting agents from the palette.
- Air-gapped installs: `fetch-assets`, `--seed-dir`, `--offline`, mirror URL
  templates, pinned SHA-256 digests.
- Guardrails: loopback default, proxy secret, Host/Origin checks, herdr API
  allowlist, read-only mode, CSP, audit log.
- Reclamation of remote resources: code-server idle stop, ownership and
  orphan reaping, retention of uploads, logs and old versions; `--instance`.
- English and Simplified Chinese UI.
- Settings dialog (`prefix ,`) rendered from setting definitions: language,
  light/dark/system theme (VS Code panels follow it), interface and terminal
  font sizes, VS Code panel beside or below the terminals, Option as Meta,
  and core settings saved on the core host (`/api/settings`, flags lock them).
- code-server installation methods (`--code-server-install`): uploaded by the
  core, downloaded by each machine (verified), or an existing install
  (`--code-server-path`), with fallback to uploading.
- Dragging panes by their header to swap them, place them beside another pane
  or move them to another or a new tab; renaming panes, tabs and workspaces
  in place.
- In-app dialogs for creating workspaces (folder completion on the machine,
  optional name) and for confirming closes, instead of the browser's
  `prompt()` and `confirm()`.
- Dragging tabs along the tab bar and workspaces along their machine's list
  in the sidebar to reorder them (`tab.move`, `workspace.move`).
- Context menus on pane headers, tabs and workspaces with their commands and
  key bindings, usable from the keyboard; read-only mode keeps the browser's
  menu.
- Tabs that do not fit continue on more rows instead of scrolling the tab
  bar, so every tab stays visible and can be dragged anywhere; long labels
  are cut with an ellipsis.
- Selections longer than a pane: holding a selection drag above or below
  the pane scrolls herdr's scrollback (`pane.scroll`) and extends the
  selection; copying copies the whole range, read from herdr
  (`pane.selection.read`).
- Project tooling: one-step rename with state migration, repository checks,
  pane input contract tests (browser and herdr key encodings), reproducible
  builds, third-party notices, CI, release workflow with
  checksums and build provenance (from a public repository), Dependabot.

### Fixed

- A finished agent opened by hand (not from the inbox) stayed marked as
  pending: the pane focused in the UI is now focused in herdr when it is done.
- The VS Code panel showed "Not Found" when a code-server whose installation
  had moved (after a rename) still listened on the socket: such a process is
  replaced, the rename migration stops the old code-server first, and the
  core stops the local machine's code-server when it exits.
- Tabs were shown sorted by `Tab.number`, which herdr keeps with a tab when
  it moves; tabs and workspaces now follow herdr's order, and `prefix 1..9`
  picks tabs by position. A new tab created from another workspace's menu no
  longer takes the cwd of a pane elsewhere.

### Changed

- Pane header actions use icons with larger targets and stay visible; read-only
  mode hides actions it would refuse; the VS Code loading page follows the UI
  language and theme.
- Renamed from webherdr to herdr-ide: binaries, Go module, `~/.herdr-ide`,
  `HERDR_IDE_*` variables and the `herdr-ide.herdr-ide-bridge` extension.
  Existing installs migrate on first start: machines move `~/.webherdr` to
  `~/.herdr-ide`, browsers move their stored preferences, code-server drops
  the old bridge extension and the core removes the old download cache.

### Security

- code-server's port proxy (`/m/<machine>/code/proxy/<port>/`) is disabled
  and refused by the core: it served any service listening on a machine,
  including another user's on a shared machine, with the UI's origin, where
  its scripts could type into every pane.
- Pages are served with `Referrer-Policy: same-origin` instead of
  `no-referrer`, so same-origin POSTs carry their Origin (requests from other
  sites still get no referrer).

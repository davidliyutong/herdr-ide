# Feature design documents

One document per feature. Each records why the feature exists, how it works,
which alternatives were rejected and why, how it fails, and how it is tested.
[architecture.md](../architecture.md) is the map of components and protocols;
these documents are the reasoning behind them. Reference material (flags,
shortcuts, paths) lives in [reference.md](../reference.md).

| # | Feature | Summary |
| --- | --- | --- |
| 02 | [Multi-machine transport](02-multi-machine-transport.md) | One ssh session per machine running a static agent; yamux multiplexing; platform detection and upload. |
| 04 | [Layout and keyboard](04-layout-and-keyboard.md) | Workspaces, tabs and split panes of the machine's layout document; direct shortcuts of the desktop app as the only default keys (no prefix: other keys reach the terminal), chords for users who bind them; command palette. |
| 05 | [VS Code panel](05-vscode-panel.md) | code-server per machine behind the core's proxy; bridge extension; Git Graph and diffs. |
| 06 | [Quick Look and files](06-quick-look-and-files.md) | Path detection in terminals, media preview with range streaming, uploads for agents, downloads with folders as zips. |
| 07 | [Agent-native workflow](07-agent-native-workflow.md) | Attention inbox, notifications, starting agents, sending code to agents. |
| 08 | [Web access and security](08-web-access-and-security.md) | Browser/PWA delivery, reverse-proxy model and the guardrails around it. |
| 09 | [Air-gapped installs](09-air-gapped-installs.md) | Artifact resolution on the core host, seed directories, mirrors, pinned checksums. |
| 10 | [Remote resource lifecycle](10-remote-resource-lifecycle.md) | Ownership and reclamation of every process and file created on machines. |
| 11 | [Naming and renames](11-naming-and-renames.md) | Centralized product names, one-step renames and migration of persisted state. |
| 12 | [Internationalization](12-internationalization.md) | English and Chinese UI, translated extension, codes instead of server prose. |
| 13 | [Settings, keybindings and appearance](13-settings-and-appearance.md) | One settings and one keybinding system in the core, VS Code style files, a settings UI generated from the definitions; themes, terminal font, colors and cursor. |
| 14 | [GUI windows](14-gui-windows.md) | Windows of programs on remote machines in browser windows: user-space Xvfb tied to the terminal core, per-window capture as pictures or video, VirtualGL. |
| 16 | [Desktop packaging](16-desktop-packaging.md) | The web UI in an Electron shell for macOS: an owned core, the menu, theme and language from the core's settings and keybindings, `.app` and DMG builds. |
| 19 | [Formulas in panes](19-formulas-in-panes.md) | LaTeX under the resting pointer typeset by KaTeX in a popover; the spellings agents print, also without dropped backslashes. |
| 21 | [herdr-core terminal core](21-terminal-core.md) | A herdr-core of the agent's own on each machine, in a session apart from the user's, and a client of its API: terminals as raw byte streams with credit. |
| 22 | [Terminal protocol for clients](22-terminal-protocol.md) | `/api/v1/term`: a machine's terminals, their events and raw byte streams for clients that emulate and draw terminals themselves, and the layout document those clients share. |
| 24 | [Design tokens](24-design-tokens.md) | One file of colors, metrics, font sizes and terminal palettes, generated into the web UI's CSS variables and the terminal colors' setting defaults. |
| 25 | [Agent detection in terminals](25-agent-detection.md) | herdr's method for the terminal core's terminals: the foreground process names the agent, herdr's rules over the screen give its state, done when a turn ends; in the agent, next to the terminals. |
| 26 | [Web terminals](26-web-terminals.md) | Ghostty's terminal library as WebAssembly emulates the browser's terminals; WebGL2 (or Canvas 2D) draws them; keys, mouse and pastes encoded for each program's modes; selections, links, clipboard and find in the page. |

## Writing a feature document

Use the same sections so documents stay comparable:

1. **Context** – the problem and the constraints that shaped the design.
2. **Goals / non-goals.**
3. **Design** – behavior and the important mechanisms, with file pointers.
4. **Alternatives considered** – each rejected option and the reason.
5. **Failure modes** – what breaks, how it is detected and recovered.
6. **Security** – only when the feature affects the threat model in
   [SECURITY.md](../../SECURITY.md).
7. **Testing** – where the behavior is covered.

Describe the system as it is. Open questions and planned work are tracked in
the issue tracker, not in these documents. Update the document in the same
pull request as the behavior it describes.

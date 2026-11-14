# Feature design documents

One document per feature. Each records why the feature exists, how it works,
which alternatives were rejected and why, how it fails, and how it is tested.
[architecture.md](../architecture.md) is the map of components and protocols;
these documents are the reasoning behind them. Reference material (flags,
shortcuts, paths) lives in [reference.md](../reference.md).

| # | Feature | Summary |
| --- | --- | --- |
| 01 | [herdr integration](01-herdr-integration.md) | Talk to herdr through its public socket API and its endpoint protocol instead of embedding its TUI. |
| 02 | [Multi-machine transport](02-multi-machine-transport.md) | One ssh session per machine running a static agent; yamux multiplexing; platform detection and upload. |
| 03 | [Pane rendering and input](03-pane-rendering-and-input.md) | herdr's cell grid on a canvas; semantic input herdr encodes per pane; selections, links, clipboard. |
| 04 | [Layout and keyboard](04-layout-and-keyboard.md) | herdr's split tree rendered natively; herdr-compatible prefix keymap; command palette. |
| 05 | [VS Code panel](05-vscode-panel.md) | code-server per machine behind the core's proxy; bridge extension; Git Graph and diffs. |
| 06 | [Quick Look and files](06-quick-look-and-files.md) | Path detection in terminals, media preview with range streaming, uploads for agents, downloads with folders as zips. |
| 07 | [Agent-native workflow](07-agent-native-workflow.md) | Attention inbox, notifications, starting agents, sending code to agents. |
| 08 | [Web access and security](08-web-access-and-security.md) | Browser/PWA delivery, reverse-proxy model and the guardrails around it. |
| 09 | [Air-gapped installs](09-air-gapped-installs.md) | Artifact resolution on the core host, seed directories, mirrors, pinned checksums. |
| 10 | [Remote resource lifecycle](10-remote-resource-lifecycle.md) | Ownership and reclamation of every process and file created on machines. |
| 11 | [Naming and renames](11-naming-and-renames.md) | Centralized product names, one-step renames and migration of persisted state. |
| 12 | [Internationalization](12-internationalization.md) | English and Chinese UI, translated extension, codes instead of server prose. |
| 13 | [Settings and appearance](13-settings-and-appearance.md) | Settings generated from definitions in the browser and the core; themes, terminal font and palette, font sizes, panel position. |
| 14 | [GUI windows](14-gui-windows.md) | Windows of programs on remote machines in browser windows: user-space Xvfb, per-window capture, VirtualGL. |
| 15 | [Bundled herdr](15-bundled-herdr.md) | Release archives carry the native herdr, verified at build time and used when no herdr is installed. |
| 16 | [Desktop packaging](16-desktop-packaging.md) | macOS Electron shell, owned core lifecycle, `.app` and DMG builds. |
| 17 | [Managing herdr from the UI](17-local-herdr-management.md) | Start, stop and update the core host's herdr; a managed copy of the bundled herdr; herdr's own `--remote` update for SSH machines. |
| 18 | [Pane surfaces through herdr's endpoint](18-endpoint-surfaces.md) | One connection per shown machine to herdr's client socket; endpoint protocol generation 1; one browser owns the session at a time. |
| 19 | [Formulas in panes](19-formulas-in-panes.md) | LaTeX under the resting pointer typeset by KaTeX in a popover; the spellings agents print, also without dropped backslashes. |
| 20 | [Find in panes](20-find-in-panes.md) | ⌘F / Ctrl+Shift+F finds text in a pane's output and scrollback, also by regular expression, case or whole word; the agent searches next to herdr; matches highlighted, the current one scrolled into view. |

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

# Feature design documents

One document per feature. Each records why the feature exists, how it works,
which alternatives were rejected and why, how it fails, and how it is tested.
[architecture.md](../architecture.md) is the map of components and protocols;
these documents are the reasoning behind them. Reference material (flags,
shortcuts, paths) lives in [reference.md](../reference.md).

| # | Feature | Summary |
| --- | --- | --- |
| 02 | [Multi-machine transport](02-multi-machine-transport.md) | One ssh session per machine running a static agent; yamux multiplexing; platform detection and upload. |
| 04 | [Layout and keyboard](04-layout-and-keyboard.md) | Workspaces, tabs and split panes of the machine's layout document; direct shortcuts that leave other keys to the terminal; command palette. |
| 05 | [VS Code panes](05-vscode-panes.md) | code-server per machine behind the core's proxy as a pane of the split tree; bridge extension; Git Graph and diffs. |
| 06 | [Quick Look and files](06-quick-look-and-files.md) | Path detection in terminals, media preview with range streaming, uploads for agents, downloads with folders as zips. |
| 07 | [Agent-native workflow](07-agent-native-workflow.md) | Attention inbox, notifications, starting agents, sending code to agents; chats count as agents do. |
| 08 | [Web access and security](08-web-access-and-security.md) | Browser/PWA delivery, reverse-proxy model and the guardrails around it. |
| 09 | [Air-gapped installs](09-air-gapped-installs.md) | Artifact resolution on the core host, seed directories, mirrors, pinned checksums. |
| 10 | [Remote resource lifecycle](10-remote-resource-lifecycle.md) | Ownership and reclamation of every process and file created on machines. |
| 11 | [Naming and renames](11-naming-and-renames.md) | Centralized product names, one-step renames; a renamed version starts with namespaces of its own. |
| 12 | [Internationalization](12-internationalization.md) | English and Chinese UI, translated extension, codes instead of server prose. |
| 13 | [Settings, keybindings and appearance](13-settings-and-appearance.md) | One settings and one keybinding system in the core, VS Code style files and a generated settings UI; themes, terminal font and colors. |
| 14 | [GUI windows](14-gui-windows.md) | Windows of programs on remote Linux machines in browser windows: a display per terminal core (Xwayland on the GPU, else Xvfb), captured as pictures or video. |
| 16 | [Desktop app](16-desktop-packaging.md) | The web UI in an Electron shell for macOS, Windows and Linux with a core of its own, each system's menus and installers. |
| 19 | [Formulas in panes](19-formulas-in-panes.md) | LaTeX under the resting pointer typeset by KaTeX in a popover. |
| 21 | [herdr-core terminal core](21-terminal-core.md) | A herdr-core of the agent's own on each machine, in a session apart from the user's; terminals as raw byte streams with credit. |
| 22 | [Terminal protocol for clients](22-terminal-protocol.md) | `/api/v1/term`: a machine's terminals, events and byte streams for clients that emulate terminals themselves, and the shared layout document. |
| 24 | [Design tokens and design language](24-design-tokens.md) | One file of colors, themes, sizes and terminal palettes, generated into the web UI's CSS variables and the settings' defaults. |
| 25 | [Agent detection in terminals](25-agent-detection.md) | herdr's rules in the agent: the foreground process names the agent, the screen gives its state; the session Claude Code or Codex runs. |
| 26 | [Web terminals](26-web-terminals.md) | Ghostty's terminal library as WebAssembly emulates the terminals, WebGL2 draws them; input encoded for each program's modes. |
| 27 | [Plugins](27-plugins.md) | Built-in features with one shape: routes, the agent's `plugin` op, sidebar panels, panes with agent statuses, commands and status bar items; a switch per plugin. |
| 28 | [File explorer](28-file-explorer.md) | A tree of the machine's files following the focused terminal, and an editor whose saves never overwrite a change made on the machine. |
| 29 | [AI usage](29-ai-usage.md) | The AI subscriptions signed in on the machines: windows, resets, pace and balances per account, alerts, the local logs' cost at API prices, and the focused agent session's cost. |
| 30 | [Variable vault](30-variable-vault.md) | Environment variables encrypted on the core host that coding agents read through an MCP server, allowed per machine or approved in the UI. |
| 31 | [Git](31-git.md) | Source Control and Git Graph without VS Code: a panel, a graph pane and diffs in Monaco; git run with fixed arguments on machines. |
| 32 | [Browser pane and port forwards](32-browser-and-ports.md) | A tab that shows a machine's `localhost` service through a loopback forward on the core host, kept another origin than the UI. |
| 33 | [Workspaces after the terminal core starts again](33-workspace-restore.md) | The layout's tabs come back as shells in their directories, and Claude Code and Codex resume their own session, else the directory's latest. |
| 34 | [System monitor and task manager](34-system-monitor.md) | Live CPU, memory, GPU, network and disk per machine, and a task manager with a process tree and guarded signals. |
| 35 | [Coding agents' sessions and transcripts](35-agent-native-view.md) | The agent kind registry; the session an agent's process runs; transcripts read on the machine into ACP-shaped events; the conversation view's components. |
| 36 | [Terminal history](36-terminal-history.md) | Opt-in snapshots of terminal output on each machine's disk, within limits, shown above the new shell after the terminal core restarted. |
| 37 | [Agent chats](37-agent-chats.md) | Claude Code, Codex, Kimi Code and Grok run headless by a chat host on each machine and drawn in panes; a bounded journal; sessions moved between terminals and chats. |
| 38 | [State in SQLite](38-sqlite-state.md) | One private SQLite database per owner, named per host on shared homes, schemas versioned per feature; earlier state files imported once. |
| 39 | [Nodes](39-nodes.md) | One program on every machine: a node behind a local socket that several UIs attach to, locally or over ssh; the terminal core and chat host run as services of their own; upgrades without interrupting panes. |
| 40 | [Homes several hosts share](40-shared-homes.md) | Hosts sharing one home (NFS) keep their sockets, locks, executables, logs and terminal cores apart: a host-local runtime directory, a directory per host, a terminal core session per host, and retention for hosts gone. |
| 41 | [Project Search](41-project-search.md) | A Search panel that finds text in the files of a folder on a machine (VS Code's search view): match case, whole word, regular expressions, include and exclude globs, results by file opening at the match; ripgrep where the machine has it, a bounded walker of the agent's otherwise. |

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

Keep documents short. State what the feature does for the user, the design
and its key decisions with their reasons, the invariants that must hold,
and where the code lives. Leave out what the code and tests already state
line by line, edge-case enumerations, history and trivia such as exact
timeouts; link to another document instead of repeating it.

On `main`, describe the system as it is. Open questions and planned work are
tracked in the issue tracker, not in these documents. A feature built in
stages may have its document describe the goal on its branch, which merges
once the code matches it. Update the document in the same pull request as
the behavior it describes.

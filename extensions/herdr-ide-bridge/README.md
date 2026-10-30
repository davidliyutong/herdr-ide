# herdr-ide bridge

VS Code extension installed automatically into code-server by herdr-ide. It
connects the code-server window to the herdr-ide core through the agent's unix
socket (`$HERDR_IDE_BRIDGE_SOCKET`) so the web UI can open files at a
position, show diffs, open Git Graph and preview media, and so that
**Send to Agent** (editor context menu, `⌘⌥A` / `Ctrl+Alt+A`) pastes the
selection into the agent pane focused in herdr-ide.

Build: `pnpm install && pnpm run package` (produces `herdr-ide-bridge.vsix`,
embedded into the core by `scripts/build.sh`).

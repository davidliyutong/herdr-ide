# webherdr bridge

VS Code extension installed automatically into code-server by webherdr. It
connects the code-server window to the webherdr core through the agent's unix
socket (`$WEBHERDR_BRIDGE_SOCKET`) so the web UI can open files at a
position, show diffs, open Git Graph and preview media, and so that
**Send to Agent** (editor context menu, `⌘⌥A` / `Ctrl+Alt+A`) pastes the
selection into the agent pane focused in webherdr.

Build: `pnpm install && pnpm run package` (produces `webherdr-bridge.vsix`,
embedded into the core by `scripts/build.sh`).

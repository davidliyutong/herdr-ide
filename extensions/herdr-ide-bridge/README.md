# herdr-ide bridge

VS Code extension installed automatically into code-server by herdr-ide. It
connects the code-server window to the herdr-ide core through the agent's unix
socket (`$HERDR_IDE_BRIDGE_SOCKET`) so the web UI can open files at a
position, show diffs, open Git Graph and preview media, and so that
**Send to Agent** (editor context menu, `⌘⌥A` / `Ctrl+Alt+A`) pastes the
selection into the agent pane focused in herdr-ide, and so that
**Download (folders as zip)** (explorer context menu) downloads the selected
files and folders in the browser showing the window. `⌘W` / `Ctrl+W` in a
window without editors, where VS Code would close the window, closes the
herdr-ide pane showing it. **Give the Keyboard Back to herdr-ide**
(`⌃B` on macOS, `Ctrl+Alt+Shift+B` elsewhere; not in VS Code's terminal,
where the key stays the shell's) moves the keyboard to the header of the
herdr-ide pane showing the window, where herdr-ide's keys work (`⌘J` hides
VS Code again).

Build: `pnpm install && pnpm run package` (produces `herdr-ide-bridge.vsix`,
embedded into the core by `scripts/build.sh`).

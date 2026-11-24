package keybindings

import "fmt"

// When tells where a binding applies: in the main window outside dialogs
// (terminal; in a VS Code pane too, for the keys VS Code leaves), only while
// a VS Code pane has the keyboard (vscode), while a dialog of the
// application is open (dialog), or everywhere (always).
type When string

const (
	WhenTerminal When = "terminal"
	WhenVSCode   When = "vscode"
	WhenDialog   When = "dialog"
	WhenAlways   When = "always"
)

func validWhen(w When) bool {
	switch w {
	case WhenTerminal, WhenVSCode, WhenDialog, WhenAlways:
		return true
	}
	return false
}

// Platforms the default bindings differ by: the desktop app on macOS,
// Windows and Linux, and browsers on each. Browsers keep Cmd+T, Cmd+W and
// similar keys for themselves, so most direct shortcuts exist only in the
// desktop app.
const (
	PlatformMac            = "mac"
	PlatformWindows        = "windows"
	PlatformLinux          = "linux"
	PlatformMacBrowser     = "mac-browser"
	PlatformWindowsBrowser = "windows-browser"
	PlatformLinuxBrowser   = "linux-browser"
)

// Platforms lists every platform, in the API's order.
var Platforms = []string{
	PlatformMac,
	PlatformWindows,
	PlatformLinux,
	PlatformMacBrowser,
	PlatformWindowsBrowser,
	PlatformLinuxBrowser,
}

// Section groups commands on the keyboard shortcuts page.
type Section struct {
	ID    string `json:"id"`
	Order int    `json:"order"`
}

// Default is a command's default key, on Platforms (empty: all).
type Default struct {
	Key       string
	Platforms []string
}

// Command is something a key can run. Its label in the UIs is the
// translation of command.<ID>.
type Command struct {
	ID       string
	Section  string
	When     When
	Defaults []Default
}

// Sections are the keyboard page's sections, in order.
var Sections = []Section{
	{ID: "app", Order: 10},
	{ID: "workspace", Order: 20},
	{ID: "tab", Order: 30},
	{ID: "pane", Order: 40},
	{ID: "view", Order: 50},
	{ID: "find", Order: 60},
	{ID: "code", Order: 70},
}

var (
	macApp      = []string{PlatformMac}
	winApp      = []string{PlatformWindows}
	linuxApp    = []string{PlatformLinux}
	winLinuxApp = []string{PlatformWindows, PlatformLinux}
	macBrowser  = []string{PlatformMacBrowser}
	macAll      = []string{PlatformMac, PlatformMacBrowser}
	winLinuxAll = []string{PlatformWindows, PlatformWindowsBrowser, PlatformLinux, PlatformLinuxBrowser}
)

func on(platforms []string, key string) Default { return Default{Key: key, Platforms: platforms} }

func cmd(id, section string, defaults ...Default) Command {
	return Command{ID: id, Section: section, When: WhenTerminal, Defaults: defaults}
}

// always is a command that also runs while a dialog has the keyboard.
func always(id, section string, defaults ...Default) Command {
	return Command{ID: id, Section: section, When: WhenAlways, Defaults: defaults}
}

// Commands are every command, with the desktop app's direct shortcuts as
// defaults: on macOS the Cmd keys of Terminal.app, iTerm, Chrome and VS Code
// (Cmd+T, Cmd+1…9, Cmd+Option+arrows, Cmd+Shift+Enter…); on Windows and
// Linux Ctrl+Shift keys (as terminal emulators use, since Ctrl+W and Ctrl+T
// are keys of shells), Ctrl+Tab and Alt with a digit (as GNOME Terminal,
// Konsole and Windows Terminal switch tabs), platform-native splits and
// workspace switches (Alt+Shift++/Alt+Shift+- on Windows Terminal;
// Ctrl+Shift+D/O and Ctrl+Alt+Up/Down on Linux), Alt+Left/Right for
// pane history navigation, and Ctrl with +, - or 0 for the zoom.
// Ctrl+B escapes focus from the active editor, terminal or pane to the app
// chrome on every platform (and returns focus when already there); no other
// default is a chord, Ctrl or Alt with a letter alone, or a function key.
// Browsers get only keys they leave to pages: find, the command palette on
// macOS (Cmd+K; Cmd+Shift+P opens a private window in Firefox, as
// Ctrl+Shift+P does elsewhere, where no key is left for it and the status
// bar opens it), the keyboard shortcuts and Ctrl+B focus escape. A command
// without a key runs from the menus, the command palette or its button, and
// the user can bind any key or chord to it.
var Commands = func() []Command {
	out := []Command{
		cmd("app.commandPalette", "app", on(macApp, "cmd+shift+p"), on(winLinuxApp, "ctrl+shift+p"), on(macBrowser, "cmd+k")),
		cmd("app.keyboardShortcuts", "app", on(macAll, "cmd+slash"), on(winLinuxAll, "ctrl+shift+slash")),
		cmd("app.settings", "app", on(macApp, "cmd+comma"), on(winLinuxApp, "ctrl+comma")),
		cmd("app.agentAttention", "app", on(macApp, "cmd+shift+a"), on(winLinuxApp, "ctrl+shift+a")),
		cmd("app.addMachine", "app"),
		// The desktop app on macOS: System Settings at Full Disk Access.
		cmd("app.fullDiskAccess", "app"),

		cmd("workspace.switch", "workspace", on(macApp, "cmd+p"), on(winLinuxApp, "ctrl+shift+k")),
		cmd("workspace.next", "workspace", on(macApp, "cmd+ctrl+down"), on(winApp, "ctrl+shift+pagedown"), on(linuxApp, "ctrl+alt+down")),
		cmd("workspace.previous", "workspace", on(macApp, "cmd+ctrl+up"), on(winApp, "ctrl+shift+pageup"), on(linuxApp, "ctrl+alt+up")),
		cmd("workspace.new", "workspace", on(macApp, "cmd+n"), on(winLinuxApp, "ctrl+shift+n")),
		cmd("workspace.edit", "workspace"),
		cmd("workspace.mute", "workspace"),
		cmd("workspace.unmute", "workspace"),
		cmd("workspace.close", "workspace"),
		// Every other workspace of the machine, asking once as Close
		// Workspace does.
		cmd("workspace.closeOthers", "workspace"),

		cmd("tab.new", "tab", on(macApp, "cmd+t"), on(winLinuxApp, "ctrl+shift+t")),
		cmd("tab.rename", "tab"),
		cmd("tab.next", "tab", on(macApp, "cmd+shift+bracketright"), on(macApp, "ctrl+tab"), on(winApp, "ctrl+tab"), on(linuxApp, "ctrl+tab"), on(linuxApp, "ctrl+pagedown")),
		cmd("tab.previous", "tab", on(macApp, "cmd+shift+bracketleft"), on(macApp, "ctrl+shift+tab"), on(winApp, "ctrl+shift+tab"), on(linuxApp, "ctrl+shift+tab"), on(linuxApp, "ctrl+pageup")),
	}
	// Cmd+1…8 select a tab and Cmd+9 the last one, as in browsers.
	for i := 1; i <= 9; i++ {
		out = append(out, cmd(fmt.Sprintf("tab.select%d", i), "tab", on(macApp, fmt.Sprintf("cmd+%d", i)), on(winLinuxApp, fmt.Sprintf("alt+%d", i))))
	}
	out = append(out,
		cmd("tab.close", "tab", on(macApp, "cmd+shift+w"), on(winLinuxApp, "ctrl+shift+w")),
		// As browsers offer them; at once, with one Undo, as Close Tab.
		cmd("tab.closeOthers", "tab"),
		cmd("tab.closeRight", "tab"),
		// Pinned tabs stay first and Close Others and Close to the Right
		// leave them; as VS Code and browsers offer, without a key.
		cmd("tab.pin", "tab"),
		cmd("tab.unpin", "tab"),
		cmd("tab.mute", "tab"),
		cmd("tab.unmute", "tab"),
		// The browser plugin: a new tab with an empty browser pane on the
		// focused machine, and the focused browser pane's page again.
		cmd("browser.open", "tab"),
		cmd("browser.reload", "tab"),
		// The chat plugin: a new tab with a chat with an agent on the
		// focused machine, in the focused pane's directory (a menu of the
		// agents when the machine has more than one). No default: the
		// agents' own keys stay theirs.
		cmd("chat.new", "tab"),

		cmd("pane.splitRight", "pane", on(macApp, "cmd+d"), on(winApp, "alt+shift+equal"), on(linuxApp, "ctrl+shift+d")),
		cmd("pane.splitDown", "pane", on(macApp, "cmd+shift+d"), on(winApp, "alt+shift+minus"), on(linuxApp, "ctrl+shift+o")),
		cmd("pane.close", "pane", on(macApp, "cmd+w")),
		cmd("pane.zoom", "pane", on(macApp, "cmd+shift+enter"), on(winLinuxApp, "ctrl+shift+enter")),
		// Switches focus between the active pane (editor/terminal) and app
		// chrome so app shortcuts run without editor/terminal interception.
		cmd("pane.leave", "pane", Default{Key: "ctrl+b"}),
		// Renames the focused terminal's pane in its header. No default:
		// F2 and the like belong to the programs in the terminals.
		cmd("pane.rename", "pane"),
		// The focused pane's menu (its header's), at its header: every
		// command of the pane from the keyboard.
		cmd("pane.actions", "pane"),
		cmd("pane.focusLeft", "pane", on(macApp, "cmd+alt+left"), on(winLinuxApp, "alt+shift+left")),
		cmd("pane.focusDown", "pane", on(macApp, "cmd+alt+down"), on(winLinuxApp, "alt+shift+down")),
		cmd("pane.focusUp", "pane", on(macApp, "cmd+alt+up"), on(winLinuxApp, "alt+shift+up")),
		cmd("pane.focusRight", "pane", on(macApp, "cmd+alt+right"), on(winLinuxApp, "alt+shift+right")),
		cmd("pane.focusNext", "pane"),
		cmd("pane.focusPrevious", "pane"),
		// Back and forward through the panes focused, with the keys of
		// Safari, Finder and Xcode on macOS and Explorer/VS Code elsewhere.
		cmd("pane.back", "pane", on(macApp, "cmd+bracketleft"), on(winLinuxApp, "alt+left")),
		cmd("pane.forward", "pane", on(macApp, "cmd+bracketright"), on(winLinuxApp, "alt+right")),
		// Brings back what Close Pane or Close Tab closed in the last
		// seconds. Cmd+Z in a terminal: the page takes it there; text fields
		// and VS Code keep it for Undo (desktop/src/menu.ts).
		cmd("pane.undoClose", "pane", on(macApp, "cmd+z"), on(winLinuxApp, "ctrl+shift+z")),

		cmd("view.toggleSidebar", "view", on(macApp, "cmd+b"), on(winLinuxApp, "ctrl+shift+b")),
		// The right sidebar: the plugins' panels (web/src/plugins), with
		// VS Code's key for its secondary sidebar.
		cmd("view.togglePanel", "view", on(macApp, "cmd+alt+b"), on(winLinuxApp, "alt+shift+b")),
		// The file explorer's panel, with VS Code's key for its explorer.
		cmd("view.panel.files", "view", on(macApp, "cmd+shift+e"), on(winLinuxApp, "ctrl+shift+e")),
		// The desktop app's zoom (the window.zoom setting), with the keys
		// browsers zoom pages with, which they keep for themselves; also in
		// dialogs and VS Code, as the window's zoom is. Ctrl+= is Zoom In
		// too, as it is in terminal emulators and browsers on Windows and
		// Linux.
		always("view.zoomIn", "view", on(macApp, "cmd+shift+equal"), on(macApp, "cmd+equal"),
			on(winLinuxApp, "ctrl+shift+equal"), on(winLinuxApp, "ctrl+equal")),
		always("view.zoomOut", "view", on(macApp, "cmd+minus"), on(winLinuxApp, "ctrl+minus")),
		always("view.zoomReset", "view", on(macApp, "cmd+0"), on(winLinuxApp, "ctrl+0")),
		// The variable vault's panel (plugin vault).
		cmd("view.panel.vault", "view"),
		// The AI usage plugin's panel (web/src/plugins/usage).
		cmd("view.panel.usage", "view"),
		// The Git plugin's panel, with VS Code's key for its Source Control.
		cmd("view.panel.git", "view", on(macApp, "ctrl+shift+g"), on(winLinuxApp, "ctrl+shift+g")),
		// The System Monitor & Task Manager plugin's panel (web/src/plugins/monitor).
		cmd("view.panel.monitor", "view"),

		cmd("find.open", "find", on(macAll, "cmd+f"), on(winLinuxAll, "ctrl+shift+f")),
		cmd("find.next", "find", on(macApp, "cmd+g")),
		cmd("find.previous", "find", on(macApp, "cmd+shift+g")),

		// Inside VS Code its own cmd+j (its panel) runs instead; on a
		// VS Code pane whose header has the keyboard (the bridge
		// extension's ctrl+b) it shows the pane focused before it.
		cmd("code.open", "code", on(macApp, "cmd+j"), on(winLinuxApp, "ctrl+shift+j")),
		cmd("code.diff", "code"),
		cmd("code.gitGraph", "code"),
		// The Git plugin's graph pane.
		cmd("git.graph", "code"),
	)
	return out
}()

// Renamed are the commands of earlier versions that another one took the
// place of: the user's rules naming the old id apply to the new one.
var Renamed = map[string]string{
	// The VS Code panel's toggle: VS Code is a pane now, opened as a tab.
	"view.toggleCode": "code.open",
	// Renaming a workspace became editing its name and directory.
	"workspace.rename": "workspace.edit",
}

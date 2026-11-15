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

// Platforms the default bindings differ by: the desktop app on macOS and
// on other systems, and browsers on either. Browsers keep Cmd+T, Cmd+W and
// similar keys for themselves, so most direct shortcuts exist only in the
// desktop app.
const (
	PlatformMac        = "mac"
	PlatformPC         = "pc"
	PlatformMacBrowser = "mac-browser"
	PlatformPCBrowser  = "pc-browser"
)

// Platforms lists every platform, in the API's order.
var Platforms = []string{PlatformMac, PlatformPC, PlatformMacBrowser, PlatformPCBrowser}

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
	macApp     = []string{PlatformMac}
	pcApp      = []string{PlatformPC}
	macBrowser = []string{PlatformMacBrowser}
	macAll     = []string{PlatformMac, PlatformMacBrowser}
	pcAll      = []string{PlatformPC, PlatformPCBrowser}
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
// (Cmd+T, Cmd+1…9, Cmd+Option+arrows, Cmd+Shift+Enter…); on other systems
// Ctrl+Shift keys (as terminal emulators use, since Ctrl+W and Ctrl+T are
// keys of shells), Ctrl+Tab and Alt with a digit (as GNOME Terminal and
// Konsole switch tabs), and Ctrl with +, - or 0 for the zoom (as GNOME
// Terminal and Windows Terminal change the font size). No default is a
// chord, and none is Ctrl or Alt with a letter alone or a function key,
// which programs in terminals read: every key that is not a default reaches
// the terminal on its first press.
// Browsers get only keys they leave to pages: find, the command palette on
// macOS (Cmd+K; Cmd+Shift+P opens a private window in Firefox, as
// Ctrl+Shift+P does elsewhere, where no key is left for it and the status
// bar opens it) and the keyboard shortcuts. A command without a key runs
// from the menus, the command palette or its button, and the user can bind
// any key or chord to it.
var Commands = func() []Command {
	out := []Command{
		cmd("app.commandPalette", "app", on(macApp, "cmd+shift+p"), on(pcApp, "ctrl+shift+p"), on(macBrowser, "cmd+k")),
		cmd("app.keyboardShortcuts", "app", on(macAll, "cmd+slash"), on(pcAll, "ctrl+shift+slash")),
		cmd("app.settings", "app", on(macApp, "cmd+comma"), on(pcApp, "ctrl+comma")),
		cmd("app.agentAttention", "app", on(macApp, "cmd+shift+a"), on(pcApp, "ctrl+shift+a")),
		cmd("app.addMachine", "app"),
		// The desktop app on macOS: System Settings at Full Disk Access.
		cmd("app.fullDiskAccess", "app"),

		cmd("workspace.switch", "workspace", on(macApp, "cmd+p")),
		cmd("workspace.next", "workspace", on(macApp, "cmd+ctrl+down")),
		cmd("workspace.previous", "workspace", on(macApp, "cmd+ctrl+up")),
		cmd("workspace.new", "workspace", on(macApp, "cmd+n"), on(pcApp, "ctrl+shift+n")),
		cmd("workspace.edit", "workspace"),
		cmd("workspace.close", "workspace"),

		cmd("tab.new", "tab", on(macApp, "cmd+t"), on(pcApp, "ctrl+shift+t")),
		cmd("tab.rename", "tab"),
		cmd("tab.next", "tab", on(macApp, "cmd+shift+bracketright"), on(macApp, "ctrl+tab"), on(pcApp, "ctrl+tab")),
		cmd("tab.previous", "tab", on(macApp, "cmd+shift+bracketleft"), on(macApp, "ctrl+shift+tab"), on(pcApp, "ctrl+shift+tab")),
	}
	// Cmd+1…8 select a tab and Cmd+9 the last one, as in browsers.
	for i := 1; i <= 9; i++ {
		out = append(out, cmd(fmt.Sprintf("tab.select%d", i), "tab", on(macApp, fmt.Sprintf("cmd+%d", i)), on(pcApp, fmt.Sprintf("alt+%d", i))))
	}
	out = append(out,
		cmd("tab.close", "tab", on(macApp, "cmd+shift+w"), on(pcApp, "ctrl+shift+w")),

		cmd("pane.splitRight", "pane", on(macApp, "cmd+d")),
		cmd("pane.splitDown", "pane", on(macApp, "cmd+shift+d")),
		cmd("pane.close", "pane", on(macApp, "cmd+w")),
		cmd("pane.zoom", "pane", on(macApp, "cmd+shift+enter"), on(pcApp, "ctrl+shift+enter")),
		cmd("pane.focusLeft", "pane", on(macApp, "cmd+alt+left")),
		cmd("pane.focusDown", "pane", on(macApp, "cmd+alt+down")),
		cmd("pane.focusUp", "pane", on(macApp, "cmd+alt+up")),
		cmd("pane.focusRight", "pane", on(macApp, "cmd+alt+right")),
		cmd("pane.focusNext", "pane", on(macApp, "cmd+bracketright")),
		cmd("pane.focusPrevious", "pane", on(macApp, "cmd+bracketleft")),

		cmd("view.toggleSidebar", "view", on(macApp, "cmd+b")),
		// The desktop app's zoom (the window.zoom setting), with the keys
		// browsers zoom pages with, which they keep for themselves; also in
		// dialogs and VS Code, as the window's zoom is. Ctrl+= is Zoom In
		// too, as it is in terminal emulators and browsers on Windows and
		// Linux.
		always("view.zoomIn", "view", on(macApp, "cmd+shift+equal"), on(macApp, "cmd+equal"),
			on(pcApp, "ctrl+shift+equal"), on(pcApp, "ctrl+equal")),
		always("view.zoomOut", "view", on(macApp, "cmd+minus"), on(pcApp, "ctrl+minus")),
		always("view.zoomReset", "view", on(macApp, "cmd+0"), on(pcApp, "ctrl+0")),

		cmd("find.open", "find", on(macAll, "cmd+f"), on(pcAll, "ctrl+shift+f")),
		cmd("find.next", "find", on(macApp, "cmd+g")),
		cmd("find.previous", "find", on(macApp, "cmd+shift+g")),

		// Inside VS Code its own cmd+j (its panel) runs instead.
		cmd("code.open", "code", on(macApp, "cmd+j"), on(pcApp, "ctrl+shift+j")),
		cmd("code.diff", "code"),
		cmd("code.gitGraph", "code"),
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

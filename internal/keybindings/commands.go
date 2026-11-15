package keybindings

import "fmt"

// When tells where a binding applies: in the main window outside VS Code
// and dialogs (terminal), while VS Code has the keyboard (vscode), while a
// dialog of the application is open (dialog), or everywhere (always).
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

// Commands are every command, with the desktop app's direct shortcuts as
// defaults: Cmd on macOS, Ctrl+Shift on other systems (as terminal
// emulators use, since Ctrl+W and Ctrl+T are keys of shells). No default
// is a chord, and none is Ctrl or Alt with a letter alone or a function
// key, which programs in terminals read: every key that is not a default
// reaches the terminal on its first press. Browsers get only keys they leave to pages: find, the
// command palette on macOS (Cmd+K; Cmd+Shift+P opens a private window in
// Firefox, as Ctrl+Shift+P does elsewhere, where no key is left for it and
// the status bar opens it) and the list of shortcuts. A command without a
// key runs from the menus, the command palette or its button, and the user
// can bind any key or chord to it.
var Commands = func() []Command {
	out := []Command{
		cmd("app.commandPalette", "app", on(macApp, "cmd+shift+p"), on(pcApp, "ctrl+shift+p"), on(macBrowser, "cmd+k")),
		cmd("app.keyboardShortcuts", "app", on(macAll, "cmd+slash"), on(pcAll, "ctrl+shift+slash")),
		cmd("app.settings", "app", on(macApp, "cmd+comma"), on(pcApp, "ctrl+comma")),
		cmd("app.agentAttention", "app"),

		cmd("workspace.switch", "workspace"),
		cmd("workspace.next", "workspace"),
		cmd("workspace.previous", "workspace"),
		cmd("workspace.new", "workspace", on(macApp, "cmd+n"), on(pcApp, "ctrl+shift+n")),
		cmd("workspace.rename", "workspace"),
		cmd("workspace.close", "workspace"),

		cmd("tab.new", "tab", on(macApp, "cmd+t"), on(pcApp, "ctrl+shift+t")),
		cmd("tab.rename", "tab"),
		cmd("tab.next", "tab", on(macApp, "cmd+shift+bracketright")),
		cmd("tab.previous", "tab", on(macApp, "cmd+shift+bracketleft")),
	}
	for i := 1; i <= 9; i++ {
		out = append(out, cmd(fmt.Sprintf("tab.select%d", i), "tab"))
	}
	out = append(out,
		cmd("tab.close", "tab", on(pcApp, "ctrl+shift+w")),

		cmd("pane.splitRight", "pane", on(macApp, "cmd+d")),
		cmd("pane.splitDown", "pane", on(macApp, "cmd+shift+d")),
		cmd("pane.close", "pane", on(macApp, "cmd+w")),
		cmd("pane.zoom", "pane"),
		cmd("pane.focusLeft", "pane"),
		cmd("pane.focusDown", "pane"),
		cmd("pane.focusUp", "pane"),
		cmd("pane.focusRight", "pane"),
		cmd("pane.focusNext", "pane"),
		cmd("pane.focusPrevious", "pane"),

		cmd("view.toggleSidebar", "view", on(macApp, "cmd+b")),
		// Hiding the VS Code panel from inside VS Code is what the key is for.
		Command{ID: "view.toggleCode", Section: "view", When: WhenAlways,
			Defaults: []Default{on(macApp, "cmd+j"), on(pcApp, "ctrl+shift+j")}},

		cmd("find.open", "find", on(macAll, "cmd+f"), on(pcAll, "ctrl+shift+f")),
		cmd("find.next", "find", on(macApp, "cmd+g")),
		cmd("find.previous", "find", on(macApp, "cmd+shift+g")),

		cmd("code.open", "code"),
		cmd("code.diff", "code"),
		cmd("code.gitGraph", "code"),
	)
	return out
}()

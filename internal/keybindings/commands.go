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

// Platforms the default bindings differ by: the desktop applications on
// macOS and on other systems, and browsers on either. Browsers keep
// Cmd+T, Cmd+W and similar keys for themselves, so most direct shortcuts
// exist only in the applications; the prefix chords work everywhere.
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
	macApp = []string{PlatformMac}
	pcApp  = []string{PlatformPC}
	macAll = []string{PlatformMac, PlatformMacBrowser}
	pcAll  = []string{PlatformPC, PlatformPCBrowser}
)

func keys(all ...string) []Default {
	out := make([]Default, len(all))
	for i, k := range all {
		out[i] = Default{Key: k}
	}
	return out
}

func on(platforms []string, key string) Default { return Default{Key: key, Platforms: platforms} }

func cmd(id, section string, defaults ...Default) Command {
	return Command{ID: id, Section: section, When: WhenTerminal, Defaults: defaults}
}

// Commands are every command, with the defaults of herdr's prefix keymap
// (ctrl+b, then a key) on every platform and the applications' direct
// shortcuts: those of the macOS application's menu on macOS (Cmd), the
// desktop app's on other systems (Ctrl+Shift, as terminal emulators use,
// since Ctrl+W and Ctrl+T are keys of shells).
var Commands = func() []Command {
	out := []Command{
		cmd("app.commandPalette", "app", keys("ctrl+b space", "ctrl+b g")...),
		cmd("app.keyboardShortcuts", "app", keys("ctrl+b shift+slash")...),
		cmd("app.settings", "app", Default{Key: "ctrl+b comma"}, on(macApp, "cmd+comma"), on(pcApp, "ctrl+comma")),
		cmd("app.agentAttention", "app", keys("ctrl+b o")...),

		cmd("workspace.switch", "workspace", keys("ctrl+b w")...),
		cmd("workspace.new", "workspace", Default{Key: "ctrl+b shift+n"}, on(macApp, "cmd+n"), on(pcApp, "ctrl+shift+n")),
		cmd("workspace.rename", "workspace", keys("ctrl+b shift+w")...),
		cmd("workspace.close", "workspace", keys("ctrl+b shift+d")...),

		cmd("tab.new", "tab", Default{Key: "ctrl+b c"}, on(macApp, "cmd+t"), on(pcApp, "ctrl+shift+t")),
		cmd("tab.rename", "tab", keys("ctrl+b shift+t")...),
		cmd("tab.next", "tab", Default{Key: "ctrl+b n"}, on(macApp, "cmd+shift+bracketright")),
		cmd("tab.previous", "tab", Default{Key: "ctrl+b p"}, on(macApp, "cmd+shift+bracketleft")),
	}
	for i := 1; i <= 9; i++ {
		out = append(out, cmd(fmt.Sprintf("tab.select%d", i), "tab", keys(fmt.Sprintf("ctrl+b %d", i))...))
	}
	out = append(out,
		cmd("tab.close", "tab", Default{Key: "ctrl+b shift+x"}, on(pcApp, "ctrl+shift+w")),

		cmd("pane.splitRight", "pane", Default{Key: "ctrl+b v"}, on(macApp, "cmd+d")),
		cmd("pane.splitDown", "pane", Default{Key: "ctrl+b minus"}, on(macApp, "cmd+shift+d")),
		cmd("pane.close", "pane", Default{Key: "ctrl+b x"}, on(macApp, "cmd+w")),
		cmd("pane.zoom", "pane", keys("ctrl+b z")...),
		cmd("pane.focusLeft", "pane", keys("ctrl+b h")...),
		cmd("pane.focusDown", "pane", keys("ctrl+b j")...),
		cmd("pane.focusUp", "pane", keys("ctrl+b k")...),
		cmd("pane.focusRight", "pane", keys("ctrl+b l")...),
		cmd("pane.focusNext", "pane", keys("ctrl+b tab")...),
		cmd("pane.focusPrevious", "pane", keys("ctrl+b shift+tab")...),

		cmd("view.toggleSidebar", "view", Default{Key: "ctrl+b b"}, on(macApp, "cmd+b")),
		// Hiding the VS Code panel from inside VS Code is what the key is for.
		Command{ID: "view.toggleCode", Section: "view", When: WhenAlways,
			Defaults: []Default{on(macApp, "cmd+j"), on(pcApp, "ctrl+shift+j")}},

		cmd("find.open", "find", on(macAll, "cmd+f"), on(pcAll, "ctrl+shift+f")),
		cmd("find.next", "find", on(macApp, "cmd+g")),
		cmd("find.previous", "find", on(macApp, "cmd+shift+g")),

		cmd("code.open", "code", keys("ctrl+b e")...),
		cmd("code.diff", "code", keys("ctrl+b d")...),
		cmd("code.gitGraph", "code", keys("ctrl+b shift+g")...),
	)
	return out
}()

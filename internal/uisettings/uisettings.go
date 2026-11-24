// Package uisettings defines the settings of the user interface: the web UI
// (also inside the desktop app) reads them from the core (/api/settings), so
// every client of a core looks and behaves the same
// and the values survive browsers, profiles and reinstalls. See
// docs/features/13-settings-and-appearance.md.
package uisettings

import (
	"slices"

	"veldr/internal/agentkinds"
	"veldr/internal/settings"
)

// terminalColors are a theme's terminal colors: the 16 ANSI colors are
// black to white, then their bright variants.
type terminalColors struct {
	Background, Foreground, Cursor, Selection string
	Palette                                   []string
}

// Setting keys the core itself does not read are named here for tests and
// the clients' documentation; the clients use the same strings.
const (
	Language   = "appearance.language"
	Theme      = "appearance.theme"
	ColorTheme = "appearance.colorTheme"
	UIFontSize = "appearance.uiFontSize"
	Zoom       = "window.zoom"
	FontFamily = "terminal.fontFamily"
	FontSize   = "terminal.fontSize"
	Scrollback = "terminal.scrollback"
	UndoClose  = "layout.undoClose"
	// KeptTerminals is how many terminals a page keeps attached, hidden,
	// besides the ones it shows.
	KeptTerminals = "performance.keptTerminals"
	MutedAgents   = "notifications.mutedAgents"
	SchemePrefix  = "terminal.colorScheme."
	ColorsPrefix  = "terminal.colors."
)

// SSHEnv is read by the core: whether the new terminals of an ssh machine
// get the variables of its ssh session (internal/server/sshenv.go).
const SSHEnv = "terminal.sshEnv"

// MaxKeptTerminals is the most terminals a page keeps attached while they
// are not shown: each holds a stream and an emulator with its scrollback.
const MaxKeptTerminals = 64

// MaxScrollback is the most lines a terminal keeps above its screen.
const MaxScrollback = 100_000

// MinZoom and MaxZoom bound the desktop app's zoom, in percent.
const (
	MinZoom = 50
	MaxZoom = 300
)

// MinUndoClose and MaxUndoClose bound the time, in seconds, a closed pane,
// tab or workspace can be brought back.
const (
	MinUndoClose = 3
	MaxUndoClose = 120
)

// Agents are the ids of the coding agents the terminals recognize (the
// kinds of internal/agentkinds, which are the manifests' of
// internal/agent/detect), sorted, offered by the list of silent agents.
var Agents = agentIDs()

func agentIDs() []string {
	var ids []string
	for _, k := range agentkinds.All() {
		ids = append(ids, k.ID)
	}
	slices.Sort(ids)
	return ids
}

// Schemes are the terminal color schemes the UIs offer; "default" is the
// design tokens' colors of the theme in use (web/src/terminal/schemes.ts
// has the colors of the others).
var Schemes = []string{
	"default", "dracula", "gruvbox-dark", "gruvbox-light", "nord", "one-dark", "one-light",
	"solarized-dark", "solarized-light", "tomorrow", "tomorrow-night",
}

func rng(min, max float64) (*float64, *float64) { return settings.Range(min, max) }

func defs() []settings.Def {
	uiMin, uiMax := rng(11, 20)
	zoomMin, zoomMax := rng(MinZoom, MaxZoom)
	fontMin, fontMax := rng(6, 40)
	lineMin, lineMax := rng(0.8, 2)
	cursorMin, cursorMax := rng(0.5, 4)
	scrollMin, scrollMax := rng(0, MaxScrollback)
	undoMin, undoMax := rng(MinUndoClose, MaxUndoClose)
	keptMin, keptMax := rng(0, MaxKeptTerminals)
	out := []settings.Def{
		// Performance: the terminals a page keeps attached while another tab,
		// workspace or machine is shown (the web UI's keptPanes.ts); 0 keeps none.
		{Key: KeptTerminals, Type: settings.TypeNumber, Default: 12, Min: keptMin, Max: keptMax, Integer: true, Step: 1,
			Section: "performance", Order: 10},

		// Appearance.
		{Key: Theme, Type: settings.TypeEnum, Default: "system", Enum: []string{"system", "light", "dark"},
			Section: "appearance", Order: 10},
		// The accent of the chrome (design/tokens.json themes); the neutrals
		// are the same in every one.
		{Key: ColorTheme, Type: settings.TypeEnum, Default: tokenThemes[0], Enum: append([]string(nil), tokenThemes...),
			Section: "appearance", Order: 15},
		{Key: Language, Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "en", "zh-CN"},
			Section: "appearance", Order: 20},
		{Key: UIFontSize, Type: settings.TypeNumber, Default: 13, Min: uiMin, Max: uiMax, Integer: true,
			Section: "appearance", Order: 30},
		// The desktop app's windows, terminals included, in percent: its shell
		// applies it; browsers zoom pages themselves.
		{Key: Zoom, Type: settings.TypeNumber, Default: 100, Min: zoomMin, Max: zoomMax, Integer: true, Step: 10,
			Section: "appearance", Order: 35},

		// Panes, tabs and workspaces: how long a close can be undone, in
		// seconds (the web UI's Undo Close).
		{Key: UndoClose, Type: settings.TypeNumber, Default: 5, Min: undoMin, Max: undoMax, Integer: true, Step: 1,
			Section: "layout", Order: 10},

		// Terminal.
		{Key: FontFamily, Type: settings.TypeString, Default: "", Section: "terminal", Group: "text", Order: 10},
		{Key: FontSize, Type: settings.TypeNumber, Default: 13, Min: fontMin, Max: fontMax, Step: 1,
			Section: "terminal", Group: "text", Order: 20},
		{Key: "terminal.fontWeight", Type: settings.TypeEnum, Default: "regular", Enum: []string{"regular", "medium"},
			Section: "terminal", Group: "text", Order: 30},
		{Key: "terminal.lineHeight", Type: settings.TypeNumber, Default: 1.05, Min: lineMin, Max: lineMax, Step: 0.05,
			Section: "terminal", Group: "text", Order: 40},
		// A thin bar by default, as text fields and editors show it; programs
		// may ask for another shape (DECSCUSR).
		{Key: "terminal.cursorStyle", Type: settings.TypeEnum, Default: "bar", Enum: []string{"block", "bar", "underline"},
			Section: "terminal", Group: "cursor", Order: 50},
		// The bar's and the underline's thickness, in CSS pixels.
		{Key: "terminal.cursorWidth", Type: settings.TypeNumber, Default: 1, Min: cursorMin, Max: cursorMax, Step: 0.5,
			Section: "terminal", Group: "cursor", Order: 55},
		{Key: "terminal.cursorBlink", Type: settings.TypeBool, Default: true, Section: "terminal", Group: "cursor", Order: 60},
		{Key: Scrollback, Type: settings.TypeNumber, Default: 10000, Min: scrollMin, Max: scrollMax, Integer: true,
			Step: 1000, Section: "terminal", Group: "behavior", Order: 70},
		{Key: "terminal.bell", Type: settings.TypeEnum, Default: "visual", Enum: []string{"none", "sound", "visual"},
			Section: "terminal", Group: "behavior", Order: 80},
		{Key: "terminal.optionIsMeta", Type: settings.TypeBool, Default: false, Section: "terminal", Group: "behavior", Order: 90},
		// LaTeX formulas in panes shown rendered under the pointer.
		{Key: "terminal.mathHover", Type: settings.TypeBool, Default: true, Section: "terminal", Group: "behavior", Order: 100},
		// SSH_CONNECTION and SSH_CLIENT in the terminals of ssh machines.
		{Key: SSHEnv, Type: settings.TypeBool, Default: true, Scope: settings.ScopeRemoteMachine,
			Section: "terminal", Group: "behavior", Order: 105},
		{Key: "terminal.copyOnSelect", Type: settings.TypeBool, Default: false, Section: "terminal", Group: "clipboard", Order: 110},
		// What a program's clipboard write (OSC 52) does.
		{Key: "terminal.programClipboard", Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "ask", "off"},
			Section: "terminal", Group: "clipboard", Order: 120},

		// Terminal colors: a scheme per theme, then the user's own colors,
		// which replace the scheme's.
		{Key: SchemePrefix + "dark", Type: settings.TypeEnum, Default: "default", Enum: Schemes, Section: "colors", Order: 10},
		{Key: SchemePrefix + "light", Type: settings.TypeEnum, Default: "default", Enum: Schemes, Section: "colors", Order: 20},
		{Key: "terminal.boldIsBright", Type: settings.TypeBool, Default: false, Section: "colors", Order: 30},

		// Notifications: sounds, the system's notifications and the badge,
		// each on by default, with droid silent (sounds only).
		{Key: "notifications.sound", Type: settings.TypeBool, Default: true, Section: "notifications", Order: 10},
		{Key: "notifications.system", Type: settings.TypeBool, Default: true, Section: "notifications", Order: 20},
		{Key: "notifications.badge", Type: settings.TypeBool, Default: true, Section: "notifications", Order: 30},
		{Key: MutedAgents, Type: settings.TypeList, Item: settings.TypeString, Options: Agents, Default: []string{"droid"},
			Section: "notifications", Order: 40},
	}
	// The colors of each theme that replace its scheme's, defaulting to the
	// design tokens (the default scheme).
	for i, theme := range []string{"dark", "light"} {
		c := tokenColors[theme]
		p := ColorsPrefix + theme + "."
		base := 100 * (i + 1)
		out = append(out,
			settings.Def{Key: p + "foreground", Type: settings.TypeColor, Default: c.Foreground, Section: "colors", Order: base + 1},
			settings.Def{Key: p + "background", Type: settings.TypeColor, Default: c.Background, Section: "colors", Order: base + 2},
			settings.Def{Key: p + "cursor", Type: settings.TypeColor, Default: c.Cursor, Section: "colors", Order: base + 3},
			settings.Def{Key: p + "selection", Type: settings.TypeColor, Default: c.Selection, Section: "colors", Order: base + 4},
			settings.Def{Key: p + "palette", Type: settings.TypeList, Item: settings.TypeColor, Length: 16,
				Default: append([]string(nil), c.Palette...), Section: "colors", Order: base + 5},
		)
	}
	return out
}

// Module is the user interfaces' sections and settings.
var Module = settings.Module{
	Sections: []settings.Section{
		{ID: "appearance", Order: 10},
		{ID: "layout", Order: 20},
		{ID: "terminal", Order: 30},
		{ID: "colors", Order: 40},
		{ID: "notifications", Order: 50},
		{ID: "performance", Order: 90, Advanced: true},
	},
	Defs: defs(),
}

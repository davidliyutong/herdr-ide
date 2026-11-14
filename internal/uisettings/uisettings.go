// Package uisettings defines the settings of the user interfaces: the web UI
// (also inside the desktop app) and the macOS application read them from the
// core (/api/settings), so every client of a core looks and behaves the same
// and the values survive browsers, profiles and reinstalls. See
// docs/features/13-settings-and-appearance.md.
package uisettings

import (
	"herdr-ide/internal/settings"
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
	Language     = "appearance.language"
	Theme        = "appearance.theme"
	UIFontSize   = "appearance.uiFontSize"
	FontFamily   = "terminal.fontFamily"
	FontSize     = "terminal.fontSize"
	ColorsPrefix = "terminal.colors."
)

func rng(min, max float64) (*float64, *float64) { return settings.Range(min, max) }

func defs() []settings.Def {
	web := []string{settings.PlatformWeb}
	uiMin, uiMax := rng(11, 20)
	fontMin, fontMax := rng(6, 40)
	lineMin, lineMax := rng(0.8, 2)
	scrollMin, scrollMax := rng(0, 1_000_000)
	out := []settings.Def{
		// Appearance.
		{Key: Language, Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "en", "zh-CN"},
			Section: "appearance", Order: 10, Platforms: web},
		{Key: Theme, Type: settings.TypeEnum, Default: "system", Enum: []string{"system", "dark", "light"},
			Section: "appearance", Order: 20},
		{Key: UIFontSize, Type: settings.TypeNumber, Default: 13, Min: uiMin, Max: uiMax, Integer: true,
			Section: "appearance", Order: 30},

		// Layout.
		{Key: "layout.panelPosition", Type: settings.TypeEnum, Default: "right", Enum: []string{"right", "bottom"},
			Section: "layout", Order: 10, Platforms: web},

		// Terminal.
		{Key: FontFamily, Type: settings.TypeString, Default: "", Section: "terminal", Order: 10},
		{Key: FontSize, Type: settings.TypeNumber, Default: 13, Min: fontMin, Max: fontMax, Section: "terminal", Order: 20},
		{Key: "terminal.fontWeight", Type: settings.TypeEnum, Default: "regular", Enum: []string{"regular", "medium"},
			Section: "terminal", Order: 30},
		{Key: "terminal.lineHeight", Type: settings.TypeNumber, Default: 1.05, Min: lineMin, Max: lineMax,
			Section: "terminal", Order: 40},
		{Key: "terminal.cursorStyle", Type: settings.TypeEnum, Default: "block", Enum: []string{"block", "bar", "underline"},
			Section: "terminal", Order: 50},
		{Key: "terminal.cursorBlink", Type: settings.TypeBool, Default: true, Section: "terminal", Order: 60},
		{Key: "terminal.scrollback", Type: settings.TypeNumber, Default: 10000, Min: scrollMin, Max: scrollMax, Integer: true,
			Section: "terminal", Order: 70},
		{Key: "terminal.copyOnSelect", Type: settings.TypeBool, Default: false, Section: "terminal", Order: 80},
		{Key: "terminal.bell", Type: settings.TypeEnum, Default: "visual", Enum: []string{"none", "sound", "visual"},
			Section: "terminal", Order: 90},
		{Key: "terminal.boldIsBright", Type: settings.TypeBool, Default: false, Section: "terminal", Order: 100},
		{Key: "terminal.optionIsMeta", Type: settings.TypeBool, Default: false, Section: "terminal", Order: 110},
		// What a program's clipboard write (OSC 52) does.
		{Key: "terminal.programClipboard", Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "ask", "off"},
			Section: "terminal", Order: 120},
		// LaTeX formulas in panes shown rendered under the pointer.
		{Key: "terminal.mathHover", Type: settings.TypeBool, Default: true, Section: "terminal", Order: 130, Platforms: web},

		// Notifications: on by default, with droid muted.
		{Key: "notifications.sound", Type: settings.TypeBool, Default: true, Section: "notifications", Order: 10, Platforms: web},
		{Key: "notifications.mutedAgents", Type: settings.TypeString, Default: "droid", Section: "notifications", Order: 20, Platforms: web},
	}
	// Terminal colors per theme, defaulting to the design tokens.
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
	},
	Defs: defs(),
}

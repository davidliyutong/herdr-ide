// Package uisettings defines the settings of the user interface: the web UI
// (also inside the desktop app) reads them from the core (/api/settings), so
// every client of a core looks and behaves the same
// and the values survive browsers, profiles and reinstalls. See
// docs/features/13-settings-and-appearance.md.
package uisettings

import (
	"strings"

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
	Zoom         = "window.zoom"
	FontFamily   = "terminal.fontFamily"
	FontSize     = "terminal.fontSize"
	Scrollback   = "terminal.scrollback"
	MutedAgents  = "notifications.mutedAgents"
	SchemePrefix = "terminal.colorScheme."
	ColorsPrefix = "terminal.colors."
)

// MaxScrollback is the most lines a terminal keeps above its screen.
const MaxScrollback = 100_000

// MinZoom and MaxZoom bound the desktop app's zoom, in percent.
const (
	MinZoom = 50
	MaxZoom = 300
)

// Agents are the coding agents the terminals recognize (the manifests'
// ids, internal/agent/detect), offered by the list of silent agents.
var Agents = []string{
	"agy", "amp", "claude", "cline", "codex", "copilot", "cursor", "devin", "droid", "gemini", "grok",
	"hermes", "kilo", "kimi", "kiro", "letta", "maki", "muse", "opencode", "pi", "qodercli", "qwen",
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
	scrollMin, scrollMax := rng(0, MaxScrollback)
	out := []settings.Def{
		// Appearance.
		{Key: Theme, Type: settings.TypeEnum, Default: "system", Enum: []string{"system", "light", "dark"},
			Section: "appearance", Order: 10},
		{Key: Language, Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "en", "zh-CN"},
			Section: "appearance", Order: 20},
		{Key: UIFontSize, Type: settings.TypeNumber, Default: 13, Min: uiMin, Max: uiMax, Integer: true,
			Section: "appearance", Order: 30},
		// The desktop app's windows, terminals included, in percent: its shell
		// applies it; browsers zoom pages themselves.
		{Key: Zoom, Type: settings.TypeNumber, Default: 100, Min: zoomMin, Max: zoomMax, Integer: true, Step: 10,
			Section: "appearance", Order: 35},
		{Key: "layout.panelPosition", Type: settings.TypeEnum, Default: "right", Enum: []string{"right", "bottom"},
			Section: "appearance", Order: 40},

		// Terminal.
		{Key: FontFamily, Type: settings.TypeString, Default: "", Section: "terminal", Group: "text", Order: 10},
		{Key: FontSize, Type: settings.TypeNumber, Default: 13, Min: fontMin, Max: fontMax, Step: 1,
			Section: "terminal", Group: "text", Order: 20},
		{Key: "terminal.fontWeight", Type: settings.TypeEnum, Default: "regular", Enum: []string{"regular", "medium"},
			Section: "terminal", Group: "text", Order: 30},
		{Key: "terminal.lineHeight", Type: settings.TypeNumber, Default: 1.05, Min: lineMin, Max: lineMax, Step: 0.05,
			Section: "terminal", Group: "text", Order: 40},
		{Key: "terminal.cursorStyle", Type: settings.TypeEnum, Default: "block", Enum: []string{"block", "bar", "underline"},
			Section: "terminal", Group: "cursor", Order: 50},
		{Key: "terminal.cursorBlink", Type: settings.TypeBool, Default: true, Section: "terminal", Group: "cursor", Order: 60},
		{Key: Scrollback, Type: settings.TypeNumber, Default: 10000, Min: scrollMin, Max: scrollMax, Integer: true,
			Step: 1000, Section: "terminal", Group: "behavior", Order: 70},
		{Key: "terminal.bell", Type: settings.TypeEnum, Default: "visual", Enum: []string{"none", "sound", "visual"},
			Section: "terminal", Group: "behavior", Order: 80},
		{Key: "terminal.optionIsMeta", Type: settings.TypeBool, Default: false, Section: "terminal", Group: "behavior", Order: 90},
		// LaTeX formulas in panes shown rendered under the pointer.
		{Key: "terminal.mathHover", Type: settings.TypeBool, Default: true, Section: "terminal", Group: "behavior", Order: 100},
		{Key: "terminal.copyOnSelect", Type: settings.TypeBool, Default: false, Section: "terminal", Group: "clipboard", Order: 110},
		// What a program's clipboard write (OSC 52) does.
		{Key: "terminal.programClipboard", Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "ask", "off"},
			Section: "terminal", Group: "clipboard", Order: 120},

		// Terminal colors: a scheme per theme, then the user's own colors,
		// which replace the scheme's.
		{Key: SchemePrefix + "dark", Type: settings.TypeEnum, Default: "default", Enum: Schemes, Section: "colors", Order: 10},
		{Key: SchemePrefix + "light", Type: settings.TypeEnum, Default: "default", Enum: Schemes, Section: "colors", Order: 20},
		{Key: "terminal.boldIsBright", Type: settings.TypeBool, Default: false, Section: "colors", Order: 30},

		// Notifications: on by default, with droid silent.
		{Key: "notifications.sound", Type: settings.TypeBool, Default: true, Section: "notifications", Order: 10},
		{Key: MutedAgents, Type: settings.TypeList, Item: settings.TypeString, Options: Agents, Default: []string{"droid"},
			Section: "notifications", Order: 20},
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

// mutedList turns the comma-separated silent agents of earlier versions
// into a list.
func mutedList(v any) (any, bool) {
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		out = append(out, strings.ToLower(f))
	}
	return out, true
}

// scrollbackInRange brings a scrollback above MaxScrollback, which earlier
// versions accepted, down to it.
func scrollbackInRange(v any) (any, bool) {
	n, ok := v.(float64)
	if !ok {
		return nil, false
	}
	return min(n, MaxScrollback), true
}

// Module is the user interfaces' sections and settings, with the values of
// earlier versions changed in place: the silent agents were a string, the
// scrollback went up to a million lines.
var Module = settings.Module{
	Sections: []settings.Section{
		{ID: "appearance", Order: 10},
		{ID: "terminal", Order: 30},
		{ID: "colors", Order: 40},
		{ID: "notifications", Order: 50},
	},
	Defs: defs(),
	Migrations: []settings.Migration{
		{From: MutedAgents, To: MutedAgents, Convert: mutedList},
		{From: Scrollback, To: Scrollback, Convert: scrollbackInRange},
	},
}

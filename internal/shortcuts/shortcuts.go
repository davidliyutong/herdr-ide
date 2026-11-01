// Package shortcuts defines the desktop app's direct shortcuts (keys without
// herdr's prefix, such as Cmd+T): core settings, so every window of the
// desktop app uses the same keys and they survive restarts. The desktop shell
// reads them from /api/settings and intercepts them before the page sees
// them; browsers do not use them (see docs/features/04-layout-and-keyboard.md).
package shortcuts

import (
	"errors"
	"regexp"
	"runtime"
	"strings"

	"herdr-ide/internal/settings"
)

// Settings, one per action. The UI shows them only in the desktop app.
const (
	SettingNewTab   = "desktop-new-tab-key"
	SettingCloseTab = "desktop-close-tab-key"
)

// None disables a shortcut.
const None = "none"

// modifier is cmd on macOS, ctrl elsewhere (cmd there is the Super key).
func modifier(goos string) string {
	if goos == "darwin" {
		return "cmd"
	}
	return "ctrl"
}

var namedKeys = map[string]bool{
	"tab": true, "space": true, "enter": true, "escape": true, "backspace": true, "delete": true,
	"left": true, "right": true, "up": true, "down": true, "home": true, "end": true,
	"pageup": true, "pagedown": true, "minus": true, "equal": true, "comma": true, "period": true,
	"slash": true, "backslash": true, "semicolon": true, "quote": true, "backtick": true,
	"bracketleft": true, "bracketright": true,
}

var plainKey = regexp.MustCompile(`^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$`)

// Validate accepts "none" or modifiers and one key joined by "+", e.g.
// "cmd+t", "ctrl+shift+w", "alt+f4". At least one of cmd, ctrl and alt is
// required, so a shortcut never takes a key that types text.
func Validate(spec string) error {
	if spec == None {
		return nil
	}
	parts := strings.Split(spec, "+")
	key := parts[len(parts)-1]
	if !plainKey.MatchString(key) && !namedKeys[key] {
		return errors.New("unknown key " + key)
	}
	seen := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		switch m {
		case "cmd", "ctrl", "alt", "shift":
		default:
			return errors.New("unknown modifier " + m)
		}
		if seen[m] {
			return errors.New("repeated modifier " + m)
		}
		seen[m] = true
	}
	if !seen["cmd"] && !seen["ctrl"] && !seen["alt"] {
		return errors.New("needs cmd, ctrl or alt")
	}
	return nil
}

func defs(goos string) []settings.Def {
	mod := modifier(goos)
	return []settings.Def{
		{
			Key: SettingNewTab, Kind: settings.KindString, Default: mod + "+t", Validate: Validate,
			Usage: "desktop app: shortcut for a new tab, as modifiers and a key joined by + (cmd, ctrl, alt, shift), or none",
		},
		{
			Key: SettingCloseTab, Kind: settings.KindString, Default: mod + "+w", Validate: Validate,
			Usage: "desktop app: shortcut that closes the current tab, as modifiers and a key joined by + (cmd, ctrl, alt, shift), or none",
		},
	}
}

// SettingDefs are the shortcut settings for this platform: cmd+t and cmd+w
// on macOS, ctrl+t and ctrl+w elsewhere.
var SettingDefs = defs(runtime.GOOS)

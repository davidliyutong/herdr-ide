package keybindings

import (
	"encoding/json"
	"os"
	"strings"

	"herdr-ide/internal/userfile"
)

// legacyShortcuts are the desktop app's shortcut settings of earlier
// versions (desktop-*-key in the settings file): the command each set and
// its defaults on macOS and elsewhere.
var legacyShortcuts = []struct {
	setting, command, mac, pc string
}{
	{"desktop-new-tab-key", "tab.new", "cmd+t", "ctrl+shift+t"},
	{"desktop-close-tab-key", "tab.close", "cmd+w", "ctrl+shift+w"},
	{"desktop-settings-key", "app.settings", "cmd+comma", "ctrl+comma"},
	{"desktop-new-workspace-key", "workspace.new", "cmd+n", "ctrl+shift+n"},
	{"desktop-toggle-code-key", "view.toggleCode", "cmd+j", "ctrl+shift+j"},
}

// MigrateDesktopShortcuts turns the desktop app's shortcut settings of an
// earlier version, found in the settings file, into rules of the
// keybindings file, once: only while that file does not exist. A shortcut
// changed from its default replaces the command's direct keys; "none"
// removes them. It returns whether it wrote the file. Run it before the
// settings are loaded, which drops the old settings.
func (s *Store) MigrateDesktopShortcuts(settingsFile string, mac bool) (bool, error) {
	path := s.Path()
	if path == "" {
		return false, nil
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		return false, nil
	}
	b, err := os.ReadFile(settingsFile)
	if err != nil {
		return false, nil
	}
	var old map[string]json.RawMessage
	if json.Unmarshal(b, &old) != nil {
		return false, nil
	}
	platform := PlatformPC
	if mac {
		platform = PlatformMac
	}
	var rules []Rule
	for _, l := range legacyShortcuts {
		var v string
		if json.Unmarshal(old[l.setting], &v) != nil {
			continue
		}
		v = strings.TrimSpace(v)
		previous := l.pc
		if mac {
			previous = l.mac
		}
		key, err := Normalize(v)
		if v != "none" && (err != nil || key == previous) {
			continue
		}
		// The command's direct (single-stroke) default keys on this platform
		// give way to the user's choice.
		for _, d := range s.Defaults(platform) {
			if d.Command == l.command && !strings.Contains(d.Key, " ") {
				rules = append(rules, Rule{Key: d.Key, Command: "-" + l.command})
			}
		}
		if v != "none" {
			rules = append(rules, Rule{Key: key, Command: l.command})
		}
	}
	if len(rules) == 0 {
		return false, nil
	}
	user := make([]json.RawMessage, len(rules))
	for i, r := range rules {
		user[i], _ = json.Marshal(r)
	}
	data, err := encode(user)
	if err != nil {
		return false, err
	}
	if _, err := userfile.Write(path, data); err != nil {
		return false, err
	}
	return true, nil
}

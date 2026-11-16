package files

import (
	"errors"
	"path"
	"strings"

	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// The explorer's settings (its page in Settings › Plugins). The web UI
// reads all but saveMethod; the core sends saveMethod to the agent with
// each save and replacing upload.
const (
	// SettingShowHidden: names starting with a dot are shown, in browsers
	// that did not choose with the panel's eye button.
	SettingShowHidden = "files.showHidden"
	// SettingExclude are patterns of names the tree never shows.
	SettingExclude = "files.exclude"
	// SettingFollowFocus: the root follows the focused pane, in browsers
	// that did not choose with the panel's crosshair.
	SettingFollowFocus = "files.followFocus"
	// SettingConfirmTrash: Move to Trash asks first.
	SettingConfirmTrash = "files.confirmTrash"
	// SettingSortOrder orders a folder's entries.
	SettingSortOrder = "files.sortOrder"
	// SettingSaveMethod is how saves write a file that is there (the
	// agent's files.MethodAuto or MethodReplace), per machine.
	SettingSaveMethod = "files.saveMethod"
)

// DefaultExclude are the names hidden by default, as VS Code's
// files.exclude: version control folders and the systems' folder files.
var DefaultExclude = []string{".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"}

// Settings is the plugin's settings module (internal/registry).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: "files", Order: 66, Plugin: "files"}},
	Defs: []settings.Def{
		{Key: SettingShowHidden, Type: settings.TypeBool, Default: false, Scope: settings.ScopeApp, Section: "files", Order: 10},
		{Key: SettingExclude, Type: settings.TypeList, Item: settings.TypeString, Default: DefaultExclude,
			Options: append(append([]string{}, DefaultExclude...), "node_modules", "__pycache__", "*.pyc", ".venv"),
			Scope:   settings.ScopeApp, Section: "files", Order: 20, Validate: validExclude},
		{Key: SettingSortOrder, Type: settings.TypeEnum, Default: "default", Enum: []string{"default", "mixed", "filesFirst", "type", "modified"},
			Scope: settings.ScopeApp, Section: "files", Order: 30},
		{Key: SettingFollowFocus, Type: settings.TypeBool, Default: true, Scope: settings.ScopeApp, Section: "files", Order: 40},
		{Key: SettingConfirmTrash, Type: settings.TypeBool, Default: false, Scope: settings.ScopeApp, Section: "files", Order: 50},
		{Key: SettingSaveMethod, Type: settings.TypeEnum, Default: "auto", Enum: []string{"auto", "replace"},
			Scope: settings.ScopeMachine, Section: "files", Order: 60},
	},
}

// validExclude accepts at most 100 patterns of names: not empty, at most
// 200 bytes, without "/" but in a leading "**/" (VS Code's form, which
// matches a name in any folder too), in path.Match's syntax.
func validExclude(v any) error {
	l, _ := v.([]string)
	if len(l) > 100 {
		return errors.New("at most 100 patterns")
	}
	for _, p := range l {
		name := strings.TrimPrefix(p, "**/")
		switch {
		case name == "" || len(p) > 200:
			return errors.New("a pattern is 1 to 200 bytes")
		case strings.Contains(name, "/"):
			return errors.New("patterns match names, without /")
		}
		if _, err := path.Match(name, ""); err != nil {
			return errors.New("not a pattern: " + p)
		}
	}
	return nil
}

// saveMethod is the save method set for the call's machine; empty (the
// agent's auto) without settings.
func saveMethod(c *plugin.Call) string {
	if c.Host == nil || c.Machine == nil {
		return ""
	}
	return methodFor(c.Host.Settings(), c.Machine.ID())
}

// methodFor is the save method of machine m in st ("" without settings).
func methodFor(st *settings.Store, m string) string {
	if st == nil {
		return ""
	}
	return st.String(SettingSaveMethod, m)
}

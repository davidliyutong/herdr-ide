package git

import "herdr-ide/internal/settings"

// The plugin's settings (its section of the settings, git); the web UI
// reads them (web/src/plugins/git, web/src/eol.ts).
const (
	// SettingMixedLineEndings: what editors and diffs do with a file whose
	// lines end in more than one way (LF and CRLF): keep each line's
	// ending, unify them, or open the file read-only.
	SettingMixedLineEndings = "git.mixedLineEndings"
)

// Settings is the plugin's settings module (internal/registry).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: "git", Order: 67, Plugin: "git"}},
	Defs: []settings.Def{
		{Key: SettingMixedLineEndings, Type: settings.TypeEnum, Default: "keep", Enum: []string{"keep", "unify", "readOnly"},
			Scope: settings.ScopeApp, Section: "git", Order: 10},
	},
}

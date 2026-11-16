package git

import "herdr-ide/internal/settings"

// The plugin's settings (its section of the settings, git); the web UI
// reads them (web/src/plugins/git, web/src/eol.ts).
const (
	// SettingMixedLineEndings: what editors and diffs do with a file whose
	// lines end in more than one way (LF and CRLF): keep each line's
	// ending, unify them, or open the file read-only.
	SettingMixedLineEndings = "git.mixedLineEndings"
	// SettingChangesView: Source Control's changes as a list or a tree.
	SettingChangesView = "git.changesView"
	// SettingUntrackedChanges: untracked files among the changes or in a
	// group of their own.
	SettingUntrackedChanges = "git.untrackedChanges"
	// SettingAutoFetch: minutes between fetches of every remote while the
	// panel shows a repository (0: never).
	SettingAutoFetch = "git.autoFetch"
	// SettingConfirmSync: ask before pulling, pushing or synchronizing.
	SettingConfirmSync = "git.confirmSync"
	// SettingGraphPageSize: the commits a page of the graph pane reads (the
	// machine's pages are at most 1000).
	SettingGraphPageSize = "git.graphPageSize"
)

var (
	autoFetchMin, autoFetchMax = settings.Range(0, 240)
	pageMin, pageMax           = settings.Range(50, 1000)
)

// Settings is the plugin's settings module (internal/registry).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: "git", Order: 66, Plugin: "git"}},
	Defs: []settings.Def{
		{Key: SettingMixedLineEndings, Type: settings.TypeEnum, Default: "keep", Enum: []string{"keep", "unify", "readOnly"},
			Scope: settings.ScopeApp, Section: "git", Order: 10},
		{Key: SettingChangesView, Type: settings.TypeEnum, Default: "list", Enum: []string{"list", "tree"},
			Scope: settings.ScopeApp, Section: "git", Order: 20},
		{Key: SettingUntrackedChanges, Type: settings.TypeEnum, Default: "mixed", Enum: []string{"mixed", "separate"},
			Scope: settings.ScopeApp, Section: "git", Order: 21},
		{Key: SettingAutoFetch, Type: settings.TypeNumber, Default: 0.0, Min: autoFetchMin, Max: autoFetchMax, Integer: true,
			Scope: settings.ScopeApp, Section: "git", Order: 30},
		{Key: SettingConfirmSync, Type: settings.TypeBool, Default: false,
			Scope: settings.ScopeApp, Section: "git", Order: 31},
		{Key: SettingGraphPageSize, Type: settings.TypeNumber, Default: 300.0, Min: pageMin, Max: pageMax, Integer: true, Step: 50,
			Scope: settings.ScopeApp, Section: "git", Order: 40},
	},
}

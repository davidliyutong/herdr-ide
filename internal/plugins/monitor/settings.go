package monitor

import "veldr/internal/settings"

// The plugin's settings (section "monitor"), read by the web UI
// (web/src/plugins/monitor).
const (
	// SettingRefreshSeconds: how often the dashboard popover and task manager
	// poll metrics and processes while visible.
	SettingRefreshSeconds = "monitor.refreshSeconds"
	// SettingStatusBar: whether the bottom-right status bar shows the system
	// monitor button.
	SettingStatusBar = "monitor.statusBar"
	// SettingConfirmKill: ask before sending a termination or kill signal to a
	// process from the task manager.
	SettingConfirmKill = "monitor.confirmKill"
)

var refreshMin, refreshMax = settings.Range(1, 30)

// Settings is the plugin's settings module (internal/registry).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: "monitor", Order: 68, Plugin: ID}},
	Defs: []settings.Def{
		{Key: SettingRefreshSeconds, Type: settings.TypeNumber, Default: 2.0, Min: refreshMin, Max: refreshMax, Integer: true,
			Scope: settings.ScopeApp, Section: "monitor", Order: 10},
		{Key: SettingStatusBar, Type: settings.TypeBool, Default: true,
			Scope: settings.ScopeApp, Section: "monitor", Order: 20},
		{Key: SettingConfirmKill, Type: settings.TypeBool, Default: true,
			Scope: settings.ScopeApp, Section: "monitor", Order: 30},
	},
}

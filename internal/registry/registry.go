// Package registry lists what the core registers in its settings and
// keybinding systems: the packages' setting modules and the commands. The
// core and scripts/registry (the UIs' defaults and translation keys, the
// reference's tables) use it, so the two cannot drift apart.
package registry

import (
	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/plugins/files"
	gitplugin "herdr-ide/internal/plugins/git"
	usageplugin "herdr-ide/internal/plugins/usage"
	vaultplugin "herdr-ide/internal/plugins/vault"
	"herdr-ide/internal/plugins/vscode"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/uisettings"
)

// Settings are the setting modules, user interfaces first, and the drop of
// the desktop app's shortcut settings of earlier versions, which became
// keybinding rules before the settings are loaded.
func Settings() []settings.Module {
	return []settings.Module{uisettings.Module, codeserver.Settings, gui.Settings, plugin.Settings(Plugins(), pluginsOff), legacyShortcuts(), usageplugin.Settings}
}

// Plugins are the core's plugins (internal/plugin), in the order the UIs
// list them.
func Plugins() []plugin.Plugin {
	return []plugin.Plugin{vscode.New(), files.New(), gitplugin.New(), usageplugin.New(), vaultplugin.New()}
}

// pluginsOff are the plugins that are off until the user turns them on:
// VS Code, whose windows run on the UI's origin (its switch for browsers
// is off by default too, plugin.BrowserRisk).
var pluginsOff = plugin.Defaults{vscode.ID: true}

// legacyShortcuts drops the desktop app's old shortcut settings
// (desktop-*-key) from the settings file.
func legacyShortcuts() settings.Module {
	var m settings.Module
	for _, name := range keybindings.LegacyShortcutSettings() {
		m.Migrations = append(m.Migrations, settings.Migration{From: name})
	}
	return m
}

// Commands are the commands keys can run.
func Commands() []keybindings.Command { return keybindings.Commands }

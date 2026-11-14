// Package registry lists what the core registers in its settings and
// keybinding systems: the packages' setting modules and the commands. The
// core and scripts/registry (the UIs' defaults and translation keys, the
// reference's tables) use it, so the two cannot drift apart.
package registry

import (
	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/uisettings"
)

// Settings are the setting modules, user interfaces first, and the drop of
// the desktop app's shortcut settings of earlier versions, which became
// keybinding rules before the settings are loaded.
func Settings() []settings.Module {
	return []settings.Module{uisettings.Module, codeserver.Settings, gui.Settings, legacyShortcuts()}
}

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

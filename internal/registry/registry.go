// Package registry lists what the core registers in its settings and
// keybinding systems: the packages' setting modules and the commands. The
// core and scripts/settingskeys (the UIs' translation keys) use it, so the
// two cannot drift apart.
package registry

import (
	"herdr-ide/internal/codeserver"
	"herdr-ide/internal/gui"
	"herdr-ide/internal/keybindings"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/uisettings"
)

// Settings are the setting modules, user interfaces first.
func Settings() []settings.Module {
	return []settings.Module{uisettings.Module, codeserver.Settings, gui.Settings}
}

// Commands are the commands keys can run.
func Commands() []keybindings.Command { return keybindings.Commands }

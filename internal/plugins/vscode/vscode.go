// Package vscode is VS Code (code-server, docs/features/05-vscode-panes.md)
// as a plugin: its switch, plugins.vscode.enabled. The routes stay the
// core's own (/api/m/{id}/code/*, the proxy below /m/{id}/code/), which
// the core refuses with plugin_disabled while the plugin is off
// (internal/server/codeserver.go), so code-server is neither fetched nor
// started on a machine.
package vscode

import "herdr-ide/internal/plugin"

// ID is the plugin's id.
const ID = "vscode"

// Plugin is VS Code.
type Plugin struct{}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (*Plugin) ID() string { return ID }

// Routes: none of its own (see the package comment).
func (*Plugin) Routes() []plugin.Route { return nil }

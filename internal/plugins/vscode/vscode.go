// Package vscode is VS Code (code-server, docs/features/05-vscode-panes.md)
// as a plugin. code-server is served on the UI's own origin, so its
// extensions and webviews can do whatever the page can: the plugin is a
// plugin.BrowserRisk, with two switches, both off by default:
// plugins.vscode.enabled for the desktop app's windows and
// plugins.vscode.browser for browsers, which the UI sets only after the
// user accepted that risk. The routes stay the core's own
// (/api/m/{id}/code/*, the proxy below /m/{id}/code/, the bridge's
// commands), which the core refuses with plugin_disabled to a client
// whose switch is off (internal/server/codeserver.go), so code-server is
// neither fetched nor started on a machine for it.
package vscode

import "veldr/internal/plugin"

// ID is the plugin's id.
const ID = "vscode"

// Plugin is VS Code.
type Plugin struct{}

// New returns the plugin.
func New() *Plugin { return &Plugin{} }

func (*Plugin) ID() string { return ID }

// Routes: none of its own (see the package comment).
func (*Plugin) Routes() []plugin.Route { return nil }

// BrowserRisk: VS Code's windows run on the UI's origin.
func (*Plugin) BrowserRisk() {}

//go:build unix

package agent

import (
	"context"
	"fmt"
	"net"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// pluginEnv is what the agent gives its plugins (internal/agent/plugin).
func (a *Agent) pluginEnv() *plugin.Env {
	return &plugin.Env{
		Home:    a.home,
		Base:    a.base,
		RunDir:  a.runDir,
		Logger:  a.logger,
		Expand:  a.expand,
		Environ: cleanEnv,
	}
}

// handlePlugin runs an action of a plugin's machine side (op plugin).
func (a *Agent) handlePlugin(ctx context.Context, st net.Conn, h agentproto.Header) error {
	run := plugin.Lookup(h.Plugin)
	if run == nil {
		defer st.Close()
		return plugin.Fail(st, plugin.Errorf("unknown_plugin", "unknown plugin %q", h.Plugin))
	}
	if h.Action == "" {
		defer st.Close()
		return plugin.Fail(st, plugin.Errorf("bad_params", "%s: no action", h.Plugin))
	}
	if err := run(ctx, st, h.Action, h.Params, a.pluginEnv()); err != nil {
		return fmt.Errorf("%s.%s: %w", h.Plugin, h.Action, err)
	}
	return nil
}

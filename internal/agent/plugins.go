//go:build unix

package agent

import (
	"context"
	"fmt"
	"net"
	"runtime/debug"
	"sync/atomic"

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

// handlePlugin runs an action of a plugin's machine side (op plugin). Params
// larger than a line follow the header (Header.ParamsLength). A handler that
// panics fails its action (code failed) instead of ending the agent.
func (a *Agent) handlePlugin(ctx context.Context, st net.Conn, h agentproto.Header) error {
	run := plugin.Lookup(h.Plugin)
	params := h.Params
	if h.ParamsLength > 0 {
		body, err := agentproto.ReadBody(st, h.ParamsLength)
		if err != nil {
			defer st.Close()
			return plugin.Fail(st, plugin.Errorf("bad_params", "%s: %v", h.Plugin, err))
		}
		params = body
	}
	if run == nil {
		defer st.Close()
		return plugin.Fail(st, plugin.Errorf("unknown_plugin", "unknown plugin %q", h.Plugin))
	}
	if h.Action == "" {
		defer st.Close()
		return plugin.Fail(st, plugin.Errorf("bad_params", "%s: no action", h.Plugin))
	}
	return runPlugin(ctx, run, &writtenConn{Conn: st}, h.Plugin, h.Action, params, a.pluginEnv())
}

// runPlugin runs a handler and recovers from its panic: the action fails
// with the code failed when it has not answered yet, and its stream is
// closed. A goroutine the handler started is not covered.
func runPlugin(ctx context.Context, run plugin.Handler, st *writtenConn, id, action string, params []byte, env *plugin.Env) (err error) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		if env.Logger != nil {
			env.Logger.Printf("plugin %s.%s panicked: %v\n%s", id, action, r, debug.Stack())
		}
		if !st.wrote.Load() {
			plugin.Fail(st, plugin.Errorf("failed", "%s.%s failed", id, action))
		}
		st.Close()
		err = fmt.Errorf("%s.%s: panic: %v", id, action, r)
	}()
	if err := run(ctx, st, action, params, env); err != nil {
		return fmt.Errorf("%s.%s: %w", id, action, err)
	}
	return nil
}

// writtenConn tells whether anything was written to a stream (a reply).
type writtenConn struct {
	net.Conn
	wrote atomic.Bool
}

func (c *writtenConn) Write(p []byte) (int, error) {
	c.wrote.Store(true)
	return c.Conn.Write(p)
}

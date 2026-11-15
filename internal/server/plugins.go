package server

import (
	"context"
	"log"
	"net/http"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// pluginHost is the core as its plugins see it (plugin.Host).
type pluginHost struct{ s *Server }

func (h pluginHost) Machines() *machines.Manager { return h.s.mg }
func (h pluginHost) ReadOnly() bool              { return h.s.opts.ReadOnly }
func (h pluginHost) Settings() *settings.Store   { return h.s.opts.Settings }
func (h pluginHost) Logger() *log.Logger         { return h.s.logger }

func (h pluginHost) Broadcast(id, m string, data any) {
	h.s.broadcast(map[string]any{"t": "plugin", "plugin": id, "m": m, "data": data})
}

func (h pluginHost) Audit(r *http.Request, event string, fields map[string]any) {
	h.s.audit.log(r, event, fields)
}

// pluginRoutes are the plugins' routes: each answers 404 plugin_disabled
// while its plugin is off, a machine's routes 404 for an unknown machine,
// and mutating ones are writable and audited.
func (s *Server) pluginRoutes() []route {
	var rs []route
	host := pluginHost{s}
	for _, p := range s.opts.Plugins {
		for _, rt := range p.Routes() {
			p, rt := p, rt
			h := func(w http.ResponseWriter, r *http.Request) {
				if !plugin.Enabled(s.opts.Settings, p) {
					writeJSON(w, http.StatusNotFound, map[string]string{"error": "plugin_disabled"})
					return
				}
				c := &plugin.Call{Host: host}
				if rt.Machine {
					if c.Machine = s.machine(w, r); c.Machine == nil {
						return
					}
				}
				if rt.Mutating {
					fields := map[string]any{"plugin": p.ID()}
					if c.Machine != nil {
						fields["machine"] = c.Machine.ID()
					}
					event := p.ID()
					if rt.Audit != "" {
						event += "." + rt.Audit
					}
					s.audit.log(r, event, fields)
				}
				rt.Handler(c, w, r)
			}
			if rt.Mutating {
				h = s.writable(h)
			}
			rs = append(rs, route{plugin.Pattern(p.ID(), rt), h})
		}
	}
	return rs
}

// startPlugins runs the plugins that work while the core does.
func (s *Server) startPlugins(ctx context.Context) {
	for _, p := range s.opts.Plugins {
		if st, ok := p.(plugin.Starter); ok {
			go st.Start(ctx, pluginHost{s})
		}
	}
}

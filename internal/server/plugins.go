package server

import (
	"context"
	"log"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"herdr-ide/internal/agentproto"
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

// pluginOn reports whether the core's plugin of this id is on for client
// c (a plugin.BrowserRisk plugin has a switch per kind of client); a core
// without it (tests) has the feature on.
func (s *Server) pluginOn(id string, c plugin.Client) bool {
	for _, p := range s.opts.Plugins {
		if p.ID() == id {
			return plugin.EnabledFor(s.opts.Settings, p, c)
		}
	}
	return true
}

// withPlugin refuses a request with 404 plugin_disabled while the plugin of
// this id is off for the requesting client: the core's own routes of a
// feature that is a plugin (VS Code's).
func (s *Server) withPlugin(id string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.pluginOn(id, s.clientOf(r)) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "plugin_disabled"})
			return
		}
		h(w, r)
	}
}

// pluginRoutes are the plugins' routes: each answers 404 plugin_disabled
// while its plugin is off (for the requesting client), a machine's routes
// 404 for an unknown machine, and mutating ones are writable and audited.
func (s *Server) pluginRoutes() []route {
	var rs []route
	host := pluginHost{s}
	for _, p := range s.opts.Plugins {
		for _, rt := range p.Routes() {
			p, rt := p, rt
			h := func(w http.ResponseWriter, r *http.Request) {
				if !plugin.EnabledFor(s.opts.Settings, p, s.clientOf(r)) {
					writeJSON(w, http.StatusNotFound, map[string]string{"error": "plugin_disabled"})
					return
				}
				c := &plugin.Call{Host: host, Client: s.clientOf(r), DesktopProof: s.desktopProof()}
				if rt.Machine {
					if c.Machine = s.machine(w, r); c.Machine == nil {
						return
					}
				}
				if !rt.Mutating {
					rt.Handler(c, w, r)
					return
				}
				// A change is recorded once its handler returned (also when it
				// panicked): what it acted on and how it ended.
				out := &plugin.Outcome{ResponseWriter: w}
				defer func() {
					s.audit.log(r, pluginEvent(p, rt), pluginAuditFields(p, rt, c, r, out))
				}()
				rt.Handler(c, out, r)
			}
			if rt.Mutating {
				h = s.writable(h)
			}
			rs = append(rs, route{plugin.Pattern(p.ID(), rt), h})
		}
	}
	return rs
}

var wildcards = regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// pluginEvent is the audit event of a plugin's mutating route:
// <plugin>[.<Audit>].
func pluginEvent(p plugin.Plugin, rt plugin.Route) string {
	if rt.Audit != "" {
		return p.ID() + "." + rt.Audit
	}
	return p.ID()
}

// pluginAuditFields are the fields of a mutating route's record: the
// plugin, the machine, the route's wildcards (a variable's name, a
// request's id), what the handler added (Call.AuditField) and the outcome:
// the status and, for a failure, its code ("error"; "failed" when the
// handler answered nothing, as when it panicked).
func pluginAuditFields(p plugin.Plugin, rt plugin.Route, c *plugin.Call, r *http.Request, out *plugin.Outcome) map[string]any {
	fields := map[string]any{"plugin": p.ID()}
	if c.Machine != nil {
		fields["machine"] = c.Machine.ID()
	}
	for _, w := range wildcards.FindAllStringSubmatch(rt.Path, -1) {
		if v := r.PathValue(w[1]); v != "" {
			fields[w[1]] = v
		}
	}
	for k, v := range c.AuditFields() {
		if _, taken := fields[k]; !taken {
			fields[k] = v
		}
	}
	status := out.Status
	if status == 0 {
		status = http.StatusInternalServerError
		if out.Code == "" {
			out.Code = "failed"
		}
	}
	fields["status"] = status
	if status >= 400 {
		code := out.Code
		if code == "" {
			code = strings.ReplaceAll(strings.ToLower(http.StatusText(status)), " ", "_")
		}
		fields["error"] = code
	}
	return fields
}

// servePluginStream hands a stream an agent opened with a plugin's op to
// that plugin (plugin.Streamer); false when no plugin serves the op. While
// the plugin is off the stream fails with plugin_disabled.
func (s *Server) servePluginStream(mc *machines.Machine, conn net.Conn, h agentproto.Header) bool {
	for _, p := range s.opts.Plugins {
		st, ok := p.(plugin.Streamer)
		if !ok || !slices.Contains(st.AgentOps(), h.Op) {
			continue
		}
		if !plugin.Enabled(s.opts.Settings, p) {
			agentproto.WriteLine(conn, agentproto.Reply{Error: "plugin is off", Code: "plugin_disabled"})
			conn.Close()
			return true
		}
		st.ServeAgent(pluginHost{s}, mc, conn, h)
		return true
	}
	return false
}

// startPlugins runs the plugins that work while the core does.
func (s *Server) startPlugins(ctx context.Context) {
	for _, p := range s.opts.Plugins {
		if st, ok := p.(plugin.Starter); ok {
			go st.Start(ctx, pluginHost{s})
		}
	}
}

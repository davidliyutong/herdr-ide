// Package plugin is the core's side of plugins: features built into the
// binary that add HTTP routes below /api/p/<id>/ (the core's) and
// /api/m/{id}/p/<id>/ (a machine's), messages to the UIs over /ws
// (plugin {plugin, m, data}), settings, and reach their machine side
// through the agent's plugin op (internal/agent/plugin). The web UI's
// side of each is in web/src/plugins. Plugins are compiled in; none is
// loaded at runtime.
package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

// Route is an HTTP route of a plugin.
type Route struct {
	// Method is GET, POST, PUT or DELETE.
	Method string
	// Path is below the plugin's prefix ("" for the prefix itself) and may
	// hold {name} wildcards (http.ServeMux patterns).
	Path string
	// Machine puts the route below /api/m/{id}/p/<plugin>: the call has
	// the machine.
	Machine bool
	// Mutating routes change state: refused in read-only mode, and
	// audited as <plugin>.<Audit>.
	Mutating bool
	Audit    string
	Handler  func(c *Call, w http.ResponseWriter, r *http.Request)
}

// Call is what a route's handler gets besides the request.
type Call struct {
	Host Host
	// Machine is the route's machine (Route.Machine), nil otherwise.
	Machine *machines.Machine
}

// Host is the core as plugins see it.
type Host interface {
	Machines() *machines.Manager
	// Broadcast sends data to every page as plugin {plugin, m, data}.
	Broadcast(plugin, machine string, data any)
	// Audit records a security-relevant event.
	Audit(r *http.Request, event string, fields map[string]any)
	ReadOnly() bool
	// Settings are the core's settings; nil when it has none.
	Settings() *settings.Store
	Logger() *log.Logger
}

// Plugin is one plugin of the core.
type Plugin interface {
	// ID names the plugin: lower-case letters and digits, as in routes,
	// settings and the UIs.
	ID() string
	Routes() []Route
}

// Starter is a plugin that runs while the core does (a scheduler).
type Starter interface {
	Start(ctx context.Context, h Host)
}

// Toggled is a plugin enabled by a setting of its own; the others get
// plugins.<id>.enabled (Settings).
type Toggled interface {
	EnableSetting() string
}

var validID = regexp.MustCompile(`^[a-z][a-z0-9]*$`)

// ValidID reports whether id can name a plugin.
func ValidID(id string) bool { return validID.MatchString(id) }

// EnableSetting is the setting that enables p.
func EnableSetting(p Plugin) string {
	if t, ok := p.(Toggled); ok {
		return t.EnableSetting()
	}
	return "plugins." + p.ID() + ".enabled"
}

// Defaults tells which plugins are on unless the user turns them off.
type Defaults map[string]bool

// Settings returns the module with the switches of the plugins without a
// setting of their own (on by default unless off says otherwise), in the
// section "plugins".
func Settings(ps []Plugin, off Defaults) settings.Module {
	var m settings.Module
	for i, p := range ps {
		if _, own := p.(Toggled); own {
			continue
		}
		m.Defs = append(m.Defs, settings.Def{
			Key: EnableSetting(p), Type: settings.TypeBool, Default: !off[p.ID()],
			Scope: settings.ScopeApp, Section: "plugins", Order: 10 * (i + 1),
		})
	}
	if len(m.Defs) > 0 {
		m.Sections = []settings.Section{{ID: "plugins", Order: 65}}
	}
	return m
}

// Enabled reports whether p is on in st (nil: on).
func Enabled(st *settings.Store, p Plugin) bool {
	if st == nil {
		return true
	}
	return st.Bool(EnableSetting(p), "")
}

// Error is a failure of an agent action, with the code the agent gave.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// ErrOffline: the machine has no agent session.
var ErrOffline = &Error{Code: "offline", Message: "machine not connected"}

// Open runs action of plugin on mc's agent with params and returns the
// stream after the reply (for actions that stream) and the reply's result.
func Open(ctx context.Context, mc *machines.Machine, plugin, action string, params any) (net.Conn, json.RawMessage, error) {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, nil, err
		}
		raw = b
	}
	conn, rep, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpPlugin, Plugin: plugin, Action: action, Params: raw})
	if err != nil {
		if errors.Is(err, machines.ErrNotConnected) {
			return nil, nil, ErrOffline
		}
		if rep != nil && !rep.OK {
			code := rep.Code
			if code == "" {
				code = "failed"
			}
			return nil, nil, &Error{Code: code, Message: rep.Error}
		}
		return nil, nil, &Error{Code: "transport", Message: err.Error()}
	}
	return conn, rep.Plugin, nil
}

// Request runs action of plugin on mc's agent and decodes its result into
// out (nil: ignored).
func Request(ctx context.Context, mc *machines.Machine, plugin, action string, params, out any) error {
	conn, res, err := Open(ctx, mc, plugin, action, params)
	if err != nil {
		return err
	}
	conn.Close()
	if out == nil || len(res) == 0 {
		return nil
	}
	return json.Unmarshal(res, out)
}

// WriteJSON answers with v.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// WriteError answers with {"error": code, "message"}: an agent's Error
// keeps its code (offline: 409, transport: 502, others 400); other errors
// are 500s with the code "failed".
func WriteError(w http.ResponseWriter, err error) {
	var pe *Error
	if errors.As(err, &pe) {
		status := http.StatusBadRequest
		switch pe.Code {
		case "offline":
			status = http.StatusConflict
		case "transport":
			status = http.StatusBadGateway
		case "not_found":
			status = http.StatusNotFound
		}
		WriteJSON(w, status, map[string]string{"error": pe.Code, "message": pe.Message})
		return
	}
	WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed", "message": err.Error()})
}

// ReadJSON decodes a request body of at most limit bytes into v.
func ReadJSON(r *http.Request, limit int64, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, limit))
	if err := dec.Decode(v); err != nil {
		return &Error{Code: "bad_request", Message: err.Error()}
	}
	return nil
}

// Pattern is the http.ServeMux pattern of a plugin's route.
func Pattern(id string, rt Route) string {
	prefix := "/api/p/" + id
	if rt.Machine {
		prefix = "/api/m/{id}/p/" + id
	}
	p := strings.TrimPrefix(rt.Path, "/")
	if p != "" {
		prefix += "/" + p
	}
	return rt.Method + " " + prefix
}

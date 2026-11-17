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
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/transport"
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
	// audited as <plugin>.<Audit> once the handler returned, with what it
	// acted on (Call.AuditField) and how it ended (Outcome).
	Mutating bool
	Audit    string
	Handler  func(c *Call, w http.ResponseWriter, r *http.Request)
}

// Call is what a route's handler gets besides the request.
type Call struct {
	Host Host
	// Machine is the route's machine (Route.Machine), nil otherwise.
	Machine *machines.Machine
	// Client is the kind of client the request comes from.
	Client Client
	// TrustedOrigin is the request's Origin when the core vouches that no
	// other program serves pages of it: an --allowed-origin, or
	// http://localhost on the core's own port while the core holds that
	// port on both loopback addresses. "" for every other origin and for
	// a request without one, but a page's own GET, which a browser sends
	// without Origin (Sec-Fetch-Site: same-origin and the request's Host
	// stand for it there). What a browser binds to an origin (a WebAuthn
	// credential) is taken only for such an origin.
	TrustedOrigin string
	// DesktopProof checks a MAC that the desktop app's shell made of msg
	// with the key of its launch: the shell's word that the user answered
	// a prompt of the system (Touch ID, Windows Hello). Nil in a core the
	// shell did not start or gave no key.
	DesktopProof func(msg, mac []byte) bool

	audit map[string]any
}

// AuditField adds what a mutating route acts on (a path, a name) to its
// audit record; the core writes the record when the handler returns.
// Values are never secrets or contents.
func (c *Call) AuditField(key string, v any) {
	if c.audit == nil {
		c.audit = map[string]any{}
	}
	c.audit[key] = v
}

// AuditFields are the fields the handler added.
func (c *Call) AuditFields() map[string]any { return c.audit }

// Outcome is the response writer of a mutating route's handler: it keeps
// the status and the error code of the answer (WriteError, WriteJSON with
// an "error"), which the route's audit record carries.
type Outcome struct {
	http.ResponseWriter
	Status int
	Code   string
}

func (o *Outcome) WriteHeader(status int) {
	if o.Status == 0 {
		o.Status = status
	}
	o.ResponseWriter.WriteHeader(status)
}

func (o *Outcome) Write(b []byte) (int, error) {
	if o.Status == 0 {
		o.Status = http.StatusOK
	}
	return o.ResponseWriter.Write(b)
}

// Flush sends what was written so far.
func (o *Outcome) Flush() {
	if f, ok := o.ResponseWriter.(http.Flusher); ok {
		if o.Status == 0 {
			o.Status = http.StatusOK
		}
		f.Flush()
	}
}

// Unwrap gives http.ResponseController the writer underneath.
func (o *Outcome) Unwrap() http.ResponseWriter { return o.ResponseWriter }

// noteCode records an answer's error code when w is an Outcome.
func noteCode(w http.ResponseWriter, code string) {
	if o, ok := w.(*Outcome); ok && o.Code == "" {
		o.Code = code
	}
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

// Client is the kind of client a request comes from, as the core tells
// them apart (internal/server): the desktop app's windows, which prove it
// with the token of its launch, or a browser.
type Client string

const (
	Browser Client = "browser"
	Desktop Client = "desktop"
)

// BrowserRisk is a plugin whose content runs on the UI's own origin (VS
// Code's windows), where its scripts reach whatever the page reaches: the
// terminals of every machine, their files, an unlocked vault. Browsers
// then have a switch of their own, plugins.<id>.browser, off by default,
// which a browser user sets only after accepting that risk (the UI asks
// first), and the plugin's enable setting is the desktop app's switch.
// Each client gets the plugin only while its own switch is on.
type BrowserRisk interface {
	BrowserRisk()
}

// Streamer is a plugin that serves streams agents open towards the core
// with ops of its own (internal/agentproto), as the vault's MCP requests.
// The core hands it each stream of those ops after the header, while the
// plugin is on; it writes the reply and closes the stream.
type Streamer interface {
	AgentOps() []agentproto.Op
	ServeAgent(h Host, mc *machines.Machine, conn net.Conn, hdr agentproto.Header)
}

// MachineForgetter is a plugin that keeps something about machines (the
// vault's allowed machines): the core calls ForgetMachine when the user
// removes a machine, whether the plugin is on or off, so an id that comes
// back later does not inherit it.
type MachineForgetter interface {
	ForgetMachine(h Host, id string)
}

var validID = regexp.MustCompile(`^[a-z][a-z0-9]*$`)

// ValidID reports whether id can name a plugin.
func ValidID(id string) bool { return validID.MatchString(id) }

// EnableSetting is the setting that enables p (for a BrowserRisk plugin,
// in the desktop app).
func EnableSetting(p Plugin) string {
	if t, ok := p.(Toggled); ok {
		return t.EnableSetting()
	}
	return "plugins." + p.ID() + ".enabled"
}

// BrowserSetting is the setting that enables p in browsers:
// plugins.<id>.browser for a BrowserRisk plugin, else its enable setting.
func BrowserSetting(p Plugin) string {
	if _, risk := p.(BrowserRisk); risk {
		return "plugins." + p.ID() + ".browser"
	}
	return EnableSetting(p)
}

// SettingFor is the setting that enables p for client c.
func SettingFor(p Plugin, c Client) string {
	if c == Desktop {
		return EnableSetting(p)
	}
	return BrowserSetting(p)
}

// Defaults tells which plugins are on unless the user turns them off.
type Defaults map[string]bool

// Settings returns the module with the switches of the plugins without a
// setting of their own (on by default unless off says otherwise), in the
// section "plugins"; a BrowserRisk plugin also gets its switch for
// browsers, off by default.
func Settings(ps []Plugin, off Defaults) settings.Module {
	var m settings.Module
	for i, p := range ps {
		if _, own := p.(Toggled); !own {
			m.Defs = append(m.Defs, settings.Def{
				Key: EnableSetting(p), Type: settings.TypeBool, Default: !off[p.ID()],
				Scope: settings.ScopeApp, Section: "plugins", Order: 10 * (i + 1),
			})
		}
		if _, risk := p.(BrowserRisk); risk {
			m.Defs = append(m.Defs, settings.Def{
				Key: BrowserSetting(p), Type: settings.TypeBool, Default: false,
				Scope: settings.ScopeApp, Section: "plugins", Order: 10*(i+1) + 5,
			})
		}
	}
	if len(m.Defs) > 0 {
		m.Sections = []settings.Section{{ID: "plugins", Order: 65}}
	}
	return m
}

// EnabledFor reports whether p is on for client c in st (nil: on).
func EnabledFor(st *settings.Store, p Plugin, c Client) bool {
	if st == nil {
		return true
	}
	return st.Bool(SettingFor(p, c), "")
}

// Enabled reports whether p is on in st (nil: on): for a BrowserRisk
// plugin, for any client.
func Enabled(st *settings.Store, p Plugin) bool {
	return EnabledFor(st, p, Desktop) || EnabledFor(st, p, Browser)
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
// stream after the reply (for actions that stream or send more) and the
// reply's result. Params and results larger than agentproto.MaxInline
// travel as bodies after their lines. The stream is closed when ctx ends,
// also after the reply, so a caller that goes on reading or writing it is
// bounded by ctx; closing the stream ends that watch.
func Open(ctx context.Context, mc *machines.Machine, plugin, action string, params any) (net.Conn, json.RawMessage, error) {
	h := agentproto.Header{Op: agentproto.OpPlugin, Plugin: plugin, Action: action}
	var body []byte
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, nil, err
		}
		switch {
		case len(b) > agentproto.MaxBody:
			return nil, nil, &Error{Code: "too_large", Message: fmt.Sprintf("params of %d bytes", len(b))}
		case len(b) > agentproto.MaxInline:
			h.ParamsLength, body = int64(len(b)), b
		default:
			h.Params = b
		}
	}
	conn, rep, err := mc.OpenWith(ctx, h, body)
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
	c := &ctxConn{Conn: conn, stop: context.AfterFunc(ctx, func() { conn.Close() })}
	res := rep.Plugin
	if rep.PluginLength > 0 {
		// The result's body comes as its reply did: within the caller's
		// deadline, else transport.ReplyTimeout.
		deadline := time.Now().Add(transport.ReplyTimeout)
		if dl, ok := ctx.Deadline(); ok {
			deadline = dl
		}
		_ = conn.SetReadDeadline(deadline)
		res, err = agentproto.ReadBody(conn, rep.PluginLength)
		_ = conn.SetReadDeadline(time.Time{})
		if err != nil {
			c.Close()
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			return nil, nil, &Error{Code: "transport", Message: err.Error()}
		}
	}
	return c, res, nil
}

// ctxConn is a plugin's stream that is closed when the caller's context
// ends; Close ends that watch.
type ctxConn struct {
	net.Conn
	stop func() bool
}

func (c *ctxConn) Close() error {
	c.stop()
	return c.Conn.Close()
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
	if status >= 400 {
		switch e := v.(type) {
		case map[string]string:
			noteCode(w, e["error"])
		case map[string]any:
			code, _ := e["error"].(string)
			noteCode(w, code)
		}
	}
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

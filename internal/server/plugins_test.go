package server

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/registry"
	"herdr-ide/internal/settings"
)

// fakePlugin has a route of each kind, for the route table's tests.
type fakePlugin struct{}

func (fakePlugin) ID() string { return "fake" }
func (fakePlugin) Routes() []plugin.Route {
	ok := func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
		m := ""
		if c.Machine != nil {
			m = c.Machine.ID()
		}
		plugin.WriteJSON(w, http.StatusOK, map[string]string{"m": m})
	}
	return []plugin.Route{
		{Method: "GET", Path: "", Handler: ok},
		{Method: "POST", Path: "things/{name}", Mutating: true, Audit: "thing", Handler: ok},
		{Method: "GET", Path: "state", Machine: true, Handler: ok},
		{Method: "PUT", Path: "state", Machine: true, Mutating: true, Handler: ok},
	}
}

// testPlugins are the core's plugins and the fake one.
func testPlugins() []plugin.Plugin { return append(registry.Plugins(), fakePlugin{}) }

func TestPluginRoutes(t *testing.T) {
	s := newTestServer()
	want := []string{"GET /api/p/fake", "POST /api/p/fake/things/{name}", "GET /api/m/{id}/p/fake/state", "PUT /api/m/{id}/p/fake/state"}
	var got []string
	for _, rt := range s.pluginRoutes() {
		if strings.Contains(rt.pattern, "/fake") {
			got = append(got, rt.pattern)
		}
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("routes %q, want %q", got, want)
	}
	h := s.Handler()
	do := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("GET", "/api/p/fake"); w.Code != 200 {
		t.Errorf("GET: %d %s", w.Code, w.Body)
	}
	if w := do("GET", "/api/m/nope/p/fake/state"); w.Code != 404 {
		t.Errorf("unknown machine: %d %s", w.Code, w.Body)
	}
}

func TestPluginDisabled(t *testing.T) {
	ps := []plugin.Plugin{fakePlugin{}}
	st := settings.New("", plugin.Settings(ps, nil))
	s := newTestServer()
	s.opts.Plugins = ps
	s.opts.Settings = st
	if !plugin.Enabled(st, fakePlugin{}) {
		t.Fatal("a plugin is on by default")
	}
	if err := st.Set("plugins.fake.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/api/p/fake", nil)
	r.Host = "127.0.0.1:7780"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 404 || !strings.Contains(w.Body.String(), "plugin_disabled") {
		t.Fatalf("disabled plugin: %d %s", w.Code, w.Body)
	}
}

// fakeStreamer serves an op of its own.
type fakeStreamer struct{ fakePlugin }

func (fakeStreamer) AgentOps() []agentproto.Op { return []agentproto.Op{"fake-op"} }
func (fakeStreamer) ServeAgent(_ plugin.Host, _ *machines.Machine, conn net.Conn, _ agentproto.Header) {
	agentproto.WriteLine(conn, agentproto.Reply{OK: true, Code: "served"})
	conn.Close()
}

// Streams agents open with a plugin's op reach the plugin while it is on.
func TestPluginStreams(t *testing.T) {
	ps := []plugin.Plugin{fakeStreamer{}}
	st := settings.New("", plugin.Settings(ps, nil))
	s := newTestServer()
	s.opts.Plugins = ps
	s.opts.Settings = st
	open := func(op agentproto.Op) agentproto.Reply {
		a, b := net.Pipe()
		go s.handleAgentStream(nil, b, agentproto.Header{Op: op})
		defer a.Close()
		var rep agentproto.Reply
		agentproto.ReadLine(a, &rep)
		return rep
	}
	if rep := open("fake-op"); !rep.OK || rep.Code != "served" {
		t.Errorf("served %+v", rep)
	}
	if rep := open("other"); rep.OK {
		t.Errorf("unknown op %+v", rep)
	}
	st.Set("plugins.fake.enabled", "", false)
	if rep := open("fake-op"); rep.OK || rep.Code != "plugin_disabled" {
		t.Errorf("disabled %+v", rep)
	}
}

// auditedPlugin's change records what it acted on, and fails on request.
type auditedPlugin struct{}

func (auditedPlugin) ID() string { return "audited" }
func (auditedPlugin) Routes() []plugin.Route {
	return []plugin.Route{{Method: "POST", Path: "things/{name}", Mutating: true, Audit: "thing",
		Handler: func(c *plugin.Call, w http.ResponseWriter, r *http.Request) {
			c.AuditField("path", "/a/b")
			c.AuditField("name", "not the wildcard's")
			switch r.URL.Query().Get("fail") {
			case "conflict":
				plugin.WriteError(w, &plugin.Error{Code: "conflict", Message: "changed"})
			case "panic":
				panic(http.ErrAbortHandler)
			default:
				plugin.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
			}
		}}}
}

// A plugin's change is audited once its handler returned: with the fields
// it added, the route's wildcards and how it ended.
func TestPluginChangesAuditTheirOutcome(t *testing.T) {
	var audit strings.Builder
	s := New(machines.NewManager(nil, nil, log.New(io.Discard, "", 0)),
		Options{Audit: &audit, Logger: log.New(io.Discard, "", 0), Plugins: []plugin.Plugin{auditedPlugin{}}})
	h := s.Handler()
	records := func(query string) map[string]any {
		audit.Reset()
		r := httptest.NewRequest("POST", "/api/p/audited/things/n1"+query, nil)
		r.Host = "127.0.0.1:7780"
		func() {
			defer func() { recover() }()
			h.ServeHTTP(httptest.NewRecorder(), r)
		}()
		var rec map[string]any
		for _, line := range strings.Split(strings.TrimSpace(audit.String()), "\n") {
			var v map[string]any
			if json.Unmarshal([]byte(line), &v) == nil && v["event"] == "audited.thing" {
				rec = v
			}
		}
		if rec == nil {
			t.Fatalf("no record in %s", audit.String())
		}
		return rec
	}
	rec := records("")
	if rec["path"] != "/a/b" || rec["name"] != "n1" || rec["status"] != float64(200) || rec["error"] != nil {
		t.Errorf("success %v", rec)
	}
	rec = records("?fail=conflict")
	if rec["status"] != float64(400) || rec["error"] != "conflict" {
		t.Errorf("failure %v", rec)
	}
	rec = records("?fail=panic")
	if rec["status"] != float64(500) || rec["error"] != "failed" {
		t.Errorf("panic %v", rec)
	}
}

// Turning VS Code off ends its work: preparations and proxied connections
// follow a context that ends then; the next use gets a new one.
func TestVSCodeOffEndsItsWork(t *testing.T) {
	ps := registry.Plugins()
	st := settings.New("", plugin.Settings(ps, nil))
	s := New(machines.NewManager(nil, nil, log.New(io.Discard, "", 0)),
		Options{Logger: log.New(io.Discard, "", 0), Plugins: ps, Settings: st})
	work := s.csProxy.workContext()
	if err := st.Set("plugins.files.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	if work.Err() != nil {
		t.Fatal("another plugin's switch ended VS Code's work")
	}
	if err := st.Set("plugins.vscode.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	select {
	case <-work.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("VS Code's work outlived its switch")
	}
	st.Set("plugins.vscode.enabled", "", true)
	if s.csProxy.workContext().Err() != nil {
		t.Fatal("no new work after turning it on")
	}
}

func TestPluginSettingsDefaults(t *testing.T) {
	m := plugin.Settings([]plugin.Plugin{fakePlugin{}}, plugin.Defaults{"fake": true})
	if len(m.Defs) != 1 || m.Defs[0].Key != "plugins.fake.enabled" || m.Defs[0].Default != false {
		t.Fatalf("defs %+v", m.Defs)
	}
	if m := plugin.Settings(nil, nil); len(m.Sections) != 0 {
		t.Fatalf("a section without settings: %+v", m.Sections)
	}
}

// VS Code is a plugin whose routes are the core's own: off, they answer
// plugin_disabled before anything else (code-server is not started);
// stopping it still works.
func TestCodeRoutesFollowTheirPlugin(t *testing.T) {
	ps := registry.Plugins()
	st := settings.New("", plugin.Settings(ps, nil))
	s := newTestServer()
	s.opts.Plugins = ps
	s.opts.Settings = st
	h := s.Handler()
	do := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	paths := [][2]string{
		{"GET", "/api/m/nope/code/status"},
		{"POST", "/api/m/nope/code/start"},
		{"POST", "/api/m/nope/bridge"},
		{"GET", "/m/nope/code/"},
		{"GET", "/m/nope/code"},
	}
	for _, p := range paths {
		if w := do(p[0], p[1]); strings.Contains(w.Body.String(), "plugin_disabled") {
			t.Errorf("%s %s with VS Code on: %d %s", p[0], p[1], w.Code, w.Body)
		}
	}
	if err := st.Set("plugins.vscode.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	for _, p := range paths {
		if w := do(p[0], p[1]); w.Code != 404 || !strings.Contains(w.Body.String(), "plugin_disabled") {
			t.Errorf("%s %s with VS Code off: %d %s", p[0], p[1], w.Code, w.Body)
		}
	}
	if w := do("POST", "/api/m/nope/code/stop"); strings.Contains(w.Body.String(), "plugin_disabled") {
		t.Errorf("stop with VS Code off: %d %s", w.Code, w.Body)
	}
}

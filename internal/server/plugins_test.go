package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func TestPluginSettingsDefaults(t *testing.T) {
	m := plugin.Settings([]plugin.Plugin{fakePlugin{}}, plugin.Defaults{"fake": true})
	if len(m.Defs) != 1 || m.Defs[0].Key != "plugins.fake.enabled" || m.Defs[0].Default != false {
		t.Fatalf("defs %+v", m.Defs)
	}
	if m := plugin.Settings(nil, nil); len(m.Sections) != 0 {
		t.Fatalf("a section without settings: %+v", m.Sections)
	}
}

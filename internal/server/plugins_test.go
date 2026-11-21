package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		// What a call knows of its client, and whether the desktop shell's
		// MAC of "msg" in the header X-Mac holds.
		proved := false
		if mac, err := hex.DecodeString(r.Header.Get("X-Mac")); err == nil && c.DesktopProof != nil {
			proved = c.DesktopProof([]byte("msg"), mac)
		}
		plugin.WriteJSON(w, http.StatusOK, map[string]any{"m": m, "client": c.Client, "canProve": c.DesktopProof != nil, "proved": proved})
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

// A plugin's call knows which kind of client asks and, in a core the
// desktop app's shell started with a key, checks the shell's MACs: its word
// that the user answered a prompt of the system.
func TestPluginCallClient(t *testing.T) {
	s := newTestServer()
	token, key := strings.Repeat("Z9", 20), strings.Repeat("k3", 20)
	mac := func(k string) string {
		m := hmac.New(sha256.New, []byte(k))
		m.Write([]byte("msg"))
		return hex.EncodeToString(m.Sum(nil))
	}
	get := func(cookie, xmac string) map[string]any {
		r := httptest.NewRequest("GET", "/api/p/fake", nil)
		r.Host = "127.0.0.1:7780"
		if cookie != "" {
			r.Header.Set("Cookie", DesktopCookie+"="+cookie)
		}
		r.Header.Set("X-Mac", xmac)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	// A core no shell started: every client is a browser, nothing proves.
	if out := get(token, mac(key)); out["client"] != "browser" || out["canProve"] != false || out["proved"] != false {
		t.Errorf("without a shell: %v", out)
	}
	s.opts.DesktopToken, s.opts.DesktopVerifyKey = token, key
	if out := get(token, mac(key)); out["client"] != "desktop" || out["proved"] != true {
		t.Errorf("the desktop app: %v", out)
	}
	if out := get("", mac(key)); out["client"] != "browser" {
		t.Errorf("a browser: %v", out)
	}
	// The token, which every request of the app's pages carries, is not
	// the key.
	if out := get(token, mac(token)); out["proved"] != false {
		t.Errorf("a MAC made with the token: %v", out)
	}
	if out := get(token, "zz"); out["proved"] != false {
		t.Errorf("no MAC: %v", out)
	}
}

// The core vouches for an origin only when no other program serves pages of
// it: an --allowed-origin, or http://localhost on its own port once it
// holds that port on both loopback addresses, asked for under that Host
// from this host. A fingerprint is bound to such an origin only.
func TestTrustedOrigin(t *testing.T) {
	s := newTestServer("https://ide.example.com")
	req := func(host, origin, remote, forwarded string) *http.Request {
		r := httptest.NewRequest("POST", "/api/p/fake/things/x", nil)
		r.Host, r.RemoteAddr = host, remote
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if forwarded != "" {
			r.Header.Set("X-Forwarded-For", forwarded)
		}
		return r
	}
	const here = "127.0.0.1:50000"
	// Before the core holds both loopback addresses, not even its own.
	if got := s.trustedOrigin(req("localhost:7780", "http://localhost:7780", here, "")); got != "" {
		t.Errorf("localhost before both addresses are held: %q", got)
	}
	s.OwnLocalhost("7780")
	for _, c := range []struct{ host, origin, remote, forwarded, want string }{
		{"localhost:7780", "http://localhost:7780", here, "", "http://localhost:7780"},
		{"LocalHost:7780", "http://LOCALHOST:7780", "[::1]:50000", "", "http://localhost:7780"},
		{"ide.example.com", "https://ide.example.com", "10.0.0.7:4000", "10.0.0.9", "https://ide.example.com"},
		// Another program's page on localhost, whatever Host its request names.
		{"localhost:3000", "http://localhost:3000", here, "", ""},
		{"localhost:7780", "http://localhost:3000", here, "", ""},
		// An address is no name a credential can be for; other names of
		// loopback are not the core's to vouch for.
		{"127.0.0.1:7780", "http://127.0.0.1:7780", here, "", ""},
		{"app.localhost:7780", "http://app.localhost:7780", here, "", ""},
		{"localhost:7780", "https://localhost:7780", here, "", ""},
		// Through a proxy or from another host it is the proxy's origin
		// that counts, which the operator names.
		{"localhost:7780", "http://localhost:7780", here, "10.0.0.9", ""},
		{"localhost:7780", "http://localhost:7780", "10.0.0.7:4000", "", ""},
		{"ide.example.com", "http://ide.example.com", "10.0.0.7:4000", "", ""},
		{"localhost:7780", "", here, "", ""},
		{"localhost:7780", "null", here, "", ""},
	} {
		if got := s.trustedOrigin(req(c.host, c.origin, c.remote, c.forwarded)); got != c.want {
			t.Errorf("host %s origin %s from %s (forwarded %q): %q, want %q", c.host, c.origin, c.remote, c.forwarded, got, c.want)
		}
	}
	// A page's own GET carries no Origin: the page's word that the request
	// is its own stands for it, under the scheme the core vouches for.
	get := func(host, site, remote, forwarded string) string {
		r := req(host, "", remote, forwarded)
		r.Method = "GET"
		if site != "" {
			r.Header.Set("Sec-Fetch-Site", site)
		}
		return s.trustedOrigin(r)
	}
	for _, c := range []struct{ host, site, remote, forwarded, want string }{
		{"localhost:7780", "same-origin", here, "", "http://localhost:7780"},
		{"ide.example.com", "same-origin", "10.0.0.7:4000", "10.0.0.9", "https://ide.example.com"},
		{"localhost:7780", "", here, "", ""},
		{"localhost:7780", "same-site", here, "", ""},
		{"localhost:7780", "cross-site", here, "", ""},
		{"localhost:3000", "same-origin", here, "", ""},
		{"127.0.0.1:7780", "same-origin", here, "", ""},
	} {
		if got := get(c.host, c.site, c.remote, c.forwarded); got != c.want {
			t.Errorf("GET host %s site %q: %q, want %q", c.host, c.site, got, c.want)
		}
	}
	// Not for a request that changes something: there a browser sends
	// the Origin itself.
	r := req("localhost:7780", "", here, "")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if got := s.trustedOrigin(r); got != "" {
		t.Errorf("a POST without Origin: %q", got)
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

// Turning VS Code off for a kind of client ends that client's work (its
// proxied connections and the bridge's commands follow a context that ends
// then); preparations end once it is off for every client. The next use
// gets a new context.
func TestVSCodeOffEndsItsWork(t *testing.T) {
	ps := registry.Plugins()
	st := settings.New("", plugin.Settings(ps, nil))
	for _, key := range []string{"plugins.vscode.enabled", "plugins.vscode.browser"} {
		if err := st.Set(key, "", true); err != nil {
			t.Fatal(err)
		}
	}
	s := New(machines.NewManager(nil, nil, log.New(io.Discard, "", 0)),
		Options{Logger: log.New(io.Discard, "", 0), Plugins: ps, Settings: st})
	desktop, browser, prep := s.csProxy.workContext(plugin.Desktop), s.csProxy.workContext(plugin.Browser), s.csProxy.workContext(prepare)
	ended := func(ctx context.Context) bool {
		select {
		case <-ctx.Done():
			return true
		case <-time.After(2 * time.Second):
			return false
		}
	}
	if err := st.Set("plugins.files.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	if desktop.Err() != nil || browser.Err() != nil || prep.Err() != nil {
		t.Fatal("another plugin's switch ended VS Code's work")
	}
	if err := st.Set("plugins.vscode.browser", "", false); err != nil {
		t.Fatal(err)
	}
	if !ended(browser) {
		t.Fatal("the browsers' work outlived their switch")
	}
	if desktop.Err() != nil || prep.Err() != nil {
		t.Fatal("the browsers' switch ended the desktop app's work or the preparations")
	}
	if err := st.Set("plugins.vscode.enabled", "", false); err != nil {
		t.Fatal(err)
	}
	if !ended(desktop) || !ended(prep) {
		t.Fatal("VS Code's work outlived its switches")
	}
	st.Set("plugins.vscode.enabled", "", true)
	if s.csProxy.workContext(plugin.Desktop).Err() != nil || s.csProxy.workContext(prepare).Err() != nil {
		t.Fatal("no new work after turning it on")
	}
}

// A request takes the context of its VS Code work, and of preparing
// code-server, only while its client's switch is on: taken before the
// switch is turned off, turning it off ends it; asked for after (a request
// that passed withPlugin just before), there is none, never a new context
// that nothing would end.
func TestVSCodeWorkTakenOnlyWhileOn(t *testing.T) {
	ps := registry.Plugins()
	st := settings.New("", plugin.Settings(ps, nil))
	s := New(machines.NewManager(nil, nil, log.New(io.Discard, "", 0)),
		Options{Logger: log.New(io.Discard, "", 0), Plugins: ps, Settings: st})
	st.Set("plugins.vscode.enabled", "", false)
	if s.csProxy.workFor(plugin.Desktop, true) != nil || s.csProxy.workFor(plugin.Desktop, false) != nil {
		t.Fatal("work while off")
	}
	st.Set("plugins.vscode.enabled", "", true)
	work, prep := s.csProxy.workFor(plugin.Desktop, true), s.csProxy.workFor(plugin.Desktop, false)
	if work == nil || prep == nil || work.Err() != nil || prep.Err() != nil {
		t.Fatal("no work while on")
	}
	if s.csProxy.workFor(plugin.Browser, true) != nil || s.csProxy.workFor(plugin.Browser, false) != nil {
		t.Fatal("a browser's work while only the desktop app's switch is on")
	}
	st.Set("plugins.vscode.enabled", "", false)
	if work.Err() == nil || prep.Err() == nil {
		t.Fatal("work taken before the switch went off outlived it")
	}
	if s.csProxy.workFor(plugin.Desktop, true) != nil || s.csProxy.workFor(plugin.Desktop, false) != nil {
		t.Fatal("work taken after the switch went off")
	}
}

// riskyPlugin's content would run on the UI's origin: a switch per kind
// of client.
type riskyPlugin struct{ fakePlugin }

func (riskyPlugin) ID() string   { return "risky" }
func (riskyPlugin) BrowserRisk() {}

func TestPluginSettingsDefaults(t *testing.T) {
	m := plugin.Settings([]plugin.Plugin{fakePlugin{}}, plugin.Defaults{"fake": true})
	if len(m.Defs) != 1 || m.Defs[0].Key != "plugins.fake.enabled" || m.Defs[0].Default != false {
		t.Fatalf("defs %+v", m.Defs)
	}
	if m := plugin.Settings(nil, nil); len(m.Sections) != 0 {
		t.Fatalf("a section without settings: %+v", m.Sections)
	}
	// A plugin on the UI's origin: the desktop app's switch as usual, and
	// the browsers', off whatever the defaults say.
	m = plugin.Settings([]plugin.Plugin{riskyPlugin{}}, nil)
	if len(m.Defs) != 2 || m.Defs[0].Key != "plugins.risky.enabled" || m.Defs[0].Default != true ||
		m.Defs[1].Key != "plugins.risky.browser" || m.Defs[1].Default != false || m.Defs[1].Section != "plugins" {
		t.Fatalf("defs %+v", m.Defs)
	}
	if plugin.SettingFor(riskyPlugin{}, plugin.Desktop) != "plugins.risky.enabled" || plugin.SettingFor(riskyPlugin{}, plugin.Browser) != "plugins.risky.browser" ||
		plugin.SettingFor(fakePlugin{}, plugin.Browser) != "plugins.fake.enabled" {
		t.Fatal("the switch of each client")
	}
	// VS Code is off by default in the desktop app and in browsers.
	st := settings.New("", registry.Settings()...)
	for _, key := range []string{"plugins.vscode.enabled", "plugins.vscode.browser"} {
		if d, ok := st.Lookup(key); !ok || d.Default != false {
			t.Errorf("%s: %+v", key, d)
		}
	}
	if !st.Bool("plugins.files.enabled", "") {
		t.Error("other plugins stay on by default")
	}
}

// A settings file of an earlier version, which had only
// plugins.vscode.enabled, loads: its value is the desktop app's switch,
// and browsers still find VS Code off.
func TestVSCodeSettingOfEarlierVersions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"plugins.vscode.enabled": true, "plugins.files.enabled": false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	st := settings.New(path, registry.Settings()...)
	if err := st.Load(); err != nil {
		t.Fatal(err)
	}
	if len(st.State().Problems) != 0 {
		t.Fatalf("problems %+v", st.State().Problems)
	}
	var vs plugin.Plugin
	for _, p := range registry.Plugins() {
		if p.ID() == "vscode" {
			vs = p
		}
	}
	if !plugin.EnabledFor(st, vs, plugin.Desktop) || plugin.EnabledFor(st, vs, plugin.Browser) {
		t.Fatal("the earlier value is the desktop app's switch only")
	}
}

// VS Code is a plugin whose routes are the core's own, with a switch per
// kind of client: each request gets its client's, and one whose switch is
// off is answered plugin_disabled before anything else (code-server is not
// started); stopping it still works. The desktop app is a request with
// this launch's token in DesktopCookie; no cookie, a wrong token, or a
// core given no token is a browser. Plugins' own routes do the same.
func TestCodeRoutesFollowTheirClientsSwitch(t *testing.T) {
	ps := append(registry.Plugins(), riskyPlugin{})
	risky := plugin.Settings([]plugin.Plugin{riskyPlugin{}}, nil)
	risky.Sections = nil // the core's plugins have it
	st := settings.New("", append(registry.Settings(), risky)...)
	token := strings.Repeat("a1", 32)
	s := newTestServer()
	s.opts.Plugins = ps
	s.opts.Settings = st
	s.opts.DesktopToken = token
	untokened := newTestServer()
	untokened.opts.Plugins = ps
	untokened.opts.Settings = st
	do := func(s *Server, method, path, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader("{}"))
		r.Host = "127.0.0.1:7780"
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	desktop := DesktopCookie + "=" + token
	clients := map[string]struct {
		s      *Server
		cookie string
	}{
		"desktop":           {s, desktop},
		"desktop, shadowed": {s, DesktopCookie + "=x; other=1; " + desktop},
		"browser":           {s, ""},
		"wrong token":       {s, DesktopCookie + "=" + strings.Repeat("b2", 32)},
		"token cut short":   {s, DesktopCookie + "=" + token[:63]},
		"core without one":  {untokened, desktop},
	}
	paths := [][2]string{
		{"GET", "/api/m/nope/code/status"},
		{"POST", "/api/m/nope/code/start"},
		{"POST", "/api/m/nope/bridge"},
		{"GET", "/m/nope/code/"},
		{"GET", "/m/nope/code"},
		{"GET", "/api/p/risky"},
	}
	check := func(state string, on map[string]bool) {
		t.Helper()
		for name, c := range clients {
			for _, p := range paths {
				w := do(c.s, p[0], p[1], c.cookie)
				refused := w.Code == 404 && strings.Contains(w.Body.String(), "plugin_disabled")
				if refused == on[name] {
					t.Errorf("%s, %s: %s %s = %d %s", state, name, p[0], p[1], w.Code, w.Body)
				}
			}
			if w := do(c.s, "POST", "/api/m/nope/code/stop", c.cookie); strings.Contains(w.Body.String(), "plugin_disabled") {
				t.Errorf("%s, %s: stop %d %s", state, name, w.Code, w.Body)
			}
		}
	}
	set := func(desktop, browser bool) {
		for _, id := range []string{"vscode", "risky"} {
			if err := st.Set("plugins."+id+".enabled", "", desktop); err != nil {
				t.Fatal(err)
			}
			if err := st.Set("plugins."+id+".browser", "", browser); err != nil {
				t.Fatal(err)
			}
		}
	}
	set(false, false)
	check("both off", nil)
	set(true, false)
	check("the desktop app's on", map[string]bool{"desktop": true, "desktop, shadowed": true})
	set(false, true)
	check("the browsers' on", map[string]bool{"browser": true, "wrong token": true, "token cut short": true, "core without one": true})
	set(true, true)
	check("both on", map[string]bool{"desktop": true, "desktop, shadowed": true, "browser": true, "wrong token": true, "token cut short": true, "core without one": true})
}

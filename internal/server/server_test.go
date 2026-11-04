package server

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

func TestParseRange(t *testing.T) {
	cases := []struct {
		h          string
		size       int64
		start, len int64
		ok         bool
	}{
		{"bytes=0-", 100, 0, 100, true},
		{"bytes=10-19", 100, 10, 10, true},
		{"bytes=90-200", 100, 90, 10, true},
		{"bytes=-10", 100, 90, 10, true},
		{"bytes=-500", 100, 0, 100, true},
		{"bytes=100-", 100, 0, 0, false},
		{"bytes=5-1", 100, 0, 0, false},
		{"bytes=0-1,5-6", 100, 0, 0, false},
		{"items=0-1", 100, 0, 0, false},
	}
	for _, c := range cases {
		st, n, ok := parseRange(c.h, c.size)
		if ok != c.ok || ok && (st != c.start || n != c.len) {
			t.Errorf("parseRange(%q,%d) = %d,%d,%v want %d,%d,%v", c.h, c.size, st, n, ok, c.start, c.len, c.ok)
		}
	}
}

func TestContentTypeNeverActive(t *testing.T) {
	for _, name := range []string{"x.html", "x.htm", "x.js", "x.xhtml"} {
		if ct := contentType(name); ct != "text/plain; charset=utf-8" {
			t.Errorf("%s served as %s", name, ct)
		}
	}
	if ct := contentType("a.mp4"); ct != "video/mp4" {
		t.Errorf("mp4 = %s", ct)
	}
}

func newTestServer(origins ...string) *Server {
	mg := machines.NewManager(nil, nil, log.New(os.Stderr, "", 0))
	return New(mg, Options{AllowedOrigins: origins, Logger: log.New(os.Stderr, "", 0)})
}

func TestGuard(t *testing.T) {
	h := newTestServer("https://ide.example.com").Handler()
	cases := []struct {
		host, origin string
		want         int
	}{
		{"127.0.0.1:7780", "", 200},
		{"localhost:7780", "http://localhost:5173", 200},
		{"[::1]:7780", "", 200},
		{"ide.example.com", "https://ide.example.com", 200},
		{"evil.example.com", "", 403},                   // DNS rebinding
		{"127.0.0.1:7780", "https://evil.example", 403}, // cross-site
		{"127.0.0.1:7780", "null", 403},
		{"ide.example.com", "http://ide.example.com", 403}, // scheme must match
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/api/machines", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("host=%s origin=%s: got %d want %d", c.host, c.origin, w.Code, c.want)
		}
	}
}

func TestLoadKeyConfig(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config.toml")
	os.WriteFile(cfg, []byte(`
[keys]
prefix = "ctrl+a"
split_vertical = "prefix+|"

[[keys.command]]
key = "prefix+v"
type = "plugin_action"
command = "hx-w.visuals.open"
description = "Visual previews"

[ui]
mouse_capture = true
`), 0o644)
	t.Setenv("HERDR_CONFIG_PATH", cfg)
	k := loadKeyConfig()
	if k.Prefix != "ctrl+a" || k.Bindings["split_vertical"] != "prefix+|" {
		t.Fatalf("keys = %+v", k)
	}
	if len(k.Commands) != 1 || k.Commands[0].Command != "hx-w.visuals.open" || k.Commands[0].Type != "plugin_action" {
		t.Fatalf("commands = %+v", k.Commands)
	}
}

func TestBridgePick(t *testing.T) {
	h := newBridgeHub(newTestServer())
	a := &bridgeWindow{m: "m1", folders: []string{"/home/u/proj"}}
	b := &bridgeWindow{m: "m1", folders: []string{"/home/u/proj/sub"}}
	c := &bridgeWindow{m: "m2", folders: []string{"/home/u/proj/sub"}}
	h.windows[a], h.windows[b], h.windows[c] = true, true, true
	if w, sc := h.pick("m1", "/home/u/proj/sub"); w != b || sc != 3 {
		t.Fatalf("exact pick = %v %d", w, sc)
	}
	if w, sc := h.pick("m1", "/home/u/proj/other"); w != a || sc != 2 {
		t.Fatalf("containing pick = %v %d", w, sc)
	}
	if w, _ := h.pick("m3", "/x"); w != nil {
		t.Fatal("picked window of another machine")
	}
	_ = http.StatusOK
}

func TestUploadNameUniqueAndSafe(t *testing.T) {
	now := time.Date(2026, 10, 30, 2, 15, 0, 0, time.UTC)
	a, b := uploadName("image.png", now), uploadName("image.png", now)
	if a == b {
		t.Fatalf("same name for two uploads in one second: %s", a)
	}
	if !strings.HasPrefix(a, "20261030-021500-") || !strings.HasSuffix(a, "-image.png") {
		t.Fatalf("name = %s", a)
	}
	if n := uploadName("../../etc/pa ss;wd", now); strings.ContainsAny(n, "/ ;") {
		t.Fatalf("unsafe name %q", n)
	}
}

func TestUploadIntoDirectory(t *testing.T) {
	now := time.Date(2026, 10, 30, 2, 15, 0, 0, time.UTC)
	h, err := uploadHeader(url.Values{"name": {"shot.png"}}, "/home/u/.herdr-ide/uploads", now)
	if err != nil || !h.Mkdirs || h.Unique || filepath.Dir(h.Path) != "/home/u/.herdr-ide/uploads" {
		t.Fatalf("upload directory: %+v %v", h, err)
	}
	// Into a pane's directory under the file's own name, without replacing.
	for name, want := range map[string]string{
		"my shot.png":       "/home/u/proj/my shot.png",
		"../../etc/passwd":  "/home/u/proj/passwd",
		"a\x00\nb.txt":      "/home/u/proj/ab.txt",
		"..":                "/home/u/proj/upload",
		"":                  "/home/u/proj/upload",
		"截图 2026-11-03.png": "/home/u/proj/截图 2026-11-03.png",
	} {
		h, err := uploadHeader(url.Values{"name": {name}, "dir": {"/home/u/proj"}}, "/up", now)
		if err != nil || h.Path != want || !h.Unique || h.Mkdirs {
			t.Errorf("%q: %+v %v, want %s", name, h, err, want)
		}
	}
	if h, _ := uploadHeader(url.Values{"name": {"a"}, "dir": {"~/proj"}}, "/up", now); h.Path != "~/proj/a" {
		t.Errorf("~ dir: %+v", h)
	}
	for _, dir := range []string{"proj", "./proj", "~user/proj"} {
		if _, err := uploadHeader(url.Values{"name": {"a"}, "dir": {dir}}, "/up", now); err == nil {
			t.Errorf("relative dir %q accepted", dir)
		}
	}
	if n := keptName(strings.Repeat("é", 150) + ".png"); len(n) > 200 || !strings.HasSuffix(n, "é.png") || !utf8.ValidString(n) {
		t.Errorf("long name kept as %q", n)
	}
}

func TestAPIAllowlist(t *testing.T) {
	s := newTestServer()
	for m, want := range map[string]bool{
		"pane.split": true, "agent.prompt": true, "session.snapshot": true, "plugin.action.invoke": true,
		"tab.move": true, "workspace.move": true,
		"server.stop": false, "server.live_handoff": false, "integration.install": false,
		"plugin.link": false, "events.subscribe": false, "client_shell.surface.set": false,
	} {
		if s.apiAllowed(m) != want {
			t.Errorf("apiAllowed(%s) != %v", m, want)
		}
	}
	s.opts.ReadOnly = true
	if s.apiAllowed("pane.split") || s.apiAllowed("tab.move") || s.apiAllowed("workspace.move") || !s.apiAllowed("pane.list") {
		t.Error("read-only allowlist wrong")
	}
}

func TestProxySecret(t *testing.T) {
	s := newTestServer("https://ide.example.com")
	s.opts.ProxySecret = "0123456789abcdef-secret"
	h := s.Handler()
	do := func(remote, host, secret string) int {
		r := httptest.NewRequest("GET", "/api/machines", nil)
		r.RemoteAddr, r.Host = remote, host
		if secret != "" {
			r.Header.Set(ProxySecretHeader, secret)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := do("127.0.0.1:5555", "127.0.0.1:7780", ""); c != 200 {
		t.Errorf("local browser = %d", c)
	}
	if c := do("10.0.0.2:5555", "ide.example.com", ""); c != 403 {
		t.Errorf("remote without secret = %d", c)
	}
	if c := do("10.0.0.2:5555", "ide.example.com", "wrong"); c != 403 {
		t.Errorf("remote with wrong secret = %d", c)
	}
	if c := do("10.0.0.2:5555", "ide.example.com", "0123456789abcdef-secret"); c != 200 {
		t.Errorf("remote with secret = %d", c)
	}
	// A proxy on the same host connects from loopback but keeps the public Host.
	if c := do("127.0.0.1:5555", "ide.example.com", ""); c != 403 {
		t.Errorf("same-host proxy without secret = %d", c)
	}
}

func TestReadOnlyRefusesWrites(t *testing.T) {
	s := newTestServer()
	s.opts.ReadOnly = true
	h := s.Handler()
	for _, path := range []string{"/api/m/x/upload", "/api/m/x/bridge", "/api/m/x/code/start", "/api/m/x/gui/enable", "/m/x/gui/1/close"} {
		r := httptest.NewRequest("POST", path, nil)
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s = %d", path, w.Code)
		}
	}
}

func TestCSPOnAppShell(t *testing.T) {
	s := New(machines.NewManager(nil, nil, log.New(os.Stderr, "", 0)), Options{
		Logger: log.New(os.Stderr, "", 0),
		Static: fstest.MapFS{"index.html": {Data: []byte("<html></html>")}},
	})
	r := httptest.NewRequest("GET", "/", nil)
	r.Host = "localhost:7780"
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'self'") || !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("csp = %q", csp)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff missing")
	}
}

func TestCodeServerIdleTracking(t *testing.T) {
	s := newTestServer()
	p := s.csProxy
	p.touch("m1", 1) // an open VS Code connection
	p.last["m1"] = time.Now().Add(-time.Hour)
	if ids := p.idleAmong([]string{"m1"}, time.Minute); len(ids) != 0 {
		t.Fatalf("machine with open connection reported idle: %v", ids)
	}
	p.touch("m1", -1)
	p.last["m1"] = time.Now().Add(-time.Hour)
	if ids := p.idleAmong([]string{"m1"}, time.Minute); len(ids) != 1 {
		t.Fatalf("idle machine not reported: %v", ids)
	}
	if ids := p.idleAmong([]string{"m2"}, time.Minute); len(ids) != 0 {
		t.Fatalf("machine without traffic yet must get a grace period: %v", ids)
	}
}

// code-server's port proxy would serve any local service of a machine with
// our origin; it is refused before the machine is even looked up.
func TestCodeServerPortProxyRefused(t *testing.T) {
	h := newTestServer().Handler()
	get := func(path string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	for _, path := range []string{
		"/m/local/code/proxy/5173/", "/m/local/code/proxy/5173", "/m/local/code/PROXY/5173/x",
		"/m/local/code/absproxy/8888/", "/m/local/code/%70roxy/5173/", "/m/local/code/proxy",
	} {
		if got := get(path); got != http.StatusForbidden {
			t.Errorf("GET %s = %d, want 403", path, got)
		}
	}
	// Other code-server paths still reach the machine lookup.
	for _, path := range []string{"/m/local/code/proxyish/", "/m/local/code/static/proxy/1"} {
		if got := get(path); got != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (unknown machine)", path, got)
		}
	}
}

func TestSettingsAPI(t *testing.T) {
	s := newTestServer()
	st := settings.New("", settings.Def{Key: "mode", Kind: settings.KindEnum, Default: "a", Options: []string{"a", "b"}},
		settings.Def{Key: "locked", Kind: settings.KindString})
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	st.RegisterFlags(fs)
	fs.Parse([]string{"--locked", "x"})
	s.opts.Settings = st
	h := s.Handler()
	do := func(method, body string) (int, string) {
		r := httptest.NewRequest(method, "/api/settings", strings.NewReader(body))
		r.RemoteAddr, r.Host = "127.0.0.1:5555", "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	if c, b := do("GET", ""); c != 200 || !strings.Contains(b, `"key":"mode"`) || !strings.Contains(b, `"source":"flag"`) {
		t.Fatalf("GET = %d %s", c, b)
	}
	for _, c := range []struct {
		body, code string
		status     int
	}{
		{`{"key":"mode","value":"b"}`, "", 200},
		{`{"key":"mode","value":"z"}`, `"error":"invalid"`, 400},
		{`{"key":"locked","value":"y"}`, `"error":"locked"`, 409},
		{`{"key":"nope","value":"y"}`, `"error":"unknown"`, 404},
		{`{"key":"mode","value":"a","machine":"no-such-machine"}`, `"error":"unknown"`, 404},
		{`not json`, `"error":"invalid"`, 400},
	} {
		if code, b := do("PUT", c.body); code != c.status || !strings.Contains(b, c.code) {
			t.Errorf("PUT %s = %d %s", c.body, code, b)
		}
	}
	if st.Get("mode") != "b" {
		t.Errorf("mode = %q", st.Get("mode"))
	}
	s.opts.ReadOnly = true
	if code, _ := do("PUT", `{"key":"mode","value":"a"}`); code != 403 || st.Get("mode") != "b" {
		t.Errorf("read-only PUT = %d, mode %q", code, st.Get("mode"))
	}
}

// VS Code windows get the browser's theme kind when they connect and when it
// changes.
func TestBridgeTheme(t *testing.T) {
	s := newTestServer()
	h := s.bridge
	a, b := net.Pipe()
	defer a.Close()
	w := &bridgeWindow{m: "m", conn: a}
	h.mu.Lock()
	h.windows[w] = true
	h.mu.Unlock()
	got := make(chan string, 4)
	go func() {
		r := bufio.NewReader(b)
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			got <- strings.TrimSpace(line)
		}
	}()
	h.setTheme("light")
	h.setTheme("light") // unchanged: not resent
	h.setTheme("purple")
	h.setTheme("dark")
	for _, want := range []string{`{"kind":"light","type":"theme"}`, `{"kind":"dark","type":"theme"}`} {
		select {
		case line := <-got:
			if line != want {
				t.Fatalf("got %s, want %s", line, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no %s", want)
		}
	}
	select {
	case line := <-got:
		t.Fatalf("unexpected %s", line)
	case <-time.After(100 * time.Millisecond):
	}
}

// New panes get the machine's display environment; what the caller set wins.
func TestMergeEnv(t *testing.T) {
	env := map[string]string{"DISPLAY": ":20", "XAUTHORITY": "/x"}
	got, added := mergeEnv(json.RawMessage(`{"pane_id":"p1","direction":"right","env":{"DISPLAY":":5","FOO":"1"}}`), env)
	var p struct {
		PaneID string            `json:"pane_id"`
		Env    map[string]string `json:"env"`
	}
	if err := json.Unmarshal(got, &p); err != nil || p.PaneID != "p1" {
		t.Fatalf("params = %s (%v)", got, err)
	}
	if p.Env["DISPLAY"] != ":5" || p.Env["XAUTHORITY"] != "/x" || p.Env["FOO"] != "1" {
		t.Errorf("env = %v", p.Env)
	}
	if strings.Join(added, ",") != "XAUTHORITY" {
		t.Errorf("added = %v", added)
	}
	for _, params := range []string{"", "null", " null ", `{"env":null}`, `{"pane_id":"p1","env":null}`} {
		got, added := mergeEnv(json.RawMessage(params), env)
		if !strings.Contains(string(got), `"DISPLAY":":20"`) || len(added) != 2 {
			t.Errorf("%q: %s %v", params, got, added)
		}
	}
	if got, _ := mergeEnv(json.RawMessage(`{"a":1}`), nil); string(got) != `{"a":1}` {
		t.Errorf("no env changed params: %s", got)
	}
	for _, bad := range []string{`{"env":"bad"}`, `[1]`, `{"env":{"A":1}}`} {
		if got, added := mergeEnv(json.RawMessage(bad), env); string(got) != bad || added != nil {
			t.Errorf("malformed %s replaced: %s", bad, got)
		}
	}
}

// Closing a program window needs the page's own Origin; "null" (sandboxed
// frames, data: pages) and other sites are refused.
func TestGUICloseOrigin(t *testing.T) {
	h := newTestServer().Handler()
	for _, c := range []struct {
		origin string
		want   int
	}{
		{"null", http.StatusForbidden},
		{"https://evil.example", http.StatusForbidden},
		{"http://127.0.0.1:7780", http.StatusNotFound}, // passed the guard; no such machine
	} {
		r := httptest.NewRequest("POST", "/m/m1/gui/7/close", nil)
		r.Host = "127.0.0.1:7780"
		r.Header.Set("Origin", c.origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("Origin %s: %d, want %d", c.origin, w.Code, c.want)
		}
	}
	r := httptest.NewRequest("GET", "/api/machines", nil)
	r.Host = "127.0.0.1:7780"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Errorf("Referrer-Policy = %q", got)
	}
}

// A remote-only per-machine setting cannot be set for the core's own machine.
func TestSettingsPerMachineScope(t *testing.T) {
	mg := machines.NewManager([]machines.Spec{
		{ID: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "r1", Kind: machines.KindSSH, Target: "r1", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	st := settings.New("", settings.Def{Key: "gui", Kind: settings.KindEnum, Default: "on", Options: []string{"on", "off"}, PerMachine: settings.ScopeRemote})
	s := New(mg, Options{Logger: log.New(io.Discard, "", 0), Settings: st})
	h := s.Handler()
	put := func(body string) int {
		r := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
		r.RemoteAddr, r.Host = "127.0.0.1:5555", "127.0.0.1:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if c := put(`{"key":"gui","value":"off","machine":"local"}`); c != http.StatusBadRequest {
		t.Errorf("local machine: %d", c)
	}
	if c := put(`{"key":"gui","value":"off","machine":"r1"}`); c != http.StatusOK || st.GetFor("gui", "r1") != "off" {
		t.Errorf("remote machine: %d, %s", c, st.GetFor("gui", "r1"))
	}
}

// Managing herdr is limited to the core host, refused in read-only mode and
// audited (feature 17).
func TestHerdrEndpoints(t *testing.T) {
	specs := []machines.Spec{
		{ID: "local", Label: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "gpu", Enabled: true},
	}
	mg := machines.NewManager(specs, nil, log.New(io.Discard, "", 0))
	var audit strings.Builder
	do := func(opts Options, method, path string) *httptest.ResponseRecorder {
		opts.Logger = log.New(io.Discard, "", 0)
		r := httptest.NewRequest(method, path, nil)
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		New(mg, opts).Handler().ServeHTTP(w, r)
		return w
	}
	for _, c := range []struct {
		opts         Options
		method, path string
		code         int
		body         string
	}{
		{Options{}, "GET", "/api/m/gpu/herdr", 400, "not_local"},
		{Options{}, "POST", "/api/m/gpu/herdr/update", 400, "not_local"},
		{Options{}, "POST", "/api/m/local/herdr/uninstall", 404, ""},
		{Options{ReadOnly: true}, "POST", "/api/m/local/herdr/start", 403, "read-only"},
		{Options{Audit: &audit}, "POST", "/api/m/local/herdr/stop", 502, "transport"}, // not connected
		{Options{ReadOnly: true}, "GET", "/api/m/local/herdr", 502, "transport"},
	} {
		w := do(c.opts, c.method, c.path)
		if w.Code != c.code || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s %s: %d %s", c.method, c.path, w.Code, w.Body)
		}
	}
	if !strings.Contains(audit.String(), `"event":"herdr.stop"`) || !strings.Contains(audit.String(), `"machine":"local"`) {
		t.Fatalf("audit: %s", audit.String())
	}
}

func TestRemoteHerdrCommand(t *testing.T) {
	for _, c := range []struct {
		target, session string
		handoff         bool
		want            string
	}{
		{"gpu", "default", false, "--remote=gpu"},
		{"user@gpu", "", false, "--remote=user@gpu"},
		{"gpu", "herdr-ide-dev", true, "--remote=gpu --session herdr-ide-dev --handoff"},
		{"-oProxyCommand=x", "default", false, "--remote=-oProxyCommand=x"}, // herdr rejects it; never an option
	} {
		if got := strings.Join(remoteHerdrArgs(c.target, c.session, c.handoff), " "); got != c.want {
			t.Errorf("%+v: %q", c, got)
		}
	}
	env := strings.Join(herdrClientEnv([]string{"HOME=/h", "HERDR_ENV=1", "HERDR_PANE_ID=p", "TERM=dumb", "HERDR_SOCKET_PATH=/s"}), " ")
	if env != "HOME=/h HERDR_SOCKET_PATH=/s TERM=xterm-256color COLORTERM=truecolor" {
		t.Fatalf("env %q", env)
	}
}

// The remote update terminal is only for SSH machines, needs the local herdr
// (whose version herdr installs there) and is refused in read-only mode.
func TestHerdrRemoteEndpoint(t *testing.T) {
	specs := []machines.Spec{
		{ID: "local", Label: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "gpu", Enabled: true},
	}
	mg := machines.NewManager(specs, nil, log.New(io.Discard, "", 0))
	for _, c := range []struct {
		readOnly bool
		path     string
		code     int
		body     string
	}{
		{false, "/api/m/local/herdr/remote", 400, "not_ssh"},
		{false, "/api/m/gpu/herdr/remote", 409, "no_local_herdr"}, // the local agent has not reported herdr
		{true, "/api/m/gpu/herdr/remote", 403, "read-only"},
	} {
		r := httptest.NewRequest("GET", c.path, nil)
		r.Host = "127.0.0.1:7780"
		w := httptest.NewRecorder()
		New(mg, Options{ReadOnly: c.readOnly, Logger: log.New(io.Discard, "", 0)}).Handler().ServeHTTP(w, r)
		if w.Code != c.code || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s read-only=%v: %d %s", c.path, c.readOnly, w.Code, w.Body)
		}
	}
}

// servePTY carries the browser's keys to the command and its output back.
func TestServePTY(t *testing.T) {
	ran := make(chan bool, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ran <- servePTY(w, r, []string{"/bin/sh", "-c", "read l; echo got:$l"}, []string{"PATH=/usr/bin:/bin"})
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/?cols=80&rows=24", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte("hi\r")); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for !strings.Contains(out.String(), "got:hi") {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("%v after %q", err, out.String())
		}
		out.Write(data)
	}
	if !<-ran {
		t.Fatal("command not reported as run")
	}
}

func TestSoundClientMostRecentlyActive(t *testing.T) {
	s := newTestServer()
	if s.soundClient() != nil {
		t.Fatal("picked a client without clients")
	}
	a, b := &wsClient{s: s}, &wsClient{s: s}
	s.clients[a], s.clients[b] = true, true
	s.markActive(a, time.Minute)
	s.markActive(b, time.Hour)
	if s.soundClient() != a {
		t.Fatal("the page used a minute ago should play, not the one used an hour ago")
	}
	s.markActive(b, 0)
	if s.soundClient() != b {
		t.Fatal("input on another page should move sounds there")
	}
	// Negative or huge idle times from a browser are clamped.
	s.markActive(a, -time.Hour)
	if s.soundClient() != a || a.active.After(time.Now()) {
		t.Fatal("negative idle time")
	}
	s.markActive(a, 1<<62)
	if s.soundClient() != b {
		t.Fatal("huge idle time")
	}
}

// Browsers name the video streams they decode; anything else is dropped.
func TestVideoCodecsParam(t *testing.T) {
	for q, want := range map[string]string{
		"":                       "",
		"avc1,vp8":               "avc1,vp8",
		"vp8,vp8,AVC1,../x,a b":  "vp8",
		"a,b,c,d,e":              "a,b,c,d",
		"averyverylongcodecname": "",
	} {
		if got := strings.Join(videoCodecs(q), ","); got != want {
			t.Errorf("videoCodecs(%q) = %q, want %q", q, got, want)
		}
	}
}

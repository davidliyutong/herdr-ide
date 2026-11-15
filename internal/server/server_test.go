package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
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

// Every route that changes something, taken from the server's own route
// table: a request from another site is refused, and so is the request in
// read-only mode. A route added without writable fails here unless it is
// one of the listed exceptions.
func TestMutatingRoutesAreGuarded(t *testing.T) {
	// Routes that change nothing although their method could, and GETs that
	// do change something.
	readOnlyAllowed := map[string]string{
		"POST /api/m/{id}/code/stop": "only frees the machine's resources",
		"/m/{id}/code":               "only redirects to /m/{id}/code/",
	}
	mutatingGET := map[string]bool{
		"GET /api/m/{id}/auth": true, // starts an interactive ssh login
	}
	s := newTestServer("https://ide.example.com")
	s.opts.Static = fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}
	h := s.Handler()
	ro := newTestServer("https://ide.example.com")
	ro.opts.ReadOnly = true
	hro := ro.Handler()
	wild := strings.NewReplacer("{id}", "x", "{action}", "start", "{win}", "1")
	checked := 0
	for _, rt := range s.routes() {
		method, path, found := strings.Cut(rt.pattern, " ")
		if !found {
			method, path = "", rt.pattern
		}
		mutating := method == "" || (method != "GET" && method != "HEAD") || mutatingGET[rt.pattern]
		if !mutating || path == "/" {
			continue
		}
		if method == "" {
			method = "POST"
		}
		path = wild.Replace(path)
		do := func(h http.Handler, origin string) *httptest.ResponseRecorder {
			r := httptest.NewRequest(method, path, strings.NewReader("{}"))
			r.Host = "127.0.0.1:7780"
			if origin != "" {
				r.Header.Set("Origin", origin)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			return w
		}
		checked++
		for _, origin := range []string{"https://evil.example", "null", "http://ide.example.com"} {
			if w := do(h, origin); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "origin not allowed") {
				t.Errorf("%s from %s: %d %q", rt.pattern, origin, w.Code, w.Body.String())
			}
		}
		if why, ok := readOnlyAllowed[rt.pattern]; ok {
			t.Logf("%s: allowed in read-only mode (%s)", rt.pattern, why)
			continue
		}
		if w := do(hro, "http://127.0.0.1:7780"); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "read-only") {
			t.Errorf("%s in read-only mode: %d %q", rt.pattern, w.Code, w.Body.String())
		}
	}
	if checked < 15 {
		t.Fatalf("only %d mutating routes found", checked)
	}
	for p := range mutatingGET {
		if !slices.ContainsFunc(s.routes(), func(r route) bool { return r.pattern == p }) {
			t.Errorf("no route %s", p)
		}
	}
	for p := range readOnlyAllowed {
		if !slices.ContainsFunc(s.routes(), func(r route) bool { return r.pattern == p }) {
			t.Errorf("no route %s", p)
		}
	}
}

func TestCSPOnAppShell(t *testing.T) {
	s := New(machines.NewManager(nil, nil, log.New(os.Stderr, "", 0)), Options{
		Logger: log.New(os.Stderr, "", 0),
		Static: fstest.MapFS{"index.html": {Data: []byte("<html></html>")}},
	})
	h := s.Handler()
	// The shell itself, the shell served for a client-side route, and an
	// API path no route takes, which is not the shell.
	for _, c := range []struct {
		path  string
		code  int
		shell bool
	}{
		{"/", 200, true},
		{"/some/route", 200, true},
		{"/m/x/gui/1", 200, true},
		{"/api/unknown", 404, false},
		{"/api", 404, false},
	} {
		r := httptest.NewRequest("GET", c.path, nil)
		r.Host = "localhost:7780"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.code || strings.Contains(w.Body.String(), "<html>") != c.shell {
			t.Errorf("%s: %d %q", c.path, w.Code, w.Body.String())
		}
		if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'self'") || !strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval';") || strings.Contains(csp, "'unsafe-eval'") || strings.Contains(csp, "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'") {
			t.Errorf("%s: csp = %q", c.path, csp)
		}
		if w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: nosniff missing", c.path)
		}
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

// Send to Agent reaches the browsers with the sending window's folders, so
// the page can pick the workspace whose panel shows that window.
func TestBridgeSendToAgent(t *testing.T) {
	s := newTestServer()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &wsClient{s: s, ctx: ctx, cancel: cancel, send: make(chan []byte, 8)}
	s.clients[c] = true
	mc := machines.NewManager([]machines.Spec{{ID: "m", Label: "m", Kind: machines.KindSSH, Target: "m"}}, nil, log.New(io.Discard, "", 0)).Get("m")
	a, b := net.Pipe()
	defer b.Close()
	go s.bridge.serve(mc, a)
	r := bufio.NewReader(b)
	if _, err := r.ReadString('\n'); err != nil { // the bridge's reply
		t.Fatal(err)
	}
	// Before its hello a window's folders are unknown: none are sent. A
	// window without a folder sends an empty list.
	b.Write([]byte(`{"type":"sendToAgent","text":"@/a:1"}` + "\n"))
	b.Write([]byte(`{"type":"hello","id":"w1","folders":["/srv/app"]}` + "\n"))
	b.Write([]byte(`{"type":"sendToAgent","text":"@/srv/app/x.go:3","file":"/srv/app/x.go","line":3,"end_line":3}` + "\n"))
	b.Write([]byte(`{"type":"hello","id":"w1","folders":[]}` + "\n"))
	b.Write([]byte(`{"type":"sendToAgent","text":"@/b:2"}` + "\n"))
	for _, want := range []string{
		`{"end_line":0,"file":"","line":0,"m":"m","t":"bridge.send","text":"@/a:1"}`,
		`{"end_line":3,"file":"/srv/app/x.go","folders":["/srv/app"],"line":3,"m":"m","t":"bridge.send","text":"@/srv/app/x.go:3"}`,
		`{"end_line":0,"file":"","folders":[],"line":0,"m":"m","t":"bridge.send","text":"@/b:2"}`,
	} {
		select {
		case m := <-c.send:
			if string(m) != want {
				t.Fatalf("got %s, want %s", m, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no bridge.send")
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

// servePTY carries the browser's keys to the command and its output back.
func TestServePTY(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		servePTY(w, r, []string{"/bin/sh", "-c", "read l; echo got:$l"})
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
	// Read until the socket closes, as a browser does: it answers the close
	// frame, which carries the reason.
	var out strings.Builder
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if !strings.Contains(out.String(), "got:hi") || websocket.CloseStatus(err) != websocket.StatusNormalClosure || closeReason(err) != "done" {
				t.Fatalf("%v after %q", err, out.String())
			}
			break
		}
		out.Write(data)
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
func TestGUIStatesEndpoint(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/gui", nil)
	req.Host = "127.0.0.1:7780"
	newTestServer().Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("GET /api/gui = %d %q", rec.Code, rec.Body.String())
	}
}

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

// agentMachine runs machine "x" with an in-process agent (HOME is a temp
// dir) and waits until it is connected.
func agentMachine(t *testing.T) (*machines.Manager, *machines.Machine, *log.Logger) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec machines.Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	mg := machines.NewManager([]machines.Spec{{ID: "x", Label: "x", Kind: machines.KindSSH, Target: "x", Enabled: true}}, dial, logger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	mc := mg.Get("x")
	for deadline := time.Now().Add(10 * time.Second); mc.Session() == nil || mc.State().Info == nil; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("machine did not connect")
		}
	}
	return mg, mc, logger
}

// A read-only browser cannot make a machine reconnect: its retry is refused
// and audited, and the machine keeps its session.
func TestReadOnlyRetryKeepsTheSession(t *testing.T) {
	mg, mc, logger := agentMachine(t)
	first := mc.Session()

	var audit strings.Builder
	s := New(mg, Options{ReadOnly: true, Audit: &audit, Logger: logger})
	c := &wsClient{s: s, readOnly: true, req: httptest.NewRequest("GET", "/ws", nil)}
	c.dispatch(&inMsg{T: "retry", M: "x"})
	time.Sleep(100 * time.Millisecond)
	select {
	case <-first.Done():
		t.Fatal("a read-only retry ended the session")
	default:
	}
	if mc.Session() != first {
		t.Fatal("a read-only retry replaced the session")
	}
	if !strings.Contains(audit.String(), `"event":"denied.retry"`) {
		t.Fatalf("audit: %s", audit.String())
	}
}

// An upload the browser cancels (its request ends before the body does)
// leaves nothing in the directory; a complete one arrives under its name.
func TestCancelledUploadLeavesNoFile(t *testing.T) {
	mg, _, logger := agentMachine(t)
	srv := httptest.NewServer(New(mg, Options{Logger: logger}).Handler())
	defer srv.Close()
	dir := t.TempDir()
	target := srv.URL + "/api/m/x/upload?" + url.Values{"name": {"big.bin"}, "dir": {dir}}.Encode()
	names := func() []string {
		ents, _ := os.ReadDir(dir)
		var out []string
		for _, e := range ents {
			out = append(out, e.Name())
		}
		return out
	}
	waitFor := func(what string, ok func([]string) bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(names()); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%s: %v", what, names())
			}
		}
	}

	body, w := io.Pipe()
	req, _ := http.NewRequest("POST", target, body)
	req.ContentLength = 1 << 20
	failed := make(chan error, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			res.Body.Close()
		}
		failed <- err
	}()
	w.Write(make([]byte, 64<<10))
	waitFor("no temporary file while uploading", func(n []string) bool { return len(n) == 1 && strings.HasPrefix(n[0], "."+brand.Slug+"-upload-") })
	w.CloseWithError(errors.New("cancelled"))
	if err := <-failed; err == nil {
		t.Fatal("the cancelled request succeeded")
	}
	waitFor("the cancelled upload left files", func(n []string) bool { return len(n) == 0 })

	res, err := http.Post(target, "application/octet-stream", strings.NewReader("whole"))
	if err != nil {
		t.Fatal(err)
	}
	var st struct{ Path string }
	json.NewDecoder(res.Body).Decode(&st)
	res.Body.Close()
	if b, _ := os.ReadFile(filepath.Join(dir, "big.bin")); res.StatusCode != 200 || st.Path != filepath.Join(dir, "big.bin") || string(b) != "whole" {
		t.Fatalf("upload: %d %+v %q (%v)", res.StatusCode, st, b, names())
	}
}

func closeReason(err error) string {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Reason
	}
	return ""
}

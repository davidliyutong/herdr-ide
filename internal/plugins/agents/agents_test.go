package agents

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

const (
	sid1 = "e6cdc860-1055-488f-9ed2-8b8019061bb9"
	sid2 = "01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3"
)

// The plugin has no settings of its own: its switch is the one
// plugin.Settings gives, on by default.
func TestPlugin(t *testing.T) {
	p := New()
	if p.ID() != "agents" {
		t.Fatalf("plugin %q", p.ID())
	}
	st := settings.New("", plugin.Settings([]plugin.Plugin{p}, nil))
	if plugin.EnableSetting(p) != "plugins.agents.enabled" || !plugin.Enabled(st, p) {
		t.Errorf("switch %s, on %v", plugin.EnableSetting(p), plugin.Enabled(st, p))
	}
}

// The route is a machine's read: answered in read-only mode, not
// audited.
func TestRoutes(t *testing.T) {
	var got []string
	for _, rt := range New().Routes() {
		if rt.Method != http.MethodGet || !rt.Machine || rt.Mutating || rt.Audit != "" {
			t.Errorf("route %+v", rt)
		}
		got = append(got, plugin.Pattern(ID, rt))
	}
	want := []string{"GET /api/m/{id}/p/agents/resolve"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("routes %v, want %v", got, want)
	}
}

type agentCall struct {
	m, action string
	params    any
	ctx       context.Context
}

// fakeAgents answers the plugin's actions; while block is set every
// action waits for it to close (or for its context).
type fakeAgents struct {
	mu    sync.Mutex
	calls []agentCall
	block chan struct{}
	// started gets each call as it starts.
	started chan agentCall
	reply   func(action string, params any) (string, error)
}

func (f *fakeAgents) call(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
	c := agentCall{mc.ID(), action, params, ctx}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	block, started, reply := f.block, f.started, f.reply
	f.mu.Unlock()
	if started != nil {
		started <- c
	}
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return &plugin.Error{Code: "transport", Message: ctx.Err().Error()}
		}
	}
	s := `{}`
	if reply != nil {
		var err error
		if s, err = reply(action, params); err != nil {
			return err
		}
	}
	return json.Unmarshal([]byte(s), out)
}

func (f *fakeAgents) taken() []agentCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agentCall(nil), f.calls...)
}

func testPlugin(t *testing.T) (*Plugin, *fakeAgents, *machines.Manager) {
	t.Helper()
	p := New()
	f := &fakeAgents{}
	p.call = f.call
	mg := machines.NewManager([]machines.Spec{
		{ID: "box", Kind: machines.KindSSH, Target: "box"},
		{ID: "gpu", Kind: machines.KindSSH, Target: "gpu"},
	}, nil, log.New(io.Discard, "", 0))
	return p, f, mg
}

type readOnlyHost struct{}

func (readOnlyHost) Machines() *machines.Manager                 { return nil }
func (readOnlyHost) Broadcast(string, string, any)               {}
func (readOnlyHost) Audit(*http.Request, string, map[string]any) {}
func (readOnlyHost) ReadOnly() bool                              { return true }
func (readOnlyHost) Settings() *settings.Store                   { return nil }
func (readOnlyHost) Logger() *log.Logger                         { return log.New(io.Discard, "", 0) }

// do runs a route's handler for machine mc (nil: not connected) with the
// query q, in a read-only core.
func do(ctx context.Context, h func(*plugin.Call, http.ResponseWriter, *http.Request), mc *machines.Machine, path, q string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/m/box/p/agents/"+path+"?"+q, nil).WithContext(ctx)
	h(&plugin.Call{Host: readOnlyHost{}, Machine: mc}, w, r)
	return w
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
	}
	json.Unmarshal(w.Body.Bytes(), &e)
	return e.Error
}

const resolveQuery = "kind=claude&session=" + sid1 + "&cwd=/x"

// The request to the machine ends when the page's request does, and
// within resolveTimeout.
func TestResolveEndsWithItsRequest(t *testing.T) {
	p, f, mg := testPlugin(t)
	f.block = make(chan struct{})
	f.started = make(chan agentCall, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- do(ctx, p.getResolve, mg.Get("box"), "resolve", resolveQuery) }()
	c := <-f.started
	if dl, ok := c.ctx.Deadline(); !ok || time.Until(dl) > resolveTimeout {
		t.Errorf("no limit on the machine's request")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the request to the machine outlived the page's")
	}
	if c.ctx.Err() == nil {
		t.Error("the machine's request goes on")
	}
	p.mu.Lock()
	n := len(p.resolving)
	p.mu.Unlock()
	if n != 0 {
		t.Errorf("%d machines with resolves in flight", n)
	}
}

// At most MaxResolving resolves run at once per machine (more: 429 busy);
// another machine is not held up.
func TestResolveBusy(t *testing.T) {
	p, f, mg := testPlugin(t)
	block := make(chan struct{})
	f.block = block
	f.started = make(chan agentCall, MaxResolving+4)
	q := resolveQuery
	var wg sync.WaitGroup
	for range MaxResolving {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", q); w.Code != http.StatusOK {
				t.Errorf("a resolve in flight: %d", w.Code)
			}
		}()
		<-f.started
	}
	w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", q)
	if w.Code != http.StatusTooManyRequests || errorCode(t, w) != "busy" {
		t.Fatalf("over the limit: %d %s", w.Code, w.Body)
	}
	if n := len(f.taken()); n != MaxResolving {
		t.Fatalf("the machine was asked %d times", n)
	}
	f.mu.Lock()
	f.block = nil
	f.mu.Unlock()
	if w := do(context.Background(), p.getResolve, mg.Get("gpu"), "resolve", q); w.Code != http.StatusOK {
		t.Errorf("another machine: %d %s", w.Code, w.Body)
	}
	<-f.started
	close(block)
	wg.Wait()
	if w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", q); w.Code != http.StatusOK {
		t.Errorf("after the others: %d %s", w.Code, w.Body)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.resolving) != 0 {
		t.Errorf("resolving %v", p.resolving)
	}
}

// A resolve's kind, session and directory are checked before the machine
// is asked; its answer passes as the plugin's type encodes it.
func TestResolve(t *testing.T) {
	p, f, mg := testPlugin(t)
	for _, q := range []url.Values{
		{},
		{"kind": {"claude"}, "session": {sid1}},
		{"kind": {"gemini"}, "session": {sid1}, "cwd": {"/x"}},
		{"kind": {""}, "session": {sid1}, "cwd": {"/x"}},
		{"kind": {"claude"}, "session": {"../" + sid1}, "cwd": {"/x"}},
		{"kind": {"claude"}, "session": {strings.ToUpper(sid1)}, "cwd": {"/x"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"x"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"./x"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"~/x"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"C:\\x"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {""}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"/x\x00"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"/\xff"}},
		{"kind": {"claude"}, "session": {sid1}, "cwd": {"/" + strings.Repeat("a", MaxCwd)}},
	} {
		w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", q.Encode())
		if w.Code != http.StatusBadRequest || errorCode(t, w) != "bad_request" {
			t.Errorf("%v: %d %s", q, w.Code, w.Body)
		}
	}
	if n := len(f.taken()); n != 0 {
		t.Fatalf("the machine was asked %d times", n)
	}
	cwd := "/" + strings.Repeat("a", MaxCwd-1)
	f.reply = func(action string, params any) (string, error) {
		return `{"ok":false,"code":"other_cwd","cwd":"/home/u/elsewhere"}`, nil
	}
	w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", url.Values{"kind": {"codex"}, "session": {sid2}, "cwd": {cwd}}.Encode())
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":false,"code":"other_cwd"}` || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	c := f.taken()
	if len(c) != 1 || c[0].action != "resolve" || c[0].params != (agentproto.ResolveRequest{Kind: "codex", Session: sid2, Cwd: cwd}) {
		t.Fatalf("asked %+v", c)
	}
	if dl, ok := c[0].ctx.Deadline(); !ok || time.Until(dl) > resolveTimeout {
		t.Errorf("no limit on the machine's request")
	}
	if w := do(context.Background(), p.getResolve, nil, "resolve", url.Values{"kind": {"codex"}, "session": {sid2}, "cwd": {"/x"}}.Encode()); w.Code != http.StatusConflict {
		t.Errorf("no machine: %d", w.Code)
	}
}

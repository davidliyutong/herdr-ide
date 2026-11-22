package agents

import (
	"context"
	"encoding/json"
	"fmt"
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
	if p.ID() != "agents" || !plugin.ValidID(p.ID()) {
		t.Fatalf("plugin %q", p.ID())
	}
	st := settings.New("", plugin.Settings([]plugin.Plugin{p}, nil))
	if plugin.EnableSetting(p) != "plugins.agents.enabled" || !plugin.Enabled(st, p) {
		t.Errorf("switch %s, on %v", plugin.EnableSetting(p), plugin.Enabled(st, p))
	}
}

// Both routes are a machine's reads: answered in read-only mode, not
// audited.
func TestRoutes(t *testing.T) {
	var got []string
	for _, rt := range New().Routes() {
		if rt.Method != http.MethodGet || !rt.Machine || rt.Mutating || rt.Audit != "" {
			t.Errorf("route %+v", rt)
		}
		got = append(got, plugin.Pattern(ID, rt))
	}
	want := []string{"GET /api/m/{id}/p/agents/tail", "GET /api/m/{id}/p/agents/resolve"}
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
	} else if req, ok := params.(agentproto.TailRequest); ok {
		// Each ref's page, empty.
		var rep agentproto.TailReply
		for _, ref := range req.Refs {
			rep.Tails = append(rep.Tails, agentproto.TranscriptTail{Kind: ref.Kind, Session: ref.Session, First: ref.From, Next: ref.From})
		}
		b, _ := json.Marshal(rep)
		s = string(b)
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

func ref(parts ...string) string { return "s=" + url.QueryEscape(strings.Join(parts, "~")) }

// Everything a tail names is checked before the machine is asked.
func TestTailValidation(t *testing.T) {
	p, f, mg := testPlugin(t)
	good := ref("claude", sid1, "0")
	nine := strings.Repeat(good+"&", 8) + good
	for _, q := range []string{
		"", "wait=100", nine,
		ref("gemini", sid1, "0"), ref("", sid1, "0"), ref("Claude", sid1, "0"), ref("../claude", sid1, "0"),
		ref("claude", strings.ToUpper(sid1), "0"), ref("claude", "../"+sid1, "0"), ref("claude", sid1[:35], "0"),
		ref("claude", "/etc/"+sid1, "0"), ref("claude", sid1),
		ref("claude", sid1, ""), ref("claude", sid1, "-1"), ref("claude", sid1, "+1"), ref("claude", sid1, "1.5"),
		ref("claude", sid1, "0x10"), ref("claude", sid1, "1e3"), ref("claude", sid1, " 1"), ref("claude", sid1, "18446744073709551616"),
		ref("claude", sid1, "0", "x"), ref("claude", sid1, "0", "B"), ref("claude", sid1, "0", ""), ref("claude", sid1, "0", "b", "b"),
		ref("claude", sid1, strings.Repeat("0", 100)),
		good + "&" + ref("codex", sid2, "x"),
		good + "&wait=-1", good + "&wait=15001", good + "&wait=abc", good + "&wait=1e3", good + "&wait=+5",
		good + "&wait=", good + "&wait=1&wait=2", good + "&wait=99999999999999999999",
	} {
		w := do(context.Background(), p.getTail, mg.Get("box"), "tail", q)
		if w.Code != http.StatusBadRequest || errorCode(t, w) != "bad_request" {
			t.Errorf("%q: %d %s", q, w.Code, w.Body)
		}
	}
	if n := len(f.taken()); n != 0 {
		t.Fatalf("the machine was asked %d times", n)
	}
	// What passes reaches the machine as it was named.
	q := strings.Join([]string{ref("claude", sid1, "0", "b"), ref("codex", sid2, "18446744073709551615"), ref("claude", sid2, "0007"), "wait=15000"}, "&")
	w := do(context.Background(), p.getTail, mg.Get("box"), "tail", q)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	c := f.taken()
	want := agentproto.TailRequest{WaitMS: 15000, Refs: []agentproto.TranscriptRef{
		{Kind: "claude", Session: sid1, Back: true},
		{Kind: "codex", Session: sid2, From: 1<<64 - 1},
		{Kind: "claude", Session: sid2, From: 7},
	}}
	if len(c) != 1 || c[0].m != "box" || c[0].action != "tail" || !reflect.DeepEqual(c[0].params, want) {
		t.Fatalf("asked %+v", c)
	}
	// Eight refs, no wait.
	w = do(context.Background(), p.getTail, mg.Get("box"), "tail", strings.Repeat(good+"&", 7)+good)
	if c := f.taken(); w.Code != http.StatusOK || len(c) != 2 || c[1].params.(agentproto.TailRequest).WaitMS != 0 || len(c[1].params.(agentproto.TailRequest).Refs) != 8 {
		t.Fatalf("eight refs: %d %+v", w.Code, c)
	}
}

// The machine's pages are answered as the plugin's types encode them,
// only when they are the pages asked for; failures keep their codes.
func TestTailReply(t *testing.T) {
	p, f, mg := testPlugin(t)
	q := ref("claude", sid1, "256") + "&" + ref("codex", sid2, "0", "b")
	f.reply = func(action string, params any) (string, error) {
		return `{"tails":[{"kind":"claude","session":"` + sid1 + `","file":"ab12","first":256,"next":512,"events":[{"seq":256,"t":"user","content":[{"type":"text","text":"hi"}],"path":"/home/u/x"}],"title":"T","secret":"/home/u"},` +
			`{"kind":"codex","session":"` + sid2 + `","first":0,"next":0,"code":"not_found"}],"path":"/home/u"}`, nil
	}
	w := do(context.Background(), p.getTail, mg.Get("box"), "tail", q)
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("%d %v %s", w.Code, w.Header(), w.Body)
	}
	if strings.Contains(w.Body.String(), "/home/u") {
		t.Errorf("what the plugin's types do not have reached the page: %s", w.Body)
	}
	var out agentproto.TailReply
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || len(out.Tails) != 2 || out.Tails[0].Next != 512 ||
		len(out.Tails[0].Events) != 1 || out.Tails[0].Title != "T" || out.Tails[1].Code != "not_found" {
		t.Fatalf("%v %s", err, w.Body)
	}
	// Pages of other transcripts, or not one per ref: a bad reply.
	for _, s := range []string{
		`{"tails":[]}`,
		`{}`,
		`{"tails":[{"kind":"claude","session":"` + sid1 + `"}]}`,
		`{"tails":[{"kind":"claude","session":"` + sid1 + `"},{"kind":"claude","session":"` + sid2 + `"}]}`,
		`{"tails":[{"kind":"codex","session":"` + sid2 + `"},{"kind":"claude","session":"` + sid1 + `"}]}`,
		`{"tails":[{"kind":"claude","session":"` + sid1 + `"},{"kind":"codex","session":"` + sid2 + `"},{"kind":"codex","session":"` + sid2 + `"}]}`,
	} {
		f.reply = func(string, any) (string, error) { return s, nil }
		if w := do(context.Background(), p.getTail, mg.Get("box"), "tail", q); w.Code != http.StatusBadGateway || errorCode(t, w) != "bad_reply" {
			t.Errorf("%s: %d %s", s, w.Code, w.Body)
		}
	}
	for code, status := range map[string]int{"bad_params": 400, "not_found": 404, "transport": 502, "offline": 409} {
		f.reply = func(string, any) (string, error) { return "", &plugin.Error{Code: code, Message: "x"} }
		if w := do(context.Background(), p.getTail, mg.Get("box"), "tail", q); w.Code != status || errorCode(t, w) != code {
			t.Errorf("%s: %d %s", code, w.Code, w.Body)
		}
	}
	if w := do(context.Background(), p.getTail, nil, "tail", q); w.Code != http.StatusConflict || errorCode(t, w) != "offline" {
		t.Errorf("no machine: %d %s", w.Code, w.Body)
	}
}

// The request to the machine ends when the page's request does, and its
// own limit is the wait and the time to read.
func TestTailEndsWithItsRequest(t *testing.T) {
	p, f, mg := testPlugin(t)
	f.block = make(chan struct{})
	f.started = make(chan agentCall, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- do(ctx, p.getTail, mg.Get("box"), "tail", ref("claude", sid1, "0")+"&wait=15000") }()
	c := <-f.started
	dl, ok := c.ctx.Deadline()
	if left := time.Until(dl); !ok || left < 40*time.Second || left > 46*time.Second {
		t.Errorf("the machine's request ends in %v", left)
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
	n := len(p.inFlight)
	p.mu.Unlock()
	if n != 0 {
		t.Errorf("%d machines with tails in flight", n)
	}
}

// doFrom is do for a request from the client at address remote.
func doFrom(ctx context.Context, h func(*plugin.Call, http.ResponseWriter, *http.Request), mc *machines.Machine, path, q, remote string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/m/box/p/agents/"+path+"?"+q, nil).WithContext(ctx)
	r.RemoteAddr = remote
	h(&plugin.Call{Host: readOnlyHost{}, Machine: mc}, w, r)
	return w
}

// waitOf is the wait a call asked the machine for.
func waitOf(c agentCall) int { return c.params.(agentproto.TailRequest).WaitMS }

// counted is what the plugin counts of machine box: tails in flight,
// waiting on it, and waiting of client.
func counted(p *Plugin, client string) (inFlight, waiting, ofClient int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.inFlight["box"], p.waiting["box"], p.clients[clientKey{"box", client}]
}

// At most MaxWaitingPerClient tails of one client wait on a machine, and
// MaxWaiting of all: one beyond is read without its wait and answered at
// once when the read has news, else after overflowPause (no longer than
// its own wait), holding no place of the machine's meanwhile; other
// clients still wait; and only beyond MaxInFlight reads at once is a tail
// refused (429 busy). Another machine and resolves are not held up.
func TestTailWaiting(t *testing.T) {
	overflowPause = 300 * time.Millisecond
	t.Cleanup(func() { overflowPause = time.Second })
	p, f, mg := testPlugin(t)
	block := make(chan struct{})
	f.block = block
	f.started = make(chan agentCall, MaxInFlight+8)
	q := ref("claude", sid1, "64") + "&wait=15000"
	var wg sync.WaitGroup
	codes := make(chan int, MaxInFlight+8)
	poll := func(remote, q string) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- doFrom(context.Background(), p.getTail, mg.Get("box"), "tail", q, remote).Code
		}()
	}

	// Client a at its share: its next tail is read without its wait.
	for range MaxWaitingPerClient {
		poll("10.0.0.1:1000", q)
		if c := <-f.started; waitOf(c) != 15000 {
			t.Fatalf("a's tail waits %d", waitOf(c))
		}
	}
	poll("10.0.0.1:1001", q)
	if c := <-f.started; waitOf(c) != 0 {
		t.Fatalf("a's tail beyond its share waits %d", waitOf(c))
	}
	// Client b still waits, and is answered when the machine is.
	f.mu.Lock()
	f.block = nil
	f.reply = func(action string, params any) (string, error) {
		return `{"tails":[{"kind":"claude","session":"` + sid1 + `","first":64,"next":128,"events":[{"seq":64,"t":"user","content":[{"type":"text","text":"hi"}]}]}]}`, nil
	}
	f.mu.Unlock()
	w := doFrom(context.Background(), p.getTail, mg.Get("box"), "tail", q, "10.0.0.2:2000")
	if c := <-f.started; w.Code != http.StatusOK || waitOf(c) != 15000 || !strings.Contains(w.Body.String(), `"next":128`) {
		t.Fatalf("b: %d %d %s", w.Code, waitOf(c), w.Body)
	}
	if n, waiting, ofA := counted(p, "10.0.0.1"); n != MaxWaitingPerClient+1 || waiting != MaxWaitingPerClient || ofA != MaxWaitingPerClient {
		t.Fatalf("counted %d %d %d", n, waiting, ofA)
	}

	// Beyond its share with news: at once. Without news: held, and no
	// longer than its own wait.
	start := time.Now()
	if w := doFrom(context.Background(), p.getTail, mg.Get("box"), "tail", q, "10.0.0.1:1002"); w.Code != http.StatusOK || time.Since(start) > overflowPause/2 {
		t.Fatalf("with news: %d after %v", w.Code, time.Since(start))
	}
	<-f.started
	f.mu.Lock()
	f.reply = nil
	f.mu.Unlock()
	for _, c := range []struct {
		q           string
		least, most time.Duration
	}{
		{q, overflowPause, 3 * overflowPause},
		{ref("claude", sid1, "64") + "&wait=50", 50 * time.Millisecond, overflowPause / 2},
	} {
		start = time.Now()
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- doFrom(context.Background(), p.getTail, mg.Get("box"), "tail", c.q, "10.0.0.1:1003") }()
		if c := <-f.started; waitOf(c) != 0 {
			t.Fatalf("beyond the share waits %d", waitOf(c))
		}
		time.Sleep(c.least / 2)
		// While held it takes nothing of the machine's.
		if n, waiting, _ := counted(p, "10.0.0.1"); n != MaxWaitingPerClient+1 || waiting != MaxWaitingPerClient {
			t.Fatalf("held: counted %d %d", n, waiting)
		}
		w := <-done
		if took := time.Since(start); w.Code != http.StatusOK || took < c.least || took > c.most {
			t.Fatalf("%s: %d after %v", c.q, w.Code, took)
		}
	}
	// A held answer ends with its request.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		doFrom(ctx, p.getTail, mg.Get("box"), "tail", q, "10.0.0.1:1004")
		close(done)
	}()
	<-f.started
	cancel()
	select {
	case <-done:
	case <-time.After(overflowPause / 2):
		t.Fatal("a held answer outlived its request")
	}

	// MaxWaiting of all clients wait; the next client's tail is read
	// without its wait.
	f.mu.Lock()
	f.block = block
	f.mu.Unlock()
	for i := range MaxWaiting - MaxWaitingPerClient {
		poll(fmt.Sprintf("10.0.1.%d:3000", i), q)
		if c := <-f.started; waitOf(c) != 15000 {
			t.Fatalf("client %d waits %d", i, waitOf(c))
		}
	}
	poll("10.0.2.1:4000", q)
	if c := <-f.started; waitOf(c) != 0 {
		t.Fatalf("beyond MaxWaiting waits %d", waitOf(c))
	}
	// Reads without a wait up to MaxInFlight; then busy.
	for n, _, _ := counted(p, ""); n < MaxInFlight; n, _, _ = counted(p, "") {
		poll("10.0.3.1:5000", ref("claude", sid1, "64"))
		<-f.started
	}
	w = doFrom(context.Background(), p.getTail, mg.Get("box"), "tail", ref("claude", sid1, "64"), "10.0.4.1:6000")
	if w.Code != http.StatusTooManyRequests || errorCode(t, w) != "busy" {
		t.Fatalf("over MaxInFlight: %d %s", w.Code, w.Body)
	}
	// Another machine, and a resolve of the busy one, go on.
	f.mu.Lock()
	f.block = nil
	f.mu.Unlock()
	if w := do(context.Background(), p.getTail, mg.Get("gpu"), "tail", q); w.Code != http.StatusOK {
		t.Errorf("another machine: %d %s", w.Code, w.Body)
	}
	<-f.started
	if w := do(context.Background(), p.getResolve, mg.Get("box"), "resolve", "kind=claude&session="+sid1+"&cwd=/x"); w.Code != http.StatusOK {
		t.Errorf("a resolve: %d %s", w.Code, w.Body)
	}
	<-f.started
	close(block)
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != http.StatusOK {
			t.Errorf("a tail in flight: %d", c)
		}
	}
	if n, waiting, _ := counted(p, "10.0.0.1"); n != 0 || waiting != 0 || len(p.clients) != 0 {
		t.Errorf("counted after all: %d %d %v", n, waiting, p.clients)
	}
}

// The client of a request is the address it comes from, without its port.
func TestClientOf(t *testing.T) {
	for remote, want := range map[string]string{
		"10.0.0.1:1234": "10.0.0.1", "[::1]:80": "::1", "127.0.0.1:5": "127.0.0.1", "pipe": "pipe",
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = remote
		r.Header.Set("X-Forwarded-For", "203.0.113.9")
		if got := clientOf(r); got != want {
			t.Errorf("%s: %s", remote, got)
		}
	}
}

// At most MaxResolving resolves run at once per machine (more: 429 busy);
// another machine and tails are not held up.
func TestResolveBusy(t *testing.T) {
	p, f, mg := testPlugin(t)
	block := make(chan struct{})
	f.block = block
	f.started = make(chan agentCall, MaxResolving+4)
	q := "kind=claude&session=" + sid1 + "&cwd=/x"
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
	if w := do(context.Background(), p.getTail, mg.Get("box"), "tail", ref("claude", sid1, "0")); w.Code != http.StatusOK {
		t.Errorf("a tail: %d %s", w.Code, w.Body)
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

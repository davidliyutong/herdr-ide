package usage

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/usage"
)

const testSession = "e6cdc860-1055-488f-9ed2-8b8019061bb9"

// sessionPlugin has a machine "box" whose agent answers the session action
// with reply (nil: a session's numbers); asked records each request.
func sessionPlugin(t *testing.T, reply func(req usage.SessionRequest) (string, error)) (*Plugin, *fakeHost, *machines.Machine, *[]usage.SessionRequest) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, h := testPlugin(t, &now, []string{"box"}, nil)
	var asked []usage.SessionRequest
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		if m != "box" || action != "session" {
			return &plugin.Error{Code: "bad_params"}
		}
		req := params.(usage.SessionRequest)
		asked = append(asked, req)
		s := `{"model":"claude-opus-5-5","input":10,"cached":2000,"cacheWrite":300,"output":40,"requests":2,"cost":0.5,"priced":true,"contextUsed":2310}`
		if reply != nil {
			var err error
			if s, err = reply(req); err != nil {
				return err
			}
		}
		return json.Unmarshal([]byte(s), out)
	}
	mg := machines.NewManager([]machines.Spec{{ID: "box", Kind: machines.KindSSH, Target: "box"}}, nil, log.New(io.Discard, "", 0))
	return p, h, mg.Get("box"), &asked
}

func getSession(p *Plugin, mc *machines.Machine, kind, session string) *httptest.ResponseRecorder {
	q := url.Values{"kind": {kind}, "session": {session}}
	w := httptest.NewRecorder()
	p.getSession(&plugin.Call{Machine: mc}, w, httptest.NewRequest("GET", "/api/m/box/p/usage/session?"+q.Encode(), nil))
	return w
}

func TestSessionRoute(t *testing.T) {
	p, _, _, _ := sessionPlugin(t, nil)
	var rt *plugin.Route
	for _, r := range p.Routes() {
		if r.Path == "session" {
			rt = &r
		}
	}
	// A machine's route that only reads: answered in read-only mode, not
	// audited.
	if rt == nil || rt.Method != "GET" || !rt.Machine || rt.Mutating || rt.Audit != "" ||
		plugin.Pattern(ID, *rt) != "GET /api/m/{id}/p/usage/session" {
		t.Fatalf("route %+v", rt)
	}
}

func TestSessionAsksTheMachine(t *testing.T) {
	const marker = "MARKER-a71d"
	p, h, mc, asked := sessionPlugin(t, func(req usage.SessionRequest) (string, error) {
		// What else an agent might answer does not reach the page.
		return `{"model":"gpt-6.1-sol","input":7,"cached":0,"cacheWrite":0,"output":3,"requests":1,"cost":0.01,"priced":true,"text":"` + marker + `","path":"/home/u/` + marker + `"}`, nil
	})
	h.readOnly = true
	if err := h.st.Set(SettingPrices, "", []any{"gpt-6.1-sol 3 0.3 20"}); err != nil {
		t.Fatal(err)
	}
	w := getSession(p, mc, "codex", testSession)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), marker) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var got map[string]any
	if json.Unmarshal(w.Body.Bytes(), &got) != nil || got["model"] != "gpt-6.1-sol" || got["requests"] != 1.0 {
		t.Errorf("answer %s", w.Body)
	}
	if len(*asked) != 1 || (*asked)[0].Kind != "codex" || (*asked)[0].Session != testSession || (*asked)[0].Prices["gpt-6.1-sol"].Output != 20 {
		t.Errorf("asked %+v", *asked)
	}
}

func TestSessionParams(t *testing.T) {
	p, _, mc, asked := sessionPlugin(t, nil)
	for _, c := range []struct{ kind, session string }{
		{"", testSession},
		{"nope", testSession},
		{"Claude", testSession},
		{"gemini", testSession},   // no subscription the plugin reads
		{"opencode", testSession}, // no transcripts of its logs
		{"claude", ""},
		{"claude", "../x"},
		{"claude", strings.ToUpper(testSession)},
		{"claude", testSession[:35]},
		{"claude", testSession + "\n"},
		{"claude", testSession + "/../../etc/passwd"},
		{"claude", "$(id)"},
	} {
		w := getSession(p, mc, c.kind, c.session)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"bad_request"`) {
			t.Errorf("%q %q: %d %s", c.kind, c.session, w.Code, w.Body)
		}
	}
	if len(*asked) != 0 {
		t.Errorf("the machine was asked: %+v", *asked)
	}
	// Valid ones are.
	for _, kind := range []string{"claude", "codex"} {
		if w := getSession(p, mc, kind, testSession); w.Code != http.StatusOK {
			t.Errorf("%s: %d %s", kind, w.Code, w.Body)
		}
	}
	if len(*asked) != 2 || (*asked)[0].Prices != nil {
		t.Errorf("asked %+v", *asked)
	}
}

func TestSessionProviderOff(t *testing.T) {
	p, h, mc, asked := sessionPlugin(t, nil)
	if err := h.st.Set(providerSetting(usage.Claude), "", false); err != nil {
		t.Fatal(err)
	}
	if w := getSession(p, mc, "claude", testSession); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "provider_off") {
		t.Errorf("claude off: %d %s", w.Code, w.Body)
	}
	if w := getSession(p, mc, "codex", testSession); w.Code != http.StatusOK {
		t.Errorf("codex on: %d %s", w.Code, w.Body)
	}
	if len(*asked) != 1 || (*asked)[0].Kind != "codex" {
		t.Errorf("asked %+v", *asked)
	}
}

func TestSessionErrors(t *testing.T) {
	var fail error
	p, _, mc, _ := sessionPlugin(t, func(usage.SessionRequest) (string, error) { return "", fail })
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{&plugin.Error{Code: "not_found"}, http.StatusNotFound, "not_found"},
		{&plugin.Error{Code: "too_large"}, http.StatusBadRequest, "too_large"},
		{&plugin.Error{Code: "compressed"}, http.StatusBadRequest, "compressed"},
		{plugin.ErrOffline, http.StatusConflict, "offline"},
	} {
		fail = c.err
		w := getSession(p, mc, "claude", testSession)
		if w.Code != c.status || !strings.Contains(w.Body.String(), `"`+c.code+`"`) {
			t.Errorf("%v: %d %s", c.err, w.Code, w.Body)
		}
	}
	// The route's machine is gone.
	if w := getSession(p, nil, "claude", testSession); w.Code != http.StatusConflict {
		t.Errorf("no machine: %d %s", w.Code, w.Body)
	}
}

// At most MaxSessionReads session requests are under way per machine
// (more: 429 busy, the machine not asked); another machine is not held up,
// and a request ended gives its place back.
func TestSessionBusy(t *testing.T) {
	p, _, mc, _ := sessionPlugin(t, nil)
	block := make(chan struct{})
	started := make(chan string, MaxSessionReads+2)
	var mu sync.Mutex
	asked := 0
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		mu.Lock()
		asked++
		mu.Unlock()
		started <- m
		if m == "box" {
			select {
			case <-block:
			case <-ctx.Done():
				return &plugin.Error{Code: "transport"}
			}
		}
		return json.Unmarshal([]byte(`{"model":"m","requests":1}`), out)
	}
	var wg sync.WaitGroup
	for range MaxSessionReads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := getSession(p, mc, "claude", testSession); w.Code != http.StatusOK {
				t.Errorf("in flight: %d %s", w.Code, w.Body)
			}
		}()
		<-started
	}
	w := getSession(p, mc, "claude", testSession)
	if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), `"busy"`) {
		t.Fatalf("over the limit: %d %s", w.Code, w.Body)
	}
	mu.Lock()
	n := asked
	mu.Unlock()
	if n != MaxSessionReads {
		t.Fatalf("the machine was asked %d times", n)
	}
	other := machines.NewManager([]machines.Spec{{ID: "gpu", Kind: machines.KindSSH, Target: "gpu"}}, nil, log.New(io.Discard, "", 0)).Get("gpu")
	if w := getSession(p, other, "claude", testSession); w.Code != http.StatusOK {
		t.Errorf("another machine: %d %s", w.Code, w.Body)
	}
	<-started
	close(block)
	wg.Wait()
	if w := getSession(p, mc, "claude", testSession); w.Code != http.StatusOK {
		t.Errorf("after the others: %d %s", w.Code, w.Body)
	}
	sessionReads.Lock()
	defer sessionReads.Unlock()
	for k, n := range sessionReads.n {
		if k.p == p {
			t.Errorf("%s still counts %d", k.machine, n)
		}
	}
}

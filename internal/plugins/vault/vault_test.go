package vault

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	vaultstore "herdr-ide/internal/vault"
)

// fakeHost records what the plugin broadcasts and audits.
type fakeHost struct {
	mu       sync.Mutex
	messages []map[string]any
	audits   []string
	sent     chan map[string]any
}

func (h *fakeHost) Machines() *machines.Manager { return nil }
func (h *fakeHost) Broadcast(id, m string, data any) {
	d := data.(map[string]any)
	h.mu.Lock()
	h.messages = append(h.messages, d)
	h.mu.Unlock()
	if h.sent != nil && d["type"] == "request" {
		h.sent <- d
	}
}
func (h *fakeHost) Audit(r *http.Request, event string, fields map[string]any) {
	b, _ := json.Marshal(fields)
	h.mu.Lock()
	h.audits = append(h.audits, event+" "+string(b))
	h.mu.Unlock()
}
func (h *fakeHost) ReadOnly() bool            { return false }
func (h *fakeHost) Settings() *settings.Store { return nil }
func (h *fakeHost) Logger() *log.Logger       { return log.New(log.Writer(), "", 0) }
func (h *fakeHost) auditLog() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return strings.Join(h.audits, "\n")
}
func (h *fakeHost) messageCount(t string) (n int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, m := range h.messages {
		if m["type"] == t {
			n++
		}
	}
	return n
}

func newTest(t *testing.T) (*Plugin, *fakeHost, *vaultstore.Store) {
	t.Helper()
	p := &Plugin{Keys: &vaultstore.MemKeyStore{}, Path: filepath.Join(t.TempDir(), "vault.json"), Timeout: 200 * time.Millisecond}
	h := &fakeHost{sent: make(chan map[string]any, 8)}
	s, err := p.open(h)
	if err != nil {
		t.Fatal(err)
	}
	return p, h, s
}

func str(s string) *string { return &s }

func TestListAndValuesByMachine(t *testing.T) {
	p, h, s := newTest(t)
	ms := []string{"m1"}
	s.Set("GH_TOKEN", vaultstore.Update{Value: str("ghp_x"), Machines: &ms, Description: str("GitHub")})
	all := []string{"*"}
	inject := true
	s.Set("DB_PASS", vaultstore.Update{Value: str("pw"), Machines: &all, InjectOnly: &inject})
	ctx := context.Background()

	r := p.Handle(ctx, h, "m2", agentproto.VaultRequest{Tool: "list"})
	if !r.OK || len(r.Variables) != 2 || r.Variables[0].Name != "DB_PASS" || !r.Variables[0].InjectOnly || r.Variables[0].Approval || !r.Variables[1].Approval {
		t.Fatalf("list %+v", r)
	}
	if r.Values != nil {
		t.Error("list carries values")
	}
	r = p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"GH_TOKEN"}, Client: "claude"})
	if !r.OK || r.Values["GH_TOKEN"] != "ghp_x" {
		t.Fatalf("get %+v", r)
	}
	r = p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"DB_PASS"}})
	if r.Code != "inject_only" {
		t.Errorf("inject-only get %+v", r)
	}
	r = p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "env", Names: []string{"DB_PASS", "GH_TOKEN"}})
	if !r.OK || r.Values["DB_PASS"] != "pw" || r.Values["GH_TOKEN"] != "ghp_x" {
		t.Errorf("env %+v", r)
	}
	r = p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"NOPE"}})
	if r.Code != "not_found" {
		t.Errorf("unknown %+v", r)
	}
	s.Lock()
	r = p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"GH_TOKEN"}})
	if r.Code != "vault_locked" {
		t.Errorf("locked %+v", r)
	}
	log := p.Log()
	if len(log) != 6 || log[0].Result != "vault_locked" || log[len(log)-1].Result != "listed" {
		t.Errorf("log %+v", log)
	}
	audit := h.auditLog()
	if strings.Contains(audit, "ghp_x") || !strings.Contains(audit, `"names":["GH_TOKEN"]`) {
		t.Errorf("audit %s", audit)
	}
}

// A machine not allowed asks the pages; the first answer wins, always adds
// the machine, and no answer is a denial.
func TestApprovals(t *testing.T) {
	p, h, s := newTest(t)
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	ctx := context.Background()
	get := func() chan agentproto.VaultResponse {
		ch := make(chan agentproto.VaultResponse, 1)
		go func() {
			ch <- p.Handle(ctx, h, "m2", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Client: "codex"})
		}()
		return ch
	}
	answer := func(a string) {
		msg := <-h.sent
		req := msg["request"].(*Request)
		if req.M != "m2" || req.Names[0] != "KEY" || req.Client != "codex" {
			t.Errorf("request %+v", req)
		}
		if len(p.Pending()) != 1 {
			t.Error("not pending")
		}
		if !p.Answer(req.ID, a) {
			t.Fatal("answer refused")
		}
		if p.Answer(req.ID, AnswerDeny) {
			t.Error("a second answer was taken")
		}
	}

	ch := get()
	answer(AnswerDeny)
	if r := <-ch; r.Code != "denied" {
		t.Errorf("deny %+v", r)
	}
	ch = get()
	answer(AnswerOnce)
	if r := <-ch; !r.OK || r.Values["KEY"] != "v" {
		t.Errorf("once %+v", r)
	}
	if i, _ := s.Get("KEY"); i.Allows("m2") {
		t.Error("once added the machine")
	}
	ch = get()
	<-h.sent // nobody answers
	if r := <-ch; r.Code != "denied" {
		t.Errorf("timeout %+v", r)
	}
	ch = get()
	answer(AnswerAlways)
	if r := <-ch; !r.OK {
		t.Errorf("always %+v", r)
	}
	// Persisted: reopened, the machine reads without asking.
	s2, _ := vaultstore.Open(p.Path, p.Keys, "vault.json")
	if i, _ := s2.Get("KEY"); !i.Allows("m2") {
		t.Error("always did not persist")
	}
	if r := p.Handle(ctx, h, "m2", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK {
		t.Errorf("after always %+v", r)
	}
	if h.messageCount("resolved") != 4 {
		t.Errorf("resolved messages %d", h.messageCount("resolved"))
	}
	if len(p.Pending()) != 0 {
		t.Error("requests left")
	}
	// The requester going away ends the wait.
	cctx, cancel := context.WithCancel(ctx)
	done := make(chan agentproto.VaultResponse, 1)
	go func() { done <- p.Handle(cctx, h, "m3", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}) }()
	<-h.sent
	cancel()
	if r := <-done; r.Code != "denied" {
		t.Errorf("cancelled %+v", r)
	}
}

func TestRoutes(t *testing.T) {
	p, h, _ := newTest(t)
	mux := http.NewServeMux()
	for _, rt := range p.Routes() {
		rt := rt
		mux.HandleFunc(plugin.Pattern(ID, rt), func(w http.ResponseWriter, r *http.Request) {
			rt.Handler(&plugin.Call{Host: h}, w, r)
		})
	}
	do := func(method, path, body string) (int, map[string]any) {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	if c, out := do("PUT", "/api/p/vault/vars/1BAD", `{"value":"x"}`); c != 400 || out["error"] != "invalid_name" {
		t.Errorf("bad name %d %v", c, out)
	}
	if c, out := do("PUT", "/api/p/vault/vars/OPENAI_KEY", `{"value":"sk-1","description":"d","machines":["m1"]}`); c != 200 || out["name"] != "OPENAI_KEY" {
		t.Fatalf("set %d %v", c, out)
	}
	c, out := do("GET", "/api/p/vault", "")
	if c != 200 || strings.Contains(mustJSON(out), "sk-1") || out["status"].(map[string]any)["mode"] != "keychain" {
		t.Fatalf("list %d %v", c, out)
	}
	if c, out := do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); c != 200 || out["value"] != "sk-1" {
		t.Errorf("reveal %d %v", c, out)
	}
	// Without a value the old one stays.
	do("PUT", "/api/p/vault/vars/OPENAI_KEY", `{"description":"new"}`)
	if _, out := do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); out["value"] != "sk-1" {
		t.Errorf("kept %v", out)
	}
	do("POST", "/api/p/vault/lock", "")
	if c, out := do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); c != 409 || out["error"] != "vault_locked" {
		t.Errorf("locked reveal %d %v", c, out)
	}
	do("POST", "/api/p/vault/unlock", `{}`)
	if c, out := do("POST", "/api/p/vault/requests/nope", `{"answer":"once"}`); c != 404 {
		t.Errorf("answer %d %v", c, out)
	}
	if c, _ := do("POST", "/api/p/vault/requests/nope", `{"answer":"maybe"}`); c != 400 {
		t.Errorf("bad answer %d", c)
	}
	if c, _ := do("DELETE", "/api/p/vault/vars/OPENAI_KEY", ""); c != 200 {
		t.Errorf("delete %d", c)
	}
	if c, _ := do("DELETE", "/api/p/vault/vars/OPENAI_KEY", ""); c != 404 {
		t.Errorf("delete again %d", c)
	}
	if c, out := do("GET", "/api/p/vault/log", ""); c != 200 || out["log"] == nil {
		t.Errorf("log %d %v", c, out)
	}
	// Without a file the vault is unavailable.
	p2 := &Plugin{Keys: &vaultstore.MemKeyStore{}}
	w := httptest.NewRecorder()
	p2.handleList(&plugin.Call{Host: h}, w, httptest.NewRequest("GET", "/api/p/vault", nil))
	if w.Code != 503 {
		t.Errorf("no file: %d", w.Code)
	}
}

// The passphrase form's flow: a vault without a keychain asks for one.
func TestPassphraseRoutes(t *testing.T) {
	p := &Plugin{Keys: &vaultstore.MemKeyStore{Fail: true}, Path: filepath.Join(t.TempDir(), "vault-dev.json")}
	h := &fakeHost{}
	s, _ := p.open(h)
	s.KDF = vaultstore.KDF{Time: 1, Memory: 64, Threads: 1}
	call := &plugin.Call{Host: h}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PUT", "/api/p/vault/vars/A", strings.NewReader(`{"value":"x"}`))
	r.SetPathValue("name", "A")
	p.handleSet(call, w, r)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "vault_locked") {
		t.Fatalf("first value %d %s", w.Code, w.Body)
	}
	if st := s.Status(); st.Mode != "passphrase" || !st.Setup {
		t.Fatalf("status %+v", st)
	}
	w = httptest.NewRecorder()
	p.handleUnlock(call, w, httptest.NewRequest("POST", "/api/p/vault/unlock", strings.NewReader(`{"passphrase":"long enough"}`)))
	if w.Code != 200 {
		t.Fatalf("setup %d %s", w.Code, w.Body)
	}
	if !strings.Contains(h.auditLog(), "vault.unlocked") || strings.Contains(h.auditLog(), "long enough") {
		t.Errorf("audit %s", h.auditLog())
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

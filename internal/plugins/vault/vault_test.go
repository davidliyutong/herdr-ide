package vault

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	p := &Plugin{Path: filepath.Join(t.TempDir(), "vault.json"), Timeout: 200 * time.Millisecond}
	h := &fakeHost{sent: make(chan map[string]any, 8)}
	s, err := p.open(h)
	if err != nil {
		t.Fatal(err)
	}
	s.KDF = testKDF
	if err := s.SetPassphrase(pass); err != nil {
		t.Fatal(err)
	}
	return p, h, s
}

const pass = "correct horse"

// testKDF keeps Argon2id fast in tests (the store's tests lower its bound).
var testKDF = vaultstore.KDF{Time: 1, Memory: 8 << 10, Threads: 1}

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
		if p.answerRequest(req.ID, a) == nil {
			t.Fatal("answer refused")
		}
		if p.answerRequest(req.ID, AnswerDeny) != nil {
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
	s2, _ := vaultstore.Open(p.Path)
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
	c := newClient(p, h)
	// Without a session the gate refuses changes and reveals.
	if code, out := c.do("PUT", "/api/p/vault/vars/OPENAI_KEY", `{"value":"sk-1"}`); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("no session %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/session", `{"passphrase":"wrong horse"}`); code != 403 || out["error"] != "wrong_passphrase" {
		t.Fatalf("wrong passphrase %d %v", code, out)
	}
	c.session(t)
	if code, out := c.do("PUT", "/api/p/vault/vars/1BAD", `{"value":"x"}`); code != 400 || out["error"] != "invalid_name" {
		t.Errorf("bad name %d %v", code, out)
	}
	if code, out := c.do("PUT", "/api/p/vault/vars/OPENAI_KEY", `{"value":"sk-1","description":"d","machines":["m1"]}`); code != 200 || out["name"] != "OPENAI_KEY" {
		t.Fatalf("set %d %v", code, out)
	}
	code, out := c.do("GET", "/api/p/vault", "")
	if code != 200 || strings.Contains(mustJSON(out), "sk-1") || out["status"].(map[string]any)["mode"] != "passphrase" || out["session"] != true {
		t.Fatalf("list %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); code != 200 || out["value"] != "sk-1" {
		t.Errorf("reveal %d %v", code, out)
	}
	// Without a value the old one stays.
	c.do("PUT", "/api/p/vault/vars/OPENAI_KEY", `{"description":"new"}`)
	if _, out := c.do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); out["value"] != "sk-1" {
		t.Errorf("kept %v", out)
	}
	// Locking ends every session.
	c.do("POST", "/api/p/vault/lock", "")
	if code, out := c.do("POST", "/api/p/vault/vars/OPENAI_KEY/reveal", ""); code != 401 || out["error"] != "vault_session" {
		t.Errorf("locked reveal %d %v", code, out)
	}
	c.session(t)
	if code, out := c.do("POST", "/api/p/vault/requests/nope", `{"answer":"once"}`); code != 404 {
		t.Errorf("answer %d %v", code, out)
	}
	if code, _ := c.do("POST", "/api/p/vault/requests/nope", `{"answer":"maybe"}`); code != 400 {
		t.Errorf("bad answer %d", code)
	}
	if code, _ := c.do("DELETE", "/api/p/vault/vars/OPENAI_KEY", ""); code != 200 {
		t.Errorf("delete %d", code)
	}
	if code, _ := c.do("DELETE", "/api/p/vault/vars/OPENAI_KEY", ""); code != 404 {
		t.Errorf("delete again %d", code)
	}
	if code, out := c.do("GET", "/api/p/vault/log", ""); code != 200 || out["log"] == nil {
		t.Errorf("log %d %v", code, out)
	}
	// Ending the session closes the gate again.
	c.do("DELETE", "/api/p/vault/session", "")
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("after the end %d", code)
	}
	// Without a file the vault is unavailable.
	p2 := &Plugin{}
	w := httptest.NewRecorder()
	p2.handleList(&plugin.Call{Host: h}, w, httptest.NewRequest("GET", "/api/p/vault", nil))
	if w.Code != 503 {
		t.Errorf("no file: %d", w.Code)
	}
}

// A new vault asks for a passphrase, which opens the first session;
// sessions end unused or old; wrong passphrases in a row slow down.
func TestPassphraseAndSessions(t *testing.T) {
	p := &Plugin{Path: filepath.Join(t.TempDir(), "vault-dev.json")}
	h := &fakeHost{}
	s, _ := p.open(h)
	s.KDF = testKDF
	now := time.Unix(1_000_000, 0)
	p.now = func() time.Time { return now }
	c := newClient(p, h)
	if code, out := c.do("POST", "/api/p/vault/session", `{"passphrase":"x"}`); code != 409 || out["error"] != "no_passphrase" {
		t.Fatalf("session without a passphrase %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/passphrase", `{"passphrase":"short"}`); code != 400 || out["error"] != "weak_passphrase" {
		t.Fatalf("weak %d %v", code, out)
	}
	code, out := c.do("POST", "/api/p/vault/passphrase", `{"passphrase":"long enough"}`)
	if code != 200 || out["session"] == "" {
		t.Fatalf("setup %d %v", code, out)
	}
	c.tok = out["session"].(string)
	if code, _ := c.do("PUT", "/api/p/vault/vars/A", `{"value":"x"}`); code != 200 {
		t.Fatalf("set in the first session %d", code)
	}
	// A second passphrase is a change, with the current one.
	if code, out := c.do("POST", "/api/p/vault/passphrase", `{"passphrase":"another one"}`); code != 409 || out["error"] != "has_passphrase" {
		t.Errorf("second %d %v", code, out)
	}
	// Unused for SessionIdle, it ends.
	now = now.Add(SessionIdle + time.Second)
	if code, _ := c.do("PUT", "/api/p/vault/vars/A", `{"value":"y"}`); code != 401 {
		t.Errorf("idle session %d", code)
	}
	// Loading the list does not count as its use: only what passes the gate.
	c.session2(t, "long enough")
	for i := 0; i < 3; i++ {
		now = now.Add(SessionIdle / 2)
		if _, out := c.do("GET", "/api/p/vault", ""); i < 1 && out["session"] != true {
			t.Errorf("list %d: %v", i, out["session"])
		}
	}
	if code, _ := c.do("POST", "/api/p/vault/vars/A/reveal", ""); code != 401 {
		t.Errorf("session kept by lists %d", code)
	}
	// Used, it lasts at most SessionMax.
	c.session2(t, "long enough")
	for i := 0; i < int(SessionMax/SessionIdle)+1; i++ {
		now = now.Add(SessionIdle - time.Second)
		c.do("POST", "/api/p/vault/vars/A/reveal", "")
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/A", `{"value":"y"}`); code != 401 {
		t.Errorf("old session %d", code)
	}
	// Wrong passphrases past failFree wait, twice as long each time.
	for i := 0; i < failFree; i++ {
		if code, _ := c.do("POST", "/api/p/vault/session", `{"passphrase":"wrong one"}`); code != 403 {
			t.Fatalf("wrong %d: %d", i, code)
		}
	}
	c.do("POST", "/api/p/vault/session", `{"passphrase":"wrong one"}`)
	if code, out := c.do("POST", "/api/p/vault/session", `{"passphrase":"long enough"}`); code != 429 || out["error"] != "wait" {
		t.Errorf("not slowed %d %v", code, out)
	}
	now = now.Add(2 * time.Second)
	c.session2(t, "long enough")
	audit := h.auditLog()
	if !strings.Contains(audit, "vault.unlocked") || !strings.Contains(audit, "vault.passphrase_set") || strings.Contains(audit, "long enough") {
		t.Errorf("audit %s", audit)
	}
	// A change keeps the values and ends the other sessions.
	other := c.tok
	code, out = c.do("POST", "/api/p/vault/passphrase", `{"old":"long enough","passphrase":"longer still"}`)
	if code != 200 {
		t.Fatalf("change %d %v", code, out)
	}
	c.tok = other
	if code, _ := c.do("POST", "/api/p/vault/vars/A/reveal", ""); code != 401 {
		t.Errorf("session of the old passphrase %d", code)
	}
	c.session2(t, "longer still")
	if _, out := c.do("POST", "/api/p/vault/vars/A/reveal", ""); out["value"] != "x" {
		t.Errorf("value after the change %v", out)
	}
	// One check at a time: a guess while another runs is told so (busy,
	// not the wait of wrong passphrases).
	p.mu.Lock()
	p.guessing = true
	p.mu.Unlock()
	if code, out := c.do("POST", "/api/p/vault/session", `{"passphrase":"longer still"}`); code != 429 || out["error"] != "busy" {
		t.Errorf("parallel guess %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/passphrase", `{"old":"longer still","passphrase":"longest yet"}`); code != 429 || out["error"] != "busy" {
		t.Errorf("parallel change %d %v", code, out)
	}
	p.tried(false, false)
	// A session is not opened by a check that crossed a lock.
	epoch := p.currentEpoch()
	c.do("POST", "/api/p/vault/lock", "")
	if tok := p.newSession(epoch); tok != "" {
		t.Error("a session opened across a lock")
	}
	// Refusals of the gate and reveals are audited.
	audit = h.auditLog()
	for _, ev := range []string{"denied.vault_session", "vault.revealed"} {
		if !strings.Contains(audit, ev) {
			t.Errorf("no %s in %s", ev, audit)
		}
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// client calls the plugin's routes with h as the host, with its session.
type client struct {
	mux *http.ServeMux
	tok string
}

func newClient(p *Plugin, h *fakeHost) *client {
	mux := http.NewServeMux()
	for _, rt := range p.Routes() {
		rt := rt
		mux.HandleFunc(plugin.Pattern(ID, rt), func(w http.ResponseWriter, r *http.Request) {
			rt.Handler(&plugin.Call{Host: h}, w, r)
		})
	}
	return &client{mux: mux}
}

func (c *client) do(method, path, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if c.tok != "" {
		r.Header.Set(SessionHeader, c.tok)
	}
	c.mux.ServeHTTP(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// session opens a session with the test passphrase.
func (c *client) session(t *testing.T) { c.session2(t, pass) }

func (c *client) session2(t *testing.T, passphrase string) {
	t.Helper()
	code, out := c.do("POST", "/api/p/vault/session", mustJSON(map[string]string{"passphrase": passphrase}))
	if code != 200 {
		t.Fatalf("session %d %v", code, out)
	}
	c.tok = out["session"].(string)
}

// Answers and changes to who may read a variable are audited, without
// values; always is told apart from once in the access log.
func TestAnswersAndChangesAreAudited(t *testing.T) {
	p, h, _ := newTest(t)
	p.Timeout = 5 * time.Second
	c := newClient(p, h)
	c.session(t)
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"s3cret","machines":["m1"],"injectOnly":true}`); code != 200 {
		t.Fatal(code)
	}
	audit := h.auditLog()
	if !strings.Contains(audit, `vault.saved {"inject_only":true,"machines":["m1"],"name":"KEY","value_changed":true}`) || strings.Contains(audit, "s3cret") {
		t.Errorf("set audit %s", audit)
	}
	ch := make(chan agentproto.VaultResponse, 1)
	go func() {
		ch <- p.Handle(context.Background(), h, "m2", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
	}()
	req := (<-h.sent)["request"].(*Request)
	// Letting a value out needs a session: a program on the core host
	// cannot approve its own request.
	tok := c.tok
	c.tok = ""
	if code, out := c.do("POST", "/api/p/vault/requests/"+req.ID, `{"answer":"always"}`); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("approval without a session %d %v", code, out)
	}
	c.tok = tok
	if code, _ := c.do("POST", "/api/p/vault/requests/"+req.ID, `{"answer":"always"}`); code != 200 {
		t.Fatal(code)
	}
	if r := <-ch; !r.OK {
		t.Fatalf("always %+v", r)
	}
	audit = h.auditLog()
	if !strings.Contains(audit, `vault.answered {"answer":"always","id":"`+req.ID+`","machine":"m2","names":["KEY"],"tool":"env"}`) {
		t.Errorf("answer audit %s", audit)
	}
	if l := p.Log(); l[0].Result != "approved_always" {
		t.Errorf("log %+v", l[0])
	}
	// Denying needs no session.
	go func() {
		ch <- p.Handle(context.Background(), h, "m3", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
	}()
	req = (<-h.sent)["request"].(*Request)
	c.tok = ""
	if code, _ := c.do("POST", "/api/p/vault/requests/"+req.ID, `{"answer":"deny"}`); code != 200 {
		t.Fatalf("deny without a session %d", code)
	}
	if r := <-ch; r.Code != "denied" {
		t.Errorf("denied %+v", r)
	}
	if strings.Contains(h.auditLog(), "s3cret") {
		t.Error("a value in the audit log")
	}
}

// An answer racing the timeout: the page is told its answer was taken
// exactly when the requester gets it.
func TestAnswerRacingTheTimeout(t *testing.T) {
	p, h, s := newTest(t)
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	h.sent = make(chan map[string]any, 1)
	for i := 0; i < 200; i++ {
		p.Timeout = time.Duration(i%5) * 100 * time.Microsecond
		if p.Timeout == 0 {
			p.Timeout = 50 * time.Microsecond
		}
		ch := make(chan agentproto.VaultResponse, 1)
		go func() {
			ch <- p.Handle(context.Background(), h, "m2", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}})
		}()
		req := (<-h.sent)["request"].(*Request)
		var wg sync.WaitGroup
		took := make([]bool, 3)
		for j := range took {
			wg.Add(1)
			go func() {
				defer wg.Done()
				took[j] = p.answerRequest(req.ID, AnswerOnce) != nil
			}()
		}
		wg.Wait()
		r := <-ch
		n := 0
		for _, ok := range took {
			if ok {
				n++
			}
		}
		if n > 1 || (n == 1) != r.OK {
			t.Fatalf("round %d: answers taken %v, response %+v", i, took, r)
		}
	}
}

// A machine cannot crowd out the others' prompts: past four waiting
// requests it is busy; identical requests share one prompt; list calls do
// not make the pages reload and are coalesced.
func TestPendingRequestsAreBounded(t *testing.T) {
	p, h, s := newTest(t)
	p.Timeout = 10 * time.Second
	h.sent = make(chan map[string]any, 16)
	for _, n := range []string{"A", "B", "C", "D", "E"} {
		s.Set(n, vaultstore.Update{Value: str("v" + n)})
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	results := make(chan agentproto.VaultResponse, 8)
	ask := func(m, name string) {
		go func() {
			results <- p.Handle(ctx, h, m, agentproto.VaultRequest{Tool: "get", Names: []string{name}})
		}()
	}
	for _, n := range []string{"A", "B", "C", "D"} {
		ask("ma", n)
		<-h.sent
	}
	ask("ma", "E")
	if r := <-results; r.Code != "busy" {
		t.Fatalf("fifth request %+v", r)
	}
	// The same request again shares the prompt.
	ask("ma", "A")
	ask("mb", "A")
	msg := <-h.sent
	req := msg["request"].(*Request)
	if req.M != "mb" {
		t.Fatalf("other machine's request %+v", req)
	}
	if len(p.Pending()) != 5 {
		t.Fatalf("pending %d", len(p.Pending()))
	}
	var a *Request
	for _, r := range p.Pending() {
		if r.M == "ma" && r.Names[0] == "A" {
			a = r
		}
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		p.mu.Lock()
		waiters := a.waiters
		p.mu.Unlock()
		if waiters == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiters %d", waiters)
		}
		time.Sleep(time.Millisecond)
	}
	if p.answerRequest(a.ID, AnswerOnce) == nil {
		t.Fatal("answer refused")
	}
	for i := 0; i < 2; i++ {
		if r := <-results; !r.OK || r.Values["A"] != "vA" {
			t.Errorf("shared answer %+v", r)
		}
	}
	if p.answerRequest(req.ID, AnswerDeny) == nil {
		t.Fatal("answer refused")
	}
	if r := <-results; r.Code != "denied" {
		t.Errorf("mb %+v", r)
	}
	cancel()
	for i := 0; i < 3; i++ {
		<-results
	}
	if len(p.Pending()) != 0 {
		t.Errorf("left %d", len(p.Pending()))
	}

	before := h.messageCount("changed")
	audits := strings.Count(h.auditLog(), `"result":"listed"`)
	for i := 0; i < 10; i++ {
		p.Handle(context.Background(), h, "ma", agentproto.VaultRequest{Tool: "list"})
	}
	if h.messageCount("changed") != before {
		t.Error("list calls made the pages reload")
	}
	if n := strings.Count(h.auditLog(), `"result":"listed"`) - audits; n != 1 {
		t.Errorf("list audit lines %d", n)
	}
	if l := p.Log(); l[0].Result != "listed" || l[0].Count != 10 {
		t.Errorf("log %+v", l[0])
	}
}

// A removed machine leaves the variables' allowed machines.
func TestForgetMachine(t *testing.T) {
	p, h, s := newTest(t)
	ms := []string{"m1", "m2"}
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &ms})
	p.ForgetMachine(h, "m1")
	if i, _ := s.Get("KEY"); i.Allows("m1") || !i.Allows("m2") {
		t.Errorf("machines %v", i.Machines)
	}
	if !strings.Contains(h.auditLog(), `vault.machine_forgotten {"machine":"m1","names":["KEY"]}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	if h.messageCount("changed") != 1 {
		t.Errorf("changed %d", h.messageCount("changed"))
	}
}

// A vault's file that does not open says why (503 with the store's code:
// another version, a damaged file), and is opened again at the next use,
// so moving it away needs no restart.
func TestOpenErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	p := &Plugin{Path: path}
	h := &fakeHost{}
	c := newClient(p, h)
	for body, want := range map[string]string{
		`{"version":2,"mode":"keychain","entries":[]}`: "version",
		`{"version":3,`: "invalid",
	} {
		os.WriteFile(path, []byte(body), 0o600)
		if code, out := c.do("GET", "/api/p/vault", ""); code != 503 || out["error"] != want {
			t.Errorf("%s: %d %v", body, code, out)
		}
		if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "list"}); r.Code != "unavailable" {
			t.Errorf("an MCP request to a vault that does not open %+v", r)
		}
	}
	os.Remove(path)
	if code, out := c.do("GET", "/api/p/vault", ""); code != 200 || out["status"].(map[string]any)["setup"] != true {
		t.Errorf("after moving the file away %d %v", code, out)
	}
}

// Renaming in the editor is one call: the name and the other changes are
// saved together (audited with both names), and a refusal changes nothing.
func TestSaveRenames(t *testing.T) {
	p, h, _ := newTest(t)
	c := newClient(p, h)
	if code, _ := c.do("PUT", "/api/p/vault/vars/OLD", `{"to":"NEW"}`); code != 401 {
		t.Errorf("without a session %d", code)
	}
	c.session(t)
	c.do("PUT", "/api/p/vault/vars/OLD", `{"value":"v1","machines":["m1"]}`)
	c.do("PUT", "/api/p/vault/vars/TAKEN", `{"value":"v2"}`)
	if code, out := c.do("PUT", "/api/p/vault/vars/OLD", `{"to":"TAKEN","description":"x"}`); code != 409 || out["error"] != "exists" {
		t.Errorf("taken name %d %v", code, out)
	}
	if code, out := c.do("PUT", "/api/p/vault/vars/GONE", `{"to":"X","description":"x"}`); code != 404 || out["error"] != "not_found" {
		t.Errorf("missing variable %d %v", code, out)
	}
	code, out := c.do("PUT", "/api/p/vault/vars/OLD", `{"to":"NEW","description":"d","machines":["m1","m2"]}`)
	if code != 200 || out["name"] != "NEW" || out["description"] != "d" {
		t.Fatalf("rename %d %v", code, out)
	}
	_, out = c.do("GET", "/api/p/vault", "")
	var names []string
	for _, v := range out["variables"].([]any) {
		names = append(names, v.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "NEW,TAKEN" {
		t.Errorf("variables %v", names)
	}
	if _, out := c.do("POST", "/api/p/vault/vars/NEW/reveal", ""); out["value"] != "v1" {
		t.Errorf("value after the rename %v", out)
	}
	if !strings.Contains(h.auditLog(), `vault.saved {"from":"OLD","inject_only":false,"machines":["m1","m2"],"name":"NEW","value_changed":false}`) {
		t.Errorf("audit %s", h.auditLog())
	}
}

// accounted is how many calls with result the audit log stands for: each
// vault.access record, plus those it says it skipped.
func accounted(h *fakeHost, result string) (records, calls int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, a := range h.audits {
		ev, body, _ := strings.Cut(a, " ")
		var f map[string]any
		if ev != "vault.access" || json.Unmarshal([]byte(body), &f) != nil || f["result"] != result {
			continue
		}
		records++
		calls++
		if n, ok := f["suppressed"].(float64); ok {
			calls += int(n)
		}
	}
	return records, calls
}

// Refusals a program can repeat at will are coalesced in the log and
// written to the audit log once a while, the end of a burst included (when
// the while is over), and make no page reload; calls that let a value out
// are each recorded and make the pages reload at most once a while, the
// last one included.
func TestRefusalsAreCoalesced(t *testing.T) {
	p, h, s := newTest(t)
	p.noisyEvery = 200 * time.Millisecond
	p.changedEvery = 300 * time.Millisecond
	inject := true
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	s.Set("INJ", vaultstore.Update{Value: str("w"), Machines: &[]string{"m1"}, InjectOnly: &inject})
	ctx := context.Background()
	before := h.messageCount("changed")
	for _, c := range []struct {
		req    agentproto.VaultRequest
		result string
	}{
		{agentproto.VaultRequest{Tool: "get", Names: []string{"NOPE"}}, "not_found"},
		{agentproto.VaultRequest{Tool: "get", Names: []string{"INJ"}}, "inject_only"},
		{agentproto.VaultRequest{Tool: "get", Names: []string{"A", "B"}}, "bad_request"},
	} {
		start := time.Now()
		for i := 0; i < 10; i++ {
			if r := p.Handle(ctx, h, "m1", c.req); r.Code != c.result {
				t.Fatalf("%+v: %+v", c.req, r)
			}
		}
		fast := time.Since(start) < p.noisyEvery
		if l := p.Log(); l[0].Result != c.result || (fast && l[0].Count != 10) {
			t.Errorf("log %+v", l[0])
		}
		if records, _ := accounted(h, c.result); fast && records != 1 {
			t.Errorf("%s: %d audit records at once", c.result, records)
		}
	}
	// The ends of the bursts are written once the while is over: every
	// call is accounted for.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		_, nf := accounted(h, "not_found")
		_, io := accounted(h, "inject_only")
		_, br := accounted(h, "bad_request")
		if nf == 10 && io == 10 && br == 10 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("calls written: not_found %d, inject_only %d, bad_request %d\n%s", nf, io, br, h.auditLog())
		}
	}
	s.Lock()
	for i := 0; i < 3; i++ {
		p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}})
	}
	if l := p.Log(); l[0].Result != "vault_locked" || l[0].Count != 3 {
		t.Errorf("locked %+v", l[0])
	}
	if h.messageCount("changed") != before {
		t.Errorf("refusals made the pages reload %d times", h.messageCount("changed")-before)
	}
	if err := s.Unlock(pass); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	for i := 0; i < 5; i++ {
		if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK {
			t.Fatalf("allowed %+v", r)
		}
	}
	fast := time.Since(start) < p.changedEvery
	if records, _ := accounted(h, "allowed"); records != 5 {
		t.Errorf("allowed calls audited %d", records)
	}
	if n := h.messageCount("changed") - before; fast && n != 1 {
		t.Errorf("reloads at once %d", n)
	}
	time.Sleep(2 * p.changedEvery)
	if n := h.messageCount("changed") - before; n < 2 || (fast && n != 2) {
		t.Errorf("reloads %d", n)
	}
}

// A lock asked for while a passphrase is checked, or a new one set, comes
// after the check and its session: the vault ends locked with no session
// open, never unlocked without one (the lock undone) or locked with one.
func TestLockDuringAPassphraseCheck(t *testing.T) {
	p, h, s := newTest(t)
	c := newClient(p, h)
	consistent := func(what string) {
		t.Helper()
		p.mu.Lock()
		open := len(p.sessions)
		p.mu.Unlock()
		if locked := s.Status().Locked; locked != (open == 0) {
			t.Errorf("%s: locked %v with %d sessions", what, locked, open)
		}
	}
	var lockDone chan struct{}
	lockInside := func() {
		lockDone = make(chan struct{})
		go func() {
			c.do("POST", "/api/p/vault/lock", "")
			close(lockDone)
		}()
		select {
		case <-lockDone:
		case <-time.After(50 * time.Millisecond): // it waits for the check
		}
	}
	c.do("POST", "/api/p/vault/lock", "")
	p.keyStep = lockInside
	code, _ := c.do("POST", "/api/p/vault/session", mustJSON(map[string]string{"passphrase": pass}))
	p.keyStep = nil
	<-lockDone
	if code != 200 {
		t.Errorf("session %d", code)
	}
	consistent("unlock")
	if !s.Status().Locked {
		t.Error("the lock asked for during the check was undone")
	}

	c.session(t)
	p.keyStep = lockInside
	code, _ = c.do("POST", "/api/p/vault/passphrase", `{"old":"correct horse","passphrase":"battery staple"}`)
	p.keyStep = nil
	<-lockDone
	if code != 200 {
		t.Errorf("change %d", code)
	}
	consistent("change")
	if !s.Status().Locked {
		t.Error("the lock asked for during the change was undone")
	}

	// Any order of an unlock and a lock ends consistent.
	for i := 0; i < 20; i++ {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			c.do("POST", "/api/p/vault/session", `{"passphrase":"battery staple"}`)
		}()
		go func() {
			defer wg.Done()
			time.Sleep(time.Duration(i%5) * time.Millisecond)
			c.do("POST", "/api/p/vault/lock", "")
		}()
		wg.Wait()
		consistent("race " + strconv.Itoa(i))
	}
}

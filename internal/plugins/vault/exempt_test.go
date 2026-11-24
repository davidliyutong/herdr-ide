package vault

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"veldr/internal/agentproto"
	vaultstore "veldr/internal/vault"
)

// An exempt app's requests on its machine read without asking while the
// vault is unlocked, recorded as exempted; the app is the name the
// machine's agent saw for the process that started the one that asked,
// never what the request says; exempting takes a session the passphrase
// opened, and a removed machine, a lock or a new passphrase each end what
// they should.
func TestExemptApps(t *testing.T) {
	p, h, s := newTest(t)
	p.Timeout = 5 * time.Second
	withMachines(h, "mac")
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	s.Set("INJ", vaultstore.Update{Value: str("i"), InjectOnly: boolp(true)})
	c := newClient(p, h)
	if code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":["m1"]}`); code != 401 || out["error"] != "vault_session" {
		t.Fatalf("without a session: %d %v", code, out)
	}
	c.session(t)
	for bad, code := range map[string]string{
		`{"app":""}`: "invalid", `{"app":" claude"}`: "invalid", `{"app":"cl\u0007ude"}`: "invalid",
		// Longer than the kernels keep a process's name: it would never
		// match, or match every name it begins.
		`{"app":"claude-code-cli-x"}`: "app_too_long",
		// Shells and interpreters run any script.
		`{"app":"sh"}`: "app_generic", `{"app":"bash"}`: "app_generic", `{"app":"node"}`: "app_generic",
		`{"app":"python3.12"}`: "app_generic", `{"app":"env"}`: "app_generic",
	} {
		body := strings.Replace(bad, "}", `,"machines":["m1"],"passphrase":"`+pass+`"}`, 1)
		if got, out := c.do("POST", "/api/p/vault/exempt", body); got != 400 || out["error"] != code {
			t.Errorf("%s: %d %v", bad, got, out)
		}
	}
	if code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":[]}`); code != 400 || out["error"] != "bad_request" {
		t.Errorf("no machines: %d %v", code, out)
	}
	for _, bad := range []string{`{"app":"claude","machines":["*"]}`, `{"app":"claude","machines":["nope"]}`} {
		if code, out := c.do("POST", "/api/p/vault/exempt", bad); code != 400 || out["error"] != "unknown_machine" {
			t.Errorf("%s: %d %v", bad, code, out)
		}
	}
	// A session, the passphrase's included, is not enough: the passphrase
	// comes with the request, as it does to add an authenticator.
	if code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":["m1"]}`); code != 403 || out["error"] != "passphrase_required" {
		t.Errorf("a session alone: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":["m1"],"passphrase":"wrong horse"}`); code != 403 || out["error"] != "wrong_passphrase" {
		t.Errorf("a wrong passphrase: %d %v", code, out)
	}
	p.tried(true, false)
	if g, _ := s.Guard(); len(g.Exempt) != 0 || !strings.Contains(h.auditLog(), "denied.passphrase_required") {
		t.Fatalf("exempted without the passphrase: %+v, audit %s", g.Exempt, h.auditLog())
	}
	exempt := func() []any {
		t.Helper()
		code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":["m1"],"passphrase":"`+pass+`"}`)
		if code != 200 {
			t.Fatalf("exempt %d %v", code, out)
		}
		return out["guard"].(map[string]any)["exempt"].([]any)
	}
	exempt()
	if list := exempt(); len(list) != 1 || list[0].(map[string]any)["machine"] != "m1" || list[0].(map[string]any)["app"] != "claude" {
		t.Fatalf("exemptions %v", list)
	}
	if b, _ := os.ReadFile(p.Path); strings.Contains(string(b), "claude") {
		t.Errorf("the file names the app: %s", b)
	}

	ctx := context.Background()
	by := func(app string) []agentproto.VaultProcess {
		return []agentproto.VaultProcess{{Pid: 7, Name: "veldr-mcp"}, {Pid: 6, Name: app}, {Pid: 5, Name: "zsh"}}
	}
	// It reads without a prompt, and the release is recorded with who asked.
	r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: by("claude")})
	if !r.OK || r.Values["KEY"] != "v" || len(p.Pending()) != 0 {
		t.Fatalf("exempt get %+v", r)
	}
	if l := p.Log(); l[0].Result != ResultExempted || len(l[0].Process) != 3 || l[0].Process[1].Name != "claude" {
		t.Errorf("log %+v", l[0])
	}
	if !strings.Contains(h.auditLog(), `"result":"exempted"`) {
		t.Errorf("audit %s", h.auditLog())
	}
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "list", Process: by("claude")}); r.Variables[0].Approval || r.Variables[1].Approval {
		t.Errorf("list %+v", r.Variables)
	}
	// Inject-only stays so.
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"INJ"}, Process: by("claude")}); r.Code != "inject_only" {
		t.Errorf("inject-only get %+v", r)
	}
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "env", Names: []string{"INJ", "KEY"}, Process: by("claude")}); !r.OK || r.Values["INJ"] != "i" {
		t.Errorf("env %+v", r)
	}
	// Another app, one that only says it is the app, the app on another
	// machine, or a process the app started that asks itself: each asks.
	asks := func(what, m string, req agentproto.VaultRequest) {
		t.Helper()
		ch := make(chan agentproto.VaultResponse, 1)
		go func() { ch <- p.Handle(ctx, h, m, req) }()
		got := (<-h.sent)["request"].(*Request)
		p.answerRequest(got.ID, AnswerDeny)
		if r := <-ch; r.Code != "denied" {
			t.Errorf("%s: %+v", what, r)
		}
	}
	asks("another app", "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: by("codex")})
	asks("a request that names the app", "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Client: "claude", Process: by("codex")})
	asks("the app on another machine", "local", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: by("claude")})
	asks("the app's own process", "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: []agentproto.VaultProcess{{Pid: 6, Name: "claude"}, {Pid: 5, Name: "zsh"}}})
	// A locked vault gives nothing.
	c.do("POST", "/api/p/vault/lock", "")
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: by("claude")}); r.Code != "vault_locked" {
		t.Errorf("locked %+v", r)
	}
	c.session(t)
	// Ended, it asks again.
	_, out := c.do("GET", "/api/p/vault", "")
	id := out["guard"].(map[string]any)["exempt"].([]any)[0].(map[string]any)["id"].(string)
	if code, out := c.do("DELETE", "/api/p/vault/exempt/"+id, ""); code != 200 || len(out["guard"].(map[string]any)["exempt"].([]any)) != 0 {
		t.Fatalf("delete %d %v", code, out)
	}
	if code, _ := c.do("DELETE", "/api/p/vault/exempt/"+id, ""); code != 404 {
		t.Errorf("delete again %d", code)
	}
	asks("an exemption ended", "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: by("claude")})

	// A removed machine's exemptions go, at once or, while the key is not
	// held, at the next unlock, also when the machine comes back.
	exempt()
	p.ForgetMachine(h, "m1")
	if s.Exempt("m1", "claude") {
		t.Error("exempt on a removed machine")
	}
	exempt()
	c.do("POST", "/api/p/vault/lock", `{"forget":true}`)
	p.ForgetMachine(h, "m1")
	c.session(t)
	if g, _ := s.Guard(); len(g.Exempt) != 0 || s.Exempt("m1", "claude") {
		t.Errorf("after the unlock: %+v", g.Exempt)
	}
	// A new passphrase ends them.
	exempt()
	if code, _ := c.do("POST", "/api/p/vault/passphrase", mustJSON(map[string]string{"old": pass, "passphrase": "another horse"})); code != 200 {
		t.Fatal(code)
	}
	if g, _ := s.Guard(); len(g.Exempt) != 0 {
		t.Errorf("after a new passphrase: %+v", g.Exempt)
	}
}

// Where every Allow is verified, a program driving the page's session of
// the passphrase cannot exempt an app to read without asking: what the
// review's probe did (reveal refused, exempt taken) is refused alike.
func TestExemptingTakesThePassphraseWhereEveryAllowIsVerified(t *testing.T) {
	p, h, _ := newTest(t)
	withMachines(h, "mac")
	c := newClient(p, h)
	c.session(t)
	if code, _ := c.do("PUT", "/api/p/vault/vars/KEY", `{"value":"s3cret"}`); code != 200 {
		t.Fatal(code)
	}
	if code, _ := c.do("POST", "/api/p/vault/guard", `{"verifyEachAllow":true}`); code != 200 {
		t.Fatal(code)
	}
	if code, out := c.do("POST", "/api/p/vault/vars/KEY/reveal", ""); code != 401 || out["error"] != "vault_proof" {
		t.Fatalf("a reveal with the session: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/exempt", `{"app":"claude","machines":["local"]}`); code != 403 || out["error"] != "passphrase_required" {
		t.Fatalf("an exemption with the session: %d %v", code, out)
	}
	chain := []agentproto.VaultProcess{{Pid: 7, Name: "veldr-mcp"}, {Pid: 6, Name: "claude"}}
	ch := make(chan agentproto.VaultResponse, 1)
	go func() {
		ch <- p.Handle(context.Background(), h, "local", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}, Process: chain})
	}()
	req := (<-h.sent)["request"].(*Request)
	p.answerRequest(req.ID, AnswerDeny)
	if r := <-ch; r.OK {
		t.Fatalf("read without asking: %+v", r)
	}
}

// The app of a request is the name of the process that started the one
// that asked, whole: a name longer than an exempted app can be (macOS
// keeps 16 bytes) is no app, rather than the 15-byte start that every
// such name shares.
func TestAppOf(t *testing.T) {
	chain := func(names ...string) []agentproto.VaultProcess {
		ps := make([]agentproto.VaultProcess, len(names))
		for i, n := range names {
			ps[i] = agentproto.VaultProcess{Pid: 100 + i, Name: n}
		}
		return ps
	}
	for _, c := range []struct {
		ps   []agentproto.VaultProcess
		want string
	}{
		{chain("herdr-mcp", "claude", "zsh"), "claude"},
		{chain("herdr-mcp", "abcdefghijklmno"), "abcdefghijklmno"},
		{chain("herdr-mcp", "abcdefghijklmnop"), ""},
		{chain("herdr-mcp"), ""},
		{nil, ""},
	} {
		if got := appOf(c.ps); got != c.want {
			t.Errorf("appOf(%v) = %q, want %q", c.ps, got, c.want)
		}
	}
}

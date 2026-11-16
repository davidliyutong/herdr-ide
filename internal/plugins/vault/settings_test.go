package vault

import (
	"context"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/settings"
	vaultstore "herdr-ide/internal/vault"
)

// withSettings gives the host the vault's settings with values.
func withSettings(t *testing.T, h *fakeHost, values map[string]float64) {
	t.Helper()
	h.st = settings.New("", Settings)
	for k, v := range values {
		if err := h.st.Set(k, "", v); err != nil {
			t.Fatalf("%s: %v", k, err)
		}
	}
}

// The settings' defaults are the values the vault had before them, within
// their bounds; values out of bounds are refused.
func TestSettingsDefs(t *testing.T) {
	st := settings.New("", Settings)
	want := map[string]float64{
		SettingApprovalTimeout: 60, SettingAutoLock: 60, SettingSessionIdle: 30, SettingSessionMax: 12,
		SettingRunTimeout: 120, SettingRunMaxTimeout: 600, SettingRunOutput: 64,
	}
	for k, v := range want {
		d, ok := st.Lookup(k)
		if !ok || d.Section != ID || st.GetFor(k, "") != v || *d.Min > v || *d.Max < v || !d.Integer || d.Scope != settings.ScopeApp {
			t.Errorf("%s: %+v = %v", k, d, st.GetFor(k, ""))
		}
	}
	if len(Settings.Defs) != len(want) {
		t.Errorf("%d settings", len(Settings.Defs))
	}
	// The section is the plugin's page in Settings.
	if secs := st.Sections(); len(secs) != 1 || secs[0].ID != ID || secs[0].Plugin != ID {
		t.Errorf("sections %+v", secs)
	}
	for k, v := range map[string]float64{SettingApprovalTimeout: 5, SettingAutoLock: -1, SettingSessionMax: 25, SettingRunOutput: 2048, SettingSessionIdle: 1.5} {
		if err := st.Set(k, "", v); err == nil {
			t.Errorf("%s = %v taken", k, v)
		}
	}
	// Without settings (or out of their bounds) the defaults hold.
	h := &fakeHost{}
	p := &Plugin{}
	if p.timeout(h) != DefaultTimeout || p.autoLockAfter(h) != time.Hour {
		t.Error("defaults without settings")
	}
	if idle, most := p.sessionLimits(h); idle != SessionIdle || most != SessionMax {
		t.Errorf("sessions %v %v", idle, most)
	}
	if r := runLimits(h); *r != (agentproto.VaultRun{Timeout: 120, MaxTimeout: 600, MaxOutput: 64 << 10}) {
		t.Errorf("run %+v", r)
	}
}

// vault.approvalTimeout is how long a request waits.
func TestApprovalTimeoutSetting(t *testing.T) {
	p, h, s := newTest(t)
	p.Timeout = 0
	withSettings(t, h, map[string]float64{SettingApprovalTimeout: 10})
	s.Set("KEY", vaultstore.Update{Value: str("v")})
	done := make(chan struct{})
	go func() {
		p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}})
		close(done)
	}()
	req := (<-h.sent)["request"].(*Request)
	if d := req.Expires.Sub(req.Created); d != 10*time.Second {
		t.Errorf("waits %v", d)
	}
	p.answerRequest(req.ID, AnswerDeny)
	<-done // it writes the access log, in the test's directory
}

// vault.sessionIdle and vault.sessionMax end a page's session, and the
// list says how long one lasts unused.
func TestSessionSettings(t *testing.T) {
	p, h, _ := newTest(t)
	withSettings(t, h, map[string]float64{SettingSessionIdle: 2, SettingSessionMax: 1})
	now := time.Now()
	p.now = func() time.Time { return now }
	c := newClient(p, h)
	c.session(t)
	if _, out := c.do("GET", "/api/p/vault", ""); out["idle"] != 120.0 {
		t.Errorf("idle %v", out["idle"])
	}
	now = now.Add(2*time.Minute + time.Second)
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("idle 2 min: %d", code)
	}
	c.session(t)
	for i := 0; i < 50; i++ {
		now = now.Add(time.Minute + 30*time.Second)
		if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code == 401 {
			if elapsed := time.Duration(i+1) * 90 * time.Second; elapsed <= time.Hour {
				t.Errorf("ended after %v", elapsed)
			}
			return
		}
	}
	t.Error("a session outlived vault.sessionMax")
}

// With vault.autoLock, the vault locks once unused for that long (every
// session ends, audited); uses keep it unlocked; 0 never locks it.
func TestAutoLock(t *testing.T) {
	p, h, s := newTest(t)
	p.lockAfter, p.lockCheck = 150*time.Millisecond, 20*time.Millisecond
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	c := newClient(p, h)
	c.session(t)
	// Values read by a machine are uses.
	for i := 0; i < 6; i++ {
		time.Sleep(50 * time.Millisecond)
		if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK {
			t.Fatalf("locked while used: %+v", r)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for !s.Status().Locked {
		if time.Now().After(deadline) {
			t.Fatal("not locked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("a session outlived the lock: %d", code)
	}
	if !strings.Contains(h.auditLog(), `vault.locked {"minutes":0.0025,"reason":"idle"}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	if h.messageCount("changed") == 0 {
		t.Error("pages not told")
	}

	// 0: never.
	p.lockAfter = 0
	withSettings(t, h, map[string]float64{SettingAutoLock: 0})
	c.session(t)
	time.Sleep(200 * time.Millisecond)
	if s.Status().Locked {
		t.Error("locked with vault.autoLock 0")
	}
}

// run_with_env's limits go with an env's values, as the settings say.
func TestRunLimitsGoWithEnv(t *testing.T) {
	p, h, s := newTest(t)
	withSettings(t, h, map[string]float64{SettingRunTimeout: 30, SettingRunMaxTimeout: 90, SettingRunOutput: 8})
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	ctx := context.Background()
	r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "env", Names: []string{"KEY"}})
	if !r.OK || r.Run == nil || *r.Run != (agentproto.VaultRun{Timeout: 30, MaxTimeout: 90, MaxOutput: 8 << 10}) {
		t.Errorf("env %+v", r)
	}
	if r := p.Handle(ctx, h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK || r.Run != nil {
		t.Errorf("get %+v", r)
	}
}

// A page sets the auto-lock's time for this unlock (presets, a time of its
// own, never), behind the gate; the list says when the vault locks; the
// vault locks at that time; the next unlock follows the setting again.
func TestAutoLockSetByPage(t *testing.T) {
	p, h, s := newTest(t)
	p.lockCheck = 20 * time.Millisecond
	c := newClient(p, h)
	_, out := c.do("GET", "/api/p/vault", "")
	if al := out["autoLock"].(map[string]any); al["after"] != 3600.0 || al["custom"] != false || al["lockAt"] != nil {
		t.Fatalf("locked: %v", al)
	}
	if code, _ := c.do("POST", "/api/p/vault/autolock", `{"minutes":5}`); code != 401 {
		t.Fatalf("without a session: %d", code)
	}
	c.session(t)
	_, out = c.do("GET", "/api/p/vault", "")
	at, _ := time.Parse(time.RFC3339, out["autoLock"].(map[string]any)["lockAt"].(string))
	if d := time.Until(at); d < 59*time.Minute || d > time.Hour+time.Second {
		t.Fatalf("locks in %v", d)
	}
	for _, bad := range []string{`{"minutes":-1}`, `{"minutes":1441}`, `{"minutes":1.5}`, `{`} {
		if code, _ := c.do("POST", "/api/p/vault/autolock", bad); code != 400 {
			t.Errorf("%s: %d", bad, code)
		}
	}
	code, al := c.do("POST", "/api/p/vault/autolock", `{"minutes":0}`)
	if code != 200 || al["after"] != 0.0 || al["custom"] != true || al["lockAt"] != nil {
		t.Fatalf("never: %d %v", code, al)
	}
	if code, al = c.do("POST", "/api/p/vault/autolock", `{"minutes":null}`); al["after"] != 3600.0 || al["custom"] != false || al["setting"] != 3600.0 {
		t.Fatalf("back to the setting: %d %v", code, al)
	}
	if h.messageCount("changed") == 0 {
		t.Error("pages not told")
	}
	// A time of its own: the vault locks then, and forgets it.
	if code, al = c.do("POST", "/api/p/vault/autolock", `{"minutes":1}`); al["after"] != 60.0 || al["custom"] != true {
		t.Fatalf("a minute: %d %v", code, al)
	}
	p.mu.Lock()
	p.lockFor = 100 * time.Millisecond // a minute is long for a test
	p.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for !s.Status().Locked {
		if time.Now().After(deadline) {
			t.Fatal("not locked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if p.autoLockAfter(h) != time.Hour {
		t.Errorf("after the lock: %v", p.autoLockAfter(h))
	}
	if !strings.Contains(h.auditLog(), `"reason":"idle"`) {
		t.Errorf("audit %s", h.auditLog())
	}
}

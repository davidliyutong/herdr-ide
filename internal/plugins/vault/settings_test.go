package vault

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/settings"
	vaultstore "veldr/internal/vault"
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
		SettingApprovalTimeout: 60, SettingAutoLock: 60, SettingPassphraseDays: 14, SettingSessionIdle: 30, SettingSessionMax: 12,
		SettingRunTimeout: 120, SettingRunMaxTimeout: 600, SettingRunOutput: 64,
	}
	for k, v := range want {
		d, ok := st.Lookup(k)
		if !ok || d.Section != ID || st.GetFor(k, "") != v || *d.Min > v || *d.Max < v || !d.Integer || d.Scope != settings.ScopeApp {
			t.Errorf("%s: %+v = %v", k, d, st.GetFor(k, ""))
		}
	}
	if d, _ := st.Lookup(SettingPassphraseDays); *d.Min != 1 || *d.Max != 90 || d.Order != 25 {
		t.Errorf("passphrase days %+v", d)
	}
	if len(Settings.Defs) != len(want) {
		t.Errorf("%d settings", len(Settings.Defs))
	}
	// The section is the plugin's page in Settings.
	if secs := st.Sections(); len(secs) != 1 || secs[0].ID != ID || secs[0].Plugin != ID {
		t.Errorf("sections %+v", secs)
	}
	for _, kv := range []struct {
		k string
		v float64
	}{
		{SettingApprovalTimeout, 5}, {SettingAutoLock, -1}, {SettingSessionMax, 25}, {SettingRunOutput, 2048}, {SettingSessionIdle, 1.5},
		{SettingPassphraseDays, 0}, {SettingPassphraseDays, MaxPassphraseDays + 1}, {SettingPassphraseDays, 1.5},
	} {
		if err := st.Set(kv.k, "", kv.v); err == nil {
			t.Errorf("%s = %v taken", kv.k, kv.v)
		}
	}
	// Without settings (or out of their bounds) the defaults hold.
	h := &fakeHost{}
	p := &Plugin{}
	if p.timeout(h) != DefaultTimeout || p.autoLockAfter(h) != time.Hour || p.passphraseDays(h) != 14 {
		t.Error("defaults without settings")
	}
	if w := p.window(h, time.Minute); w != (vaultstore.Window{Days: 14, AutoLock: time.Minute}) {
		t.Errorf("window %+v", w)
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

// testClock is the plugin's clock in tests, moved by hand; the timer's
// looks are made by the test (autoLock), not by time passing.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// withClock gives p a clock of the test's: its timer looks only once an
// hour of real time, so what the test sees comes from the looks it makes.
func withClock(t *testing.T, p *Plugin) *testClock {
	t.Helper()
	c := &testClock{t: time.Now()}
	p.now, p.lockCheck = c.now, time.Hour
	t.Cleanup(func() {
		p.mu.Lock()
		if p.lockTimer != nil {
			p.lockTimer.Stop()
		}
		p.mu.Unlock()
	})
	return c
}

// With vault.autoLock, the vault locks once unused for that long (every
// session ends, audited) and forgets its key; uses keep it unlocked; 0
// never locks it.
func TestAutoLock(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	p.lockAfter = 10 * time.Minute
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	c.register(t, newAuthenticator(t)) // an authenticator changes nothing
	// Values read by a machine are uses.
	for i := 0; i < 6; i++ {
		clk.add(5 * time.Minute)
		p.autoLock(h)
		if r := p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "get", Names: []string{"KEY"}}); !r.OK {
			t.Fatalf("locked while used: %+v", r)
		}
	}
	// Lists are not.
	clk.add(10*time.Minute - time.Second)
	p.Handle(context.Background(), h, "m1", agentproto.VaultRequest{Tool: "list"})
	p.autoLock(h)
	if s.Status().Locked {
		t.Fatal("locked before its time")
	}
	clk.add(time.Second)
	p.autoLock(h)
	if _, err := s.Guard(); !s.Status().Locked || !errors.Is(err, vaultstore.ErrLocked) {
		t.Fatalf("not locked, or the key kept: %v", err)
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("a session outlived the lock: %d", code)
	}
	if !strings.Contains(h.auditLog(), `vault.locked {"minutes":10,"reason":"idle"}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	if h.messageCount("changed") == 0 {
		t.Error("pages not told")
	}
	// A locked vault needs no timer.
	p.mu.Lock()
	timer := p.lockTimer
	p.mu.Unlock()
	if timer != nil {
		t.Error("a timer runs for a locked vault")
	}

	// 0: never, for as long as it lasts.
	p.lockAfter = 0
	withSettings(t, h, map[string]float64{SettingAutoLock: 0})
	c.session(t)
	clk.add(30 * 24 * time.Hour)
	p.autoLock(h)
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

// A setting changed while the vault is unlocked shortens the time before it
// locks but does not lengthen it: settings are changed without the gate, so
// a longer time, or never, counts from the next unlock with the passphrase.
func TestAutoLockSettingDoesNotLengthenAnUnlock(t *testing.T) {
	p, h, s := newTest(t)
	h.st = settings.New("", Settings)
	c := newClient(p, h)
	set := func(minutes float64) {
		t.Helper()
		if err := h.st.Set(SettingAutoLock, "", minutes); err != nil {
			t.Fatal(err)
		}
	}
	set(30)
	c.do("POST", "/api/p/vault/lock", "")
	c.session(t) // unlocks
	if got := p.autoLockAfter(h); got != 30*time.Minute {
		t.Fatalf("after the unlock: %v", got)
	}
	set(0) // never
	if got := p.autoLockAfter(h); got != 30*time.Minute {
		t.Errorf("never, set while unlocked: %v", got)
	}
	set(600)
	if got := p.autoLockAfter(h); got != 30*time.Minute {
		t.Errorf("a longer time, set while unlocked: %v", got)
	}
	set(5)
	if got := p.autoLockAfter(h); got != 5*time.Minute {
		t.Errorf("a shorter time: %v", got)
	}
	// The next unlock takes the setting as it is then.
	set(0)
	c.do("POST", "/api/p/vault/lock", "")
	c.session(t)
	if got := p.autoLockAfter(h); got != 0 || s.Status().Locked {
		t.Errorf("never, at the next unlock: %v", got)
	}
}

// The auto-lock follows the setting only: the list says when the vault
// locks (to a session), the vault locks then, and no page sets another
// time for an unlock (POST autolock is gone).
func TestAutoLockFollowsTheSetting(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	withSettings(t, h, map[string]float64{SettingAutoLock: 20})
	c := newClient(p, h)
	c.do("POST", "/api/p/vault/lock", "")
	_, out := c.do("GET", "/api/p/vault", "")
	if al := out["autoLock"].(map[string]any); al["after"] != 1200.0 || al["setting"] != 1200.0 || al["lockAt"] != nil || len(al) != 2 {
		t.Fatalf("locked: %v", al)
	}
	c.session(t)
	_, out = c.do("GET", "/api/p/vault", "")
	at, _ := time.Parse(time.RFC3339, out["autoLock"].(map[string]any)["lockAt"].(string))
	if d := at.Sub(clk.now()); d <= 19*time.Minute || d > 20*time.Minute {
		t.Fatalf("locks in %v", d)
	}
	if code, _ := c.do("POST", "/api/p/vault/autolock", `{"minutes":0,"passphrase":"`+pass+`"}`); code != 404 && code != 405 {
		t.Errorf("POST autolock: %d", code)
	}
	clk.add(20*time.Minute - time.Second)
	p.autoLock(h)
	if s.Status().Locked {
		t.Fatal("locked before its time")
	}
	clk.add(time.Second)
	p.autoLock(h)
	if !s.Status().Locked {
		t.Fatal("not locked at its time")
	}
}

// Sessions and the automatic lock count the computer's sleep: asleep past
// them (the monotonic clock stopped, the wall clock went on), the first
// request after it wakes finds its session ended and the timer's look
// locks the vault; a wall clock set back lengthens nothing, the monotonic
// clock having gone on.
func TestTimeLimitsCountSleep(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	p.lockAfter = 10 * time.Minute
	var mu sync.Mutex
	var mono time.Duration
	p.mono = func() time.Duration {
		mu.Lock()
		defer mu.Unlock()
		return mono
	}
	awake := func(d time.Duration) {
		mu.Lock()
		mono += d
		mu.Unlock()
		clk.add(d)
	}
	c := newClient(p, h)
	c.session(t)
	awake(time.Minute)
	clk.add(SessionIdle + time.Minute) // asleep
	if code, out := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 || out["error"] != "vault_session" {
		t.Errorf("a session outlived its idle time asleep: %d %v", code, out)
	}
	// The timer's look, late after a sleep, judges by the wall clock too.
	p.autoLock(h)
	if !s.Status().Locked {
		t.Error("the timer kept the vault unlocked past its time asleep")
	}
	// A wall clock set back does not lengthen it.
	c.session(t)
	clk.add(-48 * time.Hour)
	awake(10 * time.Minute)
	p.autoLock(h)
	if !s.Status().Locked {
		t.Error("a wall clock set back lengthened the auto-lock")
	}
}

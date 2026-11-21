package vault

import (
	"context"
	"strings"
	"sync"
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
		SettingApprovalTimeout: 60, SettingAutoLock: 60, SettingPassphraseHours: 24, SettingSessionIdle: 30, SettingSessionMax: 12,
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
	for _, kv := range []struct {
		k string
		v float64
	}{
		{SettingApprovalTimeout, 5}, {SettingAutoLock, -1}, {SettingSessionMax, 25}, {SettingRunOutput, 2048}, {SettingSessionIdle, 1.5},
		{SettingPassphraseHours, 0}, {SettingPassphraseHours, MaxPassphraseHours + 1},
	} {
		if err := st.Set(kv.k, "", kv.v); err == nil {
			t.Errorf("%s = %v taken", kv.k, kv.v)
		}
	}
	// Without settings (or out of their bounds) the defaults hold.
	h := &fakeHost{}
	p := &Plugin{}
	if p.timeout(h) != DefaultTimeout || p.autoLockAfter(h) != time.Hour || p.passphraseFor(h) != 24*time.Hour {
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
// session ends, audited); uses keep it unlocked; without an authenticator
// the lock forgets the key; 0 never locks it, but the key's hold still
// ends.
func TestAutoLock(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	p.lockAfter = 10 * time.Minute
	s.Set("KEY", vaultstore.Update{Value: str("v"), Machines: &[]string{"m1"}})
	c := newClient(p, h)
	c.session(t)
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
	if !s.Status().Locked || s.Held() {
		t.Fatalf("not locked, or the key kept without an authenticator: held %v", s.Held())
	}
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("a session outlived the lock: %d", code)
	}
	if !strings.Contains(h.auditLog(), `vault.locked {"keyHeld":false,"minutes":10,"reason":"idle"}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	if h.messageCount("changed") == 0 {
		t.Error("pages not told")
	}

	// 0: never; the key is still forgotten at the end of its hold.
	p.lockAfter = 0
	withSettings(t, h, map[string]float64{SettingAutoLock: 0})
	c.session(t)
	clk.add(24*time.Hour - time.Minute)
	p.autoLock(h)
	if s.Status().Locked {
		t.Error("locked with vault.autoLock 0")
	}
	clk.add(time.Minute)
	p.autoLock(h)
	if s.Held() || !strings.Contains(h.auditLog(), `"reason":"passphrase"`) {
		t.Errorf("the key outlived its hold: %s", h.auditLog())
	}
}

// With an authenticator the automatic lock keeps the key: the vault is
// locked until a proof or the passphrase unlocks it, and the timer still
// ends the hold.
func TestAutoLockKeepsTheKeyForAProof(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	p.lockAfter = 10 * time.Minute
	c := newClient(p, h)
	c.origin = testOrigin
	c.session(t)
	c.register(t, newAuthenticator(t))
	clk.add(10 * time.Minute)
	p.autoLock(h)
	if !s.Status().Locked || !s.Held() {
		t.Fatalf("locked %v, held %v", s.Status().Locked, s.Held())
	}
	if !strings.Contains(h.auditLog(), `vault.locked {"keyHeld":true,"minutes":10,"reason":"idle"}`) {
		t.Errorf("audit %s", h.auditLog())
	}
	// When the key goes is a session's to see.
	_, list := c.do("GET", "/api/p/vault", "")
	if al := list["autoLock"].(map[string]any); al["keyUntil"] != nil || al["lockAt"] != nil {
		t.Errorf("auto-lock without a session %v", al)
	}
	// The passphrase unlocks it as well, and begins the hold again.
	clk.add(23 * time.Hour)
	c.session(t)
	if s.Status().Locked {
		t.Fatal("the passphrase did not unlock it")
	}
	_, list = c.do("GET", "/api/p/vault", "")
	al := list["autoLock"].(map[string]any)
	until, _ := time.Parse(time.RFC3339, al["keyUntil"].(string))
	if d := until.Sub(clk.now()); al["lockAt"] == nil || d <= 24*time.Hour-time.Second || d > 24*time.Hour {
		t.Errorf("auto-lock %v", al)
	}
	clk.add(2 * time.Hour)
	p.autoLock(h) // locks it again, idle
	p.autoLock(h)
	if !s.Held() {
		t.Error("the hold did not begin again with the passphrase")
	}
	clk.add(22 * time.Hour)
	p.autoLock(h)
	if s.Held() {
		t.Error("the key outlived its hold while locked")
	}
}

// vault.passphraseHours bounds the key's hold; a change while the core
// holds the key shortens the hold but does not lengthen it, since settings
// are changed without the gate.
func TestPassphraseHoldSettingDoesNotLengthenIt(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	h.st = settings.New("", Settings)
	set := func(hours float64) {
		t.Helper()
		if err := h.st.Set(SettingPassphraseHours, "", hours); err != nil {
			t.Fatal(err)
		}
	}
	c := newClient(p, h)
	set(2)
	c.session(t)
	set(100)
	if got := p.passphraseFor(h); got != 2*time.Hour {
		t.Errorf("a longer hold, set while held: %v", got)
	}
	set(1)
	if got := p.passphraseFor(h); got != time.Hour {
		t.Errorf("a shorter hold: %v", got)
	}
	clk.add(time.Hour)
	if _, list := c.do("GET", "/api/p/vault", ""); s.Held() || list["status"].(map[string]any)["locked"] != true {
		t.Fatalf("held past the shorter hold: %v", list["status"])
	}
	// The next passphrase takes the setting as it is then.
	set(100)
	c.session(t)
	if got := p.passphraseFor(h); got != 100*time.Hour {
		t.Errorf("at the next passphrase: %v", got)
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
	// A page's own time, through the gate and with the passphrase again, is
	// not capped.
	if code, _ := c.do("POST", "/api/p/vault/autolock", `{"minutes":0,"passphrase":"`+pass+`"}`); code != 200 || p.autoLockAfter(h) != 0 {
		t.Errorf("a page's never: %d %v", code, p.autoLockAfter(h))
	}
	// The next unlock takes the setting as it is then.
	set(0)
	c.do("POST", "/api/p/vault/lock", "")
	c.session(t)
	if got := p.autoLockAfter(h); got != 0 || s.Status().Locked {
		t.Errorf("never, at the next unlock: %v", got)
	}
}

// A page sets the auto-lock's time for this unlock (presets, a time of its
// own, never), behind the gate; the list says when the vault locks; the
// vault locks at that time; the next unlock follows the setting again.
func TestAutoLockSetByPage(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
	c := newClient(p, h)
	c.do("POST", "/api/p/vault/lock", "")
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
	if d := at.Sub(clk.now()); d <= 59*time.Minute || d > time.Hour {
		t.Fatalf("locks in %v", d)
	}
	for _, bad := range []string{`{"minutes":-1}`, `{"minutes":1441}`, `{"minutes":1.5}`, `{`} {
		if code, _ := c.do("POST", "/api/p/vault/autolock", bad); code != 400 {
			t.Errorf("%s: %d", bad, code)
		}
	}
	// Never, or a longer time, takes the passphrase again; a shorter one
	// the session.
	if code, out := c.do("POST", "/api/p/vault/autolock", `{"minutes":0}`); code != 403 || out["error"] != "passphrase_required" || p.autoLockAfter(h) != time.Hour {
		t.Fatalf("never with the session alone: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/autolock", `{"minutes":120}`); code != 403 || out["error"] != "passphrase_required" {
		t.Fatalf("longer with the session alone: %d %v", code, out)
	}
	if code, out := c.do("POST", "/api/p/vault/autolock", `{"minutes":120,"passphrase":"wrong horse"}`); code != 403 || out["error"] != "wrong_passphrase" {
		t.Fatalf("longer with a wrong passphrase: %d %v", code, out)
	}
	p.tried(true, false)
	if code, _ := c.do("POST", "/api/p/vault/autolock", `{"minutes":30}`); code != 200 || p.autoLockAfter(h) != 30*time.Minute {
		t.Fatalf("shorter: %d %v", code, p.autoLockAfter(h))
	}
	// Back to the setting is longer than the page's 30 minutes.
	if code, out := c.do("POST", "/api/p/vault/autolock", `{"minutes":null}`); code != 403 || out["error"] != "passphrase_required" {
		t.Fatalf("back to a longer setting with the session alone: %d %v", code, out)
	}
	code, al := c.do("POST", "/api/p/vault/autolock", `{"minutes":0,"passphrase":"`+pass+`"}`)
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
	clk.add(time.Minute - time.Second)
	p.autoLock(h)
	if s.Status().Locked {
		t.Fatal("locked before the page's time")
	}
	clk.add(time.Second)
	p.autoLock(h)
	if !s.Status().Locked || !strings.Contains(h.auditLog(), `"reason":"idle"`) || p.autoLockAfter(h) != time.Hour {
		t.Fatalf("after the lock: locked %v, %v, audit %s", s.Status().Locked, p.autoLockAfter(h), h.auditLog())
	}
}

// The key's hold, sessions and the automatic lock count the computer's
// sleep: asleep past the hold (the monotonic clock stopped, the wall clock
// went on), the first request after it wakes finds the key forgotten and
// its session ended; a wall clock set back lengthens nothing, the
// monotonic clock having gone on.
func TestTimeLimitsCountSleep(t *testing.T) {
	p, h, s := newTest(t)
	clk := withClock(t, p)
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
	c.origin = testOrigin
	c.session(t)
	c.register(t, newAuthenticator(t)) // a lock would keep the key
	awake(time.Minute)
	clk.add(24 * time.Hour) // asleep
	if code, out := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 || out["error"] != "vault_session" {
		t.Errorf("the first request after the hold: %d %v", code, out)
	}
	if s.Held() || !strings.Contains(h.auditLog(), `"reason":"passphrase"`) {
		t.Fatalf("the key outlived its hold asleep: held %v, audit %s", s.Held(), h.auditLog())
	}
	// The timer's look, late after a sleep, judges by the wall clock too.
	c.session(t)
	clk.add(25 * time.Hour)
	p.autoLock(h)
	if s.Held() {
		t.Error("the timer kept the key past its hold")
	}
	// A wall clock set back does not lengthen the hold.
	c.session(t)
	clk.add(-48 * time.Hour)
	awake(24 * time.Hour)
	p.autoLock(h)
	if s.Held() {
		t.Error("a wall clock set back lengthened the hold")
	}
	// Nor does sleep lengthen a session's idle time.
	c.session(t)
	clk.add(SessionIdle + time.Minute)
	if code, _ := c.do("PUT", "/api/p/vault/vars/X", `{"value":"x"}`); code != 401 {
		t.Errorf("a session outlived its idle time asleep: %d", code)
	}
}

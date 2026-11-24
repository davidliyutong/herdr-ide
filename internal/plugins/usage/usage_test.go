package usage

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/settings"
	"veldr/internal/usage"
)

type fakeHost struct {
	st       *settings.Store
	mu       sync.Mutex
	sent     []any
	readOnly bool
}

func (h *fakeHost) Machines() *machines.Manager { return nil }
func (h *fakeHost) Broadcast(id, m string, data any) {
	h.mu.Lock()
	h.sent = append(h.sent, data)
	h.mu.Unlock()
}
func (h *fakeHost) Audit(*http.Request, string, map[string]any) {}
func (h *fakeHost) ReadOnly() bool                              { return h.readOnly }
func (h *fakeHost) Settings() *settings.Store                   { return h.st }
func (h *fakeHost) Logger() *log.Logger                         { return log.New(io.Discard, "", 0) }

// testPlugin has machines whose agents answer with replies(m, options).
func testPlugin(t *testing.T, now *time.Time, ready []string, replies func(m string, o usage.Options) ([]usage.Account, error)) (*Plugin, *fakeHost) {
	dir := t.TempDir()
	st := settings.New(filepath.Join(dir, "settings-dev.json"), Settings)
	p := New()
	h := &fakeHost{st: st}
	p.host = h
	p.now = func() time.Time { return *now }
	p.ready = func() []string { return ready }
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		if action != "limits" {
			return &plugin.Error{Code: "bad_params"}
		}
		accs, err := replies(m, params.(usage.Options))
		if err != nil {
			return err
		}
		b, _ := json.Marshal(map[string]any{"accounts": accs})
		return json.Unmarshal(b, out)
	}
	return p, h
}

func win(kind string, pct float64, resets, sec int64) usage.Window {
	return usage.Window{Kind: kind, UsedPct: pct, ResetsAt: resets, WindowSec: sec}
}

func find(s Snapshot, key string) *AccountView {
	for i := range s.Accounts {
		if s.Accounts[i].Key == key {
			return &s.Accounts[i]
		}
	}
	return nil
}

func TestInterval(t *testing.T) {
	cases := []struct {
		mode              string
		watching, working bool
		want              time.Duration
	}{
		{RefreshManual, true, true, 0},
		{"1", false, false, time.Minute},
		{"15", true, false, 15 * time.Minute},
		{"60", false, false, time.Hour},
		{RefreshAdaptive, true, true, 5 * time.Minute},
		{RefreshAdaptive, false, true, 10 * time.Minute},
		{RefreshAdaptive, false, false, 30 * time.Minute},
	}
	for _, c := range cases {
		if got := Interval(c.mode, c.watching, c.working, DefaultCadence); got != c.want {
			t.Errorf("%s watching=%v working=%v: %v, want %v", c.mode, c.watching, c.working, got, c.want)
		}
	}
}

func TestCadence(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, _ := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) { return nil, nil })
	if !p.due() {
		t.Fatal("first poll not due with a machine ready")
	}
	p.Poll(context.Background())
	now = now.Add(29 * time.Minute)
	if p.due() {
		t.Error("due before 30 minutes")
	}
	// A coding agent working: every 10 minutes.
	p.onAgent(machines.AgentEvent{Machine: "local", Data: json.RawMessage(`{"terminal":"t1","agent_status":"working"}`)})
	if !p.due() {
		t.Error("not due while an agent works")
	}
	p.onAgent(machines.AgentEvent{Machine: "local", Data: json.RawMessage(`{"terminal":"t1","agent_status":"idle"}`)})
	if p.due() {
		t.Error("due after the agent stopped")
	}
	// The panel open (GET ?watch=1): every 5 minutes.
	p.Poll(context.Background())
	now = now.Add(2 * time.Minute)
	w := httptest.NewRecorder()
	p.getSnapshot(&plugin.Call{}, w, httptest.NewRequest("GET", "/api/p/usage?watch=1", nil))
	if p.due() {
		t.Error("due 2 minutes after a poll with the panel open")
	}
	now = now.Add(3 * time.Minute)
	p.watch() // the open panel's next minute
	if !p.due() {
		t.Error("not due with the panel open")
	}
	var s Snapshot
	json.Unmarshal(w.Body.Bytes(), &s)
	if s.Interval != 300 || s.Refresh != RefreshAdaptive {
		t.Errorf("snapshot cadence %d %s", s.Interval, s.Refresh)
	}
	// The adaptive cadences are settings.
	if err := p.settings().Set(SettingRefreshOpen, "", 15.0); err != nil {
		t.Fatal(err)
	}
	if err := p.settings().Set(SettingRefreshOpen, "", 0.5); err == nil {
		t.Error("half a minute accepted")
	}
	if s := p.Snapshot(); s.Interval != 900 {
		t.Errorf("set cadence %d", s.Interval)
	}
	// Manual: never by itself.
	p.settings().Set(SettingRefresh, "", RefreshManual)
	now = now.Add(time.Hour)
	if p.due() {
		t.Error("due in manual mode")
	}
	// A machine that goes away takes its agents along.
	p.onAgent(machines.AgentEvent{Machine: "box", Data: json.RawMessage(`{"terminal":"t2","agent_status":"working"}`)})
	p.onMachine(machines.State{Spec: machines.Spec{ID: "box"}, Status: machines.StatusError})
	if len(p.working) != 0 {
		t.Errorf("working %v", p.working)
	}
}

func TestPollDedupesAccounts(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	var skips []string
	shared := usage.Account{Provider: "claude", ID: "acc-1", Email: "a@example.com", Status: "ok", AsOf: now.Unix(),
		Windows: []usage.Window{win("session", 40, now.Unix()+3600, 18000)}}
	p, h := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		if m == "box" {
			skips = o.Skip
			out := []usage.Account{
				{Provider: "codex", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 10, 0, 0)}},
				{Provider: "kimi", Status: "missing"},
			}
			if slices.Contains(o.Skip, "claude:acc-1") {
				return append(out, usage.Account{Provider: "claude", ID: "acc-1", Status: "skipped"}), nil
			}
			return append(out, shared), nil
		}
		return []usage.Account{shared, {Provider: "codex", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 20, 0, 0)}}}, nil
	})
	p.Poll(context.Background())
	if !slices.Contains(skips, "claude:acc-1") {
		t.Fatalf("the second machine was not told to skip: %v", skips)
	}
	s := p.Snapshot()
	if len(s.Accounts) != 3 {
		t.Fatalf("accounts %+v", s.Accounts)
	}
	a := find(s, "claude:acc-1")
	if a == nil || !slices.Equal(a.Machines, []string{"local", "box"}) || a.Windows[0].UsedPct != 40 {
		t.Errorf("shared account %+v", a)
	}
	// Accounts without an id stay apart per machine.
	if find(s, "codex:@local") == nil || find(s, "codex:@box") == nil {
		t.Errorf("per-machine accounts %+v", s.Accounts)
	}
	if s.Machines["local"].Status != "ok" || len(h.sent) < 2 {
		t.Errorf("machines %+v, %d broadcasts", s.Machines, len(h.sent))
	}
	// The pace of the session window: 4 h of 5 gone.
	if pc := a.Windows[0].Pace; pc == nil || int(pc.ExpectedPct) != 80 || pc.BeforeReset {
		t.Errorf("pace %+v", pc)
	}
}

func TestPollKeepsLastGood(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fail := false
	p, _ := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		if fail {
			return []usage.Account{{Provider: "claude", ID: "acc-1", Status: "error", Code: "rate_limited", RetryAfter: 600}}, nil
		}
		return []usage.Account{{Provider: "claude", ID: "acc-1", Plan: "Max", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 55, 0, 0)}}}, nil
	})
	p.Poll(context.Background())
	fail = true
	now = now.Add(time.Minute)
	p.Poll(context.Background())
	a := find(p.Snapshot(), "claude:acc-1")
	if a == nil || a.Status != "error" || a.Code != "rate_limited" || len(a.Windows) != 1 || a.Windows[0].UsedPct != 55 || a.Plan != "Max" ||
		a.FetchedAt != now.Add(-time.Minute).Unix() {
		t.Fatalf("last good %+v", a)
	}
	// Retry-After: the account is skipped until then.
	var skip []string
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		skip = params.(usage.Options).Skip
		return nil
	}
	p.Poll(context.Background())
	if !slices.Contains(skip, "claude:acc-1") {
		t.Errorf("skip %v", skip)
	}
	// An offline machine: its poll fails with the agent's code.
	p.fetch = func(context.Context, string, string, any, any) error { return plugin.ErrOffline }
	p.Poll(context.Background())
	if s := p.Snapshot(); s.Machines["local"].Code != "offline" || find(s, "claude:acc-1") == nil {
		t.Errorf("offline %+v", s.Machines)
	}
	// Accounts no machine reported for a week are forgotten.
	now = now.Add(8 * 24 * time.Hour)
	p.fetch = func(ctx context.Context, m, action string, params, out any) error { return nil }
	p.Poll(context.Background())
	if len(p.Snapshot().Accounts) != 0 {
		t.Errorf("not forgotten")
	}
}

func TestHistory(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	pct := 10.0
	p, _ := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		return []usage.Account{{Provider: "claude", ID: "acc-1", Status: "ok", AsOf: now.Unix(),
			Windows: []usage.Window{win("weekly", pct, 1_800_000_000+3*86400, 7*86400)}}}, nil
	})
	for i := 0; i < 5; i++ {
		p.Poll(context.Background())
		now = now.Add(time.Hour)
		pct += 5
	}
	// Kept in the core's database beside the settings file.
	st, err := os.Stat(plugin.CoreDBFile(p.settings().Path()))
	if err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) {
		t.Fatalf("history database %v %v", st, err)
	}
	s := p.Snapshot()
	w := s.Accounts[0].Windows[0]
	if pts := p.history.Windows["claude:acc-1"][w.ID]; len(pts) != 5 || pts[4][1] != 30 {
		t.Errorf("history %v", pts)
	}
	// 20 % in 4 h: runs out long before the reset 3 days on.
	if w.Pace == nil || !w.Pace.BeforeReset || w.Pace.ExhaustsAt == 0 {
		t.Errorf("pace %+v", w.Pace)
	}
	// A restart shows the accounts again, with their history (the pace
	// from it).
	q, _ := testPlugin(t, &now, nil, nil)
	q.host = p.host
	q.loadHistory()
	s2 := q.Snapshot()
	if len(s2.Accounts) != 1 || len(s2.Accounts[0].Windows) != 1 || *s2.Accounts[0].Windows[0].Pace != *w.Pace {
		t.Errorf("reloaded %+v", s2.Accounts)
	}
	// Points older than 30 days go.
	q.history.prune(now.Add(31 * 24 * time.Hour))
	if len(q.history.Windows) != 0 {
		t.Errorf("not pruned: %v", q.history.Windows)
	}
}

func TestPace(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	w := win("session", 50, now.Unix()+3600, 7200) // half the time gone
	pc := pace(w, nil, now)
	if pc.ExpectedPct != 50 || pc.BeforeReset || pc.ExhaustsAt != now.Unix()+3600 {
		t.Errorf("even pace %+v", pc)
	}
	w.UsedPct = 100
	if pc := pace(w, nil, now); !pc.BeforeReset {
		t.Errorf("exhausted %+v", pc)
	}
	if pace(win("weekly", 10, 0, 0), nil, now) != nil {
		t.Error("pace without a reset time")
	}
}

func TestStatusPages(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, _ := testPlugin(t, &now, nil, nil)
	p.statusClient = func(ctx context.Context, url string, out any) error {
		switch {
		case strings.Contains(url, "claude"):
			return json.Unmarshal([]byte(`{"status":{"indicator":"minor","description":"Partially Degraded Service"}}`), out)
		case strings.Contains(url, "google"):
			return json.Unmarshal([]byte(`[{"end":"","severity":"high","external_desc":"Antigravity errors","affected_products":[{"id":"npdyhgECDJ6tB66MxXyo"}]},
			  {"end":"2026-01-01","severity":"high","affected_products":[{"id":"npdyhgECDJ6tB66MxXyo"}]},
			  {"severity":"high","affected_products":[{"id":"other"}]}]`), out)
		}
		return io.EOF // OpenAI's page does not answer
	}
	p.pollStatus(context.Background())
	s := p.Snapshot()
	if s.Status["claude"].Indicator != "minor" || s.Status["antigravity"].Indicator != "major" || s.Status["antigravity"].Description != "Antigravity errors" {
		t.Errorf("status %+v", s.Status)
	}
	if s.Status["codex"].Indicator != "" || s.Status["codex"].URL == "" || s.Status["grok"].URL != "https://status.x.ai" {
		t.Errorf("links %+v", s.Status)
	}
	// A provider turned off has no status.
	p.settings().Set(providerSetting("grok"), "", false)
	p.pollStatus(context.Background())
	if _, ok := p.Snapshot().Status["grok"]; ok {
		t.Errorf("grok's status kept")
	}
}

func TestCostReport(t *testing.T) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, _ := testPlugin(t, &now, []string{"local", "box"}, nil)
	var since, recent []int64
	var mu sync.Mutex
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		o := params.(usage.CostOptions)
		mu.Lock()
		since = append(since, o.Since)
		recent = append(recent, o.RecentSince)
		mu.Unlock()
		if m == "box" {
			return &plugin.Error{Code: "transport"}
		}
		b, _ := json.Marshal(usage.CostReport{Files: 3, Rows: []usage.CostRow{{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Cost: 1.5, Priced: true}},
			Recent: []usage.CostSlot{{At: now.Unix() - 1800, Provider: "claude", Tokens: 10, Requests: 1, Cost: 0.5, Priced: true}}})
		return json.Unmarshal(b, out)
	}
	w := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w, httptest.NewRequest("GET", "/api/p/usage/cost?days=7&tz=480", nil))
	var rep CostReport
	json.Unmarshal(w.Body.Bytes(), &rep)
	if rep.Days != 7 || rep.TZOffset != 480 || len(rep.Rows) != 1 || rep.Rows[0].Machine != "local" || rep.Machines["box"].Error != "transport" || rep.MonthHours != 750 {
		t.Fatalf("report %s", w.Body)
	}
	// The user's day (UTC+8: 11:00 on the 16th) and 6 before it.
	if want := time.Date(2026, 11, 10, 0, 0, 0, 0, time.FixedZone("", 8*3600)).Unix(); since[0] != want {
		t.Errorf("since %d, want %d", since[0], want)
	}
	// Quarters of an hour from the UTC day 8 days back, the machine's.
	if want := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC).Unix(); recent[0] != want || rep.RecentSince != want {
		t.Errorf("recent since %d (report %d), want %d", recent[0], rep.RecentSince, want)
	}
	if len(rep.Recent) != 1 || rep.Recent[0].Machine != "local" || rep.Recent[0].Cost != 0.5 {
		t.Errorf("recent %+v", rep.Recent)
	}
	// Served again within a minute.
	p.getCost(&plugin.Call{}, httptest.NewRecorder(), httptest.NewRequest("GET", "/api/p/usage/cost?days=7&tz=480", nil))
	if len(since) != 2 {
		t.Errorf("asked %d times", len(since))
	}
}

// The user's prices reach the machines' scans, and a change of them is
// not served from the spend's cache.
func TestCostWithOwnPrices(t *testing.T) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, h := testPlugin(t, &now, []string{"local"}, nil)
	var got []map[string]usage.Tier
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		got = append(got, params.(usage.CostOptions).Prices)
		return json.Unmarshal([]byte(`{"files":1}`), out)
	}
	p.cost(context.Background(), 7, 0)
	if err := h.st.Set(SettingPrices, "", []any{"grok-5 x 1 2"}); err == nil {
		t.Error("a bad price accepted")
	}
	if err := h.st.Set(SettingPrices, "", []any{"grok-5 3 0.75 9"}); err != nil {
		t.Fatal(err)
	}
	p.cost(context.Background(), 7, 0)
	p.cost(context.Background(), 7, 0)
	if len(got) != 2 || got[0] != nil || got[1]["grok-5"].Output != 9 {
		t.Errorf("prices sent %+v", got)
	}
}

func TestSettings(t *testing.T) {
	st := settings.New("", Settings)
	if st.String(SettingRefresh, "") != RefreshAdaptive {
		t.Error("default refresh")
	}
	if l, _ := st.Get(SettingThresholds).([]string); !slices.Equal(l, []string{"80", "95"}) {
		t.Errorf("thresholds %v", l)
	}
	if err := st.Set(SettingThresholds, "", []any{"80", "101"}); err == nil {
		t.Error("101 % accepted")
	}
	if err := st.Set(SettingThresholds, "", []any{"50"}); err != nil {
		t.Error(err)
	}
	p := New()
	p.host = &fakeHost{st: st}
	if o := p.options(); !o.ClaudeKeychain || !o.KimiRefresh {
		t.Errorf("default options %+v", o)
	}
	st.Set(providerSetting("deepseek"), "", false)
	st.Set(SettingClaudeKeychain, "", false)
	st.Set(SettingKimiRefresh, "", false)
	st.Set(SettingCodexHomes, "", []any{"~/work-codex"})
	o := p.options()
	if slices.Contains(o.Providers, "deepseek") || len(o.Providers) != len(usage.Providers)-1 || o.ClaudeKeychain || o.KimiRefresh || !slices.Equal(o.CodexHomes, []string{"~/work-codex"}) {
		t.Errorf("options %+v", o)
	}
	// A read-only core never has Kimi Code's sign-in renewed (it rewrites
	// the credentials file on the machine), whatever the setting.
	st.Set(SettingKimiRefresh, "", true)
	if o := p.options(); !o.KimiRefresh {
		t.Errorf("writable core: %+v", o)
	}
	p.host = &fakeHost{st: st, readOnly: true}
	if o := p.options(); o.KimiRefresh || len(o.Providers) != len(usage.Providers)-1 {
		t.Errorf("read-only core: %+v", o)
	}
	p.host = &fakeHost{readOnly: true}
	if o := p.options(); o.KimiRefresh || !o.ClaudeKeychain {
		t.Errorf("read-only core without settings: %+v", o)
	}
}

func TestRefreshMinimumGap(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	polls := 0
	p, _ := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		polls++
		return nil, nil
	})
	p.settings().Set(SettingRefresh, "", RefreshManual)
	// The first refresh runs at once.
	if at := p.Refresh(); !at.Equal(now) || !p.due() {
		t.Fatalf("first refresh at %v, due %v", at, p.due())
	}
	p.Poll(context.Background())
	if p.due() {
		t.Fatal("still due after the poll")
	}
	// Refreshes within the gap wait for it and share one poll.
	now = now.Add(10 * time.Second)
	w := httptest.NewRecorder()
	p.postRefresh(&plugin.Call{}, w, httptest.NewRequest("POST", "/api/p/usage/refresh", nil))
	var res struct {
		Queued bool  `json:"queued"`
		At     int64 `json:"at"`
	}
	json.Unmarshal(w.Body.Bytes(), &res)
	want := now.Add(-10 * time.Second).Add(minRefreshGap).Unix()
	if w.Code != http.StatusAccepted || !res.Queued || res.At != want {
		t.Fatalf("refresh answer %d %s, want at %d", w.Code, w.Body, want)
	}
	if at := p.Refresh(); at.Unix() != want {
		t.Errorf("second refresh at %v", at)
	}
	if p.due() {
		t.Error("due within the gap")
	}
	if s := p.Snapshot(); s.NextAt != want {
		t.Errorf("snapshot nextAt %d, want %d", s.NextAt, want)
	}
	now = now.Add(20 * time.Second)
	if !p.due() {
		t.Fatal("not due after the gap")
	}
	p.Poll(context.Background())
	if p.due() || polls != 2 {
		t.Errorf("polls %d, due %v", polls, p.due())
	}
	// A refresh while a poll runs waits for the gap after it.
	p.mu.Lock()
	p.polling = true
	p.mu.Unlock()
	if at := p.Refresh(); !at.Equal(now.Add(minRefreshGap)) {
		t.Errorf("refresh during a poll at %v", at)
	}
	p.mu.Lock()
	p.polling = false
	p.mu.Unlock()
	if p.due() {
		t.Error("due right after a poll")
	}
	p.refreshTimer.Stop()
}

func TestRetryAfterWithoutID(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	got := map[string][]string{}
	limited := true
	p, _ := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		got[m] = o.SkipLocal
		if slices.Contains(o.SkipLocal, "codex:/srv/codex2") {
			return []usage.Account{{Provider: "codex", Home: "/srv/codex2", Status: "skipped"}}, nil
		}
		if m == "local" && limited {
			return []usage.Account{{Provider: "codex", Home: "/srv/codex2", Status: "error", Code: "rate_limited", RetryAfter: 300}}, nil
		}
		return []usage.Account{{Provider: "codex", Home: "/srv/codex2", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 5, 0, 0)}}}, nil
	})
	p.Poll(context.Background())
	if a := find(p.Snapshot(), "codex:@local:/srv/codex2"); a == nil || a.Code != "rate_limited" {
		t.Fatalf("limited account %+v", a)
	}
	// Until Retry-After has passed, only that machine skips it.
	now = now.Add(time.Minute)
	p.Poll(context.Background())
	if !slices.Equal(got["local"], []string{"codex:/srv/codex2"}) || len(got["box"]) != 0 {
		t.Errorf("skips %v", got)
	}
	if a := find(p.Snapshot(), "codex:@local:/srv/codex2"); a == nil || a.Code != "rate_limited" || !slices.Equal(a.Machines, []string{"local"}) {
		t.Errorf("skipped account %+v", a)
	}
	// Afterwards it is asked again.
	limited = false
	now = now.Add(5 * time.Minute)
	p.Poll(context.Background())
	if len(got["local"]) != 0 {
		t.Errorf("still skipped: %v", got)
	}
	if a := find(p.Snapshot(), "codex:@local:/srv/codex2"); a == nil || a.Status != "ok" {
		t.Errorf("account %+v", a)
	}
}

func TestCostSharedScansAndCache(t *testing.T) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, _ := testPlugin(t, &now, []string{"local"}, nil)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		b, _ := json.Marshal(usage.CostReport{Files: 1})
		return json.Unmarshal(b, out)
	}
	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.cost(context.Background(), 30, 0)
		}()
	}
	// Let the requests meet the scan in progress, then end it.
	deadline := time.Now().Add(2 * time.Second)
	for {
		p.mu.Lock()
		n := len(p.costFlights)
		p.mu.Unlock()
		if n == 1 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls != 1 {
		t.Errorf("%d scans for one machine and one range", calls)
	}
	// A few ranges are kept.
	p.cost(context.Background(), 7, 0)
	p.cost(context.Background(), 30, 0)
	p.cost(context.Background(), 7, 0)
	if calls != 2 {
		t.Errorf("%d scans, want 2", calls)
	}
	// A request that gives up does not wait for the scan.
	p.costCache = nil
	block := make(chan struct{})
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		<-block
		return nil
	}
	bg := make(chan struct{})
	go func() {
		defer close(bg)
		p.cost(context.Background(), 1, 0)
	}()
	for {
		p.mu.Lock()
		n := len(p.costFlights)
		p.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if rep := p.cost(ctx, 1, 0); rep.Machines["local"].Error != "failed" {
		t.Errorf("cancelled request %+v", rep.Machines)
	}
	close(block)
	// The scan ends before the test's directory goes.
	<-bg
}

// A machine that connects after the first poll is asked at the next tick,
// alone, without the accounts already read; the cadence stays.
func TestJoinedMachineAskedAtOnce(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ready := []string{"local"}
	var asked []string
	var boxSkip []string
	shared := usage.Account{Provider: "claude", ID: "acc-1", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 40, 0, 0)}}
	p, _ := testPlugin(t, &now, nil, func(m string, o usage.Options) ([]usage.Account, error) {
		asked = append(asked, m)
		if m == "box" {
			boxSkip = o.Skip
			return []usage.Account{{Provider: "claude", ID: "acc-1", Status: "skipped"},
				{Provider: "kimi", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 5, 0, 0)}}}, nil
		}
		return []usage.Account{shared}, nil
	})
	p.ready = func() []string { return ready }
	p.onMachine(machines.State{ID: "local", Status: machines.StatusReady})
	p.pollDue(context.Background())
	first := p.lastPoll
	now = now.Add(20 * time.Second)
	ready = []string{"local", "box"}
	p.onMachine(machines.State{ID: "box", Status: machines.StatusReady})
	p.onMachine(machines.State{ID: "box", Status: machines.StatusReady}) // again: no second poll
	p.pollDue(context.Background())
	p.pollDue(context.Background())
	if !slices.Equal(asked, []string{"local", "box"}) || !slices.Contains(boxSkip, "claude:acc-1") {
		t.Fatalf("asked %v, box skipped %v", asked, boxSkip)
	}
	s := p.Snapshot()
	if a := find(s, "claude:acc-1"); a == nil || !slices.Equal(a.Machines, []string{"box", "local"}) {
		t.Errorf("machines of the shared account %+v", a)
	}
	if find(s, "kimi:@box") == nil || !p.lastPoll.Equal(first) || s.Machines["local"].Status != "ok" {
		t.Errorf("joined poll: %+v, last poll %v", s, p.lastPoll)
	}
}

// No poll runs, and none counts as the last, while no machine is connected.
func TestNoPollWithoutMachines(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, _ := testPlugin(t, &now, nil, func(string, usage.Options) ([]usage.Account, error) { return nil, nil })
	p.Refresh()
	if p.due() {
		t.Fatal("due without machines")
	}
	p.Poll(context.Background())
	if !p.lastPoll.IsZero() || p.polling {
		t.Errorf("an empty poll counted")
	}
}

// A machine whose poll failed stays among an account's machines; the
// history gets points only for numbers read again.
func TestFailedMachineAndStaleHistory(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	failBox := false
	acc := usage.Account{Provider: "claude", ID: "acc-1", Status: "ok", Windows: []usage.Window{win("weekly", 40, 0, 0)}}
	p, _ := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		if m == "box" && failBox {
			return nil, plugin.ErrOffline
		}
		a := acc
		a.AsOf = now.Unix()
		if slices.Contains(o.Skip, "claude:acc-1") {
			a = usage.Account{Provider: "claude", ID: "acc-1", Status: "skipped"}
		}
		return []usage.Account{a}, nil
	})
	p.Poll(context.Background())
	failBox = true
	now = now.Add(time.Hour)
	p.Poll(context.Background())
	if a := find(p.Snapshot(), "claude:acc-1"); a == nil || !slices.Equal(a.Machines, []string{"local", "box"}) {
		t.Fatalf("machines %+v", a)
	}
	// Every machine offline: the numbers stay, the history gets no point.
	p.fetch = func(context.Context, string, string, any, any) error { return plugin.ErrOffline }
	for range 4 {
		now = now.Add(time.Hour)
		p.Poll(context.Background())
	}
	if pts := p.history.Windows["claude:acc-1"]["weekly|"]; len(pts) != 2 {
		t.Errorf("history %v", pts)
	}
}

// A provider turned off leaves the snapshot at once.
func TestProviderOffHidden(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, h := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		return []usage.Account{{Provider: "claude", ID: "acc-1", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 40, 0, 0)}}}, nil
	})
	p.Poll(context.Background())
	h.st.Set(providerSetting("claude"), "", false)
	if len(p.Snapshot().Accounts) != 0 {
		t.Error("an account of a provider turned off is shown")
	}
	h.st.Set(providerSetting("claude"), "", true)
	if len(p.Snapshot().Accounts) != 1 {
		t.Error("turned on again: not shown")
	}
}

// Windows that share kind and label get ids of their own.
func TestWindowIDs(t *testing.T) {
	ids := windowIDs([]usage.Window{win("session", 1, 0, 18000), win("session", 2, 0, 3600), win("weekly", 3, 0, 0), win("weekly", 4, 0, 0), {Kind: "model", Label: "M"}})
	if !slices.Equal(ids, []string{"session||18000", "session||3600", "weekly||0", "weekly||0#1", "model|M"}) {
		t.Errorf("ids %q", ids)
	}
}

// The best answer of a poll counts whatever the machines' order: a sign-in
// expired on one machine does not hide the numbers another read; it is
// listed as an issue.
func TestBestAnswerWins(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, _ := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		if m == "local" {
			return []usage.Account{{Provider: "kimi", ID: "u1", Status: "stale", Code: "token_expired"}}, nil
		}
		return []usage.Account{{Provider: "kimi", ID: "u1", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 30, 0, 0)}}}, nil
	})
	p.Poll(context.Background())
	a := find(p.Snapshot(), "kimi:u1")
	if a == nil || a.Status != "ok" || len(a.Windows) != 1 || len(a.Issues) != 1 || a.Issues[0].Machine != "local" || a.Issues[0].Code != "token_expired" {
		t.Fatalf("account %+v", a)
	}
	// The other order: the same.
	p2, _ := testPlugin(t, &now, []string{"box", "local"}, func(m string, o usage.Options) ([]usage.Account, error) {
		if m == "local" {
			return []usage.Account{{Provider: "kimi", ID: "u1", Status: "unauth", Code: "unauthorized"}}, nil
		}
		return []usage.Account{{Provider: "kimi", ID: "u1", Status: "error", Code: "network"}}, nil
	})
	p2.Poll(context.Background())
	if a := find(p2.Snapshot(), "kimi:u1"); a == nil || a.Status != "error" || len(a.Issues) != 2 {
		t.Errorf("best of two failures %+v", a)
	}
}

func TestNamedAccountReplacesItsStandIn(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	named := false
	p, _ := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		a := usage.Account{Provider: "antigravity", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 50, 0, 0)}}
		if named && m == "local" {
			a.ID = "h1"
		}
		return []usage.Account{a}, nil
	})
	p.Poll(context.Background())
	if find(p.Snapshot(), "antigravity:@local") == nil {
		t.Fatal("no account without an id")
	}
	// The machine reads the account's id: one card, not two.
	named = true
	now = now.Add(time.Hour)
	p.Poll(context.Background())
	s := p.Snapshot()
	if find(s, "antigravity:@local") != nil || find(s, "antigravity:h1") == nil {
		t.Errorf("accounts %+v", s.Accounts)
	}
	// Another machine's account without an id is its own.
	if find(s, "antigravity:@box") == nil {
		t.Errorf("the other machine's account went: %+v", s.Accounts)
	}
}

// Machines that read the account's id after another one did are told to
// skip it: their answers, skipped, replace their accounts without an id
// all the same, and the account lists every machine.
func TestSkippedAnswersReplaceStandIns(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	named := false
	p, _ := testPlugin(t, &now, []string{"local", "box", "gpu"}, func(m string, o usage.Options) ([]usage.Account, error) {
		a := usage.Account{Provider: "antigravity", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("weekly", 50, 0, 0)}}
		if named {
			a.ID = "h1"
			if slices.Contains(o.Skip, "antigravity:h1") {
				a = usage.Account{Provider: "antigravity", ID: "h1", Status: usage.StatusSkipped}
			}
		}
		return []usage.Account{a}, nil
	})
	p.Poll(context.Background())
	if n := len(p.Snapshot().Accounts); n != 3 {
		t.Fatalf("%d accounts without an id", n)
	}
	named = true
	now = now.Add(time.Hour)
	p.Poll(context.Background())
	s := p.Snapshot()
	if len(s.Accounts) != 1 {
		t.Fatalf("accounts %+v", s.Accounts)
	}
	if a := find(s, "antigravity:h1"); a == nil || len(a.Machines) != 3 {
		t.Errorf("the account %+v", a)
	}
}

// Each provider's switch and options share one group, and the groups
// follow usage.Providers, after the groups of the other settings: every
// setting has a group, so none shows under another's heading.
func TestProviderGroups(t *testing.T) {
	groups := map[string]string{}
	orders := map[string][]int{}
	general := 0
	for _, d := range Settings.Defs {
		if d.Group == "" {
			t.Errorf("%s has no group", d.Key)
		}
		if slices.Contains([]string{groupRefresh, groupAlerts, groupSpend}, d.Group) {
			general = max(general, d.Order)
		}
	}
	for _, d := range Settings.Defs {
		if strings.HasPrefix(d.Key, "usage.providers.") && d.Order <= general {
			t.Errorf("%s (order %d) before the other settings (to %d)", d.Key, d.Order, general)
		}
		if d.Group == "" || slices.Contains([]string{groupRefresh, groupAlerts, groupSpend}, d.Group) {
			continue
		}
		orders[d.Group] = append(orders[d.Group], d.Order)
		for _, p := range usage.Providers {
			if d.Key == providerSetting(p) {
				groups[p] = d.Group
			}
		}
	}
	for _, key := range []string{SettingClaudeKeychain, SettingCodexHomes, SettingKimiRefresh} {
		for _, d := range Settings.Defs {
			if d.Key != key {
				continue
			}
			p := map[string]string{SettingClaudeKeychain: usage.Claude, SettingCodexHomes: usage.Codex, SettingKimiRefresh: usage.Kimi}[key]
			if d.Group != groups[p] || d.Order <= 0 {
				t.Errorf("%s in group %q, its provider's is %q", key, d.Group, groups[p])
			}
		}
	}
	prev := 0
	for _, p := range usage.Providers {
		g := groups[p]
		if g == "" {
			t.Fatalf("%s has no group", p)
		}
		lo := slices.Min(orders[g])
		if lo <= prev {
			t.Errorf("group %s (order %d) is out of provider order", g, lo)
		}
		prev = slices.Max(orders[g])
	}
}

// Turning a provider off or changing usage.codexHomes produces a different
// cost cache key immediately instead of serving the previous report.
func TestCostCacheKeyIncludesProvidersAndHomes(t *testing.T) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, _ := testPlugin(t, &now, []string{"local"}, nil)
	calls := 0
	var got []usage.CostOptions
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		calls++
		got = append(got, params.(usage.CostOptions))
		b, _ := json.Marshal(usage.CostReport{Files: calls})
		return json.Unmarshal(b, out)
	}
	p.cost(context.Background(), 30, 0)
	p.cost(context.Background(), 30, 0)
	if calls != 1 {
		t.Fatalf("cached call count %d, want 1", calls)
	}
	// Disable one provider: cache misses and sends the updated list.
	if err := p.settings().Set(providerSetting(usage.Grok), "", false); err != nil {
		t.Fatal(err)
	}
	p.cost(context.Background(), 30, 0)
	if calls != 2 || slices.Contains(got[1].Providers, usage.Grok) {
		t.Fatalf("after provider toggle: calls=%d providers=%v", calls, got[len(got)-1].Providers)
	}
	// Change codexHomes: cache misses and sends the new home.
	if err := p.settings().Set(SettingCodexHomes, "", []any{"/srv/codex-alt"}); err != nil {
		t.Fatal(err)
	}
	p.cost(context.Background(), 30, 0)
	if calls != 3 || !slices.Equal(got[2].CodexHomes, []string{"/srv/codex-alt"}) {
		t.Fatalf("after codexHomes change: calls=%d homes=%v", calls, got[len(got)-1].CodexHomes)
	}
}

// Per-machine cost RPC sends IfNoneMatch and reuses the previous machine
// report on NotModified; GET /api/p/usage/cost returns an ETag and answers
// 304 Not Modified when If-None-Match matches.
func TestCostMachineETagAndHTTP304(t *testing.T) {
	now := time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
	p, _ := testPlugin(t, &now, []string{"local"}, nil)
	var seenMatch []string
	agentETag := "cost-v1"
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		o := params.(usage.CostOptions)
		seenMatch = append(seenMatch, o.IfNoneMatch)
		if o.IfNoneMatch == agentETag {
			b, _ := json.Marshal(usage.CostReport{Since: o.Since, ETag: agentETag, NotModified: true})
			return json.Unmarshal(b, out)
		}
		b, _ := json.Marshal(usage.CostReport{
			Since: o.Since,
			ETag:  agentETag,
			Files: 2,
			Rows:  []usage.CostRow{{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Cost: 1.5, Requests: 1, Priced: true}},
		})
		return json.Unmarshal(b, out)
	}

	// First HTTP GET returns 200 with ETag and rows.
	w1 := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w1, httptest.NewRequest("GET", "/api/p/usage/cost?days=30&tz=0", nil))
	etag := w1.Header().Get("ETag")
	if w1.Code != http.StatusOK || etag == "" {
		t.Fatalf("first cost: code=%d etag=%q", w1.Code, etag)
	}
	var rep1 CostReport
	if err := json.Unmarshal(w1.Body.Bytes(), &rep1); err != nil || len(rep1.Rows) != 1 {
		t.Fatalf("first body: %+v %v", rep1, err)
	}

	// Matching If-None-Match while fresh returns 304 with empty body.
	req2 := httptest.NewRequest("GET", "/api/p/usage/cost?days=30&tz=0", nil)
	req2.Header.Set("If-None-Match", etag)
	w2 := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w2, req2)
	if w2.Code != http.StatusNotModified || w2.Body.Len() != 0 || w2.Header().Get("ETag") != etag {
		t.Fatalf("304 while fresh: code=%d len=%d etag=%q", w2.Code, w2.Body.Len(), w2.Header().Get("ETag"))
	}

	// Expire costFresh: core asks the agent with IfNoneMatch, reuses the
	// cached machine rows on NotModified, and still answers 304 to the client.
	now = now.Add(costFresh + time.Second)
	req3 := httptest.NewRequest("GET", "/api/p/usage/cost?days=30&tz=0", nil)
	req3.Header.Set("If-None-Match", etag)
	w3 := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w3, req3)
	if len(seenMatch) != 2 || seenMatch[0] != "" || seenMatch[1] != "cost-v1" {
		t.Fatalf("agent IfNoneMatch sequence: %v", seenMatch)
	}
	if w3.Code != http.StatusNotModified || w3.Body.Len() != 0 {
		t.Fatalf("304 after machine NotModified: code=%d len=%d", w3.Code, w3.Body.Len())
	}

	// Agent reports a new ETag with identical rows: content-based HTTP ETag
	// stays equal and still answers 304.
	agentETag = "cost-v2"
	now = now.Add(costFresh + time.Second)
	req4 := httptest.NewRequest("GET", "/api/p/usage/cost?days=30&tz=0", nil)
	req4.Header.Set("If-None-Match", etag)
	w4 := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w4, req4)
	if w4.Code != http.StatusNotModified || w4.Header().Get("ETag") != etag {
		t.Fatalf("identical content: code=%d etag=%q want 304 %q", w4.Code, w4.Header().Get("ETag"), etag)
	}
	// Now change rows too so the content ETag changes.
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		b, _ := json.Marshal(usage.CostReport{
			Since: params.(usage.CostOptions).Since,
			ETag:  "cost-v3",
			Files: 3,
			Rows:  []usage.CostRow{{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Cost: 3.0, Requests: 2, Priced: true}},
		})
		return json.Unmarshal(b, out)
	}
	now = now.Add(costFresh + time.Second)
	req5 := httptest.NewRequest("GET", "/api/p/usage/cost?days=30&tz=0", nil)
	req5.Header.Set("If-None-Match", etag)
	w5 := httptest.NewRecorder()
	p.getCost(&plugin.Call{}, w5, req5)
	if w5.Code != http.StatusOK || w5.Header().Get("ETag") == etag {
		t.Fatalf("changed data: code=%d etag=%q prev=%q", w5.Code, w5.Header().Get("ETag"), etag)
	}
}

// GET /api/p/usage returns ETag and answers 304 on matching If-None-Match
// while still recording ?watch=1; background idle polls omit the redundant
// start-of-poll broadcast while watched/manual polls keep it.
func TestSnapshotETagAndIdlePollBroadcast(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	p, h := testPlugin(t, &now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		return []usage.Account{{Provider: "claude", ID: "acc-1", Status: "ok", AsOf: now.Unix(), Windows: []usage.Window{win("session", 25, now.Unix()+3600, 18000)}}}, nil
	})
	// First poll broadcasts start + end (2 messages).
	p.Poll(context.Background())
	if len(h.sent) != 2 {
		t.Fatalf("first poll broadcasts %d, want 2", len(h.sent))
	}

	// Background idle poll (no watch, not manual) omits the start broadcast (1 message).
	h.sent = nil
	now = now.Add(30 * time.Minute)
	p.Poll(context.Background())
	if len(h.sent) != 1 || h.sent[0].(Snapshot).Polling {
		t.Fatalf("idle poll broadcasts: %+v", h.sent)
	}

	// GET /api/p/usage?watch=1 returns 200 + ETag, and a matching
	// If-None-Match returns 304 while still refreshing lastWatch.
	w1 := httptest.NewRecorder()
	p.getSnapshot(&plugin.Call{}, w1, httptest.NewRequest("GET", "/api/p/usage?watch=1", nil))
	etag := w1.Header().Get("ETag")
	if w1.Code != http.StatusOK || etag == "" {
		t.Fatalf("first snapshot: code=%d etag=%q", w1.Code, etag)
	}

	now = now.Add(2 * time.Minute)
	req304 := httptest.NewRequest("GET", "/api/p/usage?watch=1", nil)
	req304.Header.Set("If-None-Match", etag)
	w2 := httptest.NewRecorder()
	p.getSnapshot(&plugin.Call{}, w2, req304)
	if w2.Code != http.StatusNotModified || w2.Body.Len() != 0 {
		t.Fatalf("snapshot 304: code=%d len=%d", w2.Code, w2.Body.Len())
	}
	if !p.lastWatch.Equal(now) {
		t.Fatalf("304 did not record watch: lastWatch=%v now=%v", p.lastWatch, now)
	}

	// Watched poll sends both start (polling: true) and end broadcasts.
	h.sent = nil
	p.Poll(context.Background())
	if len(h.sent) != 2 || !h.sent[0].(Snapshot).Polling || h.sent[1].(Snapshot).Polling {
		t.Fatalf("watched poll broadcasts: %+v", h.sent)
	}
}

type managerHost struct {
	*fakeHost
	mg *machines.Manager
}

func (h *managerHost) Machines() *machines.Manager { return h.mg }

// Disabled machines are not live-polled for limits or cost, yet their
// previously scanned cost statistics stay included (across cache expiry,
// narrower ranges, provider toggles and restarts) until ForgetMachine.
func TestCostIncludesDisabledMachineAndSkipsLivePoll(t *testing.T) {
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	st := settings.New(filepath.Join(dir, "settings-dev.json"), Settings)
	mg := machines.NewManager([]machines.Spec{
		{ID: "local", Label: "Local", Kind: machines.KindLocal, Enabled: true},
		{ID: "box", Label: "Box", Kind: machines.KindSSH, Target: "box", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	host := &managerHost{fakeHost: &fakeHost{st: st}, mg: mg}

	// Simulate both machines ready initially.
	ready := []string{"local", "box"}
	var polled []string
	var mu sync.Mutex
	newP := func() *Plugin {
		p := New()
		p.host = host
		p.now = func() time.Time { return now }
		p.ready = func() []string { return ready }
		p.fetch = func(ctx context.Context, m, action string, params, out any) error {
			mu.Lock()
			polled = append(polled, action+":"+m)
			mu.Unlock()
			if action == "limits" {
				return nil
			}
			if m == "local" {
				b, _ := json.Marshal(usage.CostReport{
					ETag:  "local-1",
					Files: 1,
					Rows: []usage.CostRow{
						{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Input: 10, Output: 5, Requests: 1, Cost: 1.0, Priced: true},
					},
				})
				return json.Unmarshal(b, out)
			}
			b, _ := json.Marshal(usage.CostReport{
				ETag:  "box-1",
				Files: 2,
				Rows: []usage.CostRow{
					{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Input: 20, Output: 10, Requests: 2, Cost: 2.5, Priced: true},
					{Day: "2026-11-01", Provider: "codex", Model: "gpt-5", Input: 30, Output: 15, Requests: 1, Cost: 3.0, Priced: true},
				},
			})
			return json.Unmarshal(b, out)
		}
		return p
	}

	p := newP()
	rep1 := p.cost(context.Background(), 30, 0)
	if len(rep1.Rows) != 3 {
		t.Fatalf("initial rows=%d, want 3: %+v", len(rep1.Rows), rep1.Rows)
	}

	// Disable box: it disappears from ready and is never live-polled again.
	if err := mg.SetEnabled("box", false); err != nil {
		t.Fatal(err)
	}
	ready = []string{"local"}
	polled = nil
	now = now.Add(costFresh + time.Second)

	p.Poll(context.Background())
	rep2 := p.cost(context.Background(), 30, 0)
	for _, call := range polled {
		if strings.HasSuffix(call, ":box") {
			t.Fatalf("disabled machine was live-polled: %v", polled)
		}
	}
	if len(rep2.Rows) != 3 || rep2.Machines["box"].Error != "" || rep2.Machines["box"].Files != 2 {
		t.Fatalf("disabled machine missing after cache expiry: rows=%d machine=%+v", len(rep2.Rows), rep2.Machines["box"])
	}

	// Narrower day range (7 days) and disabled provider still filter the
	// disabled machine's historical rows accurately without polling it.
	polled = nil
	rep7 := p.cost(context.Background(), 7, 0)
	if len(rep7.Rows) != 2 {
		t.Fatalf("7-day rows=%d, want 2: %+v", len(rep7.Rows), rep7.Rows)
	}
	if err := st.Set(providerSetting(usage.Codex), "", false); err != nil {
		t.Fatal(err)
	}
	repNoCodex := p.cost(context.Background(), 30, 0)
	if len(repNoCodex.Rows) != 2 {
		t.Fatalf("without codex rows=%d, want 2: %+v", len(repNoCodex.Rows), repNoCodex.Rows)
	}
	for _, call := range polled {
		if strings.HasSuffix(call, ":box") {
			t.Fatalf("disabled machine polled on range/provider change: %v", polled)
		}
	}
	_ = st.Set(providerSetting(usage.Codex), "", true)

	// Restart (fresh Plugin reading core.db) while box is still disabled:
	// box's historical cost statistics persist and are still included.
	polled = nil
	q := newP()
	repRestart := q.cost(context.Background(), 30, 0)
	if len(repRestart.Rows) != 3 || repRestart.Machines["box"].Files != 2 {
		t.Fatalf("after restart rows=%d machine=%+v", len(repRestart.Rows), repRestart.Machines["box"])
	}
	for _, call := range polled {
		if strings.HasSuffix(call, ":box") {
			t.Fatalf("disabled machine polled after restart: %v", polled)
		}
	}

	// Removing the machine (ForgetMachine) drops its cached cost rows.
	q.ForgetMachine(host, "box")
	repForgotten := q.cost(context.Background(), 30, 0)
	if len(repForgotten.Rows) != 1 || repForgotten.Rows[0].Machine != "local" {
		t.Fatalf("after ForgetMachine rows=%+v", repForgotten.Rows)
	}
}

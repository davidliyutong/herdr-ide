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
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/usage"
)

type fakeHost struct {
	st   *settings.Store
	mu   sync.Mutex
	sent []any
}

func (h *fakeHost) Machines() *machines.Manager { return nil }
func (h *fakeHost) Broadcast(id, m string, data any) {
	h.mu.Lock()
	h.sent = append(h.sent, data)
	h.mu.Unlock()
}
func (h *fakeHost) Audit(*http.Request, string, map[string]any) {}
func (h *fakeHost) ReadOnly() bool                              { return false }
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
		{RefreshAdaptive, true, true, 2 * time.Minute},
		{RefreshAdaptive, false, true, 5 * time.Minute},
		{RefreshAdaptive, false, false, 30 * time.Minute},
	}
	for _, c := range cases {
		if got := Interval(c.mode, c.watching, c.working); got != c.want {
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
	// A coding agent working: every 5 minutes.
	p.onAgent(machines.AgentEvent{Machine: "local", Data: json.RawMessage(`{"terminal":"t1","agent_status":"working"}`)})
	if !p.due() {
		t.Error("not due while an agent works")
	}
	p.onAgent(machines.AgentEvent{Machine: "local", Data: json.RawMessage(`{"terminal":"t1","agent_status":"idle"}`)})
	if p.due() {
		t.Error("due after the agent stopped")
	}
	// The panel open (GET ?watch=1): every 2 minutes.
	p.Poll(context.Background())
	now = now.Add(2 * time.Minute)
	w := httptest.NewRecorder()
	p.getSnapshot(&plugin.Call{}, w, httptest.NewRequest("GET", "/api/p/usage?watch=1", nil))
	if !p.due() {
		t.Error("not due with the panel open")
	}
	var s Snapshot
	json.Unmarshal(w.Body.Bytes(), &s)
	if s.Interval != 120 || s.Refresh != RefreshAdaptive {
		t.Errorf("snapshot cadence %d %s", s.Interval, s.Refresh)
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
	path := p.historyPath()
	if filepath.Base(path) != "usage-history-dev.json" {
		t.Fatalf("history path %s", path)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("history file %v %v", st, err)
	}
	s := p.Snapshot()
	w := s.Accounts[0].Windows[0]
	if len(w.History) != 5 || w.History[4][1] != 30 {
		t.Errorf("history %v", w.History)
	}
	// 20 % in 4 h: runs out long before the reset 3 days on.
	if w.Pace == nil || !w.Pace.BeforeReset || w.Pace.ExhaustsAt == 0 {
		t.Errorf("pace %+v", w.Pace)
	}
	// A restart shows the accounts again, with their history.
	q, _ := testPlugin(t, &now, nil, nil)
	q.host = p.host
	q.loadHistory(path)
	s2 := q.Snapshot()
	if len(s2.Accounts) != 1 || len(s2.Accounts[0].Windows) != 1 || len(s2.Accounts[0].Windows[0].History) != 5 {
		t.Errorf("reloaded %+v", s2.Accounts)
	}
	// Points older than 30 days go.
	q.history.prune(now.Add(31 * 24 * time.Hour))
	if len(q.history.Windows) != 0 {
		t.Errorf("not pruned: %v", q.history.Windows)
	}
}

func TestHistoryPointsAreThinned(t *testing.T) {
	h := newHistory()
	now := time.Unix(1_800_000_000, 0)
	var pts [][2]float64
	for i := 0; i < 200; i++ {
		pts = append(pts, [2]float64{float64(now.Unix() - int64(200-i)*60), float64(i) / 2})
	}
	h.Windows["k"] = map[string][][2]float64{"weekly|": pts}
	got := h.points("k", usage.Window{Kind: "weekly"}, now)
	if len(got) != maxPoints || got[len(got)-1] != pts[len(pts)-1] || got[0] != pts[0] {
		t.Errorf("thinned to %d: first %v last %v", len(got), got[0], got[len(got)-1])
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
	var since []int64
	var mu sync.Mutex
	p.fetch = func(ctx context.Context, m, action string, params, out any) error {
		o := params.(usage.CostOptions)
		mu.Lock()
		since = append(since, o.Since)
		mu.Unlock()
		if m == "box" {
			return &plugin.Error{Code: "transport"}
		}
		b, _ := json.Marshal(usage.CostReport{Files: 3, Rows: []usage.CostRow{{Day: "2026-11-16", Provider: "claude", Model: "claude-opus-4-6", Cost: 1.5, Priced: true}}})
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
	// Served again within a minute.
	p.getCost(&plugin.Call{}, httptest.NewRecorder(), httptest.NewRequest("GET", "/api/p/usage/cost?days=7&tz=480", nil))
	if len(since) != 2 {
		t.Errorf("asked %d times", len(since))
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
	st.Set(providerSetting("deepseek"), "", false)
	st.Set(SettingClaudeKeychain, "", false)
	st.Set(SettingCodexHomes, "", []any{"~/work-codex"})
	o := p.options()
	if slices.Contains(o.Providers, "deepseek") || len(o.Providers) != 5 || o.ClaudeKeychain || !slices.Equal(o.CodexHomes, []string{"~/work-codex"}) {
		t.Errorf("options %+v", o)
	}
}

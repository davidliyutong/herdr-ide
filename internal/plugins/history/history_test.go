package history

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

func TestPlugin(t *testing.T) {
	p := New()
	if p.ID() != "history" {
		t.Fatalf("plugin %q", p.ID())
	}
	if plugin.EnableSetting(p) != "plugins.history.enabled" {
		t.Errorf("switch %s", plugin.EnableSetting(p))
	}
	var _ plugin.Starter = p
}

// Every route is a machine's; only the clear and the adopt change
// something: guarded (refused in read-only mode, audited) as history.clear
// and history.adopt.
func TestRoutes(t *testing.T) {
	seen := map[string]bool{}
	audits := map[string]string{"DELETE": "clear", "POST": "adopt"}
	for _, rt := range New().Routes() {
		if !rt.Machine {
			t.Errorf("%s %s is not a machine's route", rt.Method, rt.Path)
		}
		mutating := rt.Method != http.MethodGet
		if rt.Mutating != mutating || rt.Audit != audits[rt.Method] {
			t.Errorf("%s %s: mutating %v, audit %q", rt.Method, rt.Path, rt.Mutating, rt.Audit)
		}
		seen[plugin.Pattern(ID, rt)] = true
	}
	for _, p := range []string{"GET /api/m/{id}/p/history", "GET /api/m/{id}/p/history/read", "DELETE /api/m/{id}/p/history", "POST /api/m/{id}/p/history/adopt"} {
		if !seen[p] {
			t.Errorf("no route %s", p)
		}
	}
}

// Capturing is off until the user turns it on, also per machine (the
// core's own included); every limit is bounded, and each can differ per
// machine.
func TestSettings(t *testing.T) {
	st := settings.New("", Settings)
	if st.Bool(SettingCapture, "") || st.Bool(SettingCapture, "local") {
		t.Fatal("capturing is on by default")
	}
	want := map[string][3]float64{
		SettingInterval:     {30, 10, 600},
		SettingLines:        {2000, 100, 10000},
		SettingMaxTerminals: {32, 1, 128},
		SettingMaxTotalMB:   {64, 1, 512},
		SettingDays:         {7, 1, 30},
	}
	seen := 0
	for _, d := range st.Defs() {
		if d.Section != "history" || d.Scope != settings.ScopeMachine {
			t.Errorf("%s: section %s, scope %s", d.Key, d.Section, d.Scope)
		}
		if d.Key == SettingCapture {
			if d.Flag != "history-capture" || !strings.Contains(d.Usage, "secrets") {
				t.Errorf("capture's flag %q, usage %q", d.Flag, d.Usage)
			}
			continue
		}
		w, ok := want[d.Key]
		if !ok {
			t.Errorf("unexpected setting %s", d.Key)
			continue
		}
		seen++
		if d.Default != w[0] || *d.Min != w[1] || *d.Max != w[2] || !d.Integer {
			t.Errorf("%s: %v %v–%v integer %v", d.Key, d.Default, *d.Min, *d.Max, d.Integer)
		}
		if err := st.Set(d.Key, "", w[2]+1); err == nil {
			t.Errorf("%s took a value above its bound", d.Key)
		}
	}
	if seen != len(want) {
		t.Errorf("%d limits, want %d", seen, len(want))
	}
	if err := st.Set(SettingCapture, "gpu", true); err != nil || !st.Bool(SettingCapture, "gpu") || st.Bool(SettingCapture, "") {
		t.Errorf("a machine's own value: %v", err)
	}
	if len(Settings.Sections) != 1 || Settings.Sections[0].Plugin != ID {
		t.Errorf("sections %+v", Settings.Sections)
	}
	// The settings' bounds are the machine's hard limits.
	if MinLines != agentproto.HistoryMinLines || MaxLines != agentproto.HistoryMaxLines ||
		MinTerminals != agentproto.HistoryMinTerminals || MaxTerminals != agentproto.HistoryMaxTerminals ||
		int64(MinTotalMB)<<20 != agentproto.HistoryMinTotalBytes || int64(MaxTotalMB)<<20 != agentproto.HistoryMaxTotalBytes ||
		MinDays != agentproto.HistoryMinDays || MaxDays != agentproto.HistoryMaxDays {
		t.Error("the settings' bounds differ from the machine's limits")
	}
}

type fakeHost struct {
	st       *settings.Store
	readOnly bool
	mu       sync.Mutex
	audits   []map[string]any
	events   []string
}

func (h *fakeHost) Machines() *machines.Manager   { return nil }
func (h *fakeHost) Broadcast(string, string, any) {}
func (h *fakeHost) Audit(_ *http.Request, event string, fields map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.events = append(h.events, event)
	h.audits = append(h.audits, fields)
}
func (h *fakeHost) ReadOnly() bool { return h.readOnly }

// audited are the audit records so far: events and fields.
func (h *fakeHost) audited() ([]string, []map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.events), slices.Clone(h.audits)
}
func (h *fakeHost) Settings() *settings.Store { return h.st }
func (h *fakeHost) Logger() *log.Logger       { return log.New(io.Discard, "", 0) }

// agentCall is one action a fake machine was asked.
type agentCall struct {
	m, action string
	params    any
}

// fakeMachines answers the plugin's actions: reply gives an action's
// result or error; block, when set, holds every action until it closes.
type fakeMachines struct {
	mu    sync.Mutex
	calls []agentCall
	ready []string
	block chan struct{}
	reply func(m, action string, params any) (any, error)
}

func (f *fakeMachines) call(ctx context.Context, m, action string, params, out any) error {
	f.mu.Lock()
	f.calls = append(f.calls, agentCall{m, action, params})
	block, reply := f.block, f.reply
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	var res any = map[string]any{}
	if reply != nil {
		var err error
		if res, err = reply(m, action, params); err != nil {
			return err
		}
	}
	if out != nil {
		b, _ := json.Marshal(res)
		return json.Unmarshal(b, out)
	}
	return nil
}

func (f *fakeMachines) taken() []agentCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// testPlugin is the plugin with a host whose settings hold the plugin's
// and its switch, and machines.
func testPlugin(t *testing.T, ready ...string) (*Plugin, *fakeHost, *fakeMachines, *time.Time) {
	t.Helper()
	p := New()
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return now }
	f := &fakeMachines{ready: ready}
	p.call = f.call
	p.ready = func() []string {
		f.mu.Lock()
		defer f.mu.Unlock()
		return slices.Clone(f.ready)
	}
	h := &fakeHost{st: settings.New("", Settings, plugin.Settings([]plugin.Plugin{p}, nil))}
	p.host = h
	h.st.OnChange(p.settingsChanged)
	return p, h, f, &now
}

// settle waits for the captures and clears step started.
func settle(t *testing.T, p *Plugin) {
	t.Helper()
	for i := 0; ; i++ {
		p.mu.Lock()
		n := len(p.busy)
		p.mu.Unlock()
		if n == 0 {
			return
		}
		if i > 500 {
			t.Fatal("still busy")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func actions(calls []agentCall, m string) []string {
	var out []string
	for _, c := range calls {
		if c.m == m {
			out = append(out, c.action)
		}
	}
	return out
}

// Captures run per machine whose setting is on, with its settings, every
// interval after the last one ended; never in read-only mode nor while
// the plugin is off.
func TestSchedulerCaptures(t *testing.T) {
	p, h, f, now := testPlugin(t, "local", "gpu", "far")
	ctx := context.Background()
	p.step(ctx)
	settle(t, p)
	// Seen the first time with capturing off: each is cleared once.
	for _, m := range []string{"local", "gpu", "far"} {
		if got := actions(f.taken(), m); !slices.Equal(got, []string{"clear"}) {
			t.Fatalf("%s: %v", m, got)
		}
	}
	p.step(ctx)
	settle(t, p)
	if c := f.taken(); len(c) != 3 {
		t.Fatalf("asked with capturing off: %+v", c)
	}
	f.mu.Lock()
	f.calls = nil
	f.mu.Unlock()
	h.st.Set(SettingCapture, "gpu", true)
	h.st.Set(SettingLines, "gpu", 500.0)
	h.st.Set(SettingMaxTotalMB, "gpu", 8.0)
	h.st.Set(SettingInterval, "gpu", 60.0)
	p.step(ctx)
	settle(t, p)
	c := f.taken()
	if len(c) != 1 || c[0].m != "gpu" || c[0].action != "capture" {
		t.Fatalf("calls %+v", c)
	}
	want := agentproto.HistoryCaptureParams{Lines: 500, MaxTerminals: 32, MaxTotalBytes: 8 << 20, Days: 7}
	if c[0].params != want {
		t.Fatalf("params %+v", c[0].params)
	}
	// Not again before the interval passed since it ended.
	*now = now.Add(59 * time.Second)
	p.step(ctx)
	settle(t, p)
	if n := len(f.taken()); n != 1 {
		t.Fatalf("%d calls before the interval", n)
	}
	*now = now.Add(time.Second)
	p.step(ctx)
	settle(t, p)
	if n := len(f.taken()); n != 2 {
		t.Fatalf("%d calls after the interval", n)
	}
	// Read-only: nothing.
	*now = now.Add(time.Hour)
	h.readOnly = true
	p.step(ctx)
	settle(t, p)
	if n := len(f.taken()); n != 2 {
		t.Fatalf("asked in read-only mode")
	}
	h.readOnly = false
	// The plugin off: no capture, the snapshots gpu kept go, once.
	h.st.Set("plugins.history.enabled", "", false)
	for range 3 {
		*now = now.Add(time.Hour)
		p.step(ctx)
		settle(t, p)
	}
	if got := actions(f.taken(), "gpu"); !slices.Equal(got, []string{"capture", "capture", "clear"}) {
		t.Fatalf("gpu with the plugin off: %v", got)
	}
	h.st.Set("plugins.history.enabled", "", true)
	// On for every machine: each is asked.
	h.st.Set(SettingCapture, "", true)
	p.step(ctx)
	settle(t, p)
	c = f.taken()[3:]
	if len(c) != 3 || len(actions(c, "local")) != 1 || len(actions(c, "far")) != 1 || len(actions(c, "gpu")) != 1 || c[0].action != "capture" {
		t.Fatalf("calls %+v", c)
	}
}

// A core that starts with capturing off for a machine (turned off while it
// was down, in the settings file, or the plugin off) asks it for one clear
// when it is first connected: audited only when it removed snapshots.
func TestSchedulerClearsAtFirstSight(t *testing.T) {
	p, h, f, now := testPlugin(t, "gpu", "far")
	f.reply = func(m, action string, params any) (any, error) {
		if m == "gpu" {
			return agentproto.HistoryClearResult{Removed: 3}, nil
		}
		return agentproto.HistoryClearResult{}, nil
	}
	ctx := context.Background()
	for range 5 {
		p.step(ctx)
		settle(t, p)
		*now = now.Add(time.Hour)
	}
	for _, m := range []string{"gpu", "far"} {
		if got := actions(f.taken(), m); !slices.Equal(got, []string{"clear"}) {
			t.Fatalf("%s: %v", m, got)
		}
	}
	if events, audits := h.audited(); len(events) != 1 || audits[0]["machine"] != "gpu" || audits[0]["removed"] != 3 {
		t.Fatalf("audit %v %v", events, audits)
	}
	// A machine first connected later is cleared then.
	f.mu.Lock()
	f.ready = append(f.ready, "new")
	f.mu.Unlock()
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "new"); !slices.Equal(got, []string{"clear"}) {
		t.Fatalf("new: %v", got)
	}

	// The plugin off from the start, capturing on: the same.
	p, _, f, _ = testPlugin(t, "gpu")
	p.getHost().Settings().Set(SettingCapture, "", true)
	p.getHost().Settings().Set("plugins.history.enabled", "", false)
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "gpu"); !slices.Equal(got, []string{"clear"}) {
		t.Fatalf("plugin off: %v", got)
	}
}

// One capture at a time per machine: a capture that runs is not asked
// again, however long it takes.
func TestSchedulerOneAtATime(t *testing.T) {
	p, h, f, now := testPlugin(t, "gpu")
	h.st.Set(SettingCapture, "gpu", true)
	block := make(chan struct{})
	f.mu.Lock()
	f.block = block
	f.mu.Unlock()
	ctx := context.Background()
	p.step(ctx)
	for range 5 {
		*now = now.Add(time.Hour)
		p.step(ctx)
	}
	time.Sleep(20 * time.Millisecond)
	if n := len(f.taken()); n != 1 {
		t.Fatalf("%d captures at once", n)
	}
	close(block)
	settle(t, p)
	*now = now.Add(time.Hour)
	p.step(ctx)
	settle(t, p)
	if n := len(f.taken()); n != 2 {
		t.Fatalf("%d captures after the first ended", n)
	}
}

// Turning the setting off clears the machine's snapshots once, audited;
// also when it happens while the machine is away (when it is back), and
// when it is turned on again before the next tick. Read-only cores clear
// nothing.
func TestSchedulerClearsWhenTurnedOff(t *testing.T) {
	p, h, f, now := testPlugin(t, "gpu", "far")
	ctx := context.Background()
	h.st.Set(SettingCapture, "", true)
	p.step(ctx)
	settle(t, p)
	f.mu.Lock()
	f.calls = nil
	f.mu.Unlock()

	h.st.Set(SettingCapture, "gpu", false)
	*now = now.Add(time.Hour)
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "gpu"); !slices.Equal(got, []string{"clear"}) {
		t.Fatalf("gpu: %v", got)
	}
	if got := actions(f.taken(), "far"); !slices.Equal(got, []string{"capture"}) {
		t.Fatalf("far: %v", got)
	}
	if events, audits := h.audited(); len(events) != 1 || events[0] != "history.clear" || audits[0]["machine"] != "gpu" || audits[0]["reason"] != "capture_off" {
		t.Fatalf("audit %v %v", events, audits)
	}
	// Once.
	*now = now.Add(time.Hour)
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "gpu"); len(got) != 1 {
		t.Fatalf("gpu asked again: %v", got)
	}

	// far is away when its setting goes off, and is turned on again before
	// it is back: cleared once it is back, then captured again.
	f.mu.Lock()
	f.ready, f.calls = []string{"gpu"}, nil
	f.mu.Unlock()
	h.st.Set(SettingCapture, "far", false)
	h.st.Set(SettingCapture, "far", true)
	*now = now.Add(time.Hour)
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "far"); len(got) != 0 {
		t.Fatalf("far asked while away: %v", got)
	}
	f.mu.Lock()
	f.ready = []string{"gpu", "far"}
	f.mu.Unlock()
	p.step(ctx)
	settle(t, p)
	p.step(ctx)
	settle(t, p)
	if got := actions(f.taken(), "far"); !slices.Equal(got, []string{"clear", "capture"}) {
		t.Fatalf("far: %v", got)
	}

	// Read-only: the clear waits.
	f.mu.Lock()
	f.calls = nil
	f.mu.Unlock()
	h.readOnly = true
	h.st.Set(SettingCapture, "far", false)
	*now = now.Add(time.Hour)
	p.step(ctx)
	settle(t, p)
	if c := f.taken(); len(c) != 0 {
		t.Fatalf("read-only core asked %+v", c)
	}
}

// A clear that fails is asked again later, waiting twice as long after
// each failure up to an hour, and at once when the machine connects again;
// it is never given up, and audited once it is done.
func TestSchedulerClearRetries(t *testing.T) {
	p, h, f, now := testPlugin(t, "gpu")
	ctx := context.Background()
	h.st.Set(SettingCapture, "gpu", true)
	p.step(ctx)
	settle(t, p)
	failing := true
	f.mu.Lock()
	f.reply = func(m, action string, params any) (any, error) {
		if failing && action == "clear" {
			return nil, &plugin.Error{Code: "transport", Message: "lost"}
		}
		return map[string]any{}, nil
	}
	f.mu.Unlock()
	h.st.Set(SettingCapture, "gpu", false)
	clears := func() int { return len(actions(f.taken(), "gpu")) - 1 }
	// Asked at 0, then 30 s, 60 s, 120 s … after each failure.
	start := *now
	var at []time.Duration
	for range 24 * 60 {
		p.step(ctx)
		settle(t, p)
		if n := clears(); n > len(at) {
			at = append(at, now.Sub(start))
		}
		*now = now.Add(30 * time.Second)
		if now.Sub(start) > 12*time.Hour {
			break
		}
	}
	want := []time.Duration{0, 30 * time.Second, 90 * time.Second, 210 * time.Second}
	if len(at) < 12 || !slices.Equal(at[:4], want) {
		t.Fatalf("asked at %v", at)
	}
	if gap := at[len(at)-1] - at[len(at)-2]; gap != clearRetryMax {
		t.Fatalf("last gap %v", gap)
	}
	// Away and back: asked at once.
	f.mu.Lock()
	f.ready = nil
	f.mu.Unlock()
	p.step(ctx)
	n := clears()
	f.mu.Lock()
	f.ready = []string{"gpu"}
	f.mu.Unlock()
	failing = false
	p.step(ctx)
	settle(t, p)
	if clears() != n+1 {
		t.Fatal("not asked when back")
	}
	if events, audits := h.audited(); len(events) != 1 || audits[0]["reason"] != "capture_off" {
		t.Fatalf("audit %v %v", events, audits)
	}
	// Done: not asked again.
	*now = now.Add(24 * time.Hour)
	p.step(ctx)
	settle(t, p)
	if clears() != n+1 {
		t.Fatal("asked after it was done")
	}
}

// Start runs until its context ends and asks a machine that is on.
func TestStart(t *testing.T) {
	p, h, f, _ := testPlugin(t, "gpu")
	h.st.Set(SettingCapture, "gpu", true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Start(ctx, h)
		close(done)
	}()
	for i := 0; len(f.taken()) == 0; i++ {
		if i > 200 {
			t.Fatal("no capture")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Start outlived its context")
	}
}

func machine(t *testing.T) *machines.Machine {
	t.Helper()
	mg := machines.NewManager([]machines.Spec{{ID: "gpu", Label: "gpu", Kind: machines.KindSSH, Target: "gpu", Enabled: false}}, nil, log.New(io.Discard, "", 0))
	return mg.Get("gpu")
}

// The routes check what the browser sends before the machine is asked,
// and pass on only what the machine may answer.
func TestRouteGuards(t *testing.T) {
	p, _, f, _ := testPlugin(t)
	mc := machine(t)
	data := bytes.Repeat([]byte("\x1b[31mx"), 1000)
	f.reply = func(m, action string, params any) (any, error) {
		switch action {
		case "list":
			return agentproto.HistoryListResult{RestoreScreen: true, Terminals: []agentproto.HistoryEntry{
				{Terminal: "t1", HistorySnapshot: agentproto.HistorySnapshot{PID: 3}},
				{Terminal: "../t2"},
			}}, nil
		case "read":
			rp := params.(agentproto.HistoryReadParams)
			if rp.Terminal == "t9" {
				return agentproto.HistoryData{Terminal: "t9", Generation: rp.Generation, Data: make([]byte, agentproto.HistoryMaxBytes+1)}, nil
			}
			if rp.Terminal == "t8" {
				return nil, &plugin.Error{Code: "not_found", Message: "no snapshot"}
			}
			return agentproto.HistoryData{Terminal: rp.Terminal, Generation: rp.Generation, Data: data,
				HistorySnapshot: agentproto.HistorySnapshot{PID: 42, At: 1700000000000, Cols: 120, Rows: 40, Lines: 2000, Bytes: int64(len(data))}}, nil
		case "clear":
			return agentproto.HistoryClearResult{Removed: 1}, nil
		}
		return nil, &plugin.Error{Code: "bad_params"}
	}
	do := func(h func(*plugin.Call, http.ResponseWriter, *http.Request), method, target string, mc *machines.Machine) (*httptest.ResponseRecorder, *plugin.Call) {
		c := &plugin.Call{Machine: mc}
		w := httptest.NewRecorder()
		h(c, w, httptest.NewRequest(method, target, nil))
		return w, c
	}
	// Bad requests never reach the machine.
	for _, q := range []string{"", "?terminal=t1", "?generation=previous", "?terminal=../x&generation=previous",
		"?terminal=t1&generation=prev", "?terminal=" + strings.Repeat("a", 65) + "&generation=current", "?terminal=.t&generation=current"} {
		if w, _ := do(p.getRead, "GET", "/read"+q, mc); w.Code != http.StatusBadRequest {
			t.Errorf("read %q: %d", q, w.Code)
		}
	}
	for _, q := range []string{"?terminal=../x", "?terminal=a/b", "?terminal=.."} {
		if w, c := do(p.deleteSnapshots, "DELETE", "/"+q, mc); w.Code != http.StatusBadRequest || c.AuditFields()["terminal"] != nil {
			t.Errorf("delete %q: %d %v", q, w.Code, c.AuditFields())
		}
	}
	if n := len(f.taken()); n != 0 {
		t.Fatalf("the machine was asked %d times", n)
	}
	// The list without what could not name a terminal.
	w, _ := do(p.getList, "GET", "/", mc)
	var l agentproto.HistoryListResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &l) != nil || len(l.Terminals) != 1 || l.Terminals[0].Terminal != "t1" || !l.RestoreScreen {
		t.Fatalf("list %d %s", w.Code, w.Body)
	}
	// The bytes as they are, described by headers.
	w, _ = do(p.getRead, "GET", "/read?terminal=t1&generation=previous", mc)
	hd := w.Header()
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || hd.Get("Content-Type") != "application/octet-stream" ||
		hd.Get("X-History-Pid") != "42" || hd.Get("X-History-At") != "1700000000000" || hd.Get("X-History-Cols") != "120" ||
		hd.Get("X-History-Rows") != "40" || hd.Get("X-History-Lines") != "2000" || hd.Get("Cache-Control") != "no-store" ||
		hd.Get("X-Content-Type-Options") != "nosniff" || hd.Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
		hd.Get("Content-Disposition") != "attachment" {
		t.Fatalf("read %d %v", w.Code, hd)
	}
	c := f.taken()
	if rp := c[len(c)-1].params.(agentproto.HistoryReadParams); rp.Terminal != "t1" || rp.Generation != "previous" {
		t.Fatalf("asked %+v", rp)
	}
	if w, _ = do(p.getRead, "GET", "/read?terminal=t9&generation=current", mc); w.Code != http.StatusBadGateway {
		t.Errorf("an answer over the limit: %d", w.Code)
	}
	if w, _ = do(p.getRead, "GET", "/read?terminal=t8&generation=current", mc); w.Code != http.StatusNotFound {
		t.Errorf("no snapshot: %d", w.Code)
	}
	// Clear one terminal, audited with it; clear all.
	w, cl := do(p.deleteSnapshots, "DELETE", "/?terminal=t1", mc)
	if w.Code != 200 || cl.AuditFields()["terminal"] != "t1" || cl.AuditFields()["removed"] != 1 {
		t.Fatalf("clear t1 %d %v", w.Code, cl.AuditFields())
	}
	c = f.taken()
	if cp := c[len(c)-1].params.(agentproto.HistoryClearParams); cp.Terminal != "t1" {
		t.Fatalf("asked %+v", cp)
	}
	if w, _ = do(p.deleteSnapshots, "DELETE", "/", mc); w.Code != 200 {
		t.Fatalf("clear all %d", w.Code)
	}
	// No machine: offline.
	if w, _ = do(p.getList, "GET", "/", nil); w.Code != http.StatusConflict {
		t.Errorf("offline %d", w.Code)
	}
	// What is not the machine's coded failure is answered with a fixed
	// wording, never the error's text.
	f.reply = func(m, action string, params any) (any, error) {
		return nil, fmt.Errorf("open /home/u/.herdr-ide/history/t1.vt: %w", context.DeadlineExceeded)
	}
	w, _ = do(p.deleteSnapshots, "DELETE", "/", mc)
	if w.Code != http.StatusGatewayTimeout || strings.Contains(w.Body.String(), "/home") {
		t.Errorf("timeout %d %s", w.Code, w.Body)
	}
	f.reply = func(m, action string, params any) (any, error) { return nil, errors.New("open /home/u/x: denied") }
	w, _ = do(p.getList, "GET", "/", mc)
	if w.Code != http.StatusBadGateway || strings.Contains(w.Body.String(), "/home") {
		t.Errorf("failure %d %s", w.Code, w.Body)
	}
}

// An adopt's addresses are checked before the machine is asked; it is
// audited with them and with its result, and the machine's failures keep
// their codes.
func TestAdoptRoute(t *testing.T) {
	p, _, f, _ := testPlugin(t)
	mc := machine(t)
	f.reply = func(m, action string, params any) (any, error) {
		if action != agentproto.HistoryAdopt {
			return nil, &plugin.Error{Code: "bad_params"}
		}
		switch params.(agentproto.HistoryAdoptParams).To {
		case "t9":
			return nil, &plugin.Error{Code: "not_found", Message: "history: no such terminal"}
		case "t8":
			return nil, &plugin.Error{Code: "not_running", Message: "history: the terminal core is not running"}
		}
		return agentproto.HistoryAdoptResult{Adopted: true}, nil
	}
	do := func(q string) (*httptest.ResponseRecorder, *plugin.Call) {
		c := &plugin.Call{Machine: mc}
		w := httptest.NewRecorder()
		p.postAdopt(c, w, httptest.NewRequest(http.MethodPost, "/adopt"+q, nil))
		return w, c
	}
	for _, q := range []string{"", "?from=t1", "?to=t2", "?from=t1&to=t1", "?from=../t1&to=t2", "?from=t1&to=t2.prev",
		"?from=t1&to=" + strings.Repeat("a", 65), "?from=.lock&to=t2", "?from=t1&to=a%2Fb"} {
		if w, c := do(q); w.Code != http.StatusBadRequest || len(c.AuditFields()) != 0 {
			t.Errorf("%q: %d %v", q, w.Code, c.AuditFields())
		}
	}
	if n := len(f.taken()); n != 0 {
		t.Fatalf("the machine was asked %d times", n)
	}
	w, c := do("?from=t1&to=t2")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"adopted":true}` {
		t.Fatalf("adopt %d %s", w.Code, w.Body)
	}
	if a := c.AuditFields(); a["from"] != "t1" || a["to"] != "t2" || a["adopted"] != true {
		t.Errorf("audit %v", a)
	}
	calls := f.taken()
	if len(calls) != 1 || calls[0].params != (agentproto.HistoryAdoptParams{From: "t1", To: "t2"}) {
		t.Fatalf("asked %+v", calls)
	}
	for to, code := range map[string]string{"t9": "not_found", "t8": "not_running"} {
		w, c := do("?from=t1&to=" + to)
		want := httptest.NewRecorder()
		plugin.WriteError(want, &plugin.Error{Code: code})
		if w.Code != want.Code || !strings.Contains(w.Body.String(), `"`+code+`"`) || c.AuditFields()["adopted"] != nil {
			t.Errorf("%s: %d %s %v", to, w.Code, w.Body, c.AuditFields())
		}
	}
	if w, _ := func() (*httptest.ResponseRecorder, *plugin.Call) {
		c := &plugin.Call{}
		w := httptest.NewRecorder()
		p.postAdopt(c, w, httptest.NewRequest(http.MethodPost, "/adopt?from=t1&to=t2", nil))
		return w, c
	}(); w.Code != http.StatusConflict {
		t.Errorf("offline %d", w.Code)
	}
}

package usage

// The alerts the core fires: at most once per period of a window and
// threshold, whatever the numbers do between polls. The first tests are
// the ways alerts fired again and again when pages decided them (use
// jittering around a threshold, a reset time that moves, a pace alert
// whose reset is a second off, a "started over" from a second of drift,
// a window whose id changed when another came or went, machines answering
// in turn).

import (
	"context"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"

	"veldr/internal/settings"
	"veldr/internal/usage"
)

// alertRun polls one account whose windows each poll sets.
type alertRun struct {
	t   *testing.T
	p   *Plugin
	now time.Time
	ws  []usage.Window
	// pace counts pace alerts too (use that rises fast runs out early).
	pace bool
}

const t0 = 1_800_000_000

func newAlertRun(t *testing.T, thresholds ...string) *alertRun {
	r := &alertRun{t: t, now: time.Unix(t0, 0)}
	r.p, _ = testPlugin(t, &r.now, []string{"local"}, func(string, usage.Options) ([]usage.Account, error) {
		return []usage.Account{{Provider: usage.Antigravity, ID: "h1", Status: usage.StatusOK, Windows: r.ws, AsOf: r.now.Unix()}}, nil
	})
	if len(thresholds) > 0 {
		l := make([]any, len(thresholds))
		for i, s := range thresholds {
			l[i] = s
		}
		if err := r.p.settings().Set(SettingThresholds, "", l); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

// poll reads ws at the time at (seconds after t0) and returns the alerts
// fired, as kind or kind:threshold (pace only with r.pace).
func (r *alertRun) poll(at int64, ws ...usage.Window) []string {
	r.t.Helper()
	r.now, r.ws = time.Unix(t0+at, 0), ws
	r.p.Poll(context.Background())
	var out []string
	for _, a := range r.p.Snapshot().Alerts {
		if a.At == r.now.Unix() && (r.pace || a.Kind != AlertPace) {
			s := a.Kind
			if a.Threshold > 0 {
				s += ":" + strconv.Itoa(a.Threshold)
			}
			out = append(out, s)
		}
	}
	return out
}

// fired counts the alerts of all polls.
func fired(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}

func equal(a, b []string) bool { return slices.Equal(a, b) }

func TestAlertsUseJitteringAroundAThreshold(t *testing.T) {
	r := newAlertRun(t, "80")
	var got []string
	for i, pct := range []float64{80.4, 79.6, 80.2, 79.9, 80.1, 79.0, 81} {
		got = fired(got, r.poll(int64(i)*300, win(usage.KindWeekly, pct, t0+86400, 604800)))
	}
	if !equal(got, []string{"threshold:80"}) {
		t.Errorf("fired %v", got)
	}
}

func TestAlertsResetMovingForward(t *testing.T) {
	r := newAlertRun(t, "80")
	var got []string
	// A rolling window: its reset moves 4 minutes at each 5-minute poll.
	for i := int64(0); i < 12; i++ {
		got = fired(got, r.poll(i*300, win(usage.KindSession, 85, t0+3600+i*240, 18000)))
	}
	if !equal(got, []string{"threshold:80"}) {
		t.Fatalf("fired %v", got)
	}
	// Once the period it fired in is over, the next one may fire.
	if got := r.poll(12*300+60, win(usage.KindSession, 85, t0+3600+12*240+60, 18000)); !equal(got, []string{"threshold:80"}) {
		t.Errorf("next period: %v", got)
	}
}

func TestAlertsPaceWithAResetASecondOff(t *testing.T) {
	r := newAlertRun(t, "95")
	r.pace = true
	var got []string
	// An hour into a 5-hour window, half used: it runs out before the
	// reset, which the provider says a second apart at each poll.
	for i, d := range []int64{0, 1, 0, 1, 0} {
		got = fired(got, r.poll(int64(i)*120, win(usage.KindSession, 50, t0+4*3600+d, 18000)))
	}
	if !equal(got, []string{"pace"}) {
		t.Errorf("fired %v", got)
	}
}

func TestAlertsNoStartedOverFromDrift(t *testing.T) {
	r := newAlertRun(t, "80")
	got := fired(
		r.poll(0, win(usage.KindWeekly, 85, t0+86400, 604800)),
		r.poll(300, win(usage.KindWeekly, 84.5, t0+86401, 604800)),
		r.poll(600, win(usage.KindWeekly, 85, t0+86400+300, 604800)),
	)
	if !equal(got, []string{"threshold:80"}) {
		t.Errorf("fired %v", got)
	}
}

func TestAlertsWindowsComingAndGoing(t *testing.T) {
	r := newAlertRun(t, "80")
	five := win(usage.KindSession, 85, t0+3600, 18000)
	one := win(usage.KindSession, 10, t0+600, 3600)
	got := fired(r.poll(0, five, one), r.poll(300, five), r.poll(500, five, one), r.poll(550, one, five))
	if !equal(got, []string{"threshold:80"}) {
		t.Errorf("fired %v", got)
	}
}

func TestAlertsMachinesAnsweringInTurn(t *testing.T) {
	now := time.Unix(t0, 0)
	turn := 0
	p, _ := testPlugin(t, &now, []string{"local", "box"}, func(m string, o usage.Options) ([]usage.Account, error) {
		a := usage.Account{Provider: usage.Claude, ID: "acc", Status: usage.StatusOK, AsOf: now.Unix(),
			Windows: []usage.Window{win(usage.KindWeekly, 85, t0+86400, 604800)}}
		for _, k := range o.Skip {
			if k == a.Key() {
				return []usage.Account{{Provider: usage.Claude, ID: "acc", Status: usage.StatusSkipped}}, nil
			}
		}
		// The machines take turns having an expired sign-in.
		if (m == "local") == (turn%2 == 1) {
			return []usage.Account{{Provider: usage.Claude, ID: "acc", Status: usage.StatusStale, Code: "token_expired"}}, nil
		}
		return []usage.Account{a}, nil
	})
	n := 0
	for turn = 0; turn < 6; turn++ {
		now = time.Unix(t0+int64(turn)*300, 0)
		p.Poll(context.Background())
		n = len(p.Snapshot().Alerts)
	}
	if n != 1 {
		t.Errorf("%d alerts", n)
	}
}

func TestAlertsNewPeriods(t *testing.T) {
	r := newAlertRun(t, "80", "95")
	if got := r.poll(0, win(usage.KindSession, 85, t0+3600, 18000)); !equal(got, []string{"threshold:80"}) {
		t.Fatalf("first: %v", got)
	}
	// The period ended unseen; the next one is over the threshold when
	// first read: it started over, and is at the threshold again.
	if got := r.poll(5000, win(usage.KindSession, 82, t0+3600+18000, 18000)); !equal(got, []string{"reset", "threshold:80"}) {
		t.Fatalf("next period: %v", got)
	}
	if got := r.poll(5300, win(usage.KindSession, 96, t0+3600+18000, 18000)); !equal(got, []string{"threshold:95"}) {
		t.Fatalf("95: %v", got)
	}
	// Started over early (a provider's reset): said once, and the
	// thresholds are armed for the new period.
	if got := r.poll(5600, win(usage.KindSession, 5, t0+5600+18000, 18000)); !equal(got, []string{"reset"}) {
		t.Fatalf("reset: %v", got)
	}
	if got := r.poll(5900, win(usage.KindSession, 6, t0+5600+18001, 18000)); len(got) != 0 {
		t.Fatalf("again: %v", got)
	}
	if got := r.poll(9000, win(usage.KindSession, 81, t0+5600+18000, 18000)); !equal(got, []string{"threshold:80"}) {
		t.Errorf("new period's threshold: %v", got)
	}
}

func TestAlertsWithoutAKnownReset(t *testing.T) {
	r := newAlertRun(t, "80")
	var got []string
	// Armed again only after falling 10 points below.
	for i, pct := range []float64{81, 75, 81, 69, 81} {
		got = fired(got, r.poll(int64(i)*300, win(usage.KindMonthly, pct, 0, 0)))
	}
	if !equal(got, []string{"threshold:80", "threshold:80"}) {
		t.Errorf("fired %v", got)
	}
}

func TestAlertsSwitchAndSnapshot(t *testing.T) {
	r := newAlertRun(t, "80")
	r.p.settings().Set(SettingAlerts, "", false)
	if got := r.poll(0, win(usage.KindWeekly, 90, t0+86400, 604800)); len(got) != 0 || len(r.p.Snapshot().Alerts) != 0 {
		t.Fatalf("off: %v", got)
	}
	// Turned on: what is over a threshold now is said once.
	r.p.settings().Set(SettingAlerts, "", true)
	if got := r.poll(300, win(usage.KindWeekly, 90, t0+86400, 604800)); !equal(got, []string{"threshold:80"}) {
		t.Fatalf("on: %v", got)
	}
	a := r.p.Snapshot().Alerts[0]
	if a.Key != "antigravity:h1" || a.Provider != usage.Antigravity || a.Window.UsedPct != 90 || a.Window.ID != "weekly|" || a.ID == "" {
		t.Errorf("alert %+v", a)
	}
	// Turned off again: the snapshot carries none.
	r.p.settings().Set(SettingAlerts, "", false)
	if n := len(r.p.Snapshot().Alerts); n != 0 {
		t.Errorf("%d alerts while off", n)
	}
	r.p.settings().Set(SettingAlerts, "", true)
	// A provider turned off: its alerts leave the snapshot.
	r.p.settings().Set(providerSetting(usage.Antigravity), "", false)
	if n := len(r.p.Snapshot().Alerts); n != 0 {
		t.Errorf("%d alerts of a provider off", n)
	}
	r.p.settings().Set(providerSetting(usage.Antigravity), "", true)
	// An hour later the snapshot no longer carries it.
	r.poll(300+3601, win(usage.KindWeekly, 91, t0+86400, 604800))
	if n := len(r.p.Snapshot().Alerts); n != 0 {
		t.Errorf("%d alerts after an hour", n)
	}
}

func TestAlertsKeptAcrossRestarts(t *testing.T) {
	now := time.Unix(t0, 0)
	dir := t.TempDir()
	reply := func(string, usage.Options) ([]usage.Account, error) {
		return []usage.Account{{Provider: usage.Claude, ID: "acc", Status: usage.StatusOK, AsOf: now.Unix(),
			Windows: []usage.Window{win(usage.KindWeekly, 85, t0+86400, 604800)}}}, nil
	}
	start := func() *Plugin {
		st := settings.New(filepath.Join(dir, "settings-dev.json"), Settings)
		p := New()
		p.host = &fakeHost{st: st}
		p.now = func() time.Time { return now }
		p.ready = func() []string { return []string{"local"} }
		tp, _ := testPlugin(t, &now, nil, reply)
		p.fetch = tp.fetch
		p.loadHistory(p.historyPath())
		return p
	}
	p := start()
	p.Poll(context.Background())
	if n := len(p.Snapshot().Alerts); n != 1 {
		t.Fatalf("%d alerts", n)
	}
	now = now.Add(2 * time.Hour)
	p = start()
	p.Poll(context.Background())
	if n := len(p.Snapshot().Alerts); n != 0 {
		t.Errorf("fired again after a restart: %d", n)
	}
}

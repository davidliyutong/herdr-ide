package usage

import (
	"slices"
	"sort"
	"strconv"
	"time"

	"veldr/internal/usage"
)

// The core decides when a window's alert fires, once for every page and
// app: a window that reached a threshold, one whose pace runs it out
// before its reset, one that started over after reaching the first
// threshold. Each fires at most once per period of its window, kept in
// the history file across restarts; the snapshot carries what fired in
// the last hour (Snapshot.Alerts), and each browser or app shows an alert
// once.
const (
	// samePeriod: resets this close are one period's (providers that say
	// how long until the reset give a time a few seconds off at each poll,
	// and rolling windows move it forward as they go).
	samePeriod = 10 * 60
	// alertHysteresis is how many points below a threshold a window
	// without a known reset must fall before it is armed again, and how far
	// the use of a window that started over before its reset must fall.
	alertHysteresis = 10.0
	// alertKeep is how long a fired alert stays in the snapshot.
	alertKeep = time.Hour
	// unknownPeriod is the period of a window that says neither its reset
	// nor its length.
	unknownPeriod = 7 * 24 * time.Hour
	// alertForget drops the record of an alert this long after its period.
	alertForget = 24 * time.Hour
)

// Alert kinds.
const (
	AlertThreshold = "threshold"
	AlertReset     = "reset"
	AlertPace      = "pace"
)

// Alert is a notification the pages show once.
type Alert struct {
	// ID tells the alert apart from every other one fired.
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Key is the account's.
	Key      string `json:"key"`
	Provider string `json:"provider"`
	Email    string `json:"email,omitempty"`
	// Window is the window as it was when the alert fired.
	Window    WindowView `json:"window"`
	Threshold int        `json:"threshold,omitempty"`
	At        int64      `json:"at"`
}

// alertRecord is what is kept of an alert that fired: the end of the
// period it fired in (Unix seconds).
type alertRecord struct {
	End int64 `json:"end"`
}

// alertsOn tells whether alerts fire (usage.alerts).
func (p *Plugin) alertsOn() bool {
	st := p.settings()
	return st == nil || st.Bool(SettingAlerts, "")
}

// thresholds are usage.thresholds as numbers, ascending.
func (p *Plugin) thresholds() []int {
	var out []int
	l := []string{"80", "95"}
	if st := p.settings(); st != nil {
		l, _ = st.GetFor(SettingThresholds, "").([]string)
	}
	for _, s := range l {
		if n, err := strconv.Atoi(s); err == nil && n >= 1 && n <= 100 && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out
}

// alertKeys tell an account's windows apart for their alerts, whatever
// other windows it has at a poll: kind, label and length (the ids of the
// snapshot add the length only where two windows share kind and label, so
// one could change when another comes or goes), and the place among
// windows that share all three.
func alertKeys(ws []usage.Window) []string {
	keys := make([]string, len(ws))
	seen := map[string]int{}
	for i, w := range ws {
		k := w.Kind + "|" + w.Label + "|" + strconv.FormatInt(w.WindowSec, 10)
		if n := seen[k]; n > 0 {
			keys[i] = k + "#" + strconv.Itoa(n)
		} else {
			keys[i] = k
		}
		seen[k]++
	}
	return keys
}

// periodEnd is when the period w is in ends: its reset, else its length
// (or unknownPeriod) from now.
func periodEnd(w usage.Window, now time.Time) int64 {
	switch {
	case w.ResetsAt > 0:
		return w.ResetsAt
	case w.WindowSec > 0:
		return now.Unix() + w.WindowSec
	}
	return now.Add(unknownPeriod).Unix()
}

// laterPeriod tells whether w is in a later period than the one rec fired
// in: that period ended, and w resets well after it (a reset a few minutes
// later is the same period's).
func laterPeriod(rec alertRecord, w usage.Window, now time.Time) bool {
	if now.Unix() < rec.End {
		return false
	}
	return w.ResetsAt == 0 || w.ResetsAt > rec.End+samePeriod
}

// startedOver tells whether w, read after old, is a new period: it resets
// well after old did, and old's reset has passed or its use fell
// alertHysteresis points (a period ended early).
func startedOver(old, w usage.Window, now time.Time) bool {
	if old.ResetsAt <= 0 || w.ResetsAt <= old.ResetsAt+samePeriod || w.UsedPct >= old.UsedPct {
		return false
	}
	return old.ResetsAt <= now.Unix() || w.UsedPct <= old.UsedPct-alertHysteresis
}

// fireAlerts finds the alerts of the accounts read in this poll (read),
// whose windows before it were prev; p.mu is held. The alerts fired are
// recorded and kept for the snapshot.
func (p *Plugin) fireAlerts(read map[string]bool, prev map[string][]usage.Window, now time.Time) {
	recs := p.history.Alerts
	if recs == nil {
		recs = map[string]alertRecord{}
		p.history.Alerts = recs
	}
	thresholds := p.thresholds()
	keys := make([]string, 0, len(read))
	for k := range read {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		a := p.accounts[k]
		if a == nil || a.view.Status != usage.StatusOK {
			continue
		}
		ws := a.view.Account.Windows
		ids, aks := windowIDs(ws), alertKeys(ws)
		before := map[string]usage.Window{}
		for i, pk := range alertKeys(prev[k]) {
			before[pk] = prev[k][i]
		}
		for i, w := range ws {
			if w.ResetsAt > 0 && w.ResetsAt <= now.Unix() {
				continue // past its reset: the numbers are of the period before
			}
			wk := k + "|" + aks[i]
			fire := func(kind string, th int) {
				view := WindowView{Window: w, ID: ids[i]}
				view.Pace = pace(w, p.history.first(k, ids[i], w, now), now)
				id := wk + "|" + kind
				if th > 0 {
					id += "|" + strconv.Itoa(th)
				}
				p.recent = append(p.recent, Alert{
					ID: id + "@" + strconv.FormatInt(now.Unix(), 10), Kind: kind, Key: k, Provider: a.view.Provider,
					Email: a.view.Email, Window: view, Threshold: th, At: now.Unix(),
				})
			}
			// A window that started over: a new period for its alerts.
			if old, ok := before[aks[i]]; ok && startedOver(old, w, now) {
				for _, th := range thresholds {
					delete(recs, wk+"|"+AlertThreshold+"|"+strconv.Itoa(th))
				}
				delete(recs, wk+"|"+AlertPace)
				if len(thresholds) > 0 && old.UsedPct >= float64(thresholds[0]) {
					rk := wk + "|" + AlertReset
					if rec, ok := recs[rk]; !ok || w.ResetsAt > rec.End+samePeriod {
						recs[rk] = alertRecord{End: w.ResetsAt}
						fire(AlertReset, 0)
					}
				}
			}
			end := periodEnd(w, now)
			for _, th := range thresholds {
				rk := wk + "|" + AlertThreshold + "|" + strconv.Itoa(th)
				rec, ok := recs[rk]
				// Without a reset to go by, below the threshold by the
				// hysteresis arms it again.
				if ok && w.ResetsAt == 0 && w.UsedPct <= float64(th)-alertHysteresis {
					delete(recs, rk)
					ok = false
				}
				if w.UsedPct >= float64(th) && (!ok || laterPeriod(rec, w, now)) {
					recs[rk] = alertRecord{End: end}
					fire(AlertThreshold, th)
				}
			}
			if pc := pace(w, p.history.first(k, ids[i], w, now), now); pc != nil && pc.BeforeReset && w.UsedPct < 100 {
				rk := wk + "|" + AlertPace
				if rec, ok := recs[rk]; !ok || laterPeriod(rec, w, now) {
					recs[rk] = alertRecord{End: end}
					fire(AlertPace, 0)
				}
			}
		}
	}
	p.pruneAlerts(now)
}

// pruneAlerts drops alerts older than alertKeep from the snapshot and
// records a day past their period; p.mu is held.
func (p *Plugin) pruneAlerts(now time.Time) {
	p.recent = slices.DeleteFunc(p.recent, func(a Alert) bool { return now.Unix()-a.At > int64(alertKeep.Seconds()) })
	for k, r := range p.history.Alerts {
		if now.Unix()-r.End > int64(alertForget.Seconds()) {
			delete(p.history.Alerts, k)
		}
	}
}

// recentAlerts are the alerts of the last alertKeep of the providers in
// on, none while alerts are off; p.mu is held.
func (p *Plugin) recentAlerts(on []string, alertsOn bool, now time.Time) []Alert {
	if !alertsOn {
		return nil
	}
	var out []Alert
	for _, a := range p.recent {
		if now.Unix()-a.At <= int64(alertKeep.Seconds()) && slices.Contains(on, a.Provider) {
			out = append(out, a)
		}
	}
	return out
}

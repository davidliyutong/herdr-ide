package usage

import (
	"encoding/json"
	"strconv"
	"time"

	"herdr-ide/internal/usage"
	"herdr-ide/internal/userfile"
)

const (
	// historyKeep is how long the history keeps a point.
	historyKeep = 30 * 24 * time.Hour
	// pointEvery is the least time between two points of a window whose
	// use did not change.
	pointEvery = 15 * time.Minute
	// maxPoints bounds the points a snapshot carries per window.
	maxPoints      = 60
	historyVersion = 1
)

// history is the windows' use over time, per account and window, and the
// accounts of the last poll (shown again after a restart).
type history struct {
	Version int `json:"version"`
	// Windows maps account key → window id (kind|label) → [time, used %].
	Windows  map[string]map[string][][2]float64 `json:"windows"`
	Accounts []AccountView                      `json:"accounts,omitempty"`
}

func newHistory() *history {
	return &history{Version: historyVersion, Windows: map[string]map[string][][2]float64{}}
}

// windowIDs are the ids of an account's windows: kind|label, and after
// another | the window's length when two windows share kind and label
// (Kimi's limits have no labels), and their place when that is shared too.
func windowIDs(ws []usage.Window) []string {
	ids := make([]string, len(ws))
	count := map[string]int{}
	for i, w := range ws {
		ids[i] = w.Kind + "|" + w.Label
		count[ids[i]]++
	}
	for i, w := range ws {
		if count[ids[i]] > 1 {
			ids[i] += "|" + strconv.FormatInt(w.WindowSec, 10)
		}
	}
	seen := map[string]int{}
	for i := range ids {
		if n := seen[ids[i]]; n > 0 {
			seen[ids[i]]++
			ids[i] += "#" + strconv.Itoa(n)
		} else {
			seen[ids[i]] = 1
		}
	}
	return ids
}

// record adds a point for each window of the accounts read in this poll
// (fresh, by key) with current numbers, and drops points older than
// historyKeep. Numbers kept from an earlier poll add none: they were not
// read again.
func (h *history) record(accs map[string]*account, fresh map[string]bool, now time.Time) {
	t := float64(now.Unix())
	for k, a := range accs {
		if !fresh[k] || a.view.Status != usage.StatusOK {
			continue
		}
		ws := h.Windows[k]
		if ws == nil {
			ws = map[string][][2]float64{}
			h.Windows[k] = ws
		}
		ids := windowIDs(a.view.Account.Windows)
		for i, w := range a.view.Account.Windows {
			id := ids[i]
			pts := ws[id]
			if n := len(pts); n > 0 && pts[n-1][1] == w.UsedPct && t-pts[n-1][0] < pointEvery.Seconds() {
				continue
			}
			ws[id] = append(pts, [2]float64{t, w.UsedPct})
		}
	}
	h.prune(now)
}

// prune drops points older than historyKeep, and accounts left without.
func (h *history) prune(now time.Time) {
	cut := float64(now.Add(-historyKeep).Unix())
	for k, ws := range h.Windows {
		for id, pts := range ws {
			i := 0
			for i < len(pts) && pts[i][0] < cut {
				i++
			}
			if i == len(pts) {
				delete(ws, id)
			} else if i > 0 {
				ws[id] = append([][2]float64(nil), pts[i:]...)
			}
		}
		if len(ws) == 0 {
			delete(h.Windows, k)
		}
	}
}

// points are the points of window w (id) of its current period (the last
// 7 days when its length is unknown), at most maxPoints, the newest kept.
func (h *history) points(key, id string, w usage.Window, now time.Time) [][2]float64 {
	pts := h.Windows[key][id]
	from := float64(now.Add(-7 * 24 * time.Hour).Unix())
	if w.ResetsAt > 0 && w.WindowSec > 0 {
		from = float64(w.ResetsAt - w.WindowSec)
	}
	var out [][2]float64
	for _, p := range pts {
		if p[0] >= from {
			out = append(out, p)
		}
	}
	if len(out) <= maxPoints {
		return out
	}
	// Every n-th point, and the last.
	step := float64(len(out)-1) / float64(maxPoints-1)
	thin := make([][2]float64, 0, maxPoints)
	for i := 0; i < maxPoints; i++ {
		thin = append(thin, out[int(float64(i)*step+0.5)])
	}
	thin[maxPoints-1] = out[len(out)-1]
	return thin
}

// loadHistory reads the history file and the accounts it kept.
func (p *Plugin) loadHistory(path string) {
	b, _, err := userfile.Read(path)
	if err != nil || len(b) == 0 {
		return
	}
	h := newHistory()
	if json.Unmarshal(b, h) != nil || h.Version != historyVersion {
		return
	}
	if h.Windows == nil {
		h.Windows = map[string]map[string][][2]float64{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	h.prune(p.now())
	p.history = h
	for _, v := range h.Accounts {
		if v.Key == "" || p.now().Sub(time.Unix(v.SeenAt, 0)) > forgetAfter {
			continue
		}
		v.Account.Windows = nil
		for _, w := range v.Windows {
			v.Account.Windows = append(v.Account.Windows, w.Window)
		}
		v.Windows = nil
		p.accounts[v.Key] = &account{view: v}
	}
}

// save writes the history file (0600, atomically).
func (p *Plugin) save() {
	path := p.historyPath()
	if path == "" {
		return
	}
	p.saveMu.Lock()
	defer p.saveMu.Unlock()
	p.mu.Lock()
	h := &history{Version: historyVersion, Windows: p.history.Windows, Accounts: make([]AccountView, 0, len(p.accounts))}
	for _, a := range p.accounts {
		v := a.view
		v.Windows = make([]WindowView, 0, len(v.Account.Windows))
		for _, w := range v.Account.Windows {
			v.Windows = append(v.Windows, WindowView{Window: w})
		}
		v.Account.Windows = nil
		h.Accounts = append(h.Accounts, v)
	}
	b, err := json.Marshal(h)
	p.mu.Unlock()
	if err != nil {
		return
	}
	if _, err := userfile.Write(path, b); err != nil {
		if h := p.getHost(); h != nil {
			h.Logger().Printf("usage: %v", err)
		}
	}
}

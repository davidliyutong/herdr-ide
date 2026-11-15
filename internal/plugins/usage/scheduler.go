package usage

import (
	"context"
	"encoding/json"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/usage"
)

const (
	// tick is how often the scheduler looks whether a poll is due.
	tick = 10 * time.Second
	// watchFor is how long a panel's GET ?watch=1 counts as open.
	watchFor = 3 * time.Minute
	// requestTimeout bounds one machine's limits action.
	requestTimeout = 60 * time.Second
	// forgetAfter drops accounts no machine reported for this long.
	forgetAfter = 7 * 24 * time.Hour
	// statusEvery is how often the status pages are asked.
	statusEvery = 10 * time.Minute
)

// WindowView is a window with its pace and recent history.
type WindowView struct {
	usage.Window
	Pace *Pace `json:"pace,omitempty"`
	// History is [time, used %] of the window's current period (at most
	// 60 points), for the burndown.
	History [][2]float64 `json:"history,omitempty"`
}

// Pace compares a window's use with its time.
type Pace struct {
	// ExpectedPct is the share of the window's time gone, in percent: use
	// above it runs ahead of an even pace.
	ExpectedPct float64 `json:"expectedPct"`
	// ExhaustsAt is when the window runs out at the current rate (Unix
	// seconds; 0: it does not, or the rate is unknown).
	ExhaustsAt int64 `json:"exhaustsAt,omitempty"`
	// BeforeReset: it runs out before it starts over.
	BeforeReset bool `json:"beforeReset,omitempty"`
}

// AccountView is an account as the UIs see it.
type AccountView struct {
	usage.Account
	Windows []WindowView `json:"windows"`
	// Key tells accounts apart: provider:id, or provider:@machine[:home]
	// for an account nothing identifies.
	Key string `json:"key"`
	// Machines are the machines the account was seen on.
	Machines []string `json:"machines"`
	// FetchedAt is when its numbers were last current (0: never).
	FetchedAt int64 `json:"fetchedAt,omitempty"`
	// SeenAt is when a machine last reported it.
	SeenAt int64 `json:"seenAt"`
}

// MachineView is how the last poll of a machine went.
type MachineView struct {
	Status string `json:"status"` // ok, error, offline
	Code   string `json:"code,omitempty"`
	At     int64  `json:"at"`
}

// StatusPage is a provider's status page.
type StatusPage struct {
	// Indicator is none, minor, major, critical or maintenance ("" for a
	// provider whose page is only linked).
	Indicator   string `json:"indicator,omitempty"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url"`
	At          int64  `json:"at,omitempty"`
}

// Snapshot is what GET /api/p/usage and the /ws messages carry.
type Snapshot struct {
	UpdatedAt int64                  `json:"updatedAt"`
	Refresh   string                 `json:"refresh"`
	Interval  int64                  `json:"interval"`
	NextAt    int64                  `json:"nextAt,omitempty"`
	Polling   bool                   `json:"polling"`
	Accounts  []AccountView          `json:"accounts"`
	Machines  map[string]MachineView `json:"machines"`
	Status    map[string]StatusPage  `json:"status"`
}

// account is what the scheduler keeps of an account.
type account struct {
	view      AccountView
	notBefore time.Time
}

// Plugin is the AI usage plugin.
type Plugin struct {
	host plugin.Host
	now  func() time.Time
	// fetch runs an action of the agent of machine m; ready lists the
	// machines connected (local first). Tests replace them.
	fetch func(ctx context.Context, m, action string, params, out any) error
	ready func() []string
	// statusClient asks the status pages.
	statusClient func(ctx context.Context, url string, out any) error

	mu        sync.Mutex
	accounts  map[string]*account
	machines  map[string]MachineView
	status    map[string]StatusPage
	history   *history
	updatedAt time.Time
	lastPoll  time.Time
	lastWatch time.Time
	polling   bool
	working   map[string]bool // machine|terminal of agents working
	costCache map[string]costEntry

	refresh chan struct{}
	saveMu  sync.Mutex
	// hostMu guards host, fetch and ready, which Start sets.
	hostMu sync.RWMutex
}

// New returns the plugin.
func New() *Plugin {
	p := &Plugin{
		now:      time.Now,
		accounts: map[string]*account{},
		machines: map[string]MachineView{},
		status:   map[string]StatusPage{},
		history:  newHistory(),
		working:  map[string]bool{},
		refresh:  make(chan struct{}, 1),
	}
	p.statusClient = fetchStatusJSON
	return p
}

func (p *Plugin) getHost() plugin.Host {
	p.hostMu.RLock()
	defer p.hostMu.RUnlock()
	return p.host
}

func (p *Plugin) settings() *settings.Store {
	if h := p.getHost(); h != nil {
		return h.Settings()
	}
	return nil
}

func (p *Plugin) enabled() bool {
	h := p.getHost()
	return h == nil || plugin.Enabled(h.Settings(), p)
}

// historyPath is usage-history[-<instance>].json beside the settings file.
func (p *Plugin) historyPath() string {
	st := p.settings()
	if st == nil || st.Path() == "" {
		return ""
	}
	sp := st.Path()
	return filepath.Join(filepath.Dir(sp), strings.Replace(filepath.Base(sp), "settings", "usage-history", 1))
}

// Start runs the scheduler until ctx ends (plugin.Starter).
func (p *Plugin) Start(ctx context.Context, h plugin.Host) {
	p.hostMu.Lock()
	p.host = h
	if p.fetch == nil {
		p.fetch = func(ctx context.Context, m, action string, params, out any) error {
			mc := h.Machines().Get(m)
			if mc == nil {
				return plugin.ErrOffline
			}
			return plugin.Request(ctx, mc, ID, action, params, out)
		}
	}
	if p.ready == nil {
		p.ready = func() []string { return readyMachines(h.Machines()) }
	}
	p.hostMu.Unlock()
	if path := p.historyPath(); path != "" {
		p.loadHistory(path)
	}
	cancel := h.Machines().Subscribe(p.onMachine, p.onAgent)
	defer cancel()
	t := time.NewTicker(tick)
	defer t.Stop()
	var lastStatus time.Time
	for {
		if p.enabled() {
			if p.now().Sub(lastStatus) >= statusEvery {
				lastStatus = p.now()
				go p.pollStatus(ctx)
			}
			if p.due() {
				p.Poll(ctx)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.refresh:
			if p.enabled() {
				p.Poll(ctx)
			}
		}
	}
}

// readyMachines are the machines with an agent, the local one first.
func readyMachines(mg *machines.Manager) []string {
	var local, other []string
	for _, st := range mg.States() {
		if st.Status != machines.StatusReady {
			continue
		}
		if st.Kind == machines.KindLocal {
			local = append(local, st.ID)
		} else {
			other = append(other, st.ID)
		}
	}
	return append(local, other...)
}

// readyList are the machines to ask (none before Start).
func (p *Plugin) readyList() []string {
	p.hostMu.RLock()
	ready := p.ready
	p.hostMu.RUnlock()
	if ready == nil {
		return nil
	}
	return ready()
}

// call runs an action of a machine's agent.
func (p *Plugin) call(ctx context.Context, m, action string, params, out any) error {
	p.hostMu.RLock()
	fetch := p.fetch
	p.hostMu.RUnlock()
	if fetch == nil {
		return plugin.ErrOffline
	}
	return fetch(ctx, m, action, params, out)
}

// onMachine forgets the agents of a machine that went away.
func (p *Plugin) onMachine(st machines.State) {
	if st.Status == machines.StatusReady {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for k := range p.working {
		if strings.HasPrefix(k, st.ID+"|") {
			delete(p.working, k)
		}
	}
}

// onAgent follows which coding agents are working (the adaptive refresh).
func (p *Plugin) onAgent(ev machines.AgentEvent) {
	var d struct {
		Terminal string `json:"terminal"`
		Status   any    `json:"agent_status"`
	}
	if json.Unmarshal(ev.Data, &d) != nil || d.Terminal == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	k := ev.Machine + "|" + d.Terminal
	if d.Status == "working" {
		p.working[k] = true
	} else {
		delete(p.working, k)
	}
}

func (p *Plugin) watch() {
	p.mu.Lock()
	p.lastWatch = p.now()
	p.mu.Unlock()
}

// Refresh asks for a poll now.
func (p *Plugin) Refresh() {
	select {
	case p.refresh <- struct{}{}:
	default:
	}
}

// interval is the current cadence; p.mu is held.
func (p *Plugin) interval() time.Duration {
	return Interval(p.refreshMode(), p.now().Sub(p.lastWatch) < watchFor, len(p.working) > 0)
}

// due tells whether a poll is due: the cadence has passed since the last
// one (and a machine is connected to ask).
func (p *Plugin) due() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	iv := p.interval()
	if iv == 0 || p.polling {
		return false
	}
	return p.lastPoll.IsZero() && len(p.readyList()) > 0 || !p.lastPoll.IsZero() && p.now().Sub(p.lastPoll) >= iv
}

// keyOf is how an account is told apart: provider:id, else per machine.
func keyOf(a usage.Account, machine string) string {
	if a.ID != "" {
		return a.Key()
	}
	k := a.Provider + ":@" + machine
	if a.Home != "" {
		k += ":" + a.Home
	}
	return k
}

// Poll asks every connected machine in turn; an account one machine
// reported is not asked again on the next (Options.Skip).
func (p *Plugin) Poll(ctx context.Context) {
	p.mu.Lock()
	if p.polling {
		p.mu.Unlock()
		return
	}
	p.polling = true
	ready := p.readyList()
	now := p.now()
	var skip []string
	for k, a := range p.accounts {
		if a.notBefore.After(now) && a.view.ID != "" {
			skip = append(skip, k)
		}
	}
	p.mu.Unlock()
	p.broadcast()

	opts := p.options()
	seen := map[string][]string{}
	results := map[string]MachineView{}
	type got struct {
		machine string
		acc     usage.Account
	}
	var fresh []got
	for _, m := range ready {
		o := opts
		o.Skip = slices.Clone(skip)
		var res struct {
			Accounts []usage.Account `json:"accounts"`
		}
		cctx, cancel := context.WithTimeout(ctx, requestTimeout)
		err := p.call(cctx, m, "limits", o, &res)
		cancel()
		if err != nil {
			code := "failed"
			if pe, ok := err.(*plugin.Error); ok {
				code = pe.Code
			}
			results[m] = MachineView{Status: "error", Code: code, At: p.now().Unix()}
			continue
		}
		results[m] = MachineView{Status: "ok", At: p.now().Unix()}
		for _, a := range res.Accounts {
			if a.Status == usage.StatusMissing {
				continue
			}
			k := keyOf(a, m)
			seen[k] = append(seen[k], m)
			if a.Status == usage.StatusSkipped {
				continue
			}
			fresh = append(fresh, got{m, a})
			if a.ID != "" && (a.Status == usage.StatusOK || a.RetryAfter > 0) {
				skip = append(skip, k)
			}
		}
	}

	p.mu.Lock()
	now = p.now()
	for _, g := range fresh {
		p.merge(keyOf(g.acc, g.machine), g.acc, now)
	}
	for k, ms := range seen {
		if a := p.accounts[k]; a != nil {
			a.view.Machines = ms
			a.view.SeenAt = now.Unix()
		}
	}
	for k, a := range p.accounts {
		if now.Sub(time.Unix(a.view.SeenAt, 0)) > forgetAfter {
			delete(p.accounts, k)
		}
	}
	for m, v := range results {
		p.machines[m] = v
	}
	for m := range p.machines {
		if !slices.Contains(ready, m) {
			p.machines[m] = MachineView{Status: "offline", At: p.machines[m].At}
		}
	}
	p.history.record(p.accounts, now)
	p.updatedAt, p.lastPoll, p.polling = now, now, false
	p.mu.Unlock()
	p.save()
	p.broadcast()
}

// merge takes a machine's answer for an account: numbers when it has
// them, else the last good numbers stay with the new status and code;
// p.mu is held.
func (p *Plugin) merge(key string, a usage.Account, now time.Time) {
	cur := p.accounts[key]
	if cur == nil {
		cur = &account{view: AccountView{Key: key}}
		p.accounts[key] = cur
	}
	if a.RetryAfter > 0 {
		cur.notBefore = now.Add(time.Duration(a.RetryAfter) * time.Second)
	}
	hasNumbers := len(a.Windows) > 0 || a.Credits != nil || len(a.Balances) > 0
	if a.Status == usage.StatusOK || hasNumbers && (cur.view.FetchedAt == 0 || a.AsOf >= cur.view.FetchedAt) {
		cur.view.Account = a
		cur.view.FetchedAt = a.AsOf
		if cur.view.FetchedAt == 0 {
			cur.view.FetchedAt = now.Unix()
		}
		return
	}
	// Keep the numbers; take the identity and the status.
	old := cur.view.Account
	cur.view.Account = a
	cur.view.Account.Windows, cur.view.Account.Credits, cur.view.Account.Balances, cur.view.Account.Available =
		old.Windows, old.Credits, old.Balances, old.Available
	cur.view.Account.Email = firstNonEmpty(a.Email, old.Email)
	cur.view.Account.Plan = firstNonEmpty(a.Plan, old.Plan)
	cur.view.Account.Source, cur.view.Account.AsOf = old.Source, old.AsOf
}

func firstNonEmpty(s ...string) string {
	for _, x := range s {
		if x != "" {
			return x
		}
	}
	return ""
}

// Snapshot is the current state for the UIs.
func (p *Plugin) Snapshot() Snapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	s := Snapshot{
		UpdatedAt: p.updatedAt.Unix(), Refresh: p.refreshMode(), Polling: p.polling,
		Accounts: []AccountView{}, Machines: map[string]MachineView{}, Status: map[string]StatusPage{},
	}
	if p.updatedAt.IsZero() {
		s.UpdatedAt = 0
	}
	iv := p.interval()
	s.Interval = int64(iv.Seconds())
	if iv > 0 && !p.lastPoll.IsZero() {
		s.NextAt = p.lastPoll.Add(iv).Unix()
	}
	for _, a := range p.accounts {
		v := a.view
		v.Windows = make([]WindowView, 0, len(a.view.Account.Windows))
		for _, w := range a.view.Account.Windows {
			pts := p.history.points(v.Key, w, now)
			v.Windows = append(v.Windows, WindowView{Window: w, Pace: pace(w, pts, now), History: pts})
		}
		v.Account.Windows = nil
		v.Machines = slices.Clone(v.Machines)
		s.Accounts = append(s.Accounts, v)
	}
	order := map[string]int{}
	for i, pr := range usage.Providers {
		order[pr] = i
	}
	sort.Slice(s.Accounts, func(i, j int) bool {
		a, b := s.Accounts[i], s.Accounts[j]
		if a.Provider != b.Provider {
			return order[a.Provider] < order[b.Provider]
		}
		return a.Key < b.Key
	})
	for k, v := range p.machines {
		s.Machines[k] = v
	}
	for k, v := range p.status {
		s.Status[k] = v
	}
	return s
}

func (p *Plugin) broadcast() {
	if h := p.getHost(); h != nil {
		h.Broadcast(ID, "", p.Snapshot())
	}
}

// pace compares w's use with its time gone and projects when it runs out
// at the rate of its history in this period (else since the period began).
func pace(w usage.Window, pts [][2]float64, now time.Time) *Pace {
	if w.ResetsAt <= 0 || w.WindowSec <= 0 {
		return nil
	}
	start := w.ResetsAt - w.WindowSec
	t := now.Unix()
	if t < start || t > w.ResetsAt {
		return nil
	}
	pc := &Pace{ExpectedPct: float64(t-start) / float64(w.WindowSec) * 100}
	if w.UsedPct >= 100 {
		pc.ExhaustsAt, pc.BeforeReset = t, true
		return pc
	}
	t0, u0 := float64(start), 0.0
	if len(pts) > 0 && pts[0][0] >= float64(start) && t-int64(pts[0][0]) >= 600 && pts[0][1] <= w.UsedPct {
		t0, u0 = pts[0][0], pts[0][1]
	}
	dt := float64(t) - t0
	if dt <= 0 || w.UsedPct <= u0 {
		return pc
	}
	rate := (w.UsedPct - u0) / dt
	pc.ExhaustsAt = t + int64((100-w.UsedPct)/rate)
	pc.BeforeReset = pc.ExhaustsAt < w.ResetsAt
	return pc
}

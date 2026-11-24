package usage

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/settings"
	"veldr/internal/usage"
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
	// minRefreshGap is the least time between polls a manual refresh
	// (POST refresh, a new DeepSeek key) makes: requests sooner wait for
	// it and share that poll.
	minRefreshGap = 30 * time.Second
)

// WindowView is a window with its pace.
type WindowView struct {
	usage.Window
	// ID tells the account's windows apart: kind|label, with the length
	// where two share them.
	ID   string `json:"id"`
	Pace *Pace  `json:"pace,omitempty"`
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
	// Issues are the machines whose answer for it was not ok in the poll
	// that last read it (a sign-in expired there), while the account's
	// numbers and status come from the best answer.
	Issues []Issue `json:"issues,omitempty"`
}

// Issue is a machine whose answer for an account was not ok.
type Issue struct {
	Machine string `json:"machine"`
	Status  string `json:"status"`
	Code    string `json:"code,omitempty"`
}

// answerRank orders a poll's answers for one account, the best first:
// numbers from the provider, then numbers from elsewhere (a log), then an
// expired sign-in, a failed request, a refused sign-in.
func answerRank(a usage.Account) int {
	switch {
	case a.Status == usage.StatusOK:
		return 0
	case len(a.Windows) > 0 || a.Credits != nil || len(a.Balances) > 0:
		return 1
	case a.Status == usage.StatusStale:
		return 2
	case a.Status == usage.StatusError:
		return 3
	}
	return 4
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
	// Alerts are the alerts fired in the last hour (none while
	// usage.alerts is off); a page shows each once.
	Alerts []Alert `json:"alerts,omitempty"`
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
	// machineCosts keeps each machine's last CostReport and ETag so
	// unchanged scans transfer only {notModified: true} over SSH, and
	// disabled or offline machines keep their historical cost statistics.
	machineCosts         map[string]machineCostEntry
	machineCostsLoaded   bool
	machineCostsReadOnly bool
	// recent are the alerts fired in the last alertKeep.
	recent []Alert
	// costFlights are the machines' scans in progress.
	costFlights map[string]*costFlight
	// refreshPending: a manual refresh waits for minRefreshGap.
	refreshPending bool
	// readyNow are the machines connected; joined those that connected
	// since the last poll, asked on their own at the next tick.
	readyNow map[string]bool
	joined   map[string]bool

	refresh chan struct{}
	// refreshTimer wakes the scheduler when a pending refresh is due.
	refreshTimer *time.Timer
	saveMu       sync.Mutex
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
		readyNow: map[string]bool{},
		joined:   map[string]bool{},
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

// persisted tells whether the history is kept in the core's database: the
// core has a settings file, beside which its database is.
func (p *Plugin) persisted() bool {
	st := p.settings()
	return st != nil && st.Path() != ""
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
	if p.persisted() {
		p.loadHistory()
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
			p.pollDue(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.refresh:
			if p.enabled() {
				p.pollDue(ctx)
			}
		}
	}
}

// pollDue polls every machine when that is due, else asks the machines
// that connected since the last poll.
func (p *Plugin) pollDue(ctx context.Context) {
	if p.due() {
		p.Poll(ctx)
	} else if ms := p.takeJoined(); len(ms) > 0 {
		p.poll(ctx, ms, true)
	}
}

// takeJoined are the machines that connected since the last poll and are
// still connected (none in manual mode or while a poll runs).
func (p *Plugin) takeJoined() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.polling || len(p.joined) == 0 || p.refreshMode() == RefreshManual {
		return nil
	}
	var out []string
	for _, m := range p.readyList() {
		if p.joined[m] {
			out = append(out, m)
		}
	}
	clear(p.joined)
	return out
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

// onMachine notes a machine that connected after the first poll, to ask
// it at the next tick, and forgets the agents of a machine that went away.
func (p *Plugin) onMachine(st machines.State) {
	p.mu.Lock()
	if st.Status == machines.StatusReady {
		joined := !p.readyNow[st.ID] && !p.lastPoll.IsZero()
		p.readyNow[st.ID] = true
		if joined {
			p.joined[st.ID] = true
		}
		p.mu.Unlock()
		if joined {
			p.wake()
		}
		return
	}
	defer p.mu.Unlock()
	delete(p.readyNow, st.ID)
	delete(p.joined, st.ID)
	for k := range p.working {
		if strings.HasPrefix(k, st.ID+"|") {
			delete(p.working, k)
		}
	}
}

// ForgetMachine drops cached state for a machine the user removed
// (plugin.MachineForgetter). Disabled machines are not forgotten so their
// historical usage statistics stay available while live polling stops.
func (p *Plugin) ForgetMachine(_ plugin.Host, id string) {
	p.mu.Lock()
	for k, e := range p.machineCosts {
		if e.Machine == id {
			delete(p.machineCosts, k)
		}
	}
	clear(p.costCache)
	delete(p.machines, id)
	delete(p.readyNow, id)
	delete(p.joined, id)
	for k := range p.working {
		if strings.HasPrefix(k, id+"|") {
			delete(p.working, k)
		}
	}
	p.mu.Unlock()
	p.deleteMachineCostsDB(id)
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

// Refresh asks for a poll as soon as minRefreshGap since the last one
// allows, and returns when that is; requests before then share it.
func (p *Plugin) Refresh() time.Time {
	p.mu.Lock()
	now := p.now()
	at := now
	if p.polling {
		at = now.Add(minRefreshGap)
	} else if !p.lastPoll.IsZero() && p.lastPoll.Add(minRefreshGap).After(now) {
		at = p.lastPoll.Add(minRefreshGap)
	}
	p.refreshPending = true
	if d := at.Sub(now); d > 0 {
		if p.refreshTimer != nil {
			p.refreshTimer.Stop()
		}
		p.refreshTimer = time.AfterFunc(d, p.wake)
	}
	p.mu.Unlock()
	if !at.After(now) {
		p.wake()
	}
	return at
}

// wake makes the scheduler look whether a poll is due.
func (p *Plugin) wake() {
	select {
	case p.refresh <- struct{}{}:
	default:
	}
}

// interval is the current cadence; p.mu is held.
func (p *Plugin) interval() time.Duration {
	return Interval(p.refreshMode(), p.now().Sub(p.lastWatch) < watchFor, len(p.working) > 0, p.cadence())
}

// due tells whether a poll is due: a machine is connected to ask, and a
// manual refresh is pending and minRefreshGap has passed, or the cadence
// has passed since the last poll.
func (p *Plugin) due() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.polling || len(p.readyList()) == 0 {
		return false
	}
	since := p.now().Sub(p.lastPoll)
	if p.refreshPending && (p.lastPoll.IsZero() || since >= minRefreshGap) {
		return true
	}
	iv := p.interval()
	if iv == 0 {
		return false
	}
	return p.lastPoll.IsZero() || since >= iv
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

// localSkip is the Options.SkipLocal entry of an account without an id:
// provider, or provider:home.
func localSkip(a usage.Account) string {
	if a.Home != "" {
		return a.Provider + ":" + a.Home
	}
	return a.Provider
}

// Poll asks every connected machine in turn; an account one machine
// reported is not asked again on the next (Options.Skip).
func (p *Plugin) Poll(ctx context.Context) { p.poll(ctx, nil, false) }

// poll asks machines in turn: every connected one, or with joined only
// those (machines that connected since the last poll), which skip the
// accounts read within the cadence and leave the cadence as it was.
func (p *Plugin) poll(ctx context.Context, only []string, joined bool) {
	p.mu.Lock()
	if p.polling {
		p.mu.Unlock()
		return
	}
	ready := p.readyList()
	now := p.now()
	showStart := p.updatedAt.IsZero() || p.refreshPending || now.Sub(p.lastWatch) < watchFor
	if joined {
		ready = only
	} else {
		p.refreshPending = false
		clear(p.joined)
	}
	if len(ready) == 0 {
		p.mu.Unlock()
		return
	}
	p.polling = true
	iv := p.interval()
	// Accounts a provider asked to wait for (Retry-After) are skipped
	// until then: by id on every machine, those without an id on theirs.
	// Machines that joined skip the accounts read within the cadence too.
	var skip []string
	local := map[string][]string{}
	for k, a := range p.accounts {
		recent := joined && a.view.ID != "" && a.view.Status == usage.StatusOK && now.Sub(time.Unix(a.view.FetchedAt, 0)) < iv
		if !a.notBefore.After(now) && !recent {
			continue
		}
		if a.view.ID != "" {
			skip = append(skip, k)
			continue
		}
		for _, m := range ready {
			if k == keyOf(a.view.Account, m) {
				local[m] = append(local[m], localSkip(a.view.Account))
			}
		}
	}
	p.mu.Unlock()
	if showStart {
		p.broadcast()
	}

	opts := p.options()
	seen := map[string][]string{}
	results := map[string]MachineView{}
	type got struct {
		machine string
		acc     usage.Account
	}
	// fresh are the answers with something to show; named every answer
	// that names its account (an id), skipped ones too.
	var fresh, named []got
	for _, m := range ready {
		o := opts
		o.Skip = slices.Clone(skip)
		o.SkipLocal = local[m]
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
			if a.ID != "" {
				named = append(named, got{m, a})
			}
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
	// Per account the best answer of this poll counts, whatever the order
	// the machines answered in: a sign-in that expired on one machine does
	// not hide the numbers another read. Machines whose answer was not ok
	// are the account's issues.
	best := map[string]got{}
	issues := map[string][]Issue{}
	var order []string
	for _, g := range fresh {
		k := keyOf(g.acc, g.machine)
		if g.acc.Status != usage.StatusOK {
			issues[k] = append(issues[k], Issue{Machine: g.machine, Status: g.acc.Status, Code: g.acc.Code})
		}
		b, ok := best[k]
		if !ok {
			order = append(order, k)
		}
		if !ok || answerRank(g.acc) < answerRank(b.acc) {
			best[k] = g
		}
	}
	read := map[string]bool{}
	prev := map[string][]usage.Window{}
	for _, k := range order {
		if a := p.accounts[k]; a != nil {
			prev[k] = a.view.Account.Windows
		}
		p.merge(k, best[k].acc, now)
		p.accounts[k].view.Issues = issues[k]
		read[k] = true
	}
	// An account seen lists the machines that saw it, and keeps those it
	// was seen on that did not answer this poll (or were not asked).
	for k, ms := range seen {
		if a := p.accounts[k]; a != nil {
			for _, m := range a.view.Machines {
				if results[m].Status != "ok" && !slices.Contains(ms, m) {
					ms = append(ms, m)
				}
			}
			a.view.Machines = ms
			a.view.SeenAt = now.Unix()
		}
	}
	// A machine that names an account it reported without an id before (an
	// id read later, or kept from an earlier version) replaces that
	// account at once, rather than showing both until forgetAfter; also
	// when it was told to skip the account another machine read first.
	for _, g := range named {
		stand := keyOf(usage.Account{Provider: g.acc.Provider, Home: g.acc.Home}, g.machine)
		if _, again := seen[stand]; !again {
			delete(p.accounts, stand)
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
	if !joined {
		for m := range p.machines {
			if !slices.Contains(ready, m) {
				p.machines[m] = MachineView{Status: "offline", At: p.machines[m].At}
			}
		}
	}
	p.history.record(p.accounts, read, now)
	if p.alertsOn() {
		p.fireAlerts(read, prev, now)
	}
	p.updatedAt, p.polling = now, false
	if !joined {
		p.lastPoll = now
	}
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

// Snapshot is the current state for the UIs: the accounts of the providers
// turned on.
func (p *Plugin) Snapshot() Snapshot {
	on := p.options().Providers
	alertsOn := p.alertsOn()
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
	if p.refreshPending && !p.lastPoll.IsZero() {
		if at := p.lastPoll.Add(minRefreshGap).Unix(); s.NextAt == 0 || at < s.NextAt {
			s.NextAt = at
		}
	}
	for _, a := range p.accounts {
		if !slices.Contains(on, a.view.Provider) {
			continue
		}
		v := a.view
		v.Windows = make([]WindowView, 0, len(a.view.Account.Windows))
		ids := windowIDs(a.view.Account.Windows)
		for i, w := range a.view.Account.Windows {
			v.Windows = append(v.Windows, WindowView{Window: w, ID: ids[i], Pace: pace(w, p.history.first(v.Key, ids[i], w, now), now)})
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
	s.Alerts = p.recentAlerts(on, alertsOn, now)
	return s
}

func (p *Plugin) broadcast() {
	if h := p.getHost(); h != nil {
		h.Broadcast(ID, "", p.Snapshot())
	}
}

// pace compares w's use with its time gone and projects when it runs out
// at the rate since from, the first point of its history in this period
// (else since the period began).
func pace(w usage.Window, from *[2]float64, now time.Time) *Pace {
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
	if from != nil && from[0] >= float64(start) && t-int64(from[0]) >= 600 && from[1] <= w.UsedPct {
		t0, u0 = from[0], from[1]
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

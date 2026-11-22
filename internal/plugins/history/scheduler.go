package history

import (
	"context"
	"errors"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

const (
	// tick is how often the scheduler looks whether a machine's capture is
	// due (history.interval is at least 10 s).
	tick = 5 * time.Second
	// captureTimeout bounds one capture of a machine.
	captureTimeout = 30 * time.Second
	// clearRetry is the wait before a clear that failed is asked again; it
	// doubles with each failure up to clearRetryMax. A clear is never given
	// up, and a machine that connects again is asked at once.
	clearRetry    = 30 * time.Second
	clearRetryMax = time.Hour
)

// Plugin is the terminal history plugin.
type Plugin struct {
	// hostMu guards host, call and ready, which Start sets (tests set call
	// and ready before).
	hostMu sync.RWMutex
	host   plugin.Host
	// call runs an action of machine m's agent; ready lists the machines
	// connected.
	call  func(ctx context.Context, m, action string, params, out any) error
	ready func() []string
	now   func() time.Time

	mu sync.Mutex
	// busy are the machines with a capture or a clear running: one at a
	// time per machine.
	busy map[string]bool
	// next is when a machine's next capture (or a failed clear's retry) is
	// due.
	next map[string]time.Time
	// on is per machine whether it keeps snapshots, as last seen:
	// history.capture with the plugin on.
	on map[string]bool
	// clearing are the machines whose snapshots are to go (observe).
	clearing map[string]pendingClear
	// connected are the machines that were connected at the last step.
	connected map[string]bool
	// failed is the code the last capture of a machine failed with,
	// logged when it changes.
	failed map[string]string
	wake   chan struct{}
}

// pendingClear is a machine's clear that is due or failed so far.
type pendingClear struct {
	// turnedOff: the scheduler saw the machine keep snapshots before (the
	// user turned them off): the clear is audited also when it removed
	// nothing.
	turnedOff bool
	// failures so far: the next one waits longer (clearWait).
	failures int
}

// New returns the plugin.
func New() *Plugin {
	return &Plugin{
		now:       time.Now,
		busy:      map[string]bool{},
		next:      map[string]time.Time{},
		on:        map[string]bool{},
		clearing:  map[string]pendingClear{},
		connected: map[string]bool{},
		failed:    map[string]string{},
		wake:      make(chan struct{}, 1),
	}
}

func (p *Plugin) getHost() plugin.Host {
	p.hostMu.RLock()
	defer p.hostMu.RUnlock()
	return p.host
}

func (p *Plugin) caller() func(ctx context.Context, m, action string, params, out any) error {
	p.hostMu.RLock()
	defer p.hostMu.RUnlock()
	return p.call
}

func (p *Plugin) readyList() []string {
	p.hostMu.RLock()
	ready := p.ready
	p.hostMu.RUnlock()
	if ready == nil {
		return nil
	}
	return ready()
}

// readyMachines are the machines with an agent.
func readyMachines(mg *machines.Manager) []string {
	var out []string
	for _, st := range mg.States() {
		if st.Status == machines.StatusReady {
			out = append(out, st.ID)
		}
	}
	return out
}

// Start runs the scheduler until ctx ends (plugin.Starter). Nothing is
// asked of a machine while the core is read-only; while the plugin is off,
// only the clears its machines' snapshots are due for.
func (p *Plugin) Start(ctx context.Context, h plugin.Host) {
	p.hostMu.Lock()
	p.host = h
	if p.call == nil {
		p.call = func(ctx context.Context, m, action string, params, out any) error {
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
	if st := h.Settings(); st != nil {
		st.OnChange(p.settingsChanged)
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		p.step(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.wake:
		}
	}
}

func (p *Plugin) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// machineSettings are a machine's history settings.
type machineSettings struct {
	capture bool
	every   time.Duration
	params  agentproto.HistoryCaptureParams
}

// intOf is a number setting of machine m within lo and hi.
func intOf(st *settings.Store, key, m string, def, lo, hi int) int {
	v, ok := st.GetFor(key, m).(float64)
	if !ok {
		return def
	}
	return max(lo, min(int(v), hi))
}

func settingsOf(st *settings.Store, m string) machineSettings {
	if st == nil {
		return machineSettings{}
	}
	return machineSettings{
		capture: st.Bool(SettingCapture, m),
		every:   time.Duration(intOf(st, SettingInterval, m, defaultInterval, MinInterval, MaxInterval)) * time.Second,
		params: agentproto.HistoryCaptureParams{
			Lines:         intOf(st, SettingLines, m, defaultLines, MinLines, MaxLines),
			MaxTerminals:  intOf(st, SettingMaxTerminals, m, defaultTerminals, MinTerminals, MaxTerminals),
			MaxTotalBytes: int64(intOf(st, SettingMaxTotalMB, m, defaultTotalMB, MinTotalMB, MaxTotalMB)) << 20,
			Days:          intOf(st, SettingDays, m, defaultDays, MinDays, MaxDays),
		},
	}
}

// keeps tells whether machine m keeps snapshots by st: history.capture
// with the plugin on. The plugin turned off counts as the setting turned
// off: its machines' snapshots go too.
func (p *Plugin) keeps(st *settings.Store, m string) bool {
	return st != nil && plugin.Enabled(st, p) && st.Bool(SettingCapture, m)
}

// observe notes whether machine m keeps snapshots. Its snapshots are to be
// cleared when it was seen keeping them and no longer does, and when it
// is seen the first time (connected) not keeping them: it may hold
// snapshots from before (the setting was turned off while the core was
// down, or in the settings file; the plugin is off), and a clear of a
// machine without any changes nothing. p.mu is held.
func (p *Plugin) observe(m string, on bool) {
	prev, seen := p.on[m]
	switch {
	case seen && prev && !on:
		pc := p.clearing[m]
		pc.turnedOff = true
		p.clearing[m] = pc
		delete(p.next, m)
	case !seen && !on:
		if _, ok := p.clearing[m]; !ok {
			p.clearing[m] = pendingClear{}
		}
	}
	p.on[m] = on
}

// settingsChanged notes history.capture or the plugin turned off for
// machines the scheduler has seen, at once: also when it is turned on
// again before the next tick, the snapshots taken so far go.
func (p *Plugin) settingsChanged(changes []settings.Change) {
	touched := false
	for _, c := range changes {
		touched = touched || c.Key == SettingCapture || c.Key == plugin.EnableSetting(p)
	}
	h := p.getHost()
	if !touched || h == nil || h.Settings() == nil {
		return
	}
	st := h.Settings()
	p.mu.Lock()
	ms := make([]string, 0, len(p.on))
	for m := range p.on {
		ms = append(ms, m)
	}
	p.mu.Unlock()
	now := map[string]bool{}
	for _, m := range ms {
		now[m] = p.keeps(st, m)
	}
	p.mu.Lock()
	for m, on := range now {
		p.observe(m, on)
	}
	p.mu.Unlock()
	p.poke()
}

// step starts what is due: per connected machine, a clear of a machine
// whose snapshots are to go (observe), else a capture when its interval
// passed since its last one ended; one at a time per machine. A machine
// that connected again is asked for its pending clear at once. Nothing is
// asked of a read-only core's machines.
func (p *Plugin) step(ctx context.Context) {
	h := p.getHost()
	if h == nil {
		return
	}
	st := h.Settings()
	readOnly := h.ReadOnly()
	ms := p.readyList()
	all := make(map[string]machineSettings, len(ms))
	for _, m := range ms {
		s := settingsOf(st, m)
		s.capture = p.keeps(st, m)
		all[m] = s
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	connected := make(map[string]bool, len(ms))
	for _, m := range ms {
		connected[m] = true
		s := all[m]
		p.observe(m, s.capture)
		_, clearing := p.clearing[m]
		if clearing && !p.connected[m] && !p.busy[m] {
			delete(p.next, m)
		}
		if readOnly || p.busy[m] || now.Before(p.next[m]) {
			continue
		}
		if clearing {
			p.busy[m] = true
			go p.clear(ctx, m)
		} else if s.capture {
			p.busy[m] = true
			go p.capture(ctx, m, s)
		}
	}
	p.connected = connected
}

// codeOf is an error's code ("" for none).
func codeOf(err error) string {
	if err == nil {
		return ""
	}
	var pe *plugin.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "failed"
}

// capture asks machine m for a capture. Captures are not audited: they
// change only the machine's own snapshots, which the setting asked for.
func (p *Plugin) capture(ctx context.Context, m string, s machineSettings) {
	cctx, cancel := context.WithTimeout(ctx, captureTimeout)
	var res agentproto.HistoryCaptureResult
	err := p.caller()(cctx, m, agentproto.HistoryCapture, s.params, &res)
	cancel()
	code := codeOf(err)
	p.mu.Lock()
	delete(p.busy, m)
	if _, clearing := p.clearing[m]; !clearing {
		p.next[m] = p.now().Add(s.every)
	}
	changed := p.failed[m] != code
	if code == "" {
		delete(p.failed, m)
	} else {
		p.failed[m] = code
	}
	p.mu.Unlock()
	if h := p.getHost(); changed && code != "" && code != "offline" && h != nil && h.Logger() != nil {
		h.Logger().Printf("history: capture on %s: %v", m, err)
	}
}

// clearWait is the wait after a clear's failures-th failure.
func clearWait(failures int) time.Duration {
	d := clearRetry
	for i := 1; i < failures && d < clearRetryMax; i++ {
		d *= 2
	}
	return min(d, clearRetryMax)
}

// clear asks machine m to remove its snapshots because it no longer keeps
// them (observe); audited as history.clear when it is done, if the user
// turned them off or it removed some, before the machine is free for its
// next capture. One that fails is asked again later (clearWait), and at
// once when the machine connects again.
func (p *Plugin) clear(ctx context.Context, m string) {
	cctx, cancel := context.WithTimeout(ctx, clearTimeout)
	var res agentproto.HistoryClearResult
	err := p.caller()(cctx, m, agentproto.HistoryClear, agentproto.HistoryClearParams{}, &res)
	cancel()
	p.mu.Lock()
	pc := p.clearing[m]
	p.mu.Unlock()
	h := p.getHost()
	if err == nil && (pc.turnedOff || res.Removed > 0) && h != nil && ctx.Err() == nil {
		h.Audit(nil, ID+".clear", map[string]any{"plugin": ID, "machine": m, "reason": "capture_off", "removed": res.Removed})
	}
	if code := codeOf(err); err != nil && code != "offline" && ctx.Err() == nil && h != nil && h.Logger() != nil {
		h.Logger().Printf("history: clear on %s: %s", m, code)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.busy, m)
	if err == nil {
		delete(p.clearing, m)
		delete(p.next, m)
		return
	}
	pc.failures++
	p.clearing[m] = pc
	p.next[m] = p.now().Add(clearWait(pc.failures))
}

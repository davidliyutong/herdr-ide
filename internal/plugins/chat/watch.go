package chat

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
)

// maxFailures is how many watches in a row may fail before the core waits
// for the next use of the host, or the machine to connect again.
const maxFailures = 6

// watched is what the core knows of one machine's chat host and its watch
// of it. Its members are guarded by Plugin.mu.
type watched struct {
	id string
	// running: a goroutine runs a watch (cancel ends it); up: its stream
	// told the states, and they are current; since: when it came up;
	// dropping: the core ends it because the host has nothing to watch.
	running, up, dropping bool
	cancel                context.CancelFunc
	since                 time.Time

	// known: the states were read at least once since the core started;
	// states are every chat's, as last read; rev numbers the messages of
	// them (StatesData.Rev).
	known  bool
	states map[string]chatproto.ChatState
	rev    uint64
	// published is per chat the status and sequence number of its last
	// agent notification ("blocked@12").
	published map[string]string

	// due: a watch is to be tried, from retryAt on; failures counts those
	// that failed in a row. noChat: the machine has no chat host to give
	// (an agent of an older version): not tried until it connects again.
	// ready: the machine was connected at the last step. lastUse: when the
	// core last used the host for a route or a page.
	due      bool
	retryAt  time.Time
	failures int
	noChat   bool
	ready    bool
	lastUse  time.Time

	// configuring: a configure runs; configAgain: the settings changed
	// meanwhile.
	configuring, configAgain bool
	// configuredHost is the host process (hostID) that took the machine's
	// settings as they are; "" for none. A host started again takes them
	// anew: it starts without full access until a configure allows it.
	configuredHost string
}

// live tells whether a chat in state st has an agent process.
func live(st chatproto.ChatState) bool {
	switch st.State {
	case chatproto.StateStarting, chatproto.StateIdle, chatproto.StateWorking, chatproto.StateWaiting:
		return true
	}
	return false
}

func anyLive(states map[string]chatproto.ChatState) bool {
	for _, st := range states {
		if live(st) {
			return true
		}
	}
	return false
}

// machine is the record of machine m, made when there is none. p.mu is
// held.
func (p *Plugin) machine(m string) *watched {
	w := p.machines[m]
	if w == nil {
		w = &watched{id: m, states: map[string]chatproto.ChatState{}, published: map[string]string{}}
		p.machines[m] = w
	}
	return w
}

func (p *Plugin) readyList() []string {
	p.hostMu.RLock()
	ready, h := p.ready, p.host
	p.hostMu.RUnlock()
	if ready != nil {
		return ready()
	}
	if h == nil || h.Machines() == nil {
		return nil
	}
	var out []string
	for _, st := range h.Machines().States() {
		if st.Status == machines.StatusReady {
			out = append(out, st.ID)
		}
	}
	return out
}

func (p *Plugin) isReady(m string) bool {
	for _, id := range p.readyList() {
		if id == m {
			return true
		}
	}
	return false
}

func (p *Plugin) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// used notes that the core used machine m's chat host for a route or a
// page: the host serves, so a watch is due if none runs.
func (p *Plugin) used(m string) {
	p.mu.Lock()
	w := p.machine(m)
	w.lastUse = p.now()
	w.noChat = false
	if !w.running {
		w.due, w.retryAt, w.failures = true, time.Time{}, 0
	}
	p.mu.Unlock()
	p.poke()
}

// inUseAdd counts a page's subscription to machine m (n is 1 or -1).
func (p *Plugin) inUseAdd(m string, n int) {
	p.mu.Lock()
	p.inUse[m] += n
	if p.inUse[m] <= 0 {
		delete(p.inUse, m)
	}
	p.machine(m).lastUse = p.now()
	p.mu.Unlock()
}

// Start watches the machines' chat hosts until ctx ends (plugin.Starter).
func (p *Plugin) Start(ctx context.Context, h plugin.Host) {
	p.hostMu.Lock()
	p.host = h
	p.hostMu.Unlock()
	if st := h.Settings(); st != nil {
		st.OnChange(p.settingsChanged)
	}
	if mg := h.Machines(); mg != nil {
		defer mg.Subscribe(func(machines.State) { p.poke() }, func(machines.AgentEvent) {})()
	}
	t := time.NewTicker(p.tick)
	defer t.Stop()
	for {
		p.step(ctx)
		select {
		case <-ctx.Done():
			p.mu.Lock()
			for _, w := range p.machines {
				if w.running {
					w.cancel()
				}
			}
			p.mu.Unlock()
			// The core stops: the pages connect to the next one.
			p.closePages("")
			return
		case <-t.C:
		case <-p.wake:
		}
	}
}

// step starts the watches that are due and ends those of machines that
// left, of a plugin turned off, and of hosts that have nothing to watch:
// no chat with an agent process, no page's subscription and no use by the
// core for linger.
func (p *Plugin) step(ctx context.Context) {
	h := p.getHost()
	if h == nil {
		return
	}
	on := plugin.Enabled(h.Settings(), p)
	ready := map[string]bool{}
	if on {
		for _, m := range p.readyList() {
			ready[m] = true
		}
	}
	now := p.now()
	p.mu.Lock()
	turnedOn, turnedOff := on && !p.on, !on && p.on
	p.on = on
	for m := range ready {
		w := p.machine(m)
		if !w.ready || turnedOn {
			w.ready, w.due, w.noChat, w.failures, w.retryAt = true, true, false, 0, time.Time{}
		}
	}
	for m, w := range p.machines {
		if !ready[m] {
			w.ready = false
			if w.running {
				w.cancel()
			}
			if h.Machines() != nil && h.Machines().Get(m) == nil && !w.running {
				// A machine the user removed.
				delete(p.machines, m)
			}
			continue
		}
		if w.running {
			if w.up && !w.dropping && p.quiet(w, now) {
				w.dropping = true
				w.cancel()
			}
			continue
		}
		if !w.due || w.noChat || now.Before(w.retryAt) {
			continue
		}
		w.running, w.due = true, false
		wctx, cancel := context.WithCancel(ctx)
		w.cancel = cancel
		go p.watch(wctx, w)
	}
	p.mu.Unlock()
	if turnedOff {
		p.closePages(CodePluginDisabled)
	}
}

// quiet tells whether the core has nothing to watch on w's host: no chat
// with an agent process, no page's subscription, and no use for linger.
// p.mu is held.
func (p *Plugin) quiet(w *watched, now time.Time) bool {
	return !anyLive(w.states) && p.inUse[w.id] == 0 && now.Sub(w.lastUse) >= p.linger && now.Sub(w.since) >= p.linger
}

// watch runs one watch of w's host until it ends, and notes how it ended.
func (p *Plugin) watch(ctx context.Context, w *watched) {
	err := p.watchOnce(ctx, w)
	p.watchEnded(ctx, w, err)
	p.poke()
}

// watchOnce connects to the host without starting one, reads every chat's
// state and then each change until the stream ends.
func (p *Plugin) watchOnce(ctx context.Context, w *watched) error {
	c, err := p.dial(ctx, w.id, false, true)
	if err != nil {
		return err
	}
	defer c.Close()
	res, err := c.send(ctx, chatproto.Request{Op: chatproto.OpWatch})
	if err != nil {
		return err
	}
	p.watchUp(w, res.States)
	p.configure(ctx, w.id)
	for {
		line, err := chatproto.ReadLine(c.r)
		if err != nil {
			return transportError(ctx, err)
		}
		var st chatproto.ChatState
		if json.Unmarshal(line, &st) != nil || !chatproto.ValidChatID(st.ID) {
			continue
		}
		p.watchChange(w, st)
	}
}

// watchEnded notes how a watch ended and when the next one is due.
func (p *Plugin) watchEnded(ctx context.Context, w *watched, err error) {
	code := codeOf(err)
	h := p.getHost()
	p.mu.Lock()
	wasUp, dropping := w.up, w.dropping
	w.running, w.up, w.dropping = false, false, false
	var stale []chatproto.ChatState
	var rev uint64
	switch {
	case dropping:
		// The core ended it as the host had nothing to watch; a use since
		// makes the next one due.
		if !p.quiet(w, p.now()) {
			w.due = true
		}
	case ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded):
		// The core ended it: the machine left, the plugin was turned off,
		// the core stops.
	case code == codeNotRunning:
		// No host serves, so no agent runs: chats the core still knows
		// with one are sleeping now, the status of a turn that ran gone.
		for id, st := range w.states {
			if live(st) {
				st.State = chatproto.StateSleeping
				if st.Status != chatproto.StatusDone {
					st.Status = chatproto.StatusIdle
				}
				w.states[id] = st
				stale = append(stale, st)
			}
		}
		if len(stale) > 0 {
			w.rev++
			rev = w.rev
		}
	case code == "unknown_plugin" || code == chatproto.CodeUnsupported:
		w.noChat = true
	case wasUp:
		// The host ended or the stream broke: look again soon.
		w.due, w.retryAt = true, p.now().Add(p.again)
	default:
		w.failures++
		if w.failures < maxFailures {
			w.due, w.retryAt = true, p.now().Add(backoff(p.retry, w.failures))
		}
		if h != nil && h.Logger() != nil && code != "offline" {
			h.Logger().Printf("chat: watch of %s: %v", w.id, err)
		}
	}
	p.mu.Unlock()
	if len(stale) > 0 && h != nil {
		h.Broadcast(ID, w.id, StatesData{T: DataStates, States: sortStates(stale), Rev: rev})
	}
}

// backoff is the wait after the n-th failure in a row: first, doubled each
// time, at most 5 minutes.
func backoff(first time.Duration, n int) time.Duration {
	d := first
	for i := 1; i < n && d < 5*time.Minute; i++ {
		d *= 2
	}
	return min(d, 5*time.Minute)
}

// note is an agent notification to send.
type note struct {
	m  string
	st chatproto.ChatState
}

// publishes tells whether st, which follows old (had: the core knew the
// chat), is a notification: a chat that became blocked or done, never the
// same status at the same sequence number twice. Of the first states the
// core reads of a machine (initial), only the blocked ones are: what ended
// before the core started was told by the core of then, and what waits for
// the user is to be answered still. After a gap in the watch (gap: the
// states a watch read first, not the core's first), a chat done at a later
// sequence number than it was is a turn that ran and ended meanwhile, done
// again. p.mu is held.
func (p *Plugin) publishes(w *watched, st, old chatproto.ChatState, had, initial, gap bool) bool {
	if st.Status != chatproto.StatusBlocked && st.Status != chatproto.StatusDone {
		return false
	}
	key := st.Status + "@" + strconv.FormatUint(st.Seq, 10)
	doneAgain := gap && st.Status == chatproto.StatusDone && st.Seq > old.Seq
	switch {
	case w.published[st.ID] == key:
		return false
	case initial && st.Status != chatproto.StatusBlocked:
		return false
	case !initial && had && old.Status == st.Status && !doneAgain:
		return false
	}
	w.published[st.ID] = key
	return true
}

// watchUp takes the states a watch read first: every chat's.
func (p *Plugin) watchUp(w *watched, states []chatproto.ChatState) {
	p.mu.Lock()
	initial := !w.known
	prev := w.states
	w.states = make(map[string]chatproto.ChatState, len(states))
	var notes []note
	for _, st := range states {
		if !chatproto.ValidChatID(st.ID) || st.State == chatproto.StateDeleted {
			continue
		}
		w.states[st.ID] = st
		old, had := prev[st.ID]
		if p.publishes(w, st, old, had, initial, !initial) {
			notes = append(notes, note{w.id, st})
		}
	}
	for id := range w.published {
		if _, ok := w.states[id]; !ok {
			delete(w.published, id)
		}
	}
	w.known, w.up, w.since, w.failures = true, true, p.now(), 0
	w.rev++
	data := StatesData{T: DataStates, States: sortStates(mapValues(w.states)), Full: true, Rev: w.rev}
	p.mu.Unlock()
	p.tell(w.id, data, notes)
}

// watchChange takes a chat's new state.
func (p *Plugin) watchChange(w *watched, st chatproto.ChatState) {
	p.mu.Lock()
	old, had := w.states[st.ID]
	var notes []note
	if st.State == chatproto.StateDeleted {
		delete(w.states, st.ID)
		delete(w.published, st.ID)
	} else {
		w.states[st.ID] = st
		if p.publishes(w, st, old, had, false, false) {
			notes = append(notes, note{w.id, st})
		}
	}
	w.rev++
	data := StatesData{T: DataStates, States: []chatproto.ChatState{st}, Rev: w.rev}
	p.mu.Unlock()
	p.tell(w.id, data, notes)
}

// tell sends machine m's states to the pages, then the notifications. A
// machine's are sent by its one watch, in the order of their Rev.
func (p *Plugin) tell(m string, data StatesData, notes []note) {
	h := p.getHost()
	if h == nil {
		return
	}
	h.Broadcast(ID, m, data)
	mg := h.Machines()
	if mg == nil {
		return
	}
	for _, n := range notes {
		title := n.st.Kind
		if k, ok := agentkinds.ByID(n.st.Kind); ok {
			title = k.Title
		}
		raw, err := json.Marshal(map[string]any{"terminal": "", "chat": n.st.ID, "agent": n.st.Kind, "display_agent": title,
			"agent_status": n.st.Status, "title": n.st.Title})
		if err == nil {
			mg.PublishAgent(machines.AgentEvent{Machine: n.m, Data: raw})
		}
	}
}

func mapValues(m map[string]chatproto.ChatState) []chatproto.ChatState {
	out := make([]chatproto.ChatState, 0, len(m))
	for _, st := range m {
		out = append(out, st)
	}
	return out
}

// sortStates orders states as the host lists chats: the most recently
// updated first.
func sortStates(s []chatproto.ChatState) []chatproto.ChatState {
	sort.Slice(s, func(i, j int) bool {
		if !s[i].Updated.Equal(s[j].Updated) {
			return s[i].Updated.After(s[j].Updated)
		}
		return s[i].ID < s[j].ID
	})
	return s
}

// Snapshot is the states of every machine's chats the core read
// (StatesSnapshot).
func (p *Plugin) Snapshot() StatesSnapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := StatesSnapshot{Machines: map[string]StatesData{}}
	for m, w := range p.machines {
		if w.known {
			out.Machines[m] = StatesData{T: DataStates, States: sortStates(mapValues(w.states)), Full: true, Rev: w.rev}
		}
	}
	return out
}

// configure gives machine m's host its settings, unless the core is
// read-only; one at a time per machine, again when they changed meanwhile.
func (p *Plugin) configure(ctx context.Context, m string) {
	h := p.getHost()
	if h == nil || h.ReadOnly() {
		return
	}
	p.mu.Lock()
	w := p.machine(m)
	if w.configuring {
		w.configAgain = true
		p.mu.Unlock()
		return
	}
	w.configuring = true
	p.mu.Unlock()
	go func() {
		for {
			s := HostSettings(h.Settings(), m)
			cctx, cancel := context.WithTimeout(ctx, shortTimeout)
			err := p.configureOnce(cctx, m, s, false)
			cancel()
			if err != nil && ctx.Err() == nil && h.Logger() != nil && codeOf(err) != "offline" {
				h.Logger().Printf("chat: configure %s: %s", m, codeOf(err))
			}
			p.mu.Lock()
			again := w.configAgain && ctx.Err() == nil
			w.configAgain = false
			if !again {
				w.configuring = false
			}
			p.mu.Unlock()
			if !again {
				return
			}
		}
	}()
}

// configureOnce sends machine m's host the settings s; with start, to a
// host it starts when none serves. The host took them when it answered:
// that host process is the machine's configured one while the settings
// stay as they are.
func (p *Plugin) configureOnce(ctx context.Context, m string, s chatproto.HostSettings, start bool) error {
	c, err := p.dial(ctx, m, start, true)
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.send(ctx, chatproto.Request{Op: chatproto.OpConfigure, Settings: &s})
	if err == nil {
		h := p.getHost()
		p.mu.Lock()
		// Settings that changed meanwhile are configured again.
		if h != nil && HostSettings(h.Settings(), m) == s {
			p.machine(m).configuredHost = hostID(c.info)
		}
		p.mu.Unlock()
	}
	return err
}

// prepare configures machine m's host before a request that may start an
// agent (a chat's new agent, a prompt, a listing that runs the agent),
// with start starting the host, unless a host took the machine's settings
// as they are since the core started or the core is read-only: the agent
// starts under them (the full access allowed, the default mode). A
// failure is left to the request that follows.
func (p *Plugin) prepare(ctx context.Context, m string, start bool) {
	h := p.getHost()
	if h == nil || h.ReadOnly() {
		return
	}
	p.mu.Lock()
	w := p.machines[m]
	done := w != nil && w.configuredHost != ""
	p.mu.Unlock()
	if !done {
		cctx, cancel := context.WithTimeout(ctx, shortTimeout)
		p.configureOnce(cctx, m, HostSettings(h.Settings(), m), start)
		cancel()
	}
}

// ensureConfigured configures the host c is connected to when it is not
// the one that took the machine's settings (a host started again since,
// another build's), before c's request; nothing on a read-only core. A
// failure is left to the request.
func (p *Plugin) ensureConfigured(ctx context.Context, m string, c *hostConn) {
	h := p.getHost()
	if h == nil || h.ReadOnly() {
		return
	}
	p.mu.Lock()
	w := p.machines[m]
	done := w != nil && w.configuredHost == hostID(c.info)
	p.mu.Unlock()
	if !done {
		cctx, cancel := context.WithTimeout(ctx, shortTimeout)
		p.configureOnce(cctx, m, HostSettings(h.Settings(), m), false)
		cancel()
	}
}

// settingsChanged configures the watched hosts the changes concern, and
// looks at the watches when the plugin was turned on or off.
func (p *Plugin) settingsChanged(changes []settings.Change) {
	h := p.getHost()
	if h == nil {
		return
	}
	all, some := false, map[string]bool{}
	for _, c := range changes {
		switch {
		case c.Key == plugin.EnableSetting(p):
			p.poke()
		case strings.HasPrefix(c.Key, ID+"."):
			if c.Machine == "" {
				all = true
			} else {
				some[c.Machine] = true
			}
		}
	}
	if !all && len(some) == 0 {
		return
	}
	p.mu.Lock()
	var ms []string
	for m, w := range p.machines {
		if all || some[m] {
			w.configuredHost = ""
			if w.up {
				ms = append(ms, m)
			}
		}
	}
	p.mu.Unlock()
	for _, m := range ms {
		p.configure(context.Background(), m)
	}
}

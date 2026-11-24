//go:build unix

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"veldr/internal/agent/detect"
	"veldr/internal/agent/sessions"
	"veldr/internal/agentproto"
	"veldr/internal/hc"
)

// Which coding agents run in the terminal core's terminals and what they do
// (op detect, docs/features/25). It lasts as long as the core keeps the
// stream open, which it does while a client follows the machine's
// terminals: one connection to the terminal core with an event
// subscription, and for each terminal whose foreground program is an agent
// an observing attach (its output says when to read the screen again) and
// reads of the screen. With Header.Sessions it also finds the session each
// agent uses (agentdetect_session.go). Nothing is started and nothing is
// written to disk.

func (a *Agent) handleDetect(ctx context.Context, st net.Conn, h agentproto.Header) error {
	defer st.Close()
	c, err := net.DialTimeout("unix", a.hcSocket(), 5*time.Second)
	if err != nil {
		return agentproto.Fail(st, fmt.Errorf("terminal core: %w", err))
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn, _, err := hc.Dial(ctx, c)
	if err != nil {
		return agentproto.Fail(st, err)
	}
	defer conn.Close()
	events, sub, err := conn.Subscribe(ctx, hc.SubscribeParams{})
	if err != nil {
		return agentproto.Fail(st, err)
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		return err
	}
	// The core sends nothing more: the stream ends when it closes it.
	go func() {
		io.Copy(io.Discard, st)
		cancel()
	}()
	d := newDetector(ctx, conn, func(ev agentproto.DetectEvent) {
		if agentproto.WriteLine(st, ev) != nil {
			cancel()
		}
	})
	if h.Sessions {
		d.resolver = newResolver(a.home, d.peers)
	}
	defer d.stopAll()
	d.resync(sub.Terminals)
	for {
		// The terminal core sends a heartbeat every 15 s.
		rctx, rcancel := context.WithTimeout(ctx, 45*time.Second)
		n, err := events.Recv(rctx)
		rcancel()
		if err != nil {
			return nil
		}
		d.event(n)
	}
}

// detectCore is what the detector asks of the terminal core (*hc.Conn).
type detectCore interface {
	Attach(ctx context.Context, p hc.AttachParams) (*hc.Stream, *hc.Attached, error)
	Call(ctx context.Context, method string, params, result any) error
}

// detector follows the terminals of one terminal core.
type detector struct {
	ctx  context.Context
	conn detectCore
	// send writes one event to the core; only flush calls it.
	send func(agentproto.DetectEvent)
	// resolver finds the agents' sessions; nil when the stream was opened
	// without Header.Sessions, and then no session file is read.
	resolver sessionResolver
	// now and after are the clock of the trackers and of the sessions'
	// schedule (tests replace them).
	now   func() time.Time
	after func(time.Duration) <-chan time.Time

	mu    sync.Mutex
	terms map[string]*watched
	// queue holds the events made under mu, in the order they were made,
	// until flush sends them.
	queue []agentproto.DetectEvent

	// sendMu lets one flush run at a time, so an event never overtakes one
	// made before it.
	sendMu sync.Mutex

	// resolveMu lets one Resolve run at a time; resolving is the terminal
	// it runs for, which peers leaves out.
	resolveMu sync.Mutex
	resolving string
}

func newDetector(ctx context.Context, conn detectCore, send func(agentproto.DetectEvent)) *detector {
	return &detector{ctx: ctx, conn: conn, send: send, now: time.Now, after: time.After, terms: map[string]*watched{}}
}

// watched is a terminal as last known, with the agent in it.
type watched struct {
	rec     hc.Terminal
	agent   string
	tracker *detect.Tracker
	stop    context.CancelFunc
	// output counts output chunks seen by the observing attach.
	output atomic.Uint64
	// session is the session of the agent last found; every event of the
	// agent carries it.
	session sessions.Found
	// wake tells the agent's session goroutine that its status or its
	// process changed.
	wake chan struct{}
}

// watchable reports whether the detector looks for an agent in the
// terminal of record r: a live terminal's foreground process, unless the
// terminal is a helper's of the product's own (helperTerminal), of which
// no detection event ever reaches the core. Every walk over the terminals
// asks it.
func watchable(r *hc.Terminal) bool {
	return r.State == "live" && r.Foreground != nil && !helperTerminal(r)
}

// helperTerminal reports whether the terminal of record r is one of the
// product's own helpers that no client shows (agentproto.Hidden: the chat
// host's name and hidden label, both), as the core's terminal protocol
// decides it.
func helperTerminal(r *hc.Terminal) bool {
	name := ""
	if r.Name != nil {
		name = *r.Name
	}
	return agentproto.Hidden(name, r.Labels[agentproto.HiddenLabel])
}

// eventLocked is the event of terminal addr's agent with status, carrying
// the session last found; d.mu is held.
func (w *watched) eventLocked(addr, status string) agentproto.DetectEvent {
	return agentproto.DetectEvent{Terminal: addr, Agent: w.agent, Status: status,
		Session: w.session.ID, SessionSource: w.session.Source}
}

// pokeLocked wakes the agent's session goroutine, if it has one; d.mu is
// held.
func (w *watched) pokeLocked() {
	if w.wake == nil {
		return
	}
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// emitLocked queues events for flush; d.mu is held.
func (d *detector) emitLocked(evs ...agentproto.DetectEvent) {
	d.queue = append(d.queue, evs...)
}

// flush sends the queued events in the order they were made. It runs
// without d.mu, so a slow stream holds up only the callers of flush.
func (d *detector) flush() {
	d.sendMu.Lock()
	defer d.sendMu.Unlock()
	for {
		d.mu.Lock()
		evs := d.queue
		d.queue = nil
		d.mu.Unlock()
		if len(evs) == 0 {
			return
		}
		for _, ev := range evs {
			d.send(ev)
		}
	}
}

func (d *detector) resync(list []hc.Terminal) {
	d.mu.Lock()
	seen := map[string]bool{}
	for _, t := range list {
		seen[t.Address] = true
	}
	var gone []string
	for addr := range d.terms {
		if !seen[addr] {
			gone = append(gone, addr)
		}
	}
	d.mu.Unlock()
	for _, addr := range gone {
		d.remove(addr)
	}
	for _, t := range list {
		d.update(t.Address, func(r *hc.Terminal) { *r = t })
	}
}

func (d *detector) event(n hc.Notification) {
	switch n.Method {
	case "missed":
		d.resync(n.Terminals)
		return
	case "event":
	default:
		return
	}
	if n.Terminal == "" || n.Machine != "" {
		return
	}
	switch n.Type {
	case "created", "restarted":
		var t hc.Terminal
		if json.Unmarshal(n.Data, &t) == nil {
			d.update(n.Terminal, func(r *hc.Terminal) { *r = t })
		}
	case "removed":
		d.remove(n.Terminal)
	case "foreground":
		var fg *hc.Foreground
		json.Unmarshal(n.Data, &fg)
		d.update(n.Terminal, func(r *hc.Terminal) { r.Foreground = fg })
	case "finished":
		d.update(n.Terminal, func(r *hc.Terminal) { r.State, r.Foreground, r.Status = "finished", nil, nil })
	case "lost":
		d.update(n.Terminal, func(r *hc.Terminal) { r.Foreground = nil })
	case "status":
		var s struct {
			Status *hc.Status `json:"status"`
		}
		json.Unmarshal(n.Data, &s)
		d.update(n.Terminal, func(r *hc.Terminal) { r.Status = s.Status })
	case "title":
		var s struct {
			Title string `json:"title"`
		}
		json.Unmarshal(n.Data, &s)
		d.update(n.Terminal, func(r *hc.Terminal) { r.Title = s.Title })
	case "size":
		var s struct {
			Cols, Rows int
		}
		json.Unmarshal(n.Data, &s)
		d.update(n.Terminal, func(r *hc.Terminal) { r.Cols, r.Rows = s.Cols, s.Rows })
	}
}

func (d *detector) remove(addr string) {
	d.mu.Lock()
	w := d.terms[addr]
	delete(d.terms, addr)
	if w != nil && w.agent != "" {
		d.leaveLocked(addr, w, true)
	}
	d.mu.Unlock()
	d.flush()
}

// leaveLocked stops following w's agent: a turn it was in ended (done),
// then, with clear, the terminal has no agent (an event without agent,
// status and session); d.mu is held.
func (d *detector) leaveLocked(addr string, w *watched, clear bool) {
	if status, changed := w.tracker.Exit(); changed {
		d.emitLocked(w.eventLocked(addr, status))
	}
	w.stop()
	w.agent, w.tracker, w.stop, w.wake, w.session = "", nil, nil, nil, sessions.Found{}
	if clear {
		d.emitLocked(agentproto.DetectEvent{Terminal: addr})
	}
}

// update changes terminal addr's record and follows what that changes: the
// agent in its foreground, the status its program reports.
func (d *detector) update(addr string, change func(*hc.Terminal)) {
	d.mu.Lock()
	w := d.terms[addr]
	if w == nil {
		w = &watched{}
		d.terms[addr] = w
	}
	before := w.rec.Foreground
	change(&w.rec)
	w.rec.Address = addr
	agent := ""
	if watchable(&w.rec) {
		agent = detect.Identify(w.rec.Foreground.Name, w.rec.Foreground.Argv)
	}
	if agent != w.agent {
		if w.agent != "" {
			// An agent that replaces another needs no event without agent
			// between them.
			d.leaveLocked(addr, w, agent == "")
		}
		if agent != "" {
			ctx, cancel := context.WithCancel(d.ctx)
			w.agent, w.tracker, w.stop = agent, detect.NewTracker(detect.ManifestFor(agent), d.now()), cancel
			if w.rec.Status != nil {
				w.tracker.Report(w.rec.Status.State)
			}
			d.emitLocked(w.eventLocked(addr, w.tracker.Status()))
			go d.follow(ctx, addr, w, w.tracker)
			if d.resolver != nil && hasSessions(agent) {
				w.wake = make(chan struct{}, 1)
				go d.followSession(ctx, addr, w, w.tracker, w.wake)
			}
		}
	} else if agent != "" {
		state := ""
		if w.rec.Status != nil {
			state = w.rec.Status.State
		}
		if state != "" || w.tracker.SelfReported() {
			if status, changed := w.tracker.Report(state); changed {
				d.emitLocked(w.eventLocked(addr, status))
				w.pokeLocked()
			}
		}
		if !sameForeground(before, w.rec.Foreground) {
			w.pokeLocked()
		}
	}
	d.mu.Unlock()
	d.flush()
}

// sameForeground reports whether a and b are the same process with the
// same command line.
func sameForeground(a, b *hc.Foreground) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.PID == b.PID && slices.Equal(a.Argv, b.Argv)
}

func (d *detector) stopAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, w := range d.terms {
		if w.stop != nil {
			w.stop()
		}
	}
}

// follow reads the screen of terminal addr while tracker's agent runs
// there: every detect.Poll when output arrived since the last read, every
// detect.IdleRecheck while an idle reading waits for confirmation, never
// during the startup grace or while the program reports its own status.
func (d *detector) follow(ctx context.Context, addr string, w *watched, tracker *detect.Tracker) {
	d.mu.Lock()
	cols, rows := max(w.rec.Cols, 1), max(w.rec.Rows, 1)
	d.mu.Unlock()
	always := false
	st, _, err := d.conn.Attach(ctx, hc.AttachParams{Terminal: addr, Cols: cols, Rows: rows, Observe: true})
	if err != nil {
		always = true // no activity to go by: read on every poll
	} else {
		go func() {
			defer st.Close()
			for {
				o, err := st.Recv(ctx)
				if err != nil {
					return
				}
				if len(o.Data) > 0 {
					st.Ack(len(o.Data))
					w.output.Add(1)
				}
			}
		}()
	}
	read := ^uint64(0) // read once the grace is over
	for {
		d.mu.Lock()
		now := d.now()
		wait := detect.Poll
		if tracker.Pending() {
			wait = detect.IdleRecheck
		}
		if left := tracker.GraceLeft(now); left > 0 {
			wait = left
		}
		pending, self := tracker.Pending(), tracker.SelfReported()
		d.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if self {
			continue
		}
		out := w.output.Load()
		if out == read && !pending && !always {
			continue
		}
		read = out
		var res struct {
			Text string `json:"text"`
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := d.conn.Call(cctx, "terminal.read", map[string]any{"terminal": addr}, &res)
		cancel()
		if err != nil {
			continue
		}
		d.mu.Lock()
		if w.tracker != tracker { // another agent took over meanwhile
			d.mu.Unlock()
			return
		}
		if status, changed := tracker.Observe(d.now(), detect.Input{Screen: res.Text, Title: w.rec.Title}); changed {
			d.emitLocked(w.eventLocked(addr, status))
			w.pokeLocked()
		}
		d.mu.Unlock()
		d.flush()
	}
}

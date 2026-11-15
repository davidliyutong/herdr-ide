//go:build unix

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"herdr-ide/internal/agent/detect"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// Which coding agents run in the terminal core's terminals and what they do
// (op detect, docs/features/25). It lasts as long as the core keeps the
// stream open, which it does while a client follows the machine's
// terminals: one connection to the terminal core with an event
// subscription, and for each terminal whose foreground program is an agent
// an observing attach (its output says when to read the screen again) and
// reads of the screen. Nothing is started and nothing is written to disk.

func (a *Agent) handleDetect(ctx context.Context, st net.Conn) error {
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
	var wmu sync.Mutex
	d := &detector{ctx: ctx, conn: conn, terms: map[string]*watched{}, send: func(ev agentproto.DetectEvent) {
		wmu.Lock()
		defer wmu.Unlock()
		if agentproto.WriteLine(st, ev) != nil {
			cancel()
		}
	}}
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

// detector follows the terminals of one terminal core.
type detector struct {
	ctx  context.Context
	conn *hc.Conn
	send func(agentproto.DetectEvent)

	mu    sync.Mutex
	terms map[string]*watched
}

// watched is a terminal as last known, with the agent in it.
type watched struct {
	rec     hc.Terminal
	agent   string
	tracker *detect.Tracker
	stop    context.CancelFunc
	// output counts output chunks seen by the observing attach.
	output atomic.Uint64
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
	var evs []agentproto.DetectEvent
	if w != nil && w.agent != "" {
		evs = d.leaveLocked(addr, w)
	}
	d.mu.Unlock()
	for _, ev := range evs {
		d.send(ev)
	}
}

// leaveLocked stops following w's agent: a turn it was in ended (done),
// then the terminal has no agent; d.mu is held.
func (d *detector) leaveLocked(addr string, w *watched) []agentproto.DetectEvent {
	var evs []agentproto.DetectEvent
	if status, changed := w.tracker.Exit(); changed {
		evs = append(evs, agentproto.DetectEvent{Terminal: addr, Agent: w.agent, Status: status})
	}
	w.stop()
	w.agent, w.tracker, w.stop = "", nil, nil
	return append(evs, agentproto.DetectEvent{Terminal: addr})
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
	change(&w.rec)
	w.rec.Address = addr
	agent := ""
	if fg := w.rec.Foreground; fg != nil && w.rec.State == "live" {
		agent = detect.Identify(fg.Name, fg.Argv)
	}
	var evs []agentproto.DetectEvent
	if agent != w.agent {
		if w.agent != "" {
			evs = d.leaveLocked(addr, w)
		}
		if agent != "" {
			if len(evs) > 0 {
				evs = evs[:len(evs)-1] // an agent replaced another
			}
			ctx, cancel := context.WithCancel(d.ctx)
			w.agent, w.tracker, w.stop = agent, detect.NewTracker(detect.ManifestFor(agent), time.Now()), cancel
			if w.rec.Status != nil {
				w.tracker.Report(w.rec.Status.State)
			}
			evs = append(evs, agentproto.DetectEvent{Terminal: addr, Agent: agent, Status: w.tracker.Status()})
			go d.follow(ctx, addr, w)
		}
	} else if agent != "" {
		state := ""
		if w.rec.Status != nil {
			state = w.rec.Status.State
		}
		if state != "" || w.tracker.SelfReported() {
			if status, changed := w.tracker.Report(state); changed {
				evs = append(evs, agentproto.DetectEvent{Terminal: addr, Agent: agent, Status: status})
			}
		}
	}
	d.mu.Unlock()
	for _, ev := range evs {
		d.send(ev)
	}
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

// follow reads the screen of terminal addr while w's agent runs there:
// every detect.Poll when output arrived since the last read, every
// detect.IdleRecheck while an idle reading waits for confirmation, never
// during the startup grace or while the program reports its own status.
func (d *detector) follow(ctx context.Context, addr string, w *watched) {
	d.mu.Lock()
	cols, rows := max(w.rec.Cols, 1), max(w.rec.Rows, 1)
	tracker, agent := w.tracker, w.agent
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
		now := time.Now()
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
		status, changed := tracker.Observe(time.Now(), detect.Input{Screen: res.Text, Title: w.rec.Title})
		d.mu.Unlock()
		if changed {
			d.send(agentproto.DetectEvent{Terminal: addr, Agent: agent, Status: status})
		}
	}
}

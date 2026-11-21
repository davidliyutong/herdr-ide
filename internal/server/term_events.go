package server

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
	"herdr-ide/internal/machines"
)

func indexTerminals(list []map[string]any) map[string]map[string]any {
	out := make(map[string]map[string]any, len(list))
	for _, t := range list {
		if addr, _ := t["address"].(string); addr != "" {
			out[addr] = t
		}
	}
	return out
}

// event applies a notification to the backend's terminals, as herdr-core's
// API describes for each type, and forwards it to the subscribers.
func (b *termBackend) event(n hc.RawNotification) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch n.Method {
	case "missed":
		b.terms = indexTerminals(n.Terminals)
		for addr := range b.terms {
			b.mergeAgent(addr)
		}
		// The events missed may have ended terminals: the snapshot is the
		// whole state, so a parked stream of one gone or over ends too.
		for addr := range b.parked {
			if t := b.terms[addr]; t == nil || t["state"] != "live" {
				b.unpark(addr)
			}
		}
		for c := range b.subs {
			c.sendJSON(b.snapshotMsg())
		}
		return
	case "event":
	default:
		return
	}
	var data map[string]any
	json.Unmarshal(n.Data, &data)
	if n.Terminal != "" {
		t := b.terms[n.Terminal]
		switch n.Type {
		case "created", "restarted":
			b.terms[n.Terminal] = data
			b.mergeAgent(n.Terminal)
		case "removed":
			delete(b.terms, n.Terminal)
			b.unpark(n.Terminal)
		case "labels":
			if rec, ok := data["record"].(map[string]any); ok {
				b.terms[n.Terminal] = rec
				b.mergeAgent(n.Terminal)
			} else if t != nil {
				t["labels"] = data["labels"]
			}
		case "turn":
			if t != nil {
				t["turn"] = data["turn"]
				b.keepSeenLocked(n.Terminal)
			}
		default: // lost, keep, finished, status, title, size, foreground
			if t == nil {
				break
			}
			if n.Type == "foreground" {
				t["foreground"] = data
				if n.Data == nil || string(n.Data) == "null" {
					delete(t, "foreground")
				}
				break
			}
			for k, v := range data {
				t[k] = v
			}
			switch n.Type {
			case "finished":
				t["state"] = "finished"
				delete(t, "foreground")
				b.unpark(n.Terminal)
			case "lost":
				delete(t, "pid")
				delete(t, "foreground")
			case "status":
				// A done seen before its report reached the core.
				b.keepSeenLocked(n.Terminal)
			}
		}
	}
	msg := map[string]any{"t": "event", "m": b.id, "type": n.Type, "data": json.RawMessage(n.Data)}
	if n.Terminal != "" {
		msg["terminal"] = n.Terminal
	}
	if len(n.Data) == 0 {
		delete(msg, "data")
	}
	for c := range b.subs {
		c.sendJSON(msg)
	}
	// A record replaced by the event lacks the agent the core knows of:
	// clients get it again right behind.
	if ev, ok := b.agents[n.Terminal]; ok && n.Terminal != "" && (n.Type == "created" || n.Type == "restarted" || n.Type == "labels") {
		raw, _ := json.Marshal(map[string]any{"agent": ev.Agent, "agent_status": ev.Status})
		again := map[string]any{"t": "event", "m": b.id, "type": "agent", "terminal": n.Terminal, "data": json.RawMessage(raw)}
		for c := range b.subs {
			c.sendJSON(again)
		}
	}
}

// detect follows the coding agents in the machine's terminals through the
// agent (op detect) until ctx ends, trying again after 5 s when the stream
// fails.
func (b *termBackend) detect(ctx context.Context, mc *machines.Machine) {
	for ctx.Err() == nil {
		conn, _, err := mc.Open(ctx, agentproto.Header{Op: agentproto.OpDetect})
		if err == nil {
			stop := context.AfterFunc(ctx, func() { conn.Close() })
			for {
				var ev agentproto.DetectEvent
				if agentproto.ReadLine(conn, &ev) != nil {
					break
				}
				b.applyAgent(ev)
			}
			stop()
			conn.Close()
		}
		// What the stream said no longer holds: a new one says it again.
		b.mu.Lock()
		var cleared []agentproto.DetectEvent
		for addr := range b.agents {
			cleared = append(cleared, agentproto.DetectEvent{Terminal: addr})
		}
		b.mu.Unlock()
		for _, ev := range cleared {
			b.applyAgent(ev)
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

// applyAgent records a terminal's agent and status and tells the clients:
// subscribers of the terminal protocol get an "agent" event, /ws clients the
// agent message that notifications and sounds follow. A turn that ended
// (done) while a client has the terminal focused counts as seen: idle.
func (b *termBackend) applyAgent(ev agentproto.DetectEvent) {
	b.mu.Lock()
	prev, had := b.agents[ev.Terminal]
	if ev.Agent == "" {
		if !had {
			b.mu.Unlock()
			return
		}
		delete(b.agents, ev.Terminal)
	} else {
		// Seen: the terminal has a client's focus, or (the first word of a
		// new detection, after the core or the agent started again) the
		// program still reports the turn a client saw before.
		if ev.Status == "done" && (b.focusedLocked(ev.Terminal) || !had && b.seenBeforeLocked(ev.Terminal)) {
			ev.Status = "idle"
		}
		if had && prev == ev {
			b.mu.Unlock()
			return
		}
		b.agents[ev.Terminal] = ev
		b.keepSeenLocked(ev.Terminal)
	}
	b.mergeAgent(ev.Terminal)
	b.mu.Unlock()
	b.notifyAgent(ev)
}

// seenLabel is the terminal core's label that keeps which turn of a
// terminal's program a client saw end: the record's turn, when the program
// reports its own status (OSC 7501) and still says done. That report
// outlives the core: after the core or the agent starts again, a new
// detection reads it as a turn that just ended, and the label tells that
// it was seen. A turn that ends later has a higher number.
const seenLabel = "seen"

// reportedDoneLocked is the turn whose end terminal addr's program reports
// (its own status is done), "" when it reports no done; b.mu is held.
func (b *termBackend) reportedDoneLocked(addr string) string {
	t := b.terms[addr]
	if r, _ := t["reported"].(bool); !r {
		return ""
	}
	if st, _ := t["status"].(map[string]any); st == nil || st["state"] != "done" {
		return ""
	}
	turn, _ := t["turn"].(float64) // absent: 0
	return strconv.FormatUint(uint64(turn), 10)
}

// seenBeforeLocked reports whether the done terminal addr's program reports
// is the turn a client saw (seenLabel); b.mu is held.
func (b *termBackend) seenBeforeLocked(addr string) bool {
	turn := b.reportedDoneLocked(addr)
	labels, _ := b.terms[addr]["labels"].(map[string]any)
	return turn != "" && labels[seenLabel] == turn
}

// keepSeenLocked labels terminal addr with the turn its program reports as
// done while the core holds that turn seen (its agent idle), so the core
// still knows after it starts again; b.mu is held. The label call runs
// apart: the core's own event of the new label follows.
func (b *termBackend) keepSeenLocked(addr string) {
	ev, ok := b.agents[addr]
	turn := b.reportedDoneLocked(addr)
	conn := b.conn
	if !ok || ev.Status != "idle" || turn == "" || conn == nil || b.seenBeforeLocked(addr) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		params := map[string]any{"terminal": addr, "labels": map[string]string{seenLabel: turn}}
		if err := conn.Call(ctx, "terminal.label", params, nil); err != nil {
			b.s.logger.Printf("term %s: label %s seen: %v", b.id, addr, err)
		}
	}()
}

// seen marks a terminal's ended turn seen (a client focused it): done
// becomes idle.
func (b *termBackend) seen(addr string) {
	b.mu.Lock()
	ev, ok := b.agents[addr]
	if !ok || ev.Status != "done" {
		b.mu.Unlock()
		return
	}
	ev.Status = "idle"
	b.agents[addr] = ev
	b.mergeAgent(addr)
	b.keepSeenLocked(addr)
	b.mu.Unlock()
	b.notifyAgent(ev)
}

// notifyAgent sends a terminal's agent change to the subscribers (event
// "agent", data {agent, agent_status}, both null when no agent runs there)
// and to /ws as an agent message.
func (b *termBackend) notifyAgent(ev agentproto.DetectEvent) {
	var agent, status any
	if ev.Agent != "" {
		agent, status = ev.Agent, ev.Status
	}
	raw, _ := json.Marshal(map[string]any{"agent": agent, "agent_status": status})
	b.mu.Lock()
	msg := map[string]any{"t": "event", "m": b.id, "type": "agent", "terminal": ev.Terminal, "data": json.RawMessage(raw)}
	for c := range b.subs {
		c.sendJSON(msg)
	}
	title, _ := b.terms[ev.Terminal]["title"].(string)
	b.mu.Unlock()
	ws, err := json.Marshal(map[string]any{"terminal": ev.Terminal, "agent": agent, "display_agent": agent,
		"agent_status": status, "title": title})
	if err == nil {
		b.s.mg.PublishAgent(machines.AgentEvent{Machine: b.id, Data: ws})
	}
}

// mergeAgent writes a terminal's agent and status into its record; b.mu is
// held.
func (b *termBackend) mergeAgent(addr string) {
	t := b.terms[addr]
	if t == nil {
		return
	}
	if ev, ok := b.agents[addr]; ok {
		t["agent"], t["agent_status"] = ev.Agent, ev.Status
	} else {
		delete(t, "agent")
		delete(t, "agent_status")
	}
}

// focusedLocked reports whether a client has a stream of terminal addr
// with the focus; b.mu is held.
func (b *termBackend) focusedLocked(addr string) bool {
	for c := range b.subs {
		c.mu.Lock()
		for _, ts := range c.streams {
			if ts.machine == b.id && ts.terminal == addr && ts.focused {
				c.mu.Unlock()
				return true
			}
		}
		c.mu.Unlock()
	}
	return false
}

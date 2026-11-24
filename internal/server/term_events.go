package server

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
	"veldr/internal/hc"
	"veldr/internal/machines"
	"veldr/internal/plugin"
	agentsplugin "veldr/internal/plugins/agents"
)

// indexTerminals sorts the terminal core's terminals into those clients are
// told of, by address, and the addresses of the hidden ones
// (hiddenTerminal). The terminals of other machines the terminal core has
// (otherMachine) are in neither: they are none of the clients'.
func indexTerminals(list []map[string]any) (terms map[string]map[string]any, hidden map[string]bool) {
	terms, hidden = make(map[string]map[string]any, len(list)), map[string]bool{}
	for _, t := range list {
		addr, _ := t["address"].(string)
		switch {
		case addr == "" || otherMachine(addr):
		case hiddenTerminal(t):
			hidden[addr] = true
		default:
			terms[addr] = t
		}
	}
	return terms, hidden
}

// hiddenTerminal reports whether a terminal's record is the chat host's,
// which a machine's agent runs as a terminal so that it lives as the
// user's terminals do: named agentproto.ChatHostName and labeled
// agentproto.HiddenLabel with the value agentproto.HiddenChatHost. Both
// are needed: the terminal core gives the name to one live terminal at a
// time and clients cannot take it, so a program of the machine that sets
// the label on another terminal (labels are free-form) does not hide that
// terminal from the clients. The chat host is no terminal of the
// clients': it is in no snapshot, no event and no list they get, its agent
// is detected for nobody, and a call or an attach that names it is
// answered as for a terminal that does not exist.
func hiddenTerminal(rec map[string]any) bool {
	name, _ := rec["name"].(string)
	labels, _ := rec["labels"].(map[string]any)
	value, _ := labels[agentproto.HiddenLabel].(string)
	return agentproto.Hidden(name, value)
}

// hiddenRecord is hiddenTerminal for a decoded record.
func hiddenRecord(t *hc.Terminal) bool {
	name := ""
	if t.Name != nil {
		name = *t.Name
	}
	return agentproto.Hidden(name, t.Labels[agentproto.HiddenLabel])
}

// closeStreamsLocked ends the clients' streams of terminal addr, which
// became hidden, also those of clients that no longer follow the machine:
// their pumps tell the clients that they closed. b.mu is held.
func (b *termBackend) closeStreamsLocked(addr string) {
	b.unpark(addr)
	for ts := range b.streams {
		if ts.terminal == addr {
			go ts.st.Close()
		}
	}
}

// track has the backend know a client's stream of it until untrack, and
// reports whether its terminal is hidden by now (the stream is to end).
func (b *termBackend) track(ts *termStream) (hidden bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.streams == nil {
		b.streams = map[*termStream]bool{}
	}
	b.streams[ts] = true
	return b.hidden[ts.terminal]
}

// untrack forgets a stream that ended or that its client let go of.
func (b *termBackend) untrack(ts *termStream) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.streams, ts)
}

// concealLocked reports whether an event is about a hidden terminal, which
// is then none of the clients', and keeps b.hidden: a terminal that is
// created hidden, or becomes so (gets the label), is hidden, and the
// clients that knew it are told that it was removed and lose their streams
// of it; one that is hidden stays so until it is removed, whatever becomes
// of its labels. b.mu is held.
func (b *termBackend) concealLocked(n hc.RawNotification, data map[string]any) bool {
	if b.hidden[n.Terminal] {
		if n.Type == "removed" {
			delete(b.hidden, n.Terminal)
		}
		return true
	}
	rec := data // created, restarted: the terminal's record
	switch n.Type {
	case "created", "restarted":
	case "labels":
		// All its labels now; its name is in the record the clients have.
		rec = map[string]any{"labels": data["labels"], "name": b.terms[n.Terminal]["name"]}
		if r, ok := data["record"].(map[string]any); ok {
			rec = r
		}
	default:
		return false
	}
	if !hiddenTerminal(rec) {
		return false
	}
	if b.hidden == nil {
		b.hidden = map[string]bool{}
	}
	b.hidden[n.Terminal] = true
	delete(b.agents, n.Terminal)
	if _, known := b.terms[n.Terminal]; known {
		delete(b.terms, n.Terminal)
		gone := map[string]any{"t": "event", "m": b.id, "type": "removed", "terminal": n.Terminal, "data": json.RawMessage("{}")}
		for c := range b.subs {
			c.sendJSON(gone)
		}
	}
	// Streams attached before it was hidden, while it was not yet known as
	// hidden, or in the instant before.
	b.closeStreamsLocked(n.Terminal)
	return true
}

// event applies a notification to the backend's terminals, as herdr-core's
// API describes for each type, and forwards it to the subscribers.
func (b *termBackend) event(n hc.RawNotification) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch n.Method {
	case "missed":
		b.terms, b.hidden = indexTerminals(n.Terminals)
		for addr := range b.terms {
			b.mergeAgent(addr)
		}
		// What runs in a terminal hidden meanwhile is no longer the
		// clients' to know, and their streams of it end.
		for addr := range b.hidden {
			delete(b.agents, addr)
			b.closeStreamsLocked(addr)
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
	// Another machine's terminals and documents are none of the clients'.
	if otherMachine(n.Terminal) || n.Machine != "" {
		return
	}
	var data map[string]any
	json.Unmarshal(n.Data, &data)
	if n.Terminal != "" {
		if b.concealLocked(n, data) {
			return
		}
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
		again := b.agentMsg(ev)
		for c := range b.subs {
			c.sendJSON(again)
		}
	}
}

// detectSwitchPoll is how often an open detect stream checks whether the
// agents plugin was switched on or off: the stream is then opened again at
// once with the new Header.Sessions.
const detectSwitchPoll = time.Second

// sessionsOn reports whether the machines resolve the sessions of the
// agents in their terminals (Header.Sessions): while the agents plugin is
// on (a core without that plugin, as in tests, has it on).
func (s *Server) sessionsOn() bool {
	return s.pluginOn(agentsplugin.ID, plugin.Desktop)
}

// detectHeader is the header of a detect stream opened now.
func (b *termBackend) detectHeader() agentproto.Header {
	return agentproto.Header{Op: agentproto.OpDetect, Sessions: b.s.sessionsOn()}
}

// redetectGrace is how long after a detect stream opened again because the
// agents plugin was switched its events are compared with what the clients
// were told before (detect): the machine reports every agent at once when a
// stream opens.
const redetectGrace = 10 * time.Second

// detect follows the coding agents in the machine's terminals through the
// agent (op detect) until ctx ends, trying again after 5 s when the stream
// fails, and at once when the agents plugin was switched (sessionsOn). A
// switch makes the machine detect every agent again: what the clients were
// told of each terminal before is kept (applyDetected), so that the agents
// found again do not notify again of a turn's end, or a block, that they
// were told of, nor bring back a done that was seen.
func (b *termBackend) detect(ctx context.Context, mc *machines.Machine) {
	var told map[string]agentproto.DetectEvent
	for ctx.Err() == nil {
		h := b.detectHeader()
		switched := false
		conn, _, err := mc.Open(ctx, h)
		if err == nil {
			until := time.Now().Add(redetectGrace)
			done, exited := make(chan struct{}), make(chan struct{})
			go func() {
				defer close(exited)
				t := time.NewTicker(detectSwitchPoll)
				defer t.Stop()
				for {
					select {
					case <-done:
						return
					case <-ctx.Done():
						conn.Close()
						return
					case <-t.C:
						if b.s.sessionsOn() != h.Sessions {
							switched = true
							conn.Close()
							return
						}
					}
				}
			}()
			for {
				var ev agentproto.DetectEvent
				if agentproto.ReadLine(conn, &ev) != nil {
					break
				}
				if told != nil && time.Now().After(until) {
					told = nil
				}
				b.applyDetected(ev, told)
			}
			close(done)
			<-exited
			conn.Close()
		}
		// What the stream said no longer holds: a new one says it again.
		b.mu.Lock()
		var cleared []agentproto.DetectEvent
		told = nil
		if switched {
			told = make(map[string]agentproto.DetectEvent, len(b.agents))
		}
		for addr, ev := range b.agents {
			cleared = append(cleared, agentproto.DetectEvent{Terminal: addr})
			if told != nil {
				told[addr] = ev
			}
		}
		b.mu.Unlock()
		for _, ev := range cleared {
			b.applyAgent(ev)
		}
		if switched {
			continue
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}

// validSessionSource reports whether s is a source a machine may report a
// session with (agentproto's SessionFrom*).
func validSessionSource(s string) bool {
	switch s {
	case agentproto.SessionFromArgv, agentproto.SessionFromPID, agentproto.SessionFromFD,
		agentproto.SessionFromStart, agentproto.SessionFromHook, agentproto.SessionFromGuess:
		return true
	}
	return false
}

// checkSession drops what a machine said of a terminal's session unless it
// is a session id with a known source, for an agent.
func checkSession(ev *agentproto.DetectEvent) {
	if ev.Agent == "" || !agentkinds.ValidSessionID(ev.Session) || !validSessionSource(ev.SessionSource) {
		ev.Session, ev.SessionSource = "", ""
	}
}

// applyAgent records a terminal's agent, status and session and tells the
// clients: subscribers of the terminal protocol get an "agent" event, /ws
// clients the agent message that notifications and sounds follow. A turn
// that ended (done) while a client has the terminal focused counts as
// seen: idle. The machine changes an agent's session in an event of its
// own, which carries the status it already reported: such an event changes
// only the record's session and reaches only the terminal protocol's
// subscribers, as no news.
func (b *termBackend) applyAgent(ev agentproto.DetectEvent) {
	b.applyDetected(ev, nil)
}

// notifies reports whether an agent message of the status makes the pages
// notify (a sound, the system's notification): a block or a turn's end.
func notifies(status string) bool { return status == "blocked" || status == "done" }

// applyDetected is applyAgent for an event of a detect stream; told holds
// what the clients were told of the terminals before the stream opened
// again because the agents plugin was switched (nil otherwise), and is
// taken for each terminal by its first event. An agent found again by such
// an event keeps a done the clients saw (idle) and one they were told of,
// and a block or a turn's end they were told of reaches /ws no second time.
func (b *termBackend) applyDetected(ev agentproto.DetectEvent, told map[string]agentproto.DetectEvent) {
	before, again := told[ev.Terminal]
	if again {
		delete(told, ev.Terminal)
		again = ev.Agent != "" && before.Agent == ev.Agent
	}
	checkSession(&ev)
	b.mu.Lock()
	if b.hidden[ev.Terminal] || otherMachine(ev.Terminal) {
		// What runs in a hidden terminal, or on another machine of the
		// terminal core, is not the clients' to know.
		delete(b.agents, ev.Terminal)
		b.mu.Unlock()
		return
	}
	prev, had := b.agents[ev.Terminal]
	quiet := false
	if ev.Agent == "" {
		if !had {
			b.mu.Unlock()
			return
		}
		delete(b.agents, ev.Terminal)
	} else if had && prev.Agent == ev.Agent && (prev.Session != ev.Session || prev.SessionSource != ev.SessionSource) {
		// The status stays the core's (a done may have been seen since).
		prev.Session, prev.SessionSource = ev.Session, ev.SessionSource
		b.agents[ev.Terminal] = prev
		b.mergeAgent(ev.Terminal)
		msg := b.agentMsg(prev)
		for c := range b.subs {
			c.sendJSON(msg)
		}
		b.mu.Unlock()
		return
	} else {
		// The end of the turn the clients knew of before the switch, seen
		// or not.
		if again && !had && ev.Status == "done" && (before.Status == "idle" || before.Status == "done") {
			ev.Status = before.Status
		}
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
		quiet = again && !had && ev.Status == before.Status && notifies(ev.Status)
		b.agents[ev.Terminal] = ev
		b.keepSeenLocked(ev.Terminal)
	}
	b.mergeAgent(ev.Terminal)
	if quiet {
		// The record and the terminal protocol's subscribers get the agent
		// back; /ws was told of this state already.
		msg := b.agentMsg(ev)
		for c := range b.subs {
			c.sendJSON(msg)
		}
		b.mu.Unlock()
		return
	}
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

// agentMsg is the terminal protocol's event of a terminal's agent: data
// {agent, agent_status, agent_session, agent_session_source}, the first two
// null when no agent runs there, the last two null when its session is not
// known. Every member is there: a client that merges the event into its
// record loses a session that ended (another agent's, or none, or the
// agents plugin switched off).
func (b *termBackend) agentMsg(ev agentproto.DetectEvent) map[string]any {
	data := map[string]any{"agent": nil, "agent_status": nil, "agent_session": nil, "agent_session_source": nil}
	if ev.Agent != "" {
		data["agent"], data["agent_status"] = ev.Agent, ev.Status
		if ev.Session != "" {
			data["agent_session"], data["agent_session_source"] = ev.Session, ev.SessionSource
		}
	}
	raw, _ := json.Marshal(data)
	return map[string]any{"t": "event", "m": b.id, "type": "agent", "terminal": ev.Terminal, "data": json.RawMessage(raw)}
}

// notifyAgent sends a terminal's agent change to the subscribers (agentMsg)
// and to /ws as an agent message.
func (b *termBackend) notifyAgent(ev agentproto.DetectEvent) {
	var agent, status any
	if ev.Agent != "" {
		agent, status = ev.Agent, ev.Status
	}
	b.mu.Lock()
	msg := b.agentMsg(ev)
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

// mergeAgent writes a terminal's agent, status and session (agent_session,
// agent_session_source; absent when not known) into its record; b.mu is
// held.
func (b *termBackend) mergeAgent(addr string) {
	t := b.terms[addr]
	if t == nil {
		return
	}
	ev, ok := b.agents[addr]
	if ok {
		t["agent"], t["agent_status"] = ev.Agent, ev.Status
	} else {
		delete(t, "agent")
		delete(t, "agent_status")
	}
	if ok && ev.Session != "" {
		t["agent_session"], t["agent_session_source"] = ev.Session, ev.SessionSource
	} else {
		delete(t, "agent_session")
		delete(t, "agent_session_source")
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

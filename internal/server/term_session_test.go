package server

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"veldr/internal/agent/detect"
	"veldr/internal/agentproto"
	"veldr/internal/machines"
	"veldr/internal/plugin"
	agentsplugin "veldr/internal/plugins/agents"
	"veldr/internal/settings"
)

const (
	testSession1 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	testSession2 = "22222222-2222-4222-8222-222222222222"
)

// wsAgents collects the /ws agent messages of s's machines.
func wsAgents(s *Server) func() []string {
	var mu sync.Mutex
	var ws []string
	s.mg.Subscribe(func(machines.State) {}, func(ev machines.AgentEvent) {
		mu.Lock()
		ws = append(ws, string(ev.Data))
		mu.Unlock()
	})
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), ws...)
	}
}

// agentData is the data of the next agent event of terminal t1.
func (c *termConn) agentData() map[string]any {
	c.t.Helper()
	for {
		if m := c.until("event"); m["type"] == "agent" && m["terminal"] == "t1" {
			return m["data"].(map[string]any)
		}
	}
}

// record is terminal t1's record as a new subscriber of s gets it.
func record(t *testing.T, s *Server) map[string]any {
	t.Helper()
	c := dialTerm(t, s)
	c.send(map[string]any{"t": "sub", "m": "x"})
	for _, r := range c.until("snapshot")["terminals"].([]any) {
		if rec := r.(map[string]any); rec["address"] == "t1" {
			return rec
		}
	}
	t.Fatal("no record of t1")
	return nil
}

// wantSession checks a record's session: its members are there when it is
// known and absent when it is not.
func wantSession(t *testing.T, what string, m map[string]any, session, source string) {
	t.Helper()
	got, _ := m["agent_session"].(string)
	gotSource, _ := m["agent_session_source"].(string)
	_, has := m["agent_session"]
	_, hasSource := m["agent_session_source"]
	if got != session || gotSource != source || has != (session != "") || hasSource != (source != "") {
		t.Fatalf("%s: session %v", what, m)
	}
}

// wantEventSession checks an agent event's session: its members are always
// there, null when it is not known, so that a client that merges the event
// into its record loses a session that ended.
func wantEventSession(t *testing.T, what string, d map[string]any, session, source string) {
	t.Helper()
	v, has := d["agent_session"]
	vs, hasSource := d["agent_session_source"]
	switch {
	case !has || !hasSource:
		t.Fatalf("%s: an agent event without its session's members: %v", what, d)
	case session == "" && (v != nil || vs != nil):
		t.Fatalf("%s: session %v, want null", what, d)
	case session != "" && (v != session || vs != source):
		t.Fatalf("%s: session %v, want %s %s", what, d, session, source)
	}
}

// A terminal's session reaches its record and the terminal protocol's
// agent events; a change of the session alone is no news: no /ws message,
// and the status stays the core's (a done seen stays idle). Sessions that
// are not session ids with a known source are dropped.
func TestTermAgentSession(t *testing.T) {
	s, core, _ := termServer(t, Options{}, true)
	ws := wsAgents(s)
	c := dialTerm(t, s)
	c.ready()
	b := s.term.existing("x")

	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "working"})
	d := c.agentData()
	wantEventSession(t, "without a session", d, "", "")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "working", Session: testSession1, SessionSource: agentproto.SessionFromPID})
	d = c.agentData()
	if d["agent"] != "claude" || d["agent_status"] != "working" {
		t.Fatalf("session event %v", d)
	}
	wantEventSession(t, "session event", d, testSession1, agentproto.SessionFromPID)
	wantSession(t, "record", record(t, s), testSession1, agentproto.SessionFromPID)
	if got := ws(); len(got) != 1 {
		t.Fatalf("/ws messages after a session change %q", got)
	}

	// A status change carries the session and is news as before.
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done", Session: testSession1, SessionSource: agentproto.SessionFromPID})
	d = c.agentData()
	if d["agent_status"] != "done" {
		t.Fatalf("done %v", d)
	}
	wantEventSession(t, "done", d, testSession1, agentproto.SessionFromPID)
	if got := ws(); len(got) != 2 || !strings.Contains(got[1], `"agent_status":"done"`) || strings.Contains(got[1], "session") {
		t.Fatalf("/ws messages %q", got)
	}
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": "t1", "cols": 80, "rows": 24})
	sid := c.until("attached")["s"]
	c.send(map[string]any{"t": "focus", "s": sid, "focused": true})
	if d = c.agentData(); d["agent_status"] != "idle" {
		t.Fatalf("seen %v", d)
	}
	c.send(map[string]any{"t": "focus", "s": sid, "focused": false})
	c.send(map[string]any{"t": "ping", "rid": 2})
	c.until("pong")

	// The machine still says done when the session changes (/clear): the
	// turn stays seen.
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done", Session: testSession2, SessionSource: agentproto.SessionFromPID})
	d = c.agentData()
	if d["agent_status"] != "idle" {
		t.Fatalf("a session change brought the seen turn back: %v", d)
	}
	wantEventSession(t, "/clear", d, testSession2, agentproto.SessionFromPID)
	if got := ws(); len(got) != 3 {
		t.Fatalf("/ws messages after /clear %q", got)
	}

	// A record the core replaces gets the session again right behind.
	core.mu.Lock()
	notify := core.notify[0]
	core.mu.Unlock()
	notify(`{"jsonrpc":"2.0","method":"event","params":{"seq":3,"type":"labels","terminal":"t1","data":{"labels":{"a":"b"},"record":{"address":"t1","state":"live","cols":80,"rows":24,"labels":{"a":"b"}}}}}`)
	wantEventSession(t, "after labels", c.agentData(), testSession2, agentproto.SessionFromPID)
	wantSession(t, "record after labels", record(t, s), testSession2, agentproto.SessionFromPID)

	// What is not a session id with a known source is dropped.
	for _, bad := range []agentproto.DetectEvent{
		{Session: "../../etc/passwd", SessionSource: agentproto.SessionFromPID},
		{Session: strings.ToUpper(testSession1), SessionSource: agentproto.SessionFromPID},
		{Session: testSession1, SessionSource: "bogus"},
		{Session: testSession1},
	} {
		what := "dropped " + bad.Session + " " + bad.SessionSource
		b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done", Session: bad.Session, SessionSource: bad.SessionSource})
		wantEventSession(t, what, c.agentData(), "", "")
		wantSession(t, what, record(t, s), "", "")
		b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done", Session: testSession2, SessionSource: agentproto.SessionFromPID})
		wantEventSession(t, "valid again", c.agentData(), testSession2, agentproto.SessionFromPID)
	}
	if got := ws(); len(got) != 3 {
		t.Fatalf("/ws messages after dropped sessions %q", got)
	}

	// The agent leaves: no session either.
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "idle", Session: testSession1, SessionSource: agentproto.SessionFromArgv})
	c.agentData()
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1"})
	d = c.agentData()
	if d["agent"] != nil || d["agent_status"] != nil {
		t.Fatalf("cleared %v", d)
	}
	wantEventSession(t, "cleared", d, "", "")
	rec := record(t, s)
	if _, ok := rec["agent"]; ok {
		t.Fatalf("record %v", rec)
	}
	wantSession(t, "cleared record", rec, "", "")
}

func TestCheckSession(t *testing.T) {
	for _, c := range []struct {
		in   agentproto.DetectEvent
		keep bool
	}{
		{agentproto.DetectEvent{Agent: "claude", Session: testSession1, SessionSource: agentproto.SessionFromArgv}, true},
		{agentproto.DetectEvent{Agent: "codex", Session: testSession1, SessionSource: agentproto.SessionFromStart}, true},
		{agentproto.DetectEvent{Agent: "codex", Session: testSession1, SessionSource: agentproto.SessionFromFD}, true},
		{agentproto.DetectEvent{Agent: "claude", Session: testSession1, SessionSource: agentproto.SessionFromHook}, true},
		{agentproto.DetectEvent{Agent: "claude", Session: testSession1, SessionSource: agentproto.SessionFromGuess}, true},
		{agentproto.DetectEvent{Session: testSession1, SessionSource: agentproto.SessionFromPID}, false},
		{agentproto.DetectEvent{Agent: "claude", Session: testSession1 + "\n", SessionSource: agentproto.SessionFromPID}, false},
		{agentproto.DetectEvent{Agent: "claude", Session: "", SessionSource: agentproto.SessionFromPID}, false},
		{agentproto.DetectEvent{Agent: "claude", Session: testSession1, SessionSource: "PID"}, false},
	} {
		ev := c.in
		checkSession(&ev)
		if kept := ev.Session == c.in.Session && ev.SessionSource == c.in.SessionSource; kept != c.keep || !kept && (ev.Session != "" || ev.SessionSource != "") {
			t.Errorf("%+v: %+v", c.in, ev)
		}
	}
}

// The detect stream asks for sessions while the agents plugin is on, also
// in a core without that plugin (tests).
func TestTermDetectHeader(t *testing.T) {
	b := &termBackend{s: &Server{}}
	if h := b.detectHeader(); h.Op != agentproto.OpDetect || !h.Sessions {
		t.Fatalf("without the plugin %+v", h)
	}
	ps := []plugin.Plugin{agentsplugin.New()}
	st := settings.New("", plugin.Settings(ps, nil))
	b.s.opts = Options{Plugins: ps, Settings: st}
	if !b.detectHeader().Sessions {
		t.Fatal("plugin on")
	}
	if err := st.Set(plugin.EnableSetting(agentsplugin.New()), "", false); err != nil {
		t.Fatal(err)
	}
	if b.detectHeader().Sessions {
		t.Fatal("plugin off")
	}
}

// Through the machine's agent: Claude Code's record of its process names
// the session after the startup grace, which reaches the record without a
// /ws message; switching the agents plugin off opens the detect stream
// again without sessions, and the record loses it.
func TestTermSessionFromTheMachine(t *testing.T) {
	shortGrace(t)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	ps := []plugin.Plugin{agentsplugin.New()}
	st := settings.New("", plugin.Settings(ps, nil))
	s, core, _ := termServer(t, Options{Plugins: ps, Settings: st}, true)
	ws := wsAgents(s)
	// A pid no process has; its record has no start time to compare.
	const pid = "3999999"
	dir := filepath.Join(os.Getenv("HOME"), ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pid+".json"), []byte(`{"pid":`+pid+`,"sessionId":"`+testSession1+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	core.mu.Lock()
	core.snap = `[{"address":"t1","state":"live","cols":80,"rows":24,"labels":{},"reported":true,"status":{"state":"idle"},` +
		`"foreground":{"pid":` + pid + `,"name":"claude","argv":["claude"],"cwd":"/"}}]`
	core.mu.Unlock()
	c := dialTerm(t, s)
	c.ready()
	d := c.agentData()
	if d["agent"] != "claude" || d["agent_status"] != "idle" {
		t.Fatalf("detected %v", d)
	}
	wantEventSession(t, "at first", d, "", "")
	d = c.agentData()
	wantEventSession(t, "after the grace", d, testSession1, agentproto.SessionFromPID)
	if d["agent_status"] != "idle" {
		t.Fatalf("session event %v", d)
	}
	wantSession(t, "record", record(t, s), testSession1, agentproto.SessionFromPID)
	if got := ws(); len(got) != 1 {
		t.Fatalf("/ws messages %q", got)
	}

	if err := st.Set(plugin.EnableSetting(agentsplugin.New()), "", false); err != nil {
		t.Fatal(err)
	}
	if s.term.existing("x").detectHeader().Sessions {
		t.Fatal("the next detect stream asks for sessions")
	}
	deadline := time.Now().Add(10 * time.Second)
	for d = c.agentData(); d["agent"] != nil; d = c.agentData() {
		if time.Now().After(deadline) {
			t.Fatal("the detect stream was not opened again")
		}
	}
	d = c.agentData()
	if d["agent"] != "claude" {
		t.Fatalf("detected again %v", d)
	}
	wantEventSession(t, "detected again", d, "", "")
	wantSession(t, "record without sessions", record(t, s), "", "")
}

// A session that ends leaves the agent events and the record: when another
// agent takes the place of the one that had it, when that one leaves and
// another starts, and when the machine reports the agent without it (the
// agents plugin switched off).
func TestTermAgentSessionEnds(t *testing.T) {
	s, _, _ := termServer(t, Options{}, true)
	c := dialTerm(t, s)
	c.ready()
	b := s.term.existing("x")
	known := func(what string) {
		t.Helper()
		b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "idle", Session: testSession1, SessionSource: agentproto.SessionFromArgv})
		wantEventSession(t, what+": known", c.agentData(), testSession1, agentproto.SessionFromArgv)
		wantSession(t, what+": known record", record(t, s), testSession1, agentproto.SessionFromArgv)
	}

	known("replaced")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "codex", Status: "idle"})
	d := c.agentData()
	if d["agent"] != "codex" {
		t.Fatalf("replaced %v", d)
	}
	wantEventSession(t, "replaced", d, "", "")
	wantSession(t, "replaced record", record(t, s), "", "")

	known("left")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1"})
	wantEventSession(t, "left", c.agentData(), "", "")
	wantSession(t, "left record", record(t, s), "", "")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "codex", Status: "working"})
	wantEventSession(t, "the next agent", c.agentData(), "", "")
	wantSession(t, "the next agent's record", record(t, s), "", "")

	known("no longer known")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "idle"})
	d = c.agentData()
	if d["agent"] != "claude" || d["agent_status"] != "idle" {
		t.Fatalf("no longer known %v", d)
	}
	wantEventSession(t, "no longer known", d, "", "")
	wantSession(t, "no longer known record", record(t, s), "", "")
}

// The first event of each terminal after the agents plugin was switched,
// against what the clients were told before: a block or a turn's end they
// were told of reaches the record and the terminal protocol but not /ws
// again, a done they saw stays idle; a turn that ended meanwhile, another
// agent, and the terminal's later events are news as before.
func TestTermRedetected(t *testing.T) {
	s, _, _ := termServer(t, Options{}, true)
	ws := wsAgents(s)
	c := dialTerm(t, s)
	c.ready()
	b := s.term.existing("x")
	ev := func(agent, status string) agentproto.DetectEvent {
		return agentproto.DetectEvent{Terminal: "t1", Agent: agent, Status: status}
	}
	n := 0
	// switched applies before, then the switch's clear, then after as the
	// new stream's first event; the terminal protocol's event gives status
	// and /ws the messages it got of the clear and after.
	switched := func(before, after agentproto.DetectEvent, status string, news ...string) {
		t.Helper()
		b.mu.Lock()
		_, had := b.agents["t1"]
		b.mu.Unlock()
		if had {
			b.applyAgent(ev("", ""))
			c.agentData()
		}
		b.applyAgent(before)
		c.agentData()
		n = len(ws())
		told := map[string]agentproto.DetectEvent{}
		b.mu.Lock()
		for addr, e := range b.agents {
			told[addr] = e
		}
		b.mu.Unlock()
		b.applyAgent(ev("", ""))
		if d := c.agentData(); d["agent"] != nil {
			t.Fatalf("cleared %v", d)
		}
		b.applyDetected(after, told)
		if d := c.agentData(); d["agent"] != after.Agent || d["agent_status"] != status {
			t.Fatalf("%v then %v: event %v, want %s", before, after, d, status)
		}
		if rec := record(t, s); rec["agent_status"] != status {
			t.Fatalf("%v then %v: record %v", before, after, rec)
		}
		got := ws()[n:]
		want := append([]string{"null"}, news...)
		if len(got) != len(want) {
			t.Fatalf("%v then %v: /ws %q, want statuses %q", before, after, got, want)
		}
		for i, w := range want {
			if !strings.Contains(got[i], `"agent_status":`+w) {
				t.Fatalf("%v then %v: /ws %q, want statuses %q", before, after, got, want)
			}
		}
		if len(told) != 0 {
			t.Fatalf("told kept %v", told)
		}
	}
	switched(ev("claude", "done"), ev("claude", "done"), "done")
	switched(ev("claude", "blocked"), ev("claude", "blocked"), "blocked")
	switched(ev("claude", "working"), ev("claude", "done"), "done", `"done"`)
	switched(ev("claude", "done"), ev("codex", "done"), "done", `"done"`)
	switched(ev("claude", "working"), ev("claude", "working"), "working", `"working"`)

	// A done the clients saw stays seen.
	b.applyAgent(ev("claude", "done"))
	c.agentData()
	b.seen("t1")
	if d := c.agentData(); d["agent_status"] != "idle" {
		t.Fatalf("seen %v", d)
	}
	n = len(ws())
	told := map[string]agentproto.DetectEvent{"t1": ev("claude", "idle")}
	b.applyAgent(ev("", ""))
	c.agentData()
	b.applyDetected(ev("claude", "done"), told)
	if d := c.agentData(); d["agent_status"] != "idle" {
		t.Fatalf("a seen done came back: %v", d)
	}
	if got := ws()[n:]; len(got) != 2 || strings.Contains(strings.Join(got, " "), `"done"`) {
		t.Fatalf("/ws after a seen done %q", got)
	}
	// Taken by the first event: what follows is news.
	b.applyDetected(ev("claude", "working"), told)
	c.agentData()
	b.applyDetected(ev("claude", "done"), told)
	if d := c.agentData(); d["agent_status"] != "done" {
		t.Fatalf("the next turn %v", d)
	}
	if got := ws(); !strings.Contains(got[len(got)-1], `"agent_status":"done"`) {
		t.Fatalf("/ws after the next turn %q", got)
	}
}

// Through the machine's agent: switching the agents plugin off and on again
// makes the machine detect the agent again, whose turn's end the clients
// were told of once only.
func TestTermSwitchNotifiesOnce(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	ps := []plugin.Plugin{agentsplugin.New()}
	st := settings.New("", plugin.Settings(ps, nil))
	s, core, _ := termServer(t, Options{Plugins: ps, Settings: st}, true)
	ws := wsAgents(s)
	core.mu.Lock()
	core.snap = `[{"address":"t1","state":"live","cols":80,"rows":24,"labels":{},"reported":true,"status":{"state":"done"},"turn":2,` +
		`"foreground":{"pid":3999998,"name":"claude","argv":["claude"],"cwd":"/"}}]`
	core.mu.Unlock()
	c := dialTerm(t, s)
	c.ready()
	if d := c.agentData(); d["agent"] != "claude" || d["agent_status"] != "done" {
		t.Fatalf("detected %v", d)
	}
	for i, on := range []bool{false, true} {
		if err := st.Set(plugin.EnableSetting(agentsplugin.New()), "", on); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for d := c.agentData(); d["agent"] != nil; d = c.agentData() {
			if time.Now().After(deadline) {
				t.Fatal("the detect stream was not opened again")
			}
		}
		if d := c.agentData(); d["agent"] != "claude" || d["agent_status"] != "done" {
			t.Fatalf("detected again %v", d)
		}
		if rec := record(t, s); rec["agent_status"] != "done" {
			t.Fatalf("record %v", rec)
		}
		// The /ws message of a second done would follow the event at once.
		time.Sleep(200 * time.Millisecond)
		done := 0
		for _, m := range ws() {
			if strings.Contains(m, `"agent_status":"done"`) {
				done++
			}
		}
		if got := ws(); done != 1 || len(got) != 2+i {
			t.Fatalf("switch %d: /ws %q", i, got)
		}
	}
}

// shortGrace shortens the agents' startup grace for a test whose agent
// runs in the test's process; registered before the server, it is
// restored once the server and its agent are gone.
func shortGrace(t *testing.T) {
	old := detect.StartupGrace
	detect.StartupGrace = 300 * time.Millisecond
	t.Cleanup(func() { detect.StartupGrace = old })
}

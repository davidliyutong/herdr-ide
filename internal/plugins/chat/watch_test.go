package chat

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
)

// clock is the time, which the test moves ahead.
type clock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.offset += d
	c.mu.Unlock()
}

// start runs the plugin's watches with short waits until the test ends.
func (s *setup) start(t *testing.T) *clock {
	t.Helper()
	c := &clock{}
	s.p.now = c.now
	s.p.tick, s.p.retry, s.p.again = 5*time.Millisecond, 10*time.Millisecond, 10*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.p.Start(ctx, s.h)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return c
}

func chatState(status, state string, seq uint64) chatproto.ChatState {
	return chatproto.ChatState{ID: chatproto.NewChatID(), Kind: "claude", Title: "t", Cwd: "/w", State: state, Status: status, Seq: seq}
}

// lastBroadcast is the last states message, and how many there were.
func (h *testHost) lastBroadcast() (broadcastEntry, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.broadcasts) == 0 {
		return broadcastEntry{}, 0
	}
	return h.broadcasts[len(h.broadcasts)-1], len(h.broadcasts)
}

func (h *testHost) noteCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.notes)
}

// The core reads every chat's state when it watches a host, sends them to
// the pages in full and then each change, numbered; it notifies of chats
// that became blocked or done, once each, and of the first states it
// reads only of the blocked ones.
func TestWatchStates(t *testing.T) {
	s := newSetup(t)
	a := chatState(chatproto.StatusBlocked, chatproto.StateWaiting, 5)
	b := chatState(chatproto.StatusDone, chatproto.StateIdle, 7)
	c := chatState(chatproto.StatusWorking, chatproto.StateWorking, 3)
	s.f.states = []chatproto.ChatState{a, b, c}
	s.start(t)

	s.h.wait(t, "the full states", func() bool { return len(s.h.broadcasts) == 1 })
	first, _ := s.h.lastBroadcast()
	if first.m != "gpu" || !first.data.Full || first.data.Rev != 1 || len(first.data.States) != 3 || first.data.T != DataStates {
		t.Fatalf("first states %+v", first)
	}
	s.h.wait(t, "the blocked chat's notification", func() bool { return len(s.h.notes) == 1 })
	s.f.wait("a configure", func() bool { return s.f.count(chatproto.OpConfigure) == 1 })
	s.f.mu.Lock()
	if s.f.opens[0] != false || s.f.requests[0].Op != chatproto.OpWatch {
		t.Errorf("the watch started a host: opens %v, %v", s.f.opens, s.f.requests[0].Op)
	}
	for _, r := range s.f.requests {
		if r.Op == chatproto.OpConfigure && *r.Settings != chatproto.DefaultHostSettings() {
			t.Errorf("configured %+v", *r.Settings)
		}
	}
	s.f.mu.Unlock()
	s.h.mu.Lock()
	note := s.h.notes[0]
	s.h.mu.Unlock()
	if note["chat"] != a.ID || note["agent_status"] != "blocked" || note["agent"] != "claude" || note["display_agent"] != "Claude Code" ||
		note["terminal"] != "" || note["title"] != "t" || note["m"] != "gpu" {
		t.Errorf("notification %v", note)
	}

	// A notification follows its change's states; one too many shows by
	// the next change.
	had := 1
	step := func(st chatproto.ChatState, notes int) {
		t.Helper()
		if got := s.h.noteCount(); got != had {
			t.Errorf("before %s %s: %d notifications, not %d", st.State, st.Status, got, had)
		}
		_, n := s.h.lastBroadcast()
		s.f.change(st)
		s.h.wait(t, "the change", func() bool { return len(s.h.broadcasts) == n+1 && len(s.h.notes) >= notes })
		last, _ := s.h.lastBroadcast()
		if last.data.Full || last.data.Rev != uint64(n+1) || len(last.data.States) != 1 || last.data.States[0] != st {
			t.Errorf("change %+v", last.data)
		}
		had = notes
	}
	c.State, c.Status, c.Seq = chatproto.StateIdle, chatproto.StatusDone, 9
	step(c, 2)
	c.Title = "renamed"
	step(c, 2)
	a.State, a.Status, a.Seq = chatproto.StateWorking, chatproto.StatusWorking, 6
	step(a, 2)
	a.State, a.Status, a.Seq = chatproto.StateWaiting, chatproto.StatusBlocked, 8
	step(a, 3)
	c.Status = chatproto.StatusIdle
	step(c, 3)
	b.State = chatproto.StateDeleted
	step(b, 3)

	code, out, _ := s.call("GET", "", "states", "")
	gpu, _ := out["machines"].(map[string]any)["gpu"].(map[string]any)
	if code != 200 || gpu == nil || gpu["rev"] != 7.0 || gpu["full"] != true || len(gpu["states"].([]any)) != 2 {
		t.Errorf("states: %d %v", code, out)
	}
	if _, ok := out["machines"].(map[string]any)["box"]; ok {
		t.Error("a machine never read is in the states")
	}
}

// A chat done again after a gap in the watch (a turn ran and ended while
// the core did not watch) is told again; one whose state is as it was is
// not, nor one that only changed its title while done.
func TestWatchDoneAcrossGap(t *testing.T) {
	s := newSetup(t)
	c := chatState(chatproto.StatusWorking, chatproto.StateWorking, 3)
	s.f.states = []chatproto.ChatState{c}
	s.start(t)
	s.h.wait(t, "the states", func() bool { return len(s.h.broadcasts) == 1 })
	c.State, c.Status, c.Seq = chatproto.StateIdle, chatproto.StatusDone, 5
	s.f.change(c)
	s.h.wait(t, "done", func() bool { return len(s.h.notes) == 1 })
	// Another turn runs and ends while the watch is down.
	s.f.mu.Lock()
	c.Seq = 9
	s.f.states[0] = c
	s.f.mu.Unlock()
	s.f.end(true)
	s.h.wait(t, "done again", func() bool { return len(s.h.notes) == 2 })
	s.h.mu.Lock()
	if n := s.h.notes[1]; n["chat"] != c.ID || n["agent_status"] != "done" {
		t.Errorf("notification %v", n)
	}
	s.h.mu.Unlock()
	// A gap after which it is as it was tells nothing; a live change of
	// its title neither.
	_, n := s.h.lastBroadcast()
	s.f.end(true)
	s.h.wait(t, "the states again", func() bool { return len(s.h.broadcasts) == n+1 })
	c.Title = "renamed"
	s.f.change(c)
	s.h.wait(t, "the change", func() bool { return len(s.h.broadcasts) == n+2 })
	time.Sleep(30 * time.Millisecond)
	if got := s.h.noteCount(); got != 2 {
		t.Errorf("%d notifications", got)
	}
}

// After its host ended the core watches again, and notifies of what
// became blocked or done meanwhile, not of what it told before.
func TestWatchAgain(t *testing.T) {
	s := newSetup(t)
	a := chatState(chatproto.StatusBlocked, chatproto.StateWaiting, 5)
	c := chatState(chatproto.StatusWorking, chatproto.StateWorking, 3)
	s.f.states = []chatproto.ChatState{a, c}
	s.start(t)
	s.h.wait(t, "the states", func() bool { return len(s.h.broadcasts) == 1 && len(s.h.notes) == 1 })
	s.f.mu.Lock()
	c.State, c.Status, c.Seq = chatproto.StateIdle, chatproto.StatusDone, 10
	s.f.states[1] = c
	s.f.mu.Unlock()
	s.f.end(true)
	s.h.wait(t, "the states again", func() bool { return len(s.h.broadcasts) == 2 })
	last, _ := s.h.lastBroadcast()
	if !last.data.Full || last.data.Rev != 2 {
		t.Errorf("again %+v", last.data)
	}
	s.h.wait(t, "the done chat's notification", func() bool { return len(s.h.notes) == 2 })
	s.h.mu.Lock()
	if s.h.notes[1]["chat"] != c.ID || s.h.notes[1]["agent_status"] != "done" {
		t.Errorf("notification %v", s.h.notes[1])
	}
	s.h.mu.Unlock()
	time.Sleep(50 * time.Millisecond)
	if n := s.h.noteCount(); n != 2 {
		t.Errorf("%d notifications", n)
	}
}

// A watch starts no host: with none serving, the core waits for a change
// or a page to use the machine's. A host the core knew of agents in that
// is gone left them sleeping.
func TestWatchStartsNoHost(t *testing.T) {
	s := newSetup(t)
	s.f.running = false
	s.start(t)
	s.f.wait("the watch's try", func() bool { return len(s.f.opens) == 1 })
	time.Sleep(50 * time.Millisecond)
	s.f.mu.Lock()
	if !slices.Equal(s.f.opens, []bool{false}) || s.f.running {
		t.Errorf("opens %v", s.f.opens)
	}
	s.f.mu.Unlock()
	if _, n := s.h.lastBroadcast(); n != 0 {
		t.Errorf("%d broadcasts", n)
	}

	c := chatState(chatproto.StatusWorking, chatproto.StateWorking, 3)
	s.f.mu.Lock()
	s.f.states = []chatproto.ChatState{c}
	s.f.mu.Unlock()
	if code, _, _ := s.call("GET", "gpu", "chats", ""); code != 409 {
		t.Fatal(code)
	}
	if code, _, _ := s.call("POST", "gpu", "agents", ""); code != 200 {
		t.Fatal(code)
	}
	s.h.wait(t, "the states", func() bool { return len(s.h.broadcasts) == 1 })

	s.f.end(false)
	s.h.wait(t, "the stale states", func() bool { return len(s.h.broadcasts) == 2 })
	last, _ := s.h.lastBroadcast()
	if last.data.Full || len(last.data.States) != 1 || last.data.States[0].State != chatproto.StateSleeping ||
		last.data.States[0].Status != chatproto.StatusIdle || last.data.Rev != 2 {
		t.Errorf("stale %+v", last.data)
	}
	s.f.mu.Lock()
	if s.f.running || s.f.opens[len(s.f.opens)-1] {
		t.Errorf("a host was started: %v", s.f.opens)
	}
	s.f.mu.Unlock()
}

// The core stops watching a host when none of its chats runs an agent, no
// page is attached and nothing used it for a while: the host can end.
func TestWatchLetsQuietHostGo(t *testing.T) {
	s := newSetup(t)
	s.f.states = []chatproto.ChatState{chatState(chatproto.StatusIdle, chatproto.StateSleeping, 3)}
	working := chatState(chatproto.StatusWorking, chatproto.StateWorking, 2)
	clk := s.start(t)
	s.f.wait("the watch", func() bool { return len(s.f.watchers) == 1 })
	s.f.change(working)
	s.h.wait(t, "the change", func() bool { return len(s.h.broadcasts) == 2 })
	clk.add(s.p.linger)
	time.Sleep(30 * time.Millisecond)
	s.f.mu.Lock()
	if len(s.f.watchers) != 1 {
		t.Error("a host whose chat works was let go")
	}
	s.f.mu.Unlock()
	working.State, working.Status = chatproto.StateSleeping, chatproto.StatusIdle
	s.f.change(working)
	s.f.wait("the watch to end", func() bool { return len(s.f.watchers) == 0 })
	n := len(s.f.opens)
	time.Sleep(30 * time.Millisecond)
	if s.f.mu.Lock(); len(s.f.opens) != n {
		t.Errorf("opens %v", s.f.opens)
	}
	s.f.mu.Unlock()
	// A use of the host makes the core watch it again.
	if code, _, _ := s.call("GET", "gpu", "chats", ""); code != 200 {
		t.Fatal(code)
	}
	s.f.wait("the watch again", func() bool { return len(s.f.watchers) == 1 })
}

// The host gets the machine's settings when they change, the machine's
// own or everyone's; a read-only core configures nothing.
func TestConfigure(t *testing.T) {
	s := newSetup(t)
	s.start(t)
	s.f.wait("a configure", func() bool { return s.f.count(chatproto.OpConfigure) == 1 })
	if err := s.h.st.Set(SettingMaxLive, "gpu", 3.0); err != nil {
		t.Fatal(err)
	}
	s.f.wait("a configure", func() bool { return s.f.count(chatproto.OpConfigure) == 2 })
	if err := s.h.st.Set(SettingPermissionMode, "", chatproto.ModePlan); err != nil {
		t.Fatal(err)
	}
	s.f.wait("a configure", func() bool { return s.f.count(chatproto.OpConfigure) == 3 })
	s.f.mu.Lock()
	last := s.f.requests[len(s.f.requests)-1]
	s.f.mu.Unlock()
	if last.Op != chatproto.OpConfigure || last.Settings.MaxLive != 3 || last.Settings.DefaultMode != chatproto.ModePlan {
		t.Errorf("configured %+v", last.Settings)
	}
	if err := s.h.st.Set(SettingMaxLive, "box", 4.0); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if s.f.mu.Lock(); s.f.count(chatproto.OpConfigure) != 3 {
		t.Error("another machine's setting configured this one")
	}
	s.f.mu.Unlock()

	r := newSetup(t)
	r.h.readOnly = true
	r.start(t)
	r.f.wait("the watch", func() bool { return len(r.f.watchers) == 1 })
	time.Sleep(30 * time.Millisecond)
	if r.f.mu.Lock(); r.f.count(chatproto.OpConfigure) != 0 {
		t.Error("a read-only core configured the host")
	}
	r.f.mu.Unlock()
}

// The watch ends with the machine's connection and with the plugin; a
// machine without a chat host is not asked again until it connects again.
func TestWatchFollowsMachineAndPlugin(t *testing.T) {
	s := newSetup(t)
	s.start(t)
	s.f.wait("the watch", func() bool { return len(s.f.watchers) == 1 })
	s.setReady()
	s.f.wait("the watch to end", func() bool { return len(s.f.watchers) == 0 })
	s.setReady("gpu")
	s.f.wait("the watch again", func() bool { return len(s.f.watchers) == 1 })
	if err := s.h.st.Set(plugin.EnableSetting(s.p), "", false); err != nil {
		t.Fatal(err)
	}
	s.f.wait("the watch to end", func() bool { return len(s.f.watchers) == 0 })
	if err := s.h.st.Set(plugin.EnableSetting(s.p), "", true); err != nil {
		t.Fatal(err)
	}
	s.f.wait("the watch again", func() bool { return len(s.f.watchers) == 1 })

	o := newSetup(t)
	o.f.openErr = "unknown_plugin"
	o.start(t)
	o.f.wait("a try", func() bool { return len(o.f.opens) == 1 })
	time.Sleep(50 * time.Millisecond)
	if o.f.mu.Lock(); len(o.f.opens) != 1 {
		t.Errorf("a machine without chats was asked again: %v", o.f.opens)
	}
	o.f.mu.Unlock()
	o.setReady()
	time.Sleep(20 * time.Millisecond)
	o.setReady("gpu")
	o.f.wait("a try after the machine connected again", func() bool { return len(o.f.opens) == 2 })
}

// A failing watch is tried again, waiting longer each time, and given up
// after maxFailures until the host is used.
func TestWatchRetries(t *testing.T) {
	if got := []time.Duration{backoff(time.Second, 1), backoff(time.Second, 3), backoff(time.Second, 20)}; !slices.Equal(got, []time.Duration{time.Second, 4 * time.Second, 5 * time.Minute}) {
		t.Errorf("backoff %v", got)
	}
	s := newSetup(t)
	s.f.openErr = "transport"
	s.start(t)
	s.f.wait("the tries", func() bool { return len(s.f.opens) == maxFailures })
	time.Sleep(50 * time.Millisecond)
	if s.f.mu.Lock(); len(s.f.opens) != maxFailures {
		t.Errorf("%d tries", len(s.f.opens))
	}
	s.f.openErr = ""
	s.f.mu.Unlock()
	s.call("GET", "gpu", "chats", "")
	s.f.wait("the watch", func() bool { return len(s.f.watchers) == 1 })
}

// When a machine goes offline, live/active/blocked chats in the core's cache
// are marked stale and sleeping/idle so they do not appear working or blocked
// indefinitely, and fresh states clear the stale flag on reconnect.
func TestWatchOfflineMarksStale(t *testing.T) {
	s := newSetup(t)
	working := chatState(chatproto.StatusWorking, chatproto.StateWorking, 2)
	blocked := chatState(chatproto.StatusBlocked, chatproto.StateWaiting, 4)
	done := chatState(chatproto.StatusDone, chatproto.StateIdle, 6)
	done.Unread = true
	s.f.states = []chatproto.ChatState{working, blocked, done}
	s.start(t)
	s.h.wait(t, "initial states", func() bool { return len(s.h.broadcasts) == 1 })

	// Machine goes offline.
	s.setReady()
	s.h.wait(t, "stale broadcast", func() bool { return len(s.h.broadcasts) == 2 })
	last, _ := s.h.lastBroadcast()
	if !last.data.Full || !last.data.Stale || len(last.data.States) != 3 {
		t.Fatalf("offline broadcast: %+v", last.data)
	}
	byID := map[string]chatproto.ChatState{}
	for _, st := range last.data.States {
		byID[st.ID] = st
	}
	if !byID[working.ID].Stale || byID[working.ID].State != chatproto.StateSleeping || byID[working.ID].Status != chatproto.StatusIdle {
		t.Errorf("working chat offline: %+v", byID[working.ID])
	}
	if !byID[blocked.ID].Stale || byID[blocked.ID].State != chatproto.StateSleeping || byID[blocked.ID].Status != chatproto.StatusIdle {
		t.Errorf("blocked chat offline: %+v", byID[blocked.ID])
	}
	if !byID[done.ID].Stale || byID[done.ID].State != chatproto.StateSleeping || byID[done.ID].Status != chatproto.StatusDone {
		t.Errorf("done chat offline: %+v", byID[done.ID])
	}
	snap := s.p.Snapshot().Machines["gpu"]
	if !snap.Stale || len(snap.States) != 3 {
		t.Fatalf("snapshot while offline: %+v", snap)
	}

	// Machine comes back online: fresh states clear Stale.
	s.setReady("gpu")
	s.h.wait(t, "reconnected broadcast", func() bool { return len(s.h.broadcasts) == 3 })
	rec, _ := s.h.lastBroadcast()
	if rec.data.Stale || !rec.data.Full {
		t.Fatalf("reconnect broadcast: %+v", rec.data)
	}
	for _, st := range rec.data.States {
		if st.Stale {
			t.Errorf("stale remained set on reconnect: %+v", st)
		}
	}
}

// A state the watch read before the machine left, taken after step ended
// the watch and marked the machine's chats stale, is dropped: the offline
// chat stays sleeping and stale, and the pages hear nothing of it. The
// states a watch read first are dropped the same way.
func TestWatchChangeAfterOfflineDropped(t *testing.T) {
	s := newSetup(t)
	working := chatState(chatproto.StatusWorking, chatproto.StateWorking, 2)
	s.p.mu.Lock()
	w := s.p.machine("gpu")
	s.p.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !s.p.watchUp(ctx, w, chatproto.HostInfo{}, []chatproto.ChatState{working}) {
		t.Fatal("the first states were not taken")
	}

	// step: the machine left.
	s.p.mu.Lock()
	cancel()
	if _, ok := markStaleLocked(w); !ok {
		t.Fatal("not marked stale")
	}
	s.p.mu.Unlock()
	_, n := s.h.lastBroadcast()

	// The watch's goroutine takes the line it had read.
	again := working
	again.Seq = 3
	if s.p.watchChange(ctx, w, again) {
		t.Error("a change of an ended watch was taken")
	}
	snap := s.p.Snapshot().Machines["gpu"]
	if !snap.Stale || len(snap.States) != 1 {
		t.Fatalf("snapshot %+v", snap)
	}
	if st := snap.States[0]; !st.Stale || st.State != chatproto.StateSleeping || st.Status != chatproto.StatusIdle || st.Seq != 2 {
		t.Errorf("offline chat came back as %+v", st)
	}
	if _, m := s.h.lastBroadcast(); m != n {
		t.Errorf("%d states messages after the machine left", m-n)
	}

	// A watch ended before it took its first states takes none.
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if s.p.watchUp(ctx2, w, chatproto.HostInfo{}, []chatproto.ChatState{working}) {
		t.Error("the first states of an ended watch were taken")
	}
	if snap := s.p.Snapshot().Machines["gpu"]; !snap.Stale || snap.States[0].State != chatproto.StateSleeping {
		t.Errorf("snapshot after an ended watch's first states: %+v", snap)
	}
}

// The states say which build the machine's chat host is and whether it is
// another than the core's, until no host serves.
func TestWatchHostOutdated(t *testing.T) {
	for _, build := range []string{"test", "v0.5.0-3-gabc-dirty.1700000002"} {
		t.Run(build, func(t *testing.T) {
			previous := agentproto.Version
			agentproto.Version = build
			t.Cleanup(func() { agentproto.Version = previous })
			s := newSetup(t)
			s.f.states = []chatproto.ChatState{chatState(chatproto.StatusWorking, chatproto.StateWorking, 3)}
			s.start(t)
			s.h.wait(t, "the states", func() bool { return len(s.h.broadcasts) == 1 })
			first, _ := s.h.lastBroadcast()
			outdated := build != "test"
			if first.data.HostVersion != "test" || first.data.Outdated != outdated {
				t.Fatalf("states of the host %q: %+v", build, first.data)
			}
			if snap := s.p.Snapshot().Machines["gpu"]; snap.HostVersion != "test" || snap.Outdated != outdated {
				t.Errorf("snapshot %+v", snap)
			}
			s.f.end(false)
			s.h.wait(t, "the host gone", func() bool { return len(s.h.broadcasts) == 2 })
			last, _ := s.h.lastBroadcast()
			if last.data.HostVersion != "" || last.data.Outdated || last.data.States == nil {
				t.Errorf("no host serves: %+v", last.data)
			}
		})
	}
}

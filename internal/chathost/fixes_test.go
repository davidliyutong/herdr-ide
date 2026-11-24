//go:build unix

package chathost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
	"veldr/internal/store"
)

// rawDo sends a request and reads its answer, without the test's T (for
// goroutines).
func rawDo(sock string, req chatproto.Request) (chatproto.Response, error) {
	var res chatproto.Response
	conn, err := net.DialTimeout("unix", sock, patience)
	if err != nil {
		return res, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(patience))
	r := bufio.NewReader(conn)
	if _, err := chatproto.ReadLine(r); err != nil {
		return res, err
	}
	b, err := chatproto.Line(req)
	if err != nil {
		return res, err
	}
	if _, err := conn.Write(b); err != nil {
		return res, err
	}
	l, err := chatproto.ReadLine(r)
	if err != nil {
		return res, err
	}
	return res, json.Unmarshal(l, &res)
}

// notice is the kind of a notice's event.
func notice(name string) string { return "notice:" + agentproto.NoticeMethod(name) }

// A catch-up reads where the log ends once it is its turn: an attach's and
// a prompt's, one after the other, bring what the session did in a
// terminal in once.
func TestCatchUpImportsOnce(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("hi")
	s.session.say("a1", "hello")
	s.session.endTurn("end_turn")
	s.until(isKind("state:idle"))
	s.must(chatproto.Command{Op: chatproto.OpHandoff})
	s.session.expect(t, "close")
	s.until(isKind("info"))

	gate := make(chan struct{})
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventUpdate, Item: "a1", Update: agentChunk("hello")},
			{T: chatproto.EventUpdate, Item: "t1", Update: agentChunk("in the terminal")},
		}
		a.historyGate = gate
	})
	// An attach starts a catch-up, which waits.
	h.attach(s.chat.ID, s.last)
	eventually(t, "the attach's catch-up", func() bool {
		h.fake.mu.Lock()
		defer h.fake.mu.Unlock()
		return len(h.fake.histories) == 1
	})
	// A prompt meanwhile starts the agent, its catch-up after the attach's.
	id := s.send(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("back")}, ClientID: "u-back"})
	c := h.served().lookup(s.chat.ID)
	eventually(t, "the start", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.starting
	})
	close(gate)
	s.session = h.fake.session(t)
	if e := s.ack(id); e != nil {
		t.Fatalf("prompt: %+v", e)
	}
	evs := s.until(isKind("turn:start"))
	n := 0
	for _, e := range evs {
		if e.Item == "t1" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("the terminal's turn was brought in %d times: %s", n, kinds(evs))
	}
	h.fake.mu.Lock()
	defer h.fake.mu.Unlock()
	if len(h.fake.histories) != 2 || h.fake.histories[0].After != "a1" || h.fake.histories[1].After != "t1" {
		t.Errorf("histories %+v", h.fake.histories)
	}
}

// A chat being deleted starts no agent: a prompt while its agent ends is
// refused.
func TestDeleteStartsNoAgent(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	h.fake.set(func(a *fakeAdapter) { a.closeDelay = 300 * time.Millisecond })
	done := make(chan error, 1)
	go func() {
		res, err := rawDo(h.sock, chatproto.Request{Op: chatproto.OpDelete, Chat: s.chat.ID})
		if err == nil && !res.OK {
			err = res.Error
		}
		done <- err
	}()
	s.session.expect(t, "close")
	if e := s.command(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("late")}}); e == nil || e.Code != chatproto.CodeUnknownChat {
		t.Errorf("a prompt to a chat being deleted: %+v", e)
	}
	if err := <-done; err != nil {
		t.Fatalf("delete: %v", err)
	}
	select {
	case <-h.fake.started:
		t.Error("an agent started for a deleted chat")
	case <-time.After(100 * time.Millisecond):
	}
}

// Forgetting a chat (the bounds' removal) ends an agent that started since
// the chat was found to have none.
func TestForgetEndsTheAgent(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	host := h.served()
	if err := host.forget(host.lookup(s.chat.ID)); err != nil {
		t.Fatal(err)
	}
	s.session.expect(t, "close")
	select {
	case <-s.session.done:
	case <-time.After(patience):
		t.Fatal("the agent of a forgotten chat runs on")
	}
	if n := host.liveAgents(nil); n != 0 {
		t.Errorf("%d agents run", n)
	}
	h.refused(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID}, chatproto.CodeUnknownChat)
}

// An event the journal does not take is told to nobody and fails the chat:
// its log has no hole, and a prompt starts it again.
func TestJournalFailureFailsTheChat(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("hi")
	j := h.served().j
	fail := func(err error) {
		j.mu.Lock()
		defer j.mu.Unlock()
		j.failAppend = nil
		if err != nil {
			j.failAppend = func() error { return err }
		}
	}
	before := h.chat(s.chat.ID).Seq
	fail(errors.New("disk full"))
	s.session.say("m1", "lost")
	s.session.expect(t, "close")
	c := h.waitState(s.chat.ID, chatproto.StateFailed)
	if c.Seq != before || c.Error == nil || c.Error.Code != chatproto.CodeFailed || !strings.Contains(c.Error.Message, "disk full") {
		t.Errorf("failed chat: seq %d of %d, error %+v", c.Seq, before, c.Error)
	}
	s.quiet()

	fail(nil)
	s.prompt("again")
	s.session = h.fake.session(t)
	s.session.expect(t, "prompt:again")
	s.until(isKind("turn:start")) // numbered on from the last stored
	a := h.attach(s.chat.ID, 0)
	a.until(func(e event) bool { return e.Seq == s.last })
}

// The answers to questions the host asked under ids of its own reach the
// adapter under the ids it gave.
func TestQuestionIDsBackToTheAdapter(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("ask")
	res := make(chan questionResult, 1)
	go func() {
		a, err := s.session.sink.Question(context.Background(), chatadapter.QuestionRequest{Questions: []chatproto.Question{
			{ID: "a", Question: "A?", AllowOther: true}, {ID: "a", Question: "A again?", AllowOther: true},
			{Question: "None?", AllowOther: true}, {ID: "q2", Question: "Two?", AllowOther: true}}})
		res <- questionResult{a, err}
	}()
	ev := s.expect("question", "state:waiting")[0]
	var ids []string
	for _, q := range ev.Questions {
		ids = append(ids, q.ID)
	}
	if want := []string{"a", "q3", "q4", "q2"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids %v, want %v", ids, want)
	}
	s.must(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID,
		Answers: map[string][]string{"a": {"x"}, "q3": {"y"}, "q4": {"z"}, "q2": {"w"}}})
	r := <-res
	if want := map[string][]string{"a": {"x"}, "": {"z"}, "q2": {"w"}}; r.err != nil || !reflect.DeepEqual(r.a.Answers, want) {
		t.Errorf("the adapter got %+v %v, want %v", r.a.Answers, r.err, want)
	}
}

// A permission too large to store, even cut, is cancelled at once: nobody
// could answer it.
func TestTooLargePermissionIsCancelled(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("big")
	parts := make([]string, 80)
	for i := range parts {
		parts[i] = strings.Repeat("y", 20<<10)
	}
	tc, _ := json.Marshal(map[string]any{"toolCallId": "t1", "title": "big", "kind": "execute", "rawInput": parts})
	res := make(chan permResult, 1)
	go func() {
		a, err := s.session.sink.Permission(context.Background(), chatadapter.PermissionRequest{Kind: chatproto.PermissionCommand,
			ToolCall: tc, Options: []chatproto.PermissionOption{{OptionID: chatadapter.OptionAllowOnce, Name: "Allow", Kind: chatproto.AllowOnce}}})
		res <- permResult{a, err}
	}()
	select {
	case r := <-res:
		if r.err != nil || !r.a.Cancelled {
			t.Errorf("the agent got %+v %v", r.a, r.err)
		}
	case <-time.After(patience):
		t.Fatal("the permission waits")
	}
	s.expect(notice(agentproto.NoticeSkipped))
	s.quiet()
	if c := h.chat(s.chat.ID); c.State != chatproto.StateWorking {
		t.Errorf("state %s", c.State)
	}
}

// Between a turn's end and the next turn, which takes the messages queued
// meanwhile, the chat works: it is not idle (no idle stop, no room made of
// it) and is not handed off. When the messages are withdrawn, or no turn
// comes within a call's time, it is idle.
func TestQueuedMessagesKeepTheChatWorking(t *testing.T) {
	h := startHost(t, func(h *testHost) { h.o.callTimeout = 500 * time.Millisecond })
	s := h.newChat()
	s.turn("first")
	s.prompt("second")
	s.session.expect(t, "prompt:second")
	q := s.expect("queued:queued")[0]
	s.session.endTurn("end_turn")
	s.expect("turn:end")
	if c := h.chat(s.chat.ID); c.State != chatproto.StateWorking {
		t.Errorf("between the turns: %s", c.State)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpHandoff}, chatproto.CodeBusy)
	s.session.sink.Event(chatproto.Event{T: chatproto.EventQueued, State: chatproto.QueuedCancelled, Message: q.Message})
	s.expect("queued:cancelled", "state:idle")

	s.turn("third")
	s.prompt("fourth")
	s.session.expect(t, "prompt:fourth")
	s.expect("queued:queued")
	s.session.endTurn("end_turn")
	s.expect("turn:end")
	s.expect("state:idle") // within the call timeout
}

// A start that comes after the host began to stop is ended before Serve
// returns: no agent outlives the host.
func TestLateStartEndsBeforeServeReturns(t *testing.T) {
	h := startHost(t, nil)
	gate := make(chan struct{})
	h.fake.set(func(a *fakeAdapter) { a.startGate, a.lateStart, a.closeDelay = gate, true, 300*time.Millisecond })
	chat := h.create(chatproto.Request{})
	host := h.served()
	c := host.lookup(chat.ID)
	h.stop()
	eventually(t, "the start called off", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return host.stopping.Load() && !c.starting
	})
	close(gate)
	sess := h.fake.session(t)
	h.wait()
	select {
	case <-sess.done:
	default:
		t.Error("an agent that started late outlived the host")
	}
}

// Two chats never take up one session, however close their requests.
func TestResumeTakenOnce(t *testing.T) {
	h := startHost(t, nil)
	const n = 16
	results := make(chan chatproto.Response, n)
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() {
			res, err := rawDo(h.sock, chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd, Resume: "session-1"})
			if err != nil {
				res.Error = &chatproto.Error{Code: "io", Message: err.Error()}
			}
			results <- res
		})
	}
	wg.Wait()
	close(results)
	ok := 0
	for res := range results {
		switch {
		case res.OK:
			ok++
			if res.Chat.SessionID != "session-1" {
				t.Errorf("a resumed chat without its session: %+v", res.Chat)
			}
		case res.Error == nil || res.Error.Code != chatproto.CodeBadRequest:
			t.Errorf("refused with %+v", res.Error)
		}
	}
	if ok != 1 {
		t.Errorf("%d chats took up one session", ok)
	}
}

// A chat whose session never had a turn makes a new one at its next start,
// also after a host's restart; it cannot be handed off.
func TestFreshSessionIsNotResumed(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	first := s.session.id
	s.mustNot(chatproto.Command{Op: chatproto.OpHandoff}, chatproto.CodeNotFound)
	h.restart()
	a := h.attach(s.chat.ID, 0)
	a.prompt("hi")
	h.fake.session(t)
	if p := h.fake.lastStart(t); p.Resume != "" || p.SessionID == "" || p.SessionID == first {
		t.Errorf("a fresh session resumed: %+v", p)
	}
}

// The journal is this host's (store.HostFile); the ones other hosts and
// earlier versions left go once nobody used them for long.
func TestOtherHostsJournalsGo(t *testing.T) {
	old := time.Now().Add(-store.HostFileRetention - 24*time.Hour)
	var other, legacy, recent string
	h := startHost(t, func(h *testHost) {
		if err := os.MkdirAll(h.base, 0o700); err != nil {
			t.Fatal(err)
		}
		other, legacy, recent = filepath.Join(h.base, "chat-elsewhere.db"), filepath.Join(h.base, DBName), filepath.Join(h.base, "chat-recent.db")
		for _, p := range []string{other, legacy, recent} {
			if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		os.Chtimes(other, old, old)
		os.Chtimes(legacy, old, old)
	})
	for p, want := range map[string]bool{other: false, legacy: false, recent: true, store.HostFile(h.base, DBName): true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s: there %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}

// OpTrust trusts a directory and those below it: an agent started there
// gets Trusted; the list keeps maxTrusted directories.
func TestTrust(t *testing.T) {
	h := startHost(t, nil)
	sub := filepath.Join(h.cwd, "sub")
	os.Mkdir(sub, 0o700)
	h.refused(chatproto.Request{Op: chatproto.OpTrust, Cwd: "relative"}, chatproto.CodeBadRequest)
	h.refused(chatproto.Request{Op: chatproto.OpTrust, Cwd: filepath.Join(h.cwd, "missing")}, chatproto.CodeBadRequest)
	h.newChat()
	if h.fake.lastStart(t).Trusted {
		t.Error("an agent trusted without the user")
	}
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: h.cwd})
	h.create(chatproto.Request{Cwd: sub})
	h.fake.session(t)
	if !h.fake.lastStart(t).Trusted {
		t.Error("an agent below a trusted directory is not trusted")
	}

	j := h.served().j
	for i := range maxTrusted + 1 {
		j.trust("/t/"+itoa(i), time.UnixMilli(int64(i+1)), fileID{})
	}
	listed := func(p string) bool {
		rows, err := j.trustedAbove(p)
		return err == nil && len(rows) > 0 && rows[0].path == p
	}
	var n int
	j.db.QueryRow(`SELECT COUNT(*) FROM trusted`).Scan(&n)
	// The user's own is the newest; /t/0 and /t/1 the oldest of 1002.
	if n != maxTrusted || listed("/t/0") || listed("/t/1") || !listed("/t/2") || !listed(h.cwd) {
		t.Errorf("%d trusted; the oldest stay %v %v", n, listed("/t/0"), listed("/t/1"))
	}
}

// OpTrusted lists valid persisted trusted folders and prunes missing/unsafe ones;
// OpHostStatus returns host metadata and active headless sessions.
func TestTrustedListAndHostStatus(t *testing.T) {
	h := startHost(t, nil)
	res := h.ok(chatproto.Request{Op: chatproto.OpTrusted})
	if len(res.Trusted) != 0 {
		t.Fatalf("initial trusted %+v", res.Trusted)
	}
	p1 := filepath.Join(h.cwd, "p1")
	p2 := filepath.Join(h.cwd, "p2")
	os.Mkdir(p1, 0o700)
	os.Mkdir(p2, 0o700)
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: p1})
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: p2})

	res = h.ok(chatproto.Request{Op: chatproto.OpTrusted})
	if len(res.Trusted) != 2 {
		t.Fatalf("trusted %+v", res.Trusted)
	}
	// Removing p1 prunes it when listed.
	os.Remove(p1)
	res = h.ok(chatproto.Request{Op: chatproto.OpTrusted})
	if len(res.Trusted) != 1 || res.Trusted[0].Cwd != p2 {
		t.Fatalf("after remove p1: %+v", res.Trusted)
	}

	s := h.newChat()
	stRes := h.ok(chatproto.Request{Op: chatproto.OpHostStatus})
	if stRes.HostStatus == nil || stRes.HostStatus.PID != os.Getpid() || stRes.HostStatus.LiveAgents != 1 ||
		len(stRes.HostStatus.Sessions) != 1 || stRes.HostStatus.Sessions[0].Chat != s.chat.ID {
		t.Fatalf("host status: %+v", stRes.HostStatus)
	}
}

// Full access: refused while the settings do not allow it, at a new chat
// and at set_config (by the value the adapter marked Full, an agent's own
// too); once they no longer do, a chat whose agent runs with it starts its
// agent again, its session resumed, in the default mode, which a notice
// tells, and stays in it.
func TestFullAccess(t *testing.T) {
	h := startHost(t, nil)
	mode := chatproto.ConfigOption{ID: "mode", Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: "default",
		Options: []chatproto.ConfigValue{{Value: "default", Name: "Ask"}, {Value: "yolo", Name: "Yolo", Full: true}, {Value: chatproto.ModeFull, Name: "Full"}}}
	h.fake.set(func(a *fakeAdapter) { a.config = append(a.config, mode) })
	h.refused(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd, Options: &chatproto.Options{Mode: chatproto.ModeFull}}, chatproto.CodeNotAllowed)
	s := h.newChat()
	for _, v := range []string{"yolo", chatproto.ModeFull} {
		s.mustNot(chatproto.Command{Op: chatproto.OpSetConfig, Config: "mode", Value: v}, chatproto.CodeNotAllowed)
	}

	allow := chatproto.HostSettings{AllowFull: true, DefaultMode: chatproto.ModeFull}
	h.ok(chatproto.Request{Op: chatproto.OpConfigure, Settings: &allow})
	s.must(chatproto.Command{Op: chatproto.OpSetConfig, Config: "mode", Value: "yolo"})
	s.session.expect(t, "set_config:mode=yolo")
	s.turn("go")
	s.session.endTurn("end_turn")
	other := filepath.Join(h.cwd, "other")
	os.Mkdir(other, 0o700)
	full := h.create(chatproto.Request{Cwd: other, Options: &chatproto.Options{Mode: chatproto.ModeFull}})
	fullSession := h.fake.session(t)
	if p := h.fake.lastStart(t); p.Options.Mode != chatproto.ModeFull {
		t.Errorf("a full chat started in %q", p.Options.Mode)
	}
	h.waitState(full.ID, chatproto.StateIdle)

	// Turned off: both live chats start their agents again, without it.
	h.ok(chatproto.Request{Op: chatproto.OpConfigure, Settings: &chatproto.HostSettings{}})
	s.session.expect(t, "close")
	fullSession.expect(t, "close")
	restarted := map[string]*fakeSession{}
	for range 2 {
		n := h.fake.session(t)
		if n.p.Options.Mode != chatproto.ModeDefault {
			t.Errorf("%s started again in %q", n.p.Cwd, n.p.Options.Mode)
		}
		// The full chat had no turn: its agent may not keep its session.
		if n.p.Cwd == other && n.p.Resume != "" || n.p.Cwd == h.cwd && n.p.Resume != s.session.id {
			t.Errorf("%s started again with the session %q", n.p.Cwd, n.p.Resume)
		}
		restarted[n.p.Cwd] = n
	}
	ev := s.until(isKind(notice(agentproto.NoticeFullAccessOff)))
	var params struct{ Mode string }
	json.Unmarshal(ev[len(ev)-1].Params, &params)
	if params.Mode != "yolo" {
		t.Errorf("notice %s", ev[len(ev)-1].raw)
	}
	s.until(isKind("state:idle"))
	h.waitState(full.ID, chatproto.StateIdle)
	// It stays in the default mode.
	s.session = restarted[h.cwd]
	s.prompt("again")
	s.session.expect(t, "prompt:again")
	s.session.endTurn("end_turn")
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	s.prompt("more")
	h.fake.session(t)
	if p := h.fake.lastStart(t); p.Options.Mode != chatproto.ModeDefault {
		t.Errorf("started again in %q", p.Options.Mode)
	}
}

// A host does not take full access from what an earlier one stored: it is
// off until a configure of its own process allows it.
func TestFullAccessOffAtStart(t *testing.T) {
	h := startHost(t, func(h *testHost) { h.o.settings = nil })
	allow := chatproto.HostSettings{AllowFull: true, DefaultMode: chatproto.ModeFull}
	h.ok(chatproto.Request{Op: chatproto.OpConfigure, Settings: &allow})
	if !h.served().settings.Load().AllowFull {
		t.Fatal("configure did not allow full access")
	}
	h.restart()
	if s := h.served().settings.Load(); s.AllowFull || s.DefaultMode != chatproto.ModeDefault {
		t.Errorf("a host started with %+v", s)
	}
	h.refused(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd, Options: &chatproto.Options{Mode: chatproto.ModeFull}}, chatproto.CodeNotAllowed)
	h.ok(chatproto.Request{Op: chatproto.OpConfigure, Settings: &allow})
	h.create(chatproto.Request{Options: &chatproto.Options{Mode: chatproto.ModeFull}})
}

// An agent that takes a mode of full access by itself while the settings
// do not allow it is set back to the mode it had, which a notice tells;
// one that cannot be is ended, its chat failed.
func TestAgentTakesFullAccess(t *testing.T) {
	h := startHost(t, nil)
	mode := chatproto.ConfigOption{ID: "mode", Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: "plan",
		Options: []chatproto.ConfigValue{{Value: "default"}, {Value: "plan"}, {Value: "auto", Full: true}, {Value: "yolo", Full: true}}}
	h.fake.set(func(a *fakeAdapter) { a.config = append(a.config, mode) })
	s := h.newChat()
	switchTo := func(sess *fakeSession, v string) {
		sess.sink.Update(func(c *chatproto.Chat) {
			c.Config = slices.Clone(c.Config)
			for i := range c.Config {
				if c.Config[i].ID == "mode" {
					c.Config[i].CurrentValue = v
				}
			}
		})
	}
	switchTo(s.session, "yolo")
	s.session.expect(t, "set_config:mode=plan")
	ev := s.until(isKind(notice(agentproto.NoticeFullAccessOff)))
	if !strings.Contains(ev[len(ev)-1].raw, `"mode":"yolo"`) {
		t.Errorf("notice %s", ev[len(ev)-1].raw)
	}
	eventually(t, "the mode set back", func() bool {
		for _, o := range h.chat(s.chat.ID).Config {
			if o.ID == "mode" {
				return o.CurrentValue == "plan"
			}
		}
		return false
	})

	// The agent does not take the mode back: it is ended.
	h.fake.set(func(a *fakeAdapter) { a.setConfigErr = errors.New("no") })
	switchTo(s.session, "auto")
	s.session.expect(t, "set_config:mode=plan")
	s.session.expect(t, "close")
	c := h.waitState(s.chat.ID, chatproto.StateFailed)
	if c.Error == nil || c.Error.Code != chatproto.CodeNotAllowed {
		t.Errorf("failed with %+v", c.Error)
	}
}

// The agent's standard error reaches the clients attached at the time,
// at most chatproto.MaxStderr of its end, and is never stored.
func TestStderrIsNotStored(t *testing.T) {
	h := startHost(t, nil)
	stderr := strings.Repeat("e", 3000) + "TOKEN=secret-at-the-end"
	// Start fails only once a client is attached: the agent's standard
	// error reaches only the connections attached when it fails.
	gate := make(chan struct{})
	h.fake.set(func(a *fakeAdapter) {
		a.startErr = &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "exited", Stderr: "SECRET-AT-THE-START" + stderr}
		a.startGate = gate
	})
	chat := h.create(chatproto.Request{})
	s := h.attach(chat.ID, 0)
	close(gate)
	ev := s.until(isKind("state:failed"))
	e := ev[len(ev)-1].Error
	if e == nil || len(e.Stderr) > chatproto.MaxStderr || !strings.HasSuffix(e.Stderr, "TOKEN=secret-at-the-end") {
		t.Fatalf("live error %+v", e)
	}
	if c := h.chat(chat.ID); c.Error == nil || c.Error.Stderr != e.Stderr {
		t.Errorf("the chat's error %+v", c.Error)
	}
	var n int
	j := openTestJournal(t, h)
	j.db.QueryRow(`SELECT COUNT(*) FROM events WHERE CAST(json AS TEXT) LIKE '%secret%'`).Scan(&n)
	var row string
	j.db.QueryRow(`SELECT error FROM chats WHERE id = ?`, chat.ID).Scan(&row)
	if n != 0 || strings.Contains(row, "secret") || !strings.Contains(row, "exited") {
		t.Errorf("stored: %d events, row %q", n, row)
	}
	for _, e := range h.attach(chat.ID, 0).until(isKind("state:failed")) {
		if strings.Contains(e.raw, "secret") {
			t.Errorf("replayed %s", e.raw)
		}
	}
	h.restart()
	if c := h.chat(chat.ID); c.Error == nil || c.Error.Stderr != "" {
		t.Errorf("after a restart %+v", c.Error)
	}
}

// What an adapter states of a chat is kept only within stateBytes each.
func TestStateBytes(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	command := func(n int) []chatproto.SlashCommand {
		cs := make([]chatproto.SlashCommand, n)
		for i := range cs {
			cs[i] = chatproto.SlashCommand{Name: "c" + itoa(i), Description: strings.Repeat("d", 1000)}
		}
		return cs
	}
	s.session.sink.Update(func(c *chatproto.Chat) { c.Commands = command(50) })
	if info := s.until(isKind("info")); len(info[len(info)-1].Chat.Commands) != 50 {
		t.Fatalf("commands %d", len(info[len(info)-1].Chat.Commands))
	}
	s.session.sink.Update(func(c *chatproto.Chat) { c.Commands, c.Title = command(80), "over" })
	if info := s.until(isKind("info")); len(info[len(info)-1].Chat.Commands) != 50 || info[len(info)-1].Chat.Title != "over" {
		t.Errorf("commands of more than %d bytes taken: %d", stateBytes, len(info[len(info)-1].Chat.Commands))
	}
}

// An attach with NoCatchUp (a read-only reader's) starts nothing: no
// History of a handed off chat's session; a plain one does.
func TestAttachWithoutCatchUp(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("hi")
	s.session.say("a1", "hello")
	s.session.endTurn("end_turn")
	s.must(chatproto.Command{Op: chatproto.OpHandoff})
	s.session.expect(t, "close")
	histories := func() int {
		h.fake.mu.Lock()
		defer h.fake.mu.Unlock()
		return len(h.fake.histories)
	}
	c := h.dial()
	c.write(chatproto.Request{Op: chatproto.OpAttach, Chat: s.chat.ID, NoCatchUp: true})
	var res chatproto.Response
	c.read(&res)
	if !res.OK {
		t.Fatalf("attach: %+v", res.Error)
	}
	time.Sleep(100 * time.Millisecond)
	if n := histories(); n != 0 {
		t.Fatalf("an attach without catch-up ran History %d times", n)
	}
	h.attach(s.chat.ID, 0)
	eventually(t, "the catch-up", func() bool { return histories() == 1 })
}

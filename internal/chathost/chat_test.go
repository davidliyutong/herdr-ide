//go:build unix

package chathost

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// A permission waits for a client's answer; of two clients that answer at
// once, the first counts.
func TestPermissionFirstAnswerWins(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("go")
	res := s.session.permission(context.Background(), chatproto.PermissionCommand)
	ev := s.expect("permission", "state:waiting")[0]
	if ev.ID == "" || ev.Kind != chatproto.PermissionCommand || len(ev.Options) != 2 || !strings.Contains(string(ev.ToolCall), "run ls") {
		t.Fatalf("permission %s", ev.raw)
	}
	if c := h.chat(s.chat.ID); c.Status != chatproto.StatusBlocked {
		t.Errorf("status %s", c.Status)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpPermission, Request: ev.ID, Option: "allow_always"}, chatproto.CodeBadRequest)
	s.mustNot(chatproto.Command{Op: chatproto.OpPermission, Request: "nope", Option: "allow_once"}, chatproto.CodeNotFound)

	other := h.attach(s.chat.ID, s.last)
	var wg sync.WaitGroup
	errs := make([]*chatproto.Error, 2)
	for i, st := range []*stream{s, other} {
		option := []string{chatadapter.OptionAllowOnce, chatadapter.OptionRejectOnce}[i]
		wg.Go(func() {
			errs[i] = st.command(chatproto.Command{Op: chatproto.OpPermission, Request: ev.ID, Option: option})
		})
	}
	wg.Wait()
	won := -1
	for i, e := range errs {
		switch {
		case e == nil && won < 0:
			won = i
		case e == nil:
			t.Fatal("both answers counted")
		case e.Code != chatproto.CodeNotFound:
			t.Errorf("the second answer: %+v", e)
		}
	}
	if won < 0 {
		t.Fatal("no answer counted")
	}
	r := <-res
	want := []string{chatadapter.OptionAllowOnce, chatadapter.OptionRejectOnce}[won]
	if r.err != nil || r.a.Cancelled || r.a.Option != want {
		t.Errorf("the agent got %+v %v, want %s", r.a, r.err, want)
	}
	done := s.expect("permission_done:user", "state:working")[0]
	if done.ID != ev.ID || done.Outcome == nil || done.Outcome.Outcome != chatproto.OutcomeSelected || done.Outcome.OptionID != want {
		t.Errorf("done %s", done.raw)
	}
}

// A question takes answers by question id: option labels, the user's own
// words where allowed; it may be skipped; the first answer counts.
func TestQuestion(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("ask me")
	res := s.session.question(context.Background())
	ev := s.expect("question", "state:waiting")[0]
	if len(ev.Questions) != 2 || ev.Questions[0].ID != "color" || ev.Questions[1].ID != "q2" {
		t.Fatalf("question %s", ev.raw)
	}
	for _, bad := range []map[string][]string{
		nil,
		{"nope": {"red"}},
		{"color": {"green"}},
		{"color": {"red", "blue"}},
		{"color": {}},
	} {
		s.mustNot(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID, Answers: bad}, chatproto.CodeBadRequest)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpPermission, Request: ev.ID, Option: "allow_once"}, chatproto.CodeNotFound)
	answers := map[string][]string{"color": {"blue"}, "q2": {"because"}}
	s.must(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID, Answers: answers})
	s.mustNot(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID, Cancelled: true}, chatproto.CodeNotFound)
	r := <-res
	// The agent gets its answers under its own ids: "" for the question
	// that had none.
	if r.err != nil || r.a.Cancelled || r.a.Answers["color"][0] != "blue" || len(r.a.Answers[""]) != 1 || r.a.Answers[""][0] != "because" {
		t.Errorf("the agent got %+v %v", r.a, r.err)
	}
	done := s.expect("question_done:user", "state:working")[0]
	if done.Answers["color"][0] != "blue" {
		t.Errorf("done %s", done.raw)
	}
	// A secret answer reaches the agent, and nothing keeps it.
	res2 := make(chan questionResult, 1)
	go func() {
		a, err := s.session.sink.Question(context.Background(), chatadapter.QuestionRequest{Questions: []chatproto.Question{
			{ID: "pw", Question: "Password?", Secret: true, AllowOther: true}, {ID: "user", Question: "User?", AllowOther: true}}})
		res2 <- questionResult{a, err}
	}()
	ev = s.expect("question", "state:waiting")[0]
	s.must(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID, Answers: map[string][]string{"pw": {"hunter2"}, "user": {"me"}}})
	if r := <-res2; r.a.Answers["pw"][0] != "hunter2" {
		t.Errorf("the agent got %+v", r.a)
	}
	done = s.expect("question_done:user", "state:working")[0]
	if strings.Contains(done.raw, "hunter2") || done.Answers["pw"][0] != secretMask || done.Answers["user"][0] != "me" {
		t.Errorf("a secret answer told: %s", done.raw)
	}
	var n int
	openTestJournal(t, h).db.QueryRow(`SELECT COUNT(*) FROM events WHERE CAST(json AS TEXT) LIKE '%hunter2%'`).Scan(&n)
	if n != 0 {
		t.Error("a secret answer is in the journal")
	}

	// Skipped.
	res = s.session.question(context.Background())
	ev = s.expect("question", "state:waiting")[0]
	s.must(chatproto.Command{Op: chatproto.OpAnswer, Request: ev.ID, Cancelled: true})
	if r := <-res; r.err != nil || !r.a.Cancelled {
		t.Errorf("skipped: %+v %v", r.a, r.err)
	}
	if done := s.expect("question_done:user", "state:working")[0]; done.Answers != nil {
		t.Errorf("a skipped question's answers: %s", done.raw)
	}
}

// What waits is cancelled by the turn's cancel, by its end, by the agent
// withdrawing it and by the chat's close, each told by whom; and no more
// than maxPending wait.
func TestPendingCancelled(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("one")
	p, q := s.session.permission(context.Background(), chatproto.PermissionFile), (chan questionResult)(nil)
	s.expect("permission", "state:waiting")
	q = s.session.question(context.Background())
	s.expect("question")
	s.must(chatproto.Command{Op: chatproto.OpCancel})
	if r := <-p; r.err != nil || !r.a.Cancelled {
		t.Errorf("permission after cancel: %+v %v", r.a, r.err)
	}
	if r := <-q; r.err != nil || !r.a.Cancelled {
		t.Errorf("question after cancel: %+v %v", r.a, r.err)
	}
	s.expect("permission_done:cancel", "question_done:cancel", "state:working")
	s.session.expect(t, "cancel")
	s.expect("turn:end", "state:idle")

	// The turn's end.
	s.turn("two")
	p = s.session.permission(context.Background(), chatproto.PermissionTool)
	s.expect("permission", "state:waiting")
	s.session.endTurn("end_turn")
	if r := <-p; r.err != nil || !r.a.Cancelled {
		t.Errorf("permission after the turn's end: %+v %v", r.a, r.err)
	}
	s.expect("permission_done:ended", "turn:end", "state:idle")

	// The agent withdraws it.
	s.turn("three")
	ctx, cancel := context.WithCancel(context.Background())
	p = s.session.permission(ctx, chatproto.PermissionTool)
	s.expect("permission", "state:waiting")
	cancel()
	if r := <-p; !r.a.Cancelled {
		t.Errorf("withdrawn: %+v", r.a)
	}
	s.expect("permission_done:cancel", "state:working")

	// Too many.
	var all []chan permResult
	for range maxPending {
		all = append(all, s.session.permission(context.Background(), chatproto.PermissionTool))
	}
	asked := 0
	s.until(func(e event) bool {
		if e.T == chatproto.EventPermission {
			asked++
		}
		return asked == maxPending
	})
	extra := s.session.permission(context.Background(), chatproto.PermissionTool)
	if r := <-extra; !r.a.Cancelled || r.err != nil {
		t.Errorf("one too many: %+v %v", r.a, r.err)
	}

	// The chat's close: the agent is told the chat ended.
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	for _, p := range all {
		if r := <-p; !r.a.Cancelled || r.err == nil {
			t.Errorf("after close: %+v %v", r.a, r.err)
		}
	}
	events := s.until(isKind("state:closed"))
	if got := kinds(events); !strings.HasSuffix(got, "permission_done:ended turn:error state:closed") {
		t.Errorf("close: %s", got)
	}
}

// The agent's events the host makes itself are left out; turn events of
// no known state too.
func TestAdapterEventsFiltered(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	sink := s.session.sink
	for _, ev := range []chatproto.Event{
		{T: chatproto.EventState, State: chatproto.StateFailed},
		{T: chatproto.EventAck, ID: "x"},
		{T: chatproto.EventPermission, ID: "p"},
		{T: chatproto.EventQuestionDone, ID: "q"},
		{T: chatproto.EventInfo},
		{T: chatproto.EventTurn, State: "weird"},
		{T: "nope"},
		{T: chatproto.EventUpdate, Live: true, Update: agentChunk("no item")},
	} {
		sink.Event(ev)
	}
	sink.Event(chatproto.Event{T: chatproto.EventNotice, Method: "_x/y", Seq: 999})
	if e := s.next(); e.kind() != "notice:_x/y" {
		t.Errorf("event %s", e.raw)
	}
	s.quiet()
	select {
	case l := <-s.lives:
		t.Errorf("a live event without an item: %s", l.raw)
	default:
	}
}

// The agent's own end: with an error the chat failed, and the next prompt
// resumes the session.
func TestAgentEnds(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	session := s.session.id
	s.turn("work")
	p := s.session.permission(context.Background(), chatproto.PermissionTool)
	s.expect("permission", "state:waiting")
	s.session.crash()
	if r := <-p; r.err == nil {
		t.Error("the permission of an agent that ended has no error")
	}
	ev := s.until(isKind("state:failed"))
	last := ev[len(ev)-1]
	if got := kinds(ev); got != "permission_done:ended turn:error state:failed" || last.Error == nil || last.Error.Code != chatproto.CodeEnded {
		t.Fatalf("events %s / %s", got, last.raw)
	}
	c := h.chat(s.chat.ID)
	if c.Status != chatproto.StatusDone || c.Error == nil {
		t.Errorf("failed chat %+v", c)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpCancel}, chatproto.CodeSleeping)
	s.mustNot(chatproto.Command{Op: chatproto.OpSetConfig, Config: "model", Value: "large"}, chatproto.CodeSleeping)
	s.prompt("again")
	s.session = h.fake.session(t)
	if p := h.fake.lastStart(t); p.Resume != session || p.SessionID != "" {
		t.Errorf("resumed with %+v", p)
	}
	s.session.expect(t, "prompt:again")
	s.expect("state:starting", "info", "state:idle", "user", "state:working", "turn:start")

	// Without an error it sleeps.
	s.session.endTurn("end_turn")
	s.expect("turn:end", "state:idle")
	s.session.end(nil)
	s.expect("state:sleeping")
}

// A start that fails leaves the chat failed with the adapter's error; the
// next prompt starts again.
func TestStartFails(t *testing.T) {
	h := startHost(t, nil)
	h.fake.set(func(a *fakeAdapter) {
		a.startErr = &chatproto.Error{Code: chatproto.CodeAuthRequired, Message: "sign in"}
	})
	chat := h.create(chatproto.Request{})
	s := h.attach(chat.ID, 0)
	ev := s.until(isKind("state:failed"))
	if e := ev[len(ev)-1].Error; e == nil || e.Code != chatproto.CodeAuthRequired {
		t.Fatalf("failed with %s", ev[len(ev)-1].raw)
	}
	h.fake.set(func(a *fakeAdapter) { a.startErr = nil })
	s.prompt("now")
	s.session = h.fake.session(t)
	if p := h.fake.lastStart(t); p.Resume != "" || p.SessionID == "" {
		t.Errorf("start again: %+v", p)
	}
	s.session.expect(t, "prompt:now")

	// An agent not in the PATH.
	chat = h.create(chatproto.Request{Kind: "missing"})
	s = h.attach(chat.ID, 0)
	ev = s.until(isKind("state:failed"))
	if e := ev[len(ev)-1].Error; e == nil || e.Code != chatproto.CodeNotFound {
		t.Fatalf("missing: %s", ev[len(ev)-1].raw)
	}
}

// A prompt to a chat that still starts waits for the start; a second one
// is refused meanwhile; commands that need the agent are refused while it
// starts.
func TestPromptWhileStarting(t *testing.T) {
	h := startHost(t, nil)
	gate := make(chan struct{})
	h.fake.set(func(a *fakeAdapter) { a.startGate = gate })
	chat := h.create(chatproto.Request{})
	s := h.attach(chat.ID, 0)
	id := s.send(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("early")}})
	eventually(t, "the prompt waits", func() bool {
		c := h.served().lookup(chat.ID)
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.held
	})
	s.mustNot(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("second")}}, chatproto.CodeBusy)
	s.mustNot(chatproto.Command{Op: chatproto.OpCompact}, chatproto.CodeBusy)
	s.mustNot(chatproto.Command{Op: chatproto.OpHandoff}, chatproto.CodeBusy)
	close(gate)
	s.session = h.fake.session(t)
	if e := s.ack(id); e != nil {
		t.Fatalf("the prompt: %+v", e)
	}
	s.session.expect(t, "prompt:early")
	s.expect("info", "state:idle", "user", "state:working", "info", "turn:start")
}

// set_config takes only the chat's options and their values; the agent
// starts again with what was set last.
func TestSetConfig(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.mustNot(chatproto.Command{Op: chatproto.OpSetConfig, Config: "effort", Value: "high"}, chatproto.CodeBadRequest)
	s.mustNot(chatproto.Command{Op: chatproto.OpSetConfig, Config: "model", Value: "huge"}, chatproto.CodeBadRequest)
	s.must(chatproto.Command{Op: chatproto.OpSetConfig, Config: "model", Value: "large"})
	s.session.expect(t, "set_config:model=large")
	info := s.expect("info")[0]
	if info.Chat.Config[0].CurrentValue != "large" {
		t.Errorf("config %+v", info.Chat.Config)
	}
	s.must(chatproto.Command{Op: chatproto.OpCompact})
	s.session.expect(t, "compact")
	s.must(chatproto.Command{Op: chatproto.OpRename, Title: "  my\nchat  "})
	if info := s.expect("info")[0]; info.Chat.Title != "my chat" {
		t.Errorf("title %q", info.Chat.Title)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpRename, Title: " "}, chatproto.CodeBadRequest)
	s.mustNot(chatproto.Command{Op: "nope"}, chatproto.CodeBadRequest)
	// Resumed with the model set last.
	s.turn("hi")
	s.session.endTurn("end_turn")
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	s.prompt("back")
	h.fake.session(t)
	if p := h.fake.lastStart(t); p.Options.Model != "large" || p.Resume == "" {
		t.Errorf("resumed with %+v", p.Options)
	}
}

// A chat idle for IdleStopMinutes sleeps, its agent ended; the next prompt
// resumes the session.
func TestIdleStopAndResume(t *testing.T) {
	h := startHost(t, func(h *testHost) {
		h.o.minute = 10 * time.Millisecond // IdleStopMinutes 5: 50 ms
		h.o.settings.IdleStopMinutes = 5
	})
	s := h.newChat()
	session := s.session
	session.expect(t, "close")
	s.expect("state:sleeping")
	if c := h.chat(s.chat.ID); c.State != chatproto.StateSleeping || c.SessionID != session.id {
		t.Fatalf("chat %+v", c)
	}
	// The session never had a turn, which the agent may not have kept: a
	// new one is made.
	s.prompt("wake up")
	s.session = h.fake.session(t)
	if p := h.fake.lastStart(t); p.Resume != "" || p.SessionID == "" || p.SessionID == session.id {
		t.Errorf("a session without a turn resumed: %+v", p)
	}
	s.session.expect(t, "prompt:wake up")
	s.expect("state:starting", "info", "state:idle", "user", "state:working", "info", "turn:start")
	// Working: no idle stop.
	time.Sleep(150 * time.Millisecond)
	if c := h.chat(s.chat.ID); c.State != chatproto.StateWorking {
		t.Errorf("a working chat was stopped: %s", c.State)
	}
	s.session.endTurn("end_turn")
	s.expect("turn:end", "state:idle")
	s.session.expect(t, "close")
	s.expect("state:sleeping")
	// One that had a turn is resumed.
	second := s.session.id
	if c := h.chat(s.chat.ID); c.SessionID != second {
		t.Errorf("the chat's session %q, want %q", c.SessionID, second)
	}
	s.prompt("again")
	s.session = h.fake.session(t)
	if p := h.fake.lastStart(t); p.Resume != second {
		t.Errorf("resume %q, want %q", p.Resume, second)
	}
}

// No more agents run than MaxLive: a start stops the agent idle the
// longest, and fails when all others work.
func TestMaxLive(t *testing.T) {
	h := startHost(t, func(h *testHost) { h.o.settings.MaxLive = 2 })
	a := h.newChat()
	b := h.newChat()
	a.turn("busy") // a works; b is idle
	c := h.newChat()
	b.session.expect(t, "close")
	b.expect("state:sleeping")
	if st := h.chat(a.chat.ID).State; st != chatproto.StateWorking {
		t.Errorf("a: %s", st)
	}
	// c is idle, a works: one more stops c.
	d := h.newChat()
	c.session.expect(t, "close")
	c.expect("state:sleeping")
	// Both work: no room.
	d.turn("busy too")
	chat := h.create(chatproto.Request{})
	e := h.attach(chat.ID, 0)
	ev := e.until(isKind("state:failed"))
	if err := ev[len(ev)-1].Error; err == nil || err.Code != chatproto.CodeTooMany {
		t.Errorf("no room: %s", ev[len(ev)-1].raw)
	}
	// configure with fewer stops idle ones.
	a.session.endTurn("end_turn")
	a.expect("turn:end", "state:idle")
	h.ok(chatproto.Request{Op: chatproto.OpConfigure, Settings: &chatproto.HostSettings{MaxLive: 1}})
	a.session.expect(t, "close")
	a.expect("state:sleeping")
}

// handoff ends the agent while no turn runs; what the session did in a
// terminal comes into the log when somebody attaches and before the next
// prompt resumes it.
func TestHandoffAndCatchUp(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("start")
	s.mustNot(chatproto.Command{Op: chatproto.OpHandoff}, chatproto.CodeBusy)
	s.session.say("i1", "one")
	s.session.endTurn("end_turn")
	s.expect("update:agent_message_chunk", "turn:end", "state:idle")
	s.must(chatproto.Command{Op: chatproto.OpHandoff})
	s.session.expect(t, "close")
	ev := s.expect("state:sleeping", "notice:"+agentproto.NoticeMethod(agentproto.NoticeHandedOff), "info")
	if !ev[2].Chat.HandedOff {
		t.Errorf("info %s", ev[2].raw)
	}
	s.mustNot(chatproto.Command{Op: chatproto.OpCompact}, chatproto.CodeHandedOff)

	// In the terminal the session went on.
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventUpdate, Item: "i1", Update: agentChunk("one")},
			{T: chatproto.EventUser, Content: []json.RawMessage{textBlock("in the terminal")}},
			{T: chatproto.EventUpdate, Item: "i2", Update: agentChunk("two")},
			{T: chatproto.EventTurn, State: chatproto.TurnEnd},
		}
	})
	other := h.attach(s.chat.ID, s.last)
	got := other.expect("user", "update:agent_message_chunk", "turn:end")
	if got[1].Item != "i2" {
		t.Errorf("caught up %s", got[1].raw)
	}
	h.fake.mu.Lock()
	hp := h.fake.histories[len(h.fake.histories)-1]
	h.fake.mu.Unlock()
	if hp.After != "i1" || hp.SessionID != s.session.id {
		t.Errorf("history after %q of %q", hp.After, hp.SessionID)
	}
	c := h.chat(s.chat.ID)
	if c.Status != chatproto.StatusIdle || !c.HandedOff {
		t.Errorf("after the catch-up: %+v", c)
	}
	// The prompt: caught up again (nothing new), then resumed.
	s.prompt("here again")
	s.session = h.fake.session(t)
	s.session.expect(t, "prompt:here again")
	h.fake.mu.Lock()
	hp = h.fake.histories[len(h.fake.histories)-1]
	h.fake.mu.Unlock()
	if hp.After != "i2" {
		t.Errorf("second history after %q", hp.After)
	}
	if c := h.chat(s.chat.ID); c.HandedOff {
		t.Error("still handed off after a prompt")
	}
}

// A new chat that imports a session has its conversation first, seen, and
// resumes it; a session that has a chat is not taken by another.
func TestImport(t *testing.T) {
	h := startHost(t, nil)
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventUser, Content: []json.RawMessage{textBlock("old")}},
			{T: chatproto.EventUpdate, Item: "a", Update: agentChunk("old answer")},
			{T: chatproto.EventTurn, State: chatproto.TurnEnd},
			{T: chatproto.EventUpdate, Item: "b", Live: true, Update: agentChunk("never")},
		}
	})
	const id = "0b6c0b6c-0b6c-4b6c-8b6c-0b6c0b6c0b6c"
	chat := h.create(chatproto.Request{Resume: id, Import: true})
	s := h.attach(chat.ID, 0)
	h.fake.session(t)
	ev := s.until(isKind("state:idle"))
	if got := kinds(ev); got != "user update:agent_message_chunk turn:end info state:idle" {
		t.Errorf("events %s", got)
	}
	if p := h.fake.lastStart(t); p.Resume != id {
		t.Errorf("start %+v", p)
	}
	c := h.chat(chat.ID)
	if c.Status != chatproto.StatusIdle || c.SessionID != id {
		t.Errorf("chat %+v", c)
	}
	h.refused(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd, Resume: id}, chatproto.CodeBadRequest)
	// sessions marks it.
	h.fake.set(func(a *fakeAdapter) {
		a.list = []chatproto.Session{{SessionID: id, Cwd: h.cwd}, {SessionID: "other", Cwd: h.cwd}}
	})
	res := h.ok(chatproto.Request{Op: chatproto.OpSessions, Kind: fakeKind, Cwd: h.cwd, Cursor: "c1"})
	if len(res.Sessions) != 2 || res.Sessions[0].Chat != chat.ID || res.Sessions[1].Chat != "" || res.NextCursor != "next-page" {
		t.Errorf("sessions %+v", res)
	}
	h.fake.set(func(a *fakeAdapter) {
		if p := a.sessionsP[0]; p.Cursor != "c1" || p.Argv[0] != testExecutable(t) || p.Cwd != h.cwd {
			t.Errorf("sessions params %+v", p)
		}
	})
	h.refused(chatproto.Request{Op: chatproto.OpSessions, Kind: fakeKind, Cwd: "rel"}, chatproto.CodeBadRequest)
	h.refused(chatproto.Request{Op: chatproto.OpSessions, Kind: "missing", Cwd: h.cwd}, chatproto.CodeNotFound)
}

// close keeps the chat, closed, and a prompt resumes it; delete forgets it
// and its log, and closes who is attached.
func TestCloseAndDelete(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	s.session.expect(t, "close")
	s.expect("state:closed")
	c := h.chat(s.chat.ID)
	if c.Closed.IsZero() || c.State != chatproto.StateClosed {
		t.Fatalf("closed %+v", c)
	}
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	if c2 := h.chat(s.chat.ID); !c2.Closed.Equal(c.Closed) {
		t.Error("closing again changed when it was closed")
	}
	s.prompt("reopen")
	s.session = h.fake.session(t)
	s.session.expect(t, "prompt:reopen")
	if c := h.chat(s.chat.ID); !c.Closed.IsZero() || c.State != chatproto.StateWorking {
		t.Errorf("resumed %+v", c)
	}
	h.ok(chatproto.Request{Op: chatproto.OpDelete, Chat: s.chat.ID})
	s.session.expect(t, "close")
	s.ends()
	h.refused(chatproto.Request{Op: chatproto.OpAttach, Chat: s.chat.ID}, chatproto.CodeUnknownChat)
	h.refused(chatproto.Request{Op: chatproto.OpDelete, Chat: s.chat.ID}, chatproto.CodeUnknownChat)
	if len(h.chats()) != 0 {
		t.Error("a chat is left")
	}
	var n int
	j := openTestJournal(t, h)
	j.db.QueryRow(`SELECT COUNT(*) FROM events`).Scan(&n)
	if n != 0 {
		t.Errorf("%d events left", n)
	}
}

// watch sends every chat's state, then each change, and a deleted chat.
func TestWatch(t *testing.T) {
	h := startHost(t, nil)
	a := h.newChat()
	c := h.dial()
	c.write(chatproto.Request{Op: chatproto.OpWatch})
	var res chatproto.Response
	c.read(&res)
	if !res.OK || len(res.States) != 1 || res.States[0].ID != a.chat.ID {
		t.Fatalf("watch %+v", res)
	}
	next := func() chatproto.ChatState {
		t.Helper()
		var st chatproto.ChatState
		c.read(&st)
		return st
	}
	if res.States[0].State != chatproto.StateIdle {
		// The watch came before the watchers were told it was idle: that
		// comes next.
		if st := next(); st.State != chatproto.StateIdle {
			t.Fatalf("watch %+v, then %+v", res, st)
		}
	}
	a.turn("hi")
	st := next()
	if st.State != chatproto.StateWorking || st.Status != chatproto.StatusWorking || st.Title != "hi" {
		t.Errorf("working %+v", st)
	}
	a.session.endTurn("end_turn")
	if st := next(); st.State != chatproto.StateIdle || st.Status != chatproto.StatusDone {
		t.Errorf("done %+v", st)
	}
	h.ok(chatproto.Request{Op: chatproto.OpSeen, Chat: a.chat.ID, Seq: 1 << 30})
	if st := next(); st.Status != chatproto.StatusIdle {
		t.Errorf("seen %+v", st)
	}
	b := h.create(chatproto.Request{})
	if st := next(); st.ID != b.ID || st.State != chatproto.StateStarting {
		t.Errorf("new %+v", st)
	}
	h.fake.session(t)
	for {
		st := next()
		if st.ID != b.ID {
			t.Fatalf("another chat's %+v", st)
		}
		if st.State == chatproto.StateIdle {
			if st.SessionID == "" {
				t.Errorf("started %+v", st)
			}
			break
		}
	}
	h.ok(chatproto.Request{Op: chatproto.OpDelete, Chat: b.ID})
	for {
		st := next()
		if st.ID == b.ID && st.State == chatproto.StateDeleted {
			break
		}
	}
}

// shutdown is refused while a chat works; otherwise the agents are ended
// gracefully, the chats sleep, and the host ends.
func TestShutdown(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("busy")
	h.refused(chatproto.Request{Op: chatproto.OpShutdown}, chatproto.CodeBusy)
	s.session.endTurn("end_turn")
	s.expect("turn:end", "state:idle")
	h.ok(chatproto.Request{Op: chatproto.OpShutdown})
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	s.session.expect(t, "close")
	s.expect("state:sleeping")
	s.ends()
	// The next host has it sleeping.
	h.serve()
	if c := h.chat(s.chat.ID); c.State != chatproto.StateSleeping || c.SessionID != s.session.id {
		t.Errorf("after the handover: %+v", c)
	}
}

// A host that ended while chats worked (killed) finds them sleeping: what
// waited cancelled, the turn ended in an error.
func TestRecovery(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("long")
	s.session.permission(context.Background(), chatproto.PermissionTool)
	s.expect("permission", "state:waiting")
	id := s.chat.ID
	// What a killed host leaves: the journal as it was, not what a stop
	// wrote.
	j := openTestJournal(t, h)
	rows, _ := j.loadChats()
	h.stop()
	h.wait()
	for _, r := range rows {
		j.db.Exec(`DELETE FROM events WHERE chat = ? AND seq > ?`, r.ID, int64(r.Seq))
		j.saveChat(r)
	}
	h.serve()
	c := h.chat(id)
	if c.State != chatproto.StateSleeping || c.Status != chatproto.StatusDone {
		t.Fatalf("recovered %+v", c)
	}
	st := h.attach(id, s.last)
	got := kinds(st.until(isKind("state:sleeping")))
	if got != "permission_done:ended turn:error state:sleeping" {
		t.Errorf("recovery %s", got)
	}
}

// The host without agents and connections ends after idleExit.
func TestIdleExit(t *testing.T) {
	h := startHost(t, func(h *testHost) { h.o.idleExit = 200 * time.Millisecond })
	s := h.newChat()
	time.Sleep(400 * time.Millisecond)
	select {
	case <-h.finished:
		t.Fatal("ended with an agent and a connection")
	default:
	}
	s.c.conn.Close()
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	start := time.Now()
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 150*time.Millisecond {
		t.Errorf("ended after %s", d)
	}
}

// Commands to a chat that has no agent.
func TestCommandsWithoutAgent(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
	for _, op := range []string{chatproto.OpCompact, chatproto.OpCancelQueued, chatproto.OpSetConfig} {
		cmd := chatproto.Command{Op: op, Message: "m1", Config: "model", Value: "large"}
		s.mustNot(cmd, chatproto.CodeSleeping)
	}
	s.must(chatproto.Command{Op: chatproto.OpRename, Title: "closed one"})
}

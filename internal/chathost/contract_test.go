//go:build unix

package chathost

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// The host records a prompt's EventUser when it believes no turn runs
// (PromptParams.Recorded), and leaves it to the adapter otherwise: a turn
// that ended between the host's look and the adapter's Prompt starts with
// the user's message all the same.
func TestPromptRecorded(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("first")
	s.prompt("second")
	s.session.expect(t, "prompt:second")
	s.expect("queued:queued")
	s.session.endTurn("end_turn")
	s.expect("turn:end", "state:idle")

	// The agent's turn ends; the host still sees it run.
	s.turn("third")
	s.session.mu.Lock()
	s.session.turn = false
	s.session.mu.Unlock()
	s.prompt("fourth")
	s.session.expect(t, "prompt:fourth")
	ev := s.expect("user", "turn:start")
	if ev[0].ClientID != "u-fourth" || promptText(ev[0].Content) != "fourth" {
		t.Errorf("the adapter's user event %s", ev[0].raw)
	}
	s.session.mu.Lock()
	var recorded []bool
	for _, p := range s.session.prompts {
		recorded = append(recorded, p.Recorded)
	}
	s.session.mu.Unlock()
	if want := []bool{true, false, true, false}; !slices.Equal(recorded, want) {
		t.Errorf("recorded %v, want %v", recorded, want)
	}
}

// A catch-up whose item the session no longer has (CodeNotFound) is left
// out: the session resumes as the log has it, without an error in the
// log. An import that fails is told.
func TestCatchUpNotFound(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("start")
	s.session.say("i1", "one")
	s.session.endTurn("end_turn")
	s.expect("update:agent_message_chunk", "turn:end", "state:idle")
	s.must(chatproto.Command{Op: chatproto.OpHandoff})
	s.session.expect(t, "close")
	s.until(isKind("info"))

	h.fake.set(func(a *fakeAdapter) {
		a.historyErr = &chatproto.Error{Code: chatproto.CodeNotFound, Message: "no item i1"}
	})
	s.prompt("back")
	s.session = h.fake.session(t)
	s.session.expect(t, "prompt:back")
	errorNotice := "notice:" + agentproto.NoticeMethod(agentproto.NoticeError)
	for _, e := range s.until(isKind("turn:start")) {
		if e.kind() == errorNotice {
			t.Errorf("an error stored: %s", e.raw)
		}
	}
	h.fake.mu.Lock()
	hp := h.fake.histories[len(h.fake.histories)-1]
	h.fake.mu.Unlock()
	if hp.After != "i1" {
		t.Errorf("catch-up after %q", hp.After)
	}
	if !strings.Contains(h.log.String(), "no catch-up of "+s.session.id+" after i1") {
		t.Errorf("not logged:\n%s", h.log)
	}

	const id = "0b6c0b6c-0b6c-4b6c-8b6c-0b6c0b6c0b6c"
	chat := h.create(chatproto.Request{Resume: id, Import: true})
	a := h.attach(chat.ID, 0)
	h.fake.session(t)
	ev := a.until(isKind("state:idle"))
	if ev[0].kind() != errorNotice || !strings.Contains(string(ev[0].Params), chatproto.CodeNotFound) {
		t.Errorf("the import's failure: %s", kinds(ev))
	}
}

// lockingAdapter's sessions call the Sink from inside every method with a
// lock of their own held, as the adapters may: the host calls no Session
// method while holding a lock its Sink takes, or it would deadlock here.
type lockingAdapter struct {
	*fakeAdapter
	mu       sync.Mutex
	sessions []*lockingSession
}

func (a *lockingAdapter) Start(ctx context.Context, p chatadapter.StartParams, sink chatadapter.Sink) (chatadapter.Session, error) {
	s, err := a.fakeAdapter.Start(ctx, p, sink)
	if err != nil {
		return nil, err
	}
	l := &lockingSession{fakeSession: s.(*fakeSession), sink: sink}
	a.mu.Lock()
	a.sessions = append(a.sessions, l)
	a.mu.Unlock()
	return l, nil
}

type lockingSession struct {
	*fakeSession
	sink  chatadapter.Sink
	mu    sync.Mutex
	pokes atomic.Int64
}

// poke calls the Sink; l.mu is held.
func (l *lockingSession) poke(what string) {
	l.sink.Event(chatproto.Event{T: chatproto.EventUpdate, Item: "poke", Live: true, Update: agentChunk(what)})
	l.sink.Update(func(c *chatproto.Chat) { c.AgentVersion = "poked by " + what })
	l.pokes.Add(1)
}

func (l *lockingSession) ID() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("id")
	return l.fakeSession.ID()
}

func (l *lockingSession) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("err")
	return l.fakeSession.Err()
}

func (l *lockingSession) PID() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("pid")
	return 0
}

// Prompt asks a permission of its own, and waits for its answer, when the
// prompt is "ask".
func (l *lockingSession) Prompt(ctx context.Context, p chatadapter.PromptParams) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("prompt")
	if promptText(p.Content) == "ask" {
		a, err := l.sink.Permission(ctx, chatadapter.PermissionRequest{Kind: chatproto.PermissionTool,
			ToolCall: json.RawMessage(`{"toolCallId":"t9","title":"asked in Prompt"}`),
			Options:  []chatproto.PermissionOption{{OptionID: chatadapter.OptionAllowOnce, Name: "Allow", Kind: chatproto.AllowOnce}}})
		if err != nil || a.Option != chatadapter.OptionAllowOnce {
			l.fakeSession.record("permission not allowed")
		}
	}
	return l.fakeSession.Prompt(ctx, p)
}

func (l *lockingSession) Cancel(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("cancel")
	return l.fakeSession.Cancel(ctx)
}

func (l *lockingSession) CancelQueued(ctx context.Context, m string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("cancel_queued")
	return l.fakeSession.CancelQueued(ctx, m)
}

func (l *lockingSession) SetConfig(ctx context.Context, id, value string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("set_config")
	return l.fakeSession.SetConfig(ctx, id, value)
}

func (l *lockingSession) Compact(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("compact")
	return l.fakeSession.Compact(ctx)
}

func (l *lockingSession) Close(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.poke("close")
	return l.fakeSession.Close(ctx)
}

func TestSessionMethodsCallTheSink(t *testing.T) {
	var a *lockingAdapter
	h := startHost(t, func(h *testHost) {
		a = &lockingAdapter{fakeAdapter: h.fake}
		h.o.adapters = func(name string) (chatadapter.Adapter, bool) { return a, name == fakeAdapterName }
	})
	s := h.newChat() // ID
	s.turn("first")  // Prompt, recorded
	s.prompt("second")
	s.session.expect(t, "prompt:second")
	q := s.until(isKind("queued:queued"))
	s.must(chatproto.Command{Op: chatproto.OpCancelQueued, Message: q[len(q)-1].Message})
	s.session.expect(t, "cancel_queued:"+q[len(q)-1].Message)
	s.must(chatproto.Command{Op: chatproto.OpSetConfig, Config: "model", Value: "large"})
	s.session.expect(t, "set_config:model=large")
	s.must(chatproto.Command{Op: chatproto.OpCompact})
	s.session.expect(t, "compact")

	// A permission asked from inside Prompt is answered meanwhile.
	id := s.send(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("ask")}, ClientID: "u-ask"})
	perm := s.until(isKind(chatproto.EventPermission))
	s.must(chatproto.Command{Op: chatproto.OpPermission, Request: perm[len(perm)-1].ID, Option: chatadapter.OptionAllowOnce})
	if e := s.ack(id); e != nil {
		t.Fatalf("prompt: %+v", e)
	}
	s.session.expect(t, "prompt:ask")

	s.must(chatproto.Command{Op: chatproto.OpCancel})
	s.session.expect(t, "cancel")
	s.until(isKind("state:idle"))
	s.must(chatproto.Command{Op: chatproto.OpHandoff}) // Close
	s.session.expect(t, "close")
	s.until(isKind("info"))
	s.prompt("again") // resumed: ID again
	s.session = h.fake.session(t)
	s.session.expect(t, "prompt:again")
	s.session.crash() // Err
	s.until(isKind("state:failed"))
	h.ok(chatproto.Request{Op: chatproto.OpDelete, Chat: s.chat.ID})

	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.sessions) != 2 {
		t.Fatalf("%d sessions", len(a.sessions))
	}
	if p0, p1 := a.sessions[0].pokes.Load(), a.sessions[1].pokes.Load(); p0 < 9 || p1 < 3 {
		t.Errorf("the sessions called the Sink %d and %d times", p0, p1)
	}
}

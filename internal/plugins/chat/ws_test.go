package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/plugin"
)

// wsPage is a page's WebSocket in the test.
type wsPage struct {
	t *testing.T
	c *websocket.Conn
}

// dial connects a page to the plugin's WebSocket.
func (s *setup) dial(t *testing.T) *wsPage {
	t.Helper()
	mux := http.NewServeMux()
	for _, rt := range s.p.Routes() {
		if rt.Path == "ws" {
			mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { rt.Handler(&plugin.Call{Host: s.h}, w, r) })
		}
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(64 << 20)
	t.Cleanup(func() { c.CloseNow() })
	return &wsPage{t: t, c: c}
}

func (pg *wsPage) send(m ClientMessage) {
	pg.t.Helper()
	b, _ := json.Marshal(m)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pg.c.Write(ctx, websocket.MessageText, b); err != nil {
		pg.t.Fatal(err)
	}
}

// next is the page's next message.
func (pg *wsPage) next() map[string]any {
	pg.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := pg.c.Read(ctx)
	if err != nil {
		pg.t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		pg.t.Fatalf("message %s: %v", b, err)
	}
	return m
}

// expect is the next message, which must be of type typ.
func (pg *wsPage) expect(typ string) map[string]any {
	pg.t.Helper()
	m := pg.next()
	if m["t"] != typ {
		pg.t.Fatalf("got %v, not %s", m, typ)
	}
	return m
}

func errCode(m map[string]any) any {
	e, _ := m["error"].(map[string]any)
	return e["code"]
}

// newChat makes a chat of the fake host.
func (s *setup) newChat(state string) string {
	id := chatproto.NewChatID()
	s.f.mu.Lock()
	s.f.chats[id] = chatproto.Chat{ID: id, Kind: "codex", Cwd: "/w", State: state, Status: chatproto.StatusIdle}
	s.f.mu.Unlock()
	return id
}

func (s *setup) attached(n int) {
	s.f.wait(fmt.Sprintf("%d attached", n), func() bool { return len(s.f.attached) == n })
}

// A page attaches to a chat and gets its events as the host sends them;
// its commands reach the host under the core's ids, and each host's
// answer reaches the page under the page's; those that decide what an
// agent may do are audited, without what was answered.
func TestWSRelay(t *testing.T) {
	s := newSetup(t)
	id := s.newChat(chatproto.StateIdle)
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id, From: 3})
	m := pg.expect(TAttached)
	if m["sub"] != "s1" || m["first"] != 1.0 || m["chat"].(map[string]any)["id"] != id {
		t.Fatalf("attached %v", m)
	}
	s.attached(1)
	s.f.mu.Lock()
	req := s.f.requests[len(s.f.requests)-1]
	s.f.mu.Unlock()
	if req.Op != chatproto.OpAttach || req.Chat != id || req.From != 3 || req.NoCatchUp {
		t.Errorf("attached as %+v", req)
	}
	s.f.emit(id, chatproto.Event{Seq: 4, T: chatproto.EventUser, ClientID: "u1", Content: []json.RawMessage{json.RawMessage(`{"type":"text","text":"<b>hi</b>"}`)}})
	s.f.emit(id, chatproto.Event{T: chatproto.EventUpdate, Live: true, Item: "m1", Update: json.RawMessage(`{"sessionUpdate":"agent_message_chunk"}`)})
	ev := pg.expect(TEvent)
	if ev["sub"] != "s1" || ev["ev"].(map[string]any)["seq"] != 4.0 || !strings.Contains(fmt.Sprint(ev["ev"]), "<b>hi</b>") {
		t.Errorf("event %v", ev)
	}
	if ev = pg.expect(TEvent); ev["ev"].(map[string]any)["live"] != true {
		t.Errorf("live event %v", ev)
	}

	pg.send(ClientMessage{Op: OpCommand, ID: "p1", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPrompt, ID: "x", ClientID: "u2",
		Content: []json.RawMessage{json.RawMessage(`{"type":"text","text":"secret prompt"}`)}}})
	if m = pg.expect(TAck); m["id"] != "p1" || m["error"] != nil {
		t.Errorf("ack %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p2", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPermission, Request: "r1", Option: "allow_once"}})
	pg.expect(TAck)
	pg.send(ClientMessage{Op: OpCommand, ID: "p3", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpAnswer, Request: "q1",
		Answers: map[string][]string{"a": {"hunter2"}}}})
	pg.expect(TAck)
	s.f.ackErr[chatproto.OpSetConfig] = &chatproto.Error{Code: chatproto.CodeNotAllowed, Message: "full access is off"}
	pg.send(ClientMessage{Op: OpCommand, ID: "p4", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpSetConfig, Config: "mode", Value: "full"}})
	if m = pg.expect(TAck); m["id"] != "p4" || errCode(m) != chatproto.CodeNotAllowed {
		t.Errorf("refused ack %v", m)
	}
	s.f.mu.Lock()
	var ids []string
	for _, c := range s.f.commands {
		ids = append(ids, c.Op+":"+c.ID)
	}
	s.f.mu.Unlock()
	if strings.Join(ids, " ") != "prompt:k1 permission:k2 answer:k3 set_config:k4" {
		t.Errorf("the host got %v", ids)
	}
	s.h.mu.Lock()
	audits := s.h.audits
	s.h.mu.Unlock()
	b, _ := json.Marshal(audits)
	if len(audits) != 3 || strings.Contains(string(b), "hunter2") || strings.Contains(string(b), "secret prompt") {
		t.Fatalf("audits %+v", audits)
	}
	want := []string{
		"chat.permission map[chat:" + id + " machine:gpu option:allow_once plugin:chat request:r1 status:200]",
		"chat.answer map[chat:" + id + " machine:gpu plugin:chat questions:1 request:q1 status:200]",
		"chat.set_config map[chat:" + id + " config:mode error:not_allowed machine:gpu plugin:chat status:403 value:full]",
	}
	for i, a := range audits {
		if got := a.event + " " + fmt.Sprint(a.fields); got != want[i] {
			t.Errorf("audit\n got %s\nwant %s", got, want[i])
		}
	}
}

// A read-only core takes attaches and refuses every command, audited; it
// leaves out the agents' standard error.
func TestWSReadOnly(t *testing.T) {
	s := newSetup(t)
	s.h.readOnly = true
	id := chatproto.NewChatID()
	s.f.chats[id] = chatproto.Chat{ID: id, Kind: "claude", State: chatproto.StateFailed,
		Error: &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "m", Stderr: "TOKEN=1"}}
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id})
	if m := pg.expect(TAttached); strings.Contains(fmt.Sprint(m), "TOKEN") || !strings.Contains(fmt.Sprint(m), "start_failed") {
		t.Errorf("attached %v", m)
	}
	s.attached(1)
	// Its attach starts nothing on the machine (no catch-up).
	s.f.mu.Lock()
	req := s.f.requests[len(s.f.requests)-1]
	s.f.mu.Unlock()
	if req.Op != chatproto.OpAttach || !req.NoCatchUp {
		t.Errorf("attached as %+v", req)
	}
	s.f.emit(id, chatproto.Event{Seq: 2, T: chatproto.EventState, State: chatproto.StateFailed, Error: &chatproto.Error{Code: "failed", Message: "m", Stderr: "TOKEN=2"}})
	if m := pg.expect(TEvent); strings.Contains(fmt.Sprint(m), "TOKEN") || m["ev"].(map[string]any)["seq"] != 2.0 {
		t.Errorf("event %v", m)
	}
	failed := chatproto.Chat{ID: id, Kind: "claude", State: chatproto.StateFailed,
		Error: &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "m", Stderr: "TOKEN=3"}}
	s.f.emit(id, chatproto.Event{T: chatproto.EventInfo, Live: true, Chat: &failed})
	if m := pg.expect(TEvent); strings.Contains(fmt.Sprint(m), "TOKEN") || !strings.Contains(fmt.Sprint(m), "start_failed") {
		t.Errorf("info event %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p1", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPrompt}})
	if m := pg.expect(TAck); m["id"] != "p1" || errCode(m) != CodeReadOnly {
		t.Errorf("ack %v", m)
	}
	time.Sleep(20 * time.Millisecond)
	s.f.mu.Lock()
	if len(s.f.commands) != 0 {
		t.Errorf("the host got %+v", s.f.commands)
	}
	s.f.mu.Unlock()
	s.h.mu.Lock()
	if len(s.h.audits) != 1 || s.h.audits[0].event != "chat.prompt" || s.h.audits[0].fields["error"] != CodeReadOnly ||
		s.h.audits[0].fields["status"] != 403 || s.h.audits[0].fields["chat"] != id {
		t.Errorf("audits %+v", s.h.audits)
	}
	s.h.mu.Unlock()
	// It starts no host.
	s.f.end(false)
	pg.expect(TDetached)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s2", M: "gpu", Chat: id})
	if m := pg.expect(TDetached); m["sub"] != "s2" || errCode(m) != codeNotRunning {
		t.Errorf("attach without a host: %v", m)
	}
}

// A page has at most MaxSubsPerMachine subscriptions of a machine and
// MaxSubs in all; an attach under an id it has replaces that one.
func TestWSLimits(t *testing.T) {
	s := newSetup(t)
	pg := s.dial(t)
	for i := range MaxSubs {
		m := "gpu"
		if i >= MaxSubsPerMachine {
			m = "box"
		}
		pg.send(ClientMessage{Op: OpAttach, Sub: fmt.Sprint("s", i), M: m, Chat: s.newChat(chatproto.StateIdle)})
		pg.expect(TAttached)
	}
	pg.send(ClientMessage{Op: OpAttach, Sub: "more", M: "other", Chat: s.newChat(chatproto.StateIdle)})
	if m := pg.expect(TDetached); m["sub"] != "more" || errCode(m) != CodeTooMany {
		t.Errorf("one more: %v", m)
	}
	pg.send(ClientMessage{Op: OpDetach, Sub: "s0"})
	pg.send(ClientMessage{Op: OpAttach, Sub: "more", M: "box", Chat: s.newChat(chatproto.StateIdle)})
	if m := pg.expect(TDetached); m["sub"] != "more" || errCode(m) != CodeTooMany {
		t.Errorf("a 17th of a machine: %v", m)
	}
	id := s.newChat(chatproto.StateIdle)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id})
	if m := pg.expect(TAttached); m["chat"].(map[string]any)["id"] != id {
		t.Errorf("replaced %v", m)
	}
	s.attached(MaxSubs - 1)
	for _, m := range []ClientMessage{
		{Op: OpAttach, Sub: "bad", M: "gpu", Chat: "c1"},
		{Op: OpAttach, Sub: "bad", Chat: id},
	} {
		pg.send(m)
		if got := pg.expect(TDetached); got["sub"] != "bad" || errCode(got) != chatproto.CodeBadRequest {
			t.Errorf("%+v: %v", m, got)
		}
	}
}

// A subscription ends when the page detaches it, when the chat host's
// connection ends (lost, or offline with the machine) and when the host
// refuses it; each command that waits gets its answer then.
func TestWSEnds(t *testing.T) {
	s := newSetup(t)
	id := s.newChat(chatproto.StateWorking)
	pg := s.dial(t)

	pg.send(ClientMessage{Op: OpDetach, Sub: "none"})
	if m := pg.expect(TDetached); m["sub"] != "none" || errCode(m) != CodeUnknownSub {
		t.Errorf("detach of none: %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p0", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpCancel}})
	if m := pg.expect(TAck); m["id"] != "p0" || errCode(m) != CodeNotAttached {
		t.Errorf("a command without a subscription: %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p0", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: "rm"}})
	if m := pg.expect(TAck); errCode(m) != chatproto.CodeBadRequest {
		t.Errorf("an unknown command: %v", m)
	}
	pg.send(ClientMessage{Op: OpAttach, Sub: "u", M: "gpu", Chat: chatproto.NewChatID()})
	if m := pg.expect(TDetached); m["sub"] != "u" || errCode(m) != chatproto.CodeUnknownChat {
		t.Errorf("an unknown chat: %v", m)
	}

	s.f.holdAcks = true
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id})
	pg.expect(TAttached)
	pg.send(ClientMessage{Op: OpCommand, ID: "p1", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpHandoff}})
	s.f.wait("the command", func() bool { return len(s.f.commands) == 1 })
	pg.send(ClientMessage{Op: OpDetach, Sub: "s1"})
	if m := pg.expect(TAck); m["id"] != "p1" || errCode(m) != CodeNotAttached {
		t.Errorf("a command of a detached subscription: %v", m)
	}
	s.attached(0)

	pg.send(ClientMessage{Op: OpAttach, Sub: "s2", M: "gpu", Chat: id})
	pg.expect(TAttached)
	pg.send(ClientMessage{Op: OpCommand, ID: "p2", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpCancel}})
	s.f.wait("the command", func() bool { return len(s.f.commands) == 2 })
	s.f.end(true)
	m := pg.expect(TDetached)
	if m["sub"] != "s2" || errCode(m) != CodeLost {
		t.Errorf("the host ended: %v", m)
	}
	if m = pg.expect(TAck); m["id"] != "p2" || errCode(m) != CodeLost {
		t.Errorf("its command: %v", m)
	}

	pg.send(ClientMessage{Op: OpAttach, Sub: "s3", M: "gpu", Chat: id})
	pg.expect(TAttached)
	s.setReady()
	s.f.end(true)
	if m := pg.expect(TDetached); m["sub"] != "s3" || errCode(m) != CodeOffline {
		t.Errorf("the machine left: %v", m)
	}
	s.f.openErr = "offline"
	pg.send(ClientMessage{Op: OpAttach, Sub: "s4", M: "gpu", Chat: id})
	if m := pg.expect(TDetached); m["sub"] != "s4" || errCode(m) != CodeOffline {
		t.Errorf("attach while offline: %v", m)
	}
}

// Turning the plugin off ends every subscription and the page's
// WebSocket.
func TestWSPluginOff(t *testing.T) {
	s := newSetup(t)
	s.start(t)
	id := s.newChat(chatproto.StateIdle)
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id})
	pg.expect(TAttached)
	if err := s.h.st.Set(plugin.EnableSetting(s.p), "", false); err != nil {
		t.Fatal(err)
	}
	if m := pg.expect(TDetached); m["sub"] != "s1" || errCode(m) != CodePluginDisabled {
		t.Errorf("detached %v", m)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := pg.c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusGoingAway {
		t.Errorf("the WebSocket: %v", err)
	}
	s.attached(0)
}

// A page that does not take its messages as fast as they come is
// disconnected, its subscriptions with it.
func TestWSBackPressure(t *testing.T) {
	oldN, oldB := backlogMessages, backlogBytes
	backlogMessages, backlogBytes = 64, 256<<10
	t.Cleanup(func() { backlogMessages, backlogBytes = oldN, oldB })
	s := newSetup(t)
	id := s.newChat(chatproto.StateWorking)
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: id})
	pg.expect(TAttached)
	s.attached(1)
	// Random text, which the WebSocket's compression does not shrink.
	raw := make([]byte, 32<<10)
	rand.Read(raw)
	text := hex.EncodeToString(raw)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 4096; i++ {
			s.f.mu.Lock()
			n := len(s.f.attached)
			s.f.mu.Unlock()
			if n == 0 {
				return
			}
			s.f.emit(id, chatproto.Event{T: chatproto.EventUpdate, Live: true, Item: "m", Update: json.RawMessage(`{"text":"` + text + `"}`)})
		}
	}()
	s.attached(0)
	<-done
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		if _, _, err := pg.c.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("the page was not disconnected")
			}
			break
		}
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		s.p.mu.Lock()
		pages, inUse := len(s.p.pages), len(s.p.inUse)
		s.p.mu.Unlock()
		if pages == 0 && inUse == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pages %d, machines in use %d", pages, inUse)
		}
	}
}

// One WebSocket carries the subscriptions of several chats of several
// machines, each with its own connection to the host: the events of a
// chat reach each of its subscriptions, under its id; a command is sent on
// one of them and answered once.
func TestWSMultiplexes(t *testing.T) {
	s := newSetup(t)
	s.setReady("gpu", "box")
	one, two := s.newChat(chatproto.StateIdle), s.newChat(chatproto.StateIdle)
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "a", M: "gpu", Chat: one})
	pg.expect(TAttached)
	pg.send(ClientMessage{Op: OpAttach, Sub: "b", M: "box", Chat: two})
	pg.expect(TAttached)
	pg.send(ClientMessage{Op: OpAttach, Sub: "c", M: "gpu", Chat: one})
	pg.expect(TAttached)
	s.attached(3)
	s.f.emit(two, chatproto.Event{Seq: 1, T: chatproto.EventTurn, State: chatproto.TurnStart})
	if m := pg.expect(TEvent); m["sub"] != "b" {
		t.Errorf("chat two's event: %v", m)
	}
	s.f.emit(one, chatproto.Event{Seq: 5, T: chatproto.EventTurn, State: chatproto.TurnEnd})
	got := map[any]bool{}
	for range 2 {
		m := pg.expect(TEvent)
		got[m["sub"]] = m["ev"].(map[string]any)["seq"] == 5.0
	}
	if !got["a"] || !got["c"] {
		t.Errorf("chat one's event reached %v", got)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p1", M: "gpu", Chat: one, Cmd: &chatproto.Command{Op: chatproto.OpCompact}})
	if m := pg.expect(TAck); m["id"] != "p1" {
		t.Errorf("ack %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p2", M: "box", Chat: one, Cmd: &chatproto.Command{Op: chatproto.OpCompact}})
	if m := pg.expect(TAck); m["id"] != "p2" || errCode(m) != CodeNotAttached {
		t.Errorf("a chat of another machine: %v", m)
	}
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	if len(s.f.commands) != 1 {
		t.Errorf("the host got %+v", s.f.commands)
	}
}

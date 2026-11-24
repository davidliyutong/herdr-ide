package chat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"veldr/internal/chatproto"
	"veldr/internal/plugin"
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

// A large replay to a page that does not take it as fast as it comes
// fills only that subscription's share of the page's backlog: the core
// stops reading it from the host, which drops that connection; the page
// hears lost once it took what was sent and attaches again from its last
// sequence number, while its other chats go on and its WebSocket stays.
func TestWSFlowControl(t *testing.T) {
	oldN, oldB := backlogMessages, backlogBytes
	backlogMessages, backlogBytes = 64, 256<<10
	t.Cleanup(func() { backlogMessages, backlogBytes = oldN, oldB })
	s := newSetup(t)
	s.f.dropAfter = 100 * time.Millisecond
	big, small := s.newChat(chatproto.StateWorking), s.newChat(chatproto.StateIdle)
	pg := s.dial(t)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s1", M: "gpu", Chat: big})
	pg.expect(TAttached)
	pg.send(ClientMessage{Op: OpAttach, Sub: "s2", M: "gpu", Chat: small})
	pg.expect(TAttached)
	s.attached(2)
	// Random text, which the WebSocket's compression does not shrink.
	raw := make([]byte, 32<<10)
	rand.Read(raw)
	text := hex.EncodeToString(raw)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 1; i <= 4096; i++ {
			s.f.mu.Lock()
			n := s.f.attachedTo(big)
			s.f.mu.Unlock()
			if n == 0 {
				return
			}
			s.f.emit(big, chatproto.Event{Seq: uint64(i), T: chatproto.EventUpdate, Item: "m", Update: json.RawMessage(`{"text":"` + text + `"}`)})
		}
	}()
	s.f.wait("the host to drop the slow connection", func() bool { return s.f.attachedTo(big) == 0 })
	<-done
	s.p.mu.Lock()
	pages := len(s.p.pages)
	s.p.mu.Unlock()
	if pages != 1 {
		t.Fatalf("%d pages", pages)
	}
	var last float64
	for {
		m := pg.next()
		if m["t"] == TEvent && m["sub"] == "s1" {
			seq := m["ev"].(map[string]any)["seq"].(float64)
			if seq != last+1 {
				t.Fatalf("event %v after %v", seq, last)
			}
			last = seq
			continue
		}
		if m["t"] != TDetached || m["sub"] != "s1" || errCode(m) != CodeLost {
			t.Fatalf("got %v", m)
		}
		break
	}
	if last == 0 {
		t.Error("no event came before the subscription was lost")
	}
	// The page's other chat goes on.
	s.f.emit(small, chatproto.Event{Seq: 1, T: chatproto.EventTurn, State: chatproto.TurnStart})
	if m := pg.expect(TEvent); m["sub"] != "s2" {
		t.Errorf("the other chat's event: %v", m)
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p1", M: "gpu", Chat: small, Cmd: &chatproto.Command{Op: chatproto.OpCancel}})
	if m := pg.expect(TAck); m["id"] != "p1" || m["error"] != nil {
		t.Errorf("ack %v", m)
	}
	// It attaches again after what it has.
	pg.send(ClientMessage{Op: OpAttach, Sub: "s3", M: "gpu", Chat: big, From: uint64(last)})
	pg.expect(TAttached)
	s.f.mu.Lock()
	req := s.f.requests[len(s.f.requests)-1]
	s.f.mu.Unlock()
	if req.Op != chatproto.OpAttach || req.Chat != big || req.From != uint64(last) {
		t.Errorf("attached again as %+v", req)
	}
}

// What only the core sends (answers, ends of subscriptions) is bounded by
// the page's backlog, the events of its subscriptions by their shares: a
// page that falls behind on the former is disconnected (try again later).
func TestWSControlOverflow(t *testing.T) {
	oldN, oldB := backlogMessages, backlogBytes
	backlogMessages, backlogBytes = 16, 256<<10
	t.Cleanup(func() { backlogMessages, backlogBytes = oldN, oldB })
	s := newSetup(t)
	pg := s.dial(t)
	var sp *page
	for deadline := time.Now().Add(5 * time.Second); sp == nil; time.Sleep(time.Millisecond) {
		s.p.mu.Lock()
		for x := range s.p.pages {
			sp = x
		}
		s.p.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("no page")
		}
	}
	sp.mu.Lock()
	data := &sub{room: make(chan struct{}, 1)}
	for range 4 * backlogMessages {
		sp.enqueueLocked([]byte(`{"t":"event","sub":"x","ev":{"t":"update"}}`), data)
	}
	afterData := sp.closed
	for range backlogMessages/2 + 1 {
		sp.enqueueLocked([]byte(`{"t":"ack","id":"k"}`), nil)
	}
	afterControl := sp.closed
	sp.mu.Unlock()
	if afterData || !afterControl {
		t.Fatalf("closed after the events %v, after the answers %v", afterData, afterControl)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		_, _, err := pg.c.Read(ctx)
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			t.Fatal("the page was not disconnected")
		}
		if code := websocket.CloseStatus(err); code != websocket.StatusTryAgainLater && code != -1 {
			t.Errorf("closed with %v", err)
		}
		break
	}
}

// Before an attach, on which a prompt may start the chat's agent, the
// host process the core reaches takes the machine's settings unless it
// took them as they are: a host started again (another pid) takes them
// anew, and so after the settings changed.
func TestWSConfigures(t *testing.T) {
	s := newSetup(t)
	s.h.st.OnChange(s.p.settingsChanged) // as Start does
	id := s.newChat(chatproto.StateSleeping)
	pg := s.dial(t)
	attach := func(sub string) []string {
		t.Helper()
		s.f.mu.Lock()
		n := len(s.f.requests)
		s.f.mu.Unlock()
		pg.send(ClientMessage{Op: OpAttach, Sub: sub, M: "gpu", Chat: id})
		pg.expect(TAttached)
		return s.f.ops()[n:]
	}
	if ops := attach("s1"); !slices.Equal(ops, []string{chatproto.OpConfigure, chatproto.OpAttach}) {
		t.Errorf("first attach: %v", ops)
	}
	if ops := attach("s2"); !slices.Equal(ops, []string{chatproto.OpAttach}) {
		t.Errorf("attach to the same host: %v", ops)
	}
	s.f.mu.Lock()
	s.f.pid = 7
	s.f.mu.Unlock()
	s.f.end(true)
	pg.expect(TDetached)
	pg.expect(TDetached)
	if ops := attach("s3"); !slices.Equal(ops, []string{chatproto.OpConfigure, chatproto.OpAttach}) {
		t.Errorf("attach to a host started again: %v", ops)
	}
	if err := s.h.st.Set(SettingAllowFull, "gpu", true); err != nil {
		t.Fatal(err)
	}
	if ops := attach("s4"); !slices.Equal(ops, []string{chatproto.OpConfigure, chatproto.OpAttach}) {
		t.Errorf("attach after the settings changed: %v", ops)
	}
	s.f.mu.Lock()
	for _, r := range s.f.requests {
		if r.Op == chatproto.OpConfigure && r.Settings == nil {
			t.Error("a configure without settings")
		}
	}
	if last := s.f.requests[len(s.f.requests)-2]; last.Op != chatproto.OpConfigure || !last.Settings.AllowFull {
		t.Errorf("configured %+v", last)
	}
	s.f.mu.Unlock()
}

// The core keeps at most maxHostConns connections to a machine's chat
// host, the last reservedConns for the watch and the configures: beyond,
// a subscription or a request is refused (too_many).
func TestHostConnLimit(t *testing.T) {
	oldMax, oldRes := maxHostConns, reservedConns
	maxHostConns, reservedConns = 5, 2
	t.Cleanup(func() { maxHostConns, reservedConns = oldMax, oldRes })
	s := newSetup(t)
	pg := s.dial(t)
	for i := range 3 {
		pg.send(ClientMessage{Op: OpAttach, Sub: fmt.Sprint("s", i), M: "gpu", Chat: s.newChat(chatproto.StateIdle)})
		pg.expect(TAttached)
	}
	pg.send(ClientMessage{Op: OpAttach, Sub: "more", M: "gpu", Chat: s.newChat(chatproto.StateIdle)})
	if m := pg.expect(TDetached); m["sub"] != "more" || errCode(m) != chatproto.CodeTooMany {
		t.Errorf("one more: %v", m)
	}
	if code, out, _ := s.call("GET", "gpu", "chats", ""); code != 409 || out["error"] != chatproto.CodeTooMany {
		t.Errorf("a request: %d %v", code, out)
	}
	// The watch and its configure have their own.
	s.start(t)
	s.f.wait("the watch", func() bool { return len(s.f.watchers) == 1 })
	s.f.wait("its configure", func() bool { return s.f.count(chatproto.OpConfigure) >= 2 })
	// A subscription that ends gives its connection back.
	pg.send(ClientMessage{Op: OpDetach, Sub: "s0"})
	s.attached(2)
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		s.p.mu.Lock()
		n := s.p.conns["gpu"].open
		s.p.mu.Unlock()
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d connections", n)
		}
	}
	pg.send(ClientMessage{Op: OpAttach, Sub: "again", M: "gpu", Chat: s.newChat(chatproto.StateIdle)})
	if m := pg.expect(TAttached); m["sub"] != "again" {
		t.Errorf("again: %v", m)
	}
}

// A command that names no machine or chat is refused without a record;
// what a page gives is clipped in the records, and of its refusals of one
// operation, one is written per refusalGap, the next one counting those
// in between.
func TestWSAuditBounds(t *testing.T) {
	s := newSetup(t)
	clk := &clock{}
	s.p.now = clk.now
	s.h.readOnly = true
	id := s.newChat(chatproto.StateIdle)
	pg := s.dial(t)
	for _, m := range []ClientMessage{
		{Op: OpCommand, ID: "b1", M: strings.Repeat("m", MaxPageID+1), Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPrompt}},
		{Op: OpCommand, ID: "b2", M: "gpu", Chat: "../x", Cmd: &chatproto.Command{Op: chatproto.OpPrompt}},
		{Op: OpCommand, ID: "b3", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPrompt}},
	} {
		pg.send(m)
		if got := pg.expect(TAck); got["id"] != m.ID || errCode(got) != chatproto.CodeBadRequest {
			t.Errorf("%s: %v", m.ID, got)
		}
	}
	long := strings.Repeat("é", 400)
	for i := range 5 {
		pg.send(ClientMessage{Op: OpCommand, ID: fmt.Sprint("c", i), M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpSetConfig, Config: "mode", Value: long}})
		if got := pg.expect(TAck); errCode(got) != CodeReadOnly {
			t.Errorf("ack %v", got)
		}
	}
	pg.send(ClientMessage{Op: OpCommand, ID: "p0", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpPrompt}})
	pg.expect(TAck)
	clk.add(refusalGap)
	pg.send(ClientMessage{Op: OpCommand, ID: "c5", M: "gpu", Chat: id, Cmd: &chatproto.Command{Op: chatproto.OpSetConfig, Config: "mode", Value: "x"}})
	pg.expect(TAck)
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	var got []string
	for _, a := range s.h.audits {
		got = append(got, fmt.Sprint(a.event, " repeated=", a.fields["repeated"]))
		if v, ok := a.fields["value"].(string); ok && len(v) > maxAudit+len("…") {
			t.Errorf("value of %d bytes", len(v))
		}
		if a.fields["machine"] != "gpu" || a.fields["chat"] != id {
			t.Errorf("audited %v", a.fields)
		}
	}
	want := []string{"chat.set_config repeated=<nil>", "chat.prompt repeated=<nil>", "chat.set_config repeated=4"}
	if !slices.Equal(got, want) {
		t.Errorf("audits\n got %q\nwant %q", got, want)
	}
	if v := s.h.audits[0].fields["value"].(string); !strings.HasPrefix(long, strings.TrimSuffix(v, "…")) || !utf8.ValidString(v) {
		t.Errorf("clipped value %q", v)
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

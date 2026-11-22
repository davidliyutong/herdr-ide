//go:build unix

package chathost

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatproto"
)

// sayN stores n messages of about size bytes each.
func (s *stream) sayN(n, size int) {
	s.t.Helper()
	for i := range n {
		s.session.say("m"+itoa(i), strings.Repeat("x", size))
	}
	for range n {
		s.next()
	}
}

// Attaching replays the stored events after From, then follows; live
// increments are never replayed; what the journal keeps outlives the host.
func TestAttachReplaysAndFollows(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("hello")
	s.session.stream("m1", "par")
	s.session.say("m1", "partial")
	s.session.endTurn("end_turn")
	s.until(isKind("state:idle"))
	all := s.last

	a := h.attach(s.chat.ID, 0)
	if a.first != 1 || a.chat.Seq != all {
		t.Errorf("attach: first %d, seq %d of %d", a.first, a.chat.Seq, all)
	}
	got := a.until(func(e event) bool { return e.Seq == all })
	if len(got) != int(all) {
		t.Errorf("replayed %d of %d", len(got), all)
	}
	select {
	case l := <-a.lives:
		t.Errorf("a live increment replayed: %s", l.raw)
	default:
	}
	b := h.attach(s.chat.ID, all-2)
	b.expect("turn:end", "state:idle")
	s.session.say("m2", "more")
	for _, st := range []*stream{s, a, b} {
		if e := st.next(); e.Item != "m2" {
			t.Errorf("followed %s", e.raw)
		}
	}
	h.attach(s.chat.ID, all+1).quiet()

	h.restart()
	c := h.attach(s.chat.ID, 0)
	if c.chat.Seq <= all || c.chat.State != chatproto.StateSleeping {
		t.Errorf("after a restart %+v", c.chat)
	}
	evs := c.until(func(e event) bool { return e.Seq == c.chat.Seq })
	if evs[len(evs)-1].kind() != "state:sleeping" {
		t.Errorf("last %s", evs[len(evs)-1].raw)
	}
}

// A connection that does not keep up is closed; the chat goes on for the
// others, and the slow one attaches again from what it has.
func TestSlowSubscriberIsDropped(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	slow, _ := h.attachRaw(s.chat.ID, s.last)
	chunk := strings.Repeat("y", 64<<10)
	for i := 0; i < (queueBytes>>16)+64; i++ {
		s.session.stream("big", chunk)
	}
	eventually(t, "the slow connection dropped", func() bool { return strings.Contains(h.log.String(), "fell behind") })
	s.session.say("after", "still here")
	if e := s.next(); e.Item != "after" {
		t.Errorf("the chat stopped for the slow one: %s", e.raw)
	}
	slow.conn.SetReadDeadline(time.Now().Add(patience))
	var err error
	for err == nil {
		_, err = slow.r.ReadByte()
	}
	h.attach(s.chat.ID, s.last-1).expect("update:agent_message_chunk")
}

// A chat's events beyond MaxChatBytes go, the oldest first; attach tells
// the first one kept.
func TestChatBytesLimit(t *testing.T) {
	h := startHost(t, func(h *testHost) { h.o.settings.MaxChatBytes = 8 << 10 })
	s := h.newChat()
	s.sayN(40, 500)
	j := openTestJournal(t, h)
	var bytes, sum int64
	var first, n int64
	j.db.QueryRow(`SELECT bytes FROM chats WHERE id = ?`, s.chat.ID).Scan(&bytes)
	j.db.QueryRow(`SELECT COALESCE(SUM(length(json)), 0), MIN(seq), COUNT(*) FROM events WHERE chat = ?`, s.chat.ID).Scan(&sum, &first, &n)
	if bytes != sum || bytes > 8<<10 || first <= 1 || n < 5 {
		t.Fatalf("bytes %d (events %d), first %d, %d events", bytes, sum, first, n)
	}
	a := h.attach(s.chat.ID, 0)
	if a.first != uint64(first) {
		t.Errorf("attach first %d, journal %d", a.first, first)
	}
	if e := a.next(); e.Seq != uint64(first) {
		t.Errorf("replay from %d", e.Seq)
	}
	if c := h.chat(s.chat.ID); c.Seq != s.last {
		t.Errorf("seq %d, last %d", c.Seq, s.last)
	}
}

// Beyond MaxTotalBytes the oldest closed chats go first, then the largest
// chats lose their oldest events; beyond MaxChats the oldest closed chats
// go; a new chat that finds no closed one to remove is refused.
func TestTotalBytesAndChatsLimits(t *testing.T) {
	const limit = 50 << 10
	h := startHost(t, func(h *testHost) {
		h.o.settings.MaxTotalBytes = limit
		h.o.settings.MaxChats = 4
		h.o.enforceEvery = 20 * time.Millisecond
	})
	j := openTestJournal(t, h)
	total := func() int64 {
		var n int64
		j.db.QueryRow(`SELECT COALESCE(SUM(bytes), 0) FROM chats`).Scan(&n)
		return n
	}
	var chats []*stream
	for range 4 {
		s := h.newChat()
		s.sayN(10, 1000) // about 11 KiB each
		chats = append(chats, s)
	}
	if n := total(); n > limit || n < limit-12<<10 {
		t.Fatalf("the test's chats take %d bytes", n)
	}
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: chats[2].chat.ID})
	time.Sleep(5 * time.Millisecond)
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: chats[0].chat.ID})
	time.Sleep(50 * time.Millisecond)
	if n := len(h.chats()); n != 4 {
		t.Fatalf("%d chats within the bounds", n)
	}
	// Over the bytes: the chat closed first goes, and that is enough.
	chats[1].sayN(8, 1000)
	eventually(t, "a closed chat removed", func() bool { return len(h.chats()) == 3 })
	time.Sleep(50 * time.Millisecond)
	ids := map[string]bool{}
	for _, c := range h.chats() {
		ids[c.ID] = true
	}
	if ids[chats[2].chat.ID] || !ids[chats[0].chat.ID] || len(ids) != 3 {
		t.Errorf("not the chat closed first removed, or more: %v", ids)
	}
	chats[2].ends()
	// More chats than MaxChats: a new one removes the oldest closed one.
	h.create(chatproto.Request{})
	h.fake.session(t)
	h.create(chatproto.Request{})
	h.fake.session(t)
	ids = map[string]bool{}
	for _, c := range h.chats() {
		ids[c.ID] = true
	}
	if len(ids) != 4 || ids[chats[0].chat.ID] {
		t.Errorf("chats %v", ids)
	}
	h.refused(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd}, chatproto.CodeTooMany)

	// No closed chat left: the largest loses its oldest events.
	chats[1].sayN(20, 1000)
	eventually(t, "the total within the bound", func() bool { return total() <= limit })
	if a := h.attach(chats[1].chat.ID, 0); a.first <= 1 {
		t.Errorf("the largest chat kept its first event: %d", a.first)
	}
	if n := len(h.chats()); n != 4 {
		t.Errorf("an open chat was removed: %d chats", n)
	}
}

// A closed chat is kept RetentionDays; an open one stays.
func TestRetention(t *testing.T) {
	h := startHost(t, func(h *testHost) {
		h.o.settings.RetentionDays = 1
		h.o.day = 300 * time.Millisecond
		h.o.enforceEvery = 20 * time.Millisecond
	})
	open, closed := h.newChat(), h.newChat()
	h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: closed.chat.ID})
	time.Sleep(100 * time.Millisecond)
	if n := len(h.chats()); n != 2 {
		t.Fatalf("removed too early: %d chats", n)
	}
	eventually(t, "the closed chat removed", func() bool { return len(h.chats()) == 1 })
	if h.chats()[0].ID != open.chat.ID {
		t.Error("the open chat was removed")
	}
	closed.ends()
}

// An event longer than MaxEvent is stored cut: a tool call's strings to
// their ends, anything else to a notice of what was left out.
func TestEventCut(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	huge := strings.Repeat("a", 3*chatproto.ToolOutputEnd) + strings.Repeat("é", chatproto.MaxEvent/2) + strings.Repeat("z", 3*chatproto.ToolOutputEnd)
	update, _ := json.Marshal(map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1",
		"content": []any{map[string]any{"type": "content", "content": map[string]string{"type": "text", "text": huge}}}})
	s.session.sink.Event(chatproto.Event{T: chatproto.EventUpdate, Item: "t1", Update: update})
	e := s.next()
	if len(e.raw) > chatproto.MaxEvent || e.Item != "t1" {
		t.Fatalf("a cut event of %d bytes", len(e.raw))
	}
	var u struct {
		Content []struct {
			Content struct{ Text string } `json:"content"`
		} `json:"content"`
	}
	json.Unmarshal(e.Update, &u)
	text := u.Content[0].Content.Text
	if !strings.HasPrefix(text, strings.Repeat("a", chatproto.ToolOutputEnd)) || !strings.HasSuffix(text, strings.Repeat("z", chatproto.ToolOutputEnd)) ||
		!strings.Contains(text, elision) || len(text) > 2*chatproto.ToolOutputEnd+len(elision) {
		t.Errorf("cut text of %d bytes", len(text))
	}
	// A message: a notice.
	s.session.say("m9", strings.Repeat("b", chatproto.MaxEvent))
	e = s.next()
	var params struct {
		Bytes int    `json:"bytes"`
		T     string `json:"t"`
	}
	json.Unmarshal(e.Params, &params)
	if e.T != chatproto.EventNotice || e.Method != agentproto.NoticeMethod(agentproto.NoticeSkipped) || e.Item != "m9" ||
		params.T != chatproto.EventUpdate || params.Bytes <= chatproto.MaxEvent {
		t.Errorf("notice %s", e.raw)
	}
	// Live increments are not cut.
	s.session.stream("m10", strings.Repeat("c", chatproto.MaxEvent))
	if l := <-s.lives; len(l.text()) != chatproto.MaxEvent {
		t.Errorf("a live increment of %d bytes", len(l.text()))
	}
}

func TestCutMiddle(t *testing.T) {
	s := strings.Repeat("é", 10) // 20 bytes
	got := cutMiddle(s, 5)
	if got != "éé"+elision+"éé" {
		t.Errorf("cutMiddle = %q", got)
	}
	raw := json.RawMessage(`{"a":"short","n":12345678901234567890,"b":["` + strings.Repeat("x", 3*chatproto.ToolOutputEnd) + `"]}`)
	cut := cutStrings(raw)
	var v struct {
		A string
		N json.Number
		B []string
	}
	if err := json.Unmarshal(cut, &v); err != nil || v.A != "short" || v.N.String() != "12345678901234567890" ||
		len(v.B[0]) != 2*chatproto.ToolOutputEnd+len(elision) {
		t.Errorf("cutStrings: %v %+v", err, v)
	}
	if small := json.RawMessage(`{"a":"b"}`); string(cutStrings(small)) != string(small) {
		t.Error("a small value changed")
	}
}

//go:build unix

package chathost

import (
	"encoding/json"
	"testing"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatproto"
)

// A chat that imports a session takes the title its adapter states of the
// session (an info event of the history, which is not stored as it came):
// the clients are told with the host's own info event, and a prompt after
// that does not name the chat. A catch-up's title is not taken.
func TestImportTitle(t *testing.T) {
	h := startHost(t, nil)
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventInfo, Chat: &chatproto.Chat{ID: "c0000000000000bad", Title: "  Fix the parser\n"}},
			{T: chatproto.EventUser, Content: []json.RawMessage{textBlock("old")}},
			{T: chatproto.EventUpdate, Item: "a", Update: agentChunk("old answer")},
			{T: chatproto.EventTurn, State: chatproto.TurnEnd},
		}
	})
	const id = "0b6c0b6c-0b6c-4b6c-8b6c-0b6c0b6c0b6d"
	chat := h.create(chatproto.Request{Resume: id, Import: true})
	if chat.Title != "" {
		t.Errorf("new chat titled %q", chat.Title)
	}
	s := h.attach(chat.ID, 0)
	s.session = h.fake.session(t)
	evs := s.until(isKind("state:idle"))
	if got := kinds(evs); got != "info user update:agent_message_chunk turn:end info state:idle" {
		t.Errorf("events %s", got)
	}
	if first := evs[0]; first.Chat == nil || first.Chat.Title != "Fix the parser" || first.Chat.ID != chat.ID {
		t.Errorf("the title's info %s", first.raw)
	}
	c := h.chat(chat.ID)
	if c.Title != "Fix the parser" {
		t.Errorf("chat %+v", c)
	}
	if c.Status != chatproto.StatusIdle {
		t.Errorf("an import's title made the chat %s", c.Status)
	}
	s.turn("a new question")
	if c := h.chat(chat.ID); c.Title != "Fix the parser" {
		t.Errorf("a prompt titled the chat %q", c.Title)
	}

	// An empty title, or one stated for a catch-up, is not taken.
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventInfo, Chat: &chatproto.Chat{Title: " \n"}},
			{T: chatproto.EventUser, Content: []json.RawMessage{textBlock("old")}},
		}
	})
	const id2 = "0b6c0b6c-0b6c-4b6c-8b6c-0b6c0b6c0b6e"
	other := h.create(chatproto.Request{Resume: id2, Import: true})
	s2 := h.attach(other.ID, 0)
	s2.session = h.fake.session(t)
	if got := kinds(s2.until(isKind("state:idle"))); got != "user info state:idle" {
		t.Errorf("events %s", got)
	}
	if c := h.chat(other.ID); c.Title != "" {
		t.Errorf("an empty title taken: %q", c.Title)
	}
	s2.must(chatproto.Command{Op: chatproto.OpHandoff})
	s2.session.expect(t, "close")
	s2.expect("state:sleeping", "notice:"+agentproto.NoticeMethod(agentproto.NoticeHandedOff), "info")
	h.fake.set(func(a *fakeAdapter) {
		a.history = []chatproto.Event{
			{T: chatproto.EventInfo, Chat: &chatproto.Chat{Title: "Later"}},
			{T: chatproto.EventUser, Content: []json.RawMessage{textBlock("in the terminal")}},
			{T: chatproto.EventTurn, State: chatproto.TurnEnd},
		}
	})
	h.attach(other.ID, s2.last).expect("user", "turn:end")
	if c := h.chat(other.ID); c.Title != "" {
		t.Errorf("a catch-up's title taken: %q", c.Title)
	}
}

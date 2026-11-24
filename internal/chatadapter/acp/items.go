//go:build unix

package acp

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"veldr/internal/chatproto"
)

// The session updates of a conversation's content.
const (
	updateMessage  = "agent_message_chunk"
	updateThought  = "agent_thought_chunk"
	updateUser     = "user_message_chunk"
	updateToolCall = "tool_call"
	updateTool     = "tool_call_update"
	updatePlan     = "plan"
)

// The session updates of a session's state, which the chat states.
const (
	updateCommands = "available_commands_update"
	updateMode     = "current_mode_update"
	updateConfig   = "config_option_update"
	updateInfo     = "session_info_update"
	updateUsage    = "usage_update"
)

// contentUpdate tells whether a session update is of the conversation's
// content.
func contentUpdate(kind string) bool {
	switch kind {
	case updateMessage, updateThought, updateUser, updateToolCall, updateTool, updatePlan:
		return true
	}
	return false
}

const (
	// splitBytes is the most text a stored message event holds: a longer
	// message goes on in an item of its own, so that each fits
	// chatproto.MaxEvent once its text is escaped as JSON.
	splitBytes = 128 << 10
	// maxTools is the most tool calls of a turn whose state is kept; the
	// updates of more are stored as they come.
	maxTools = 4096
)

// items turns an agent's session updates of a conversation's content into
// chatproto events, by item: a message or a thought streams as live events
// (its chunks as they came, each an increment of its text), and is stored
// whole, in one content block, once it ends (another kind of update comes,
// or the turn ends); a tool call (its Item is its toolCallId) is stored
// whole whenever it changes but for its content and output. While it
// runs, text its content gains goes live as tool_call_updates of the text
// added, which the clients append (an ACP update replaces the content: an
// agent sends the whole of it each time); content that changes otherwise
// is stored at once; what changed live is stored once more at the turn's
// end. A plan is stored as it comes, a whole each time. Without live,
// nothing streams: an import stores each item once it ended.
type items struct {
	// prefix starts the ids of the items it makes, unique among a chat's.
	prefix string
	live   bool
	store  func(ev chatproto.Event, tool string)
	// user takes a user message that ended, for an import; nil drops user
	// messages (the host states a chat's own prompts).
	user func(content []json.RawMessage)

	n     int // the items made
	msg   *message
	tools map[string]*toolState
	order []string // the tool calls by their first update
	plan  string   // the item of the turn's plan
	used  map[string]int
}

// message is a message or a thought being streamed.
type message struct {
	kind      string
	messageID string
	item      string
	text      strings.Builder
	// blocks are a user message's content blocks: in a replay, each chunk
	// of a user's message is a block of it.
	blocks []json.RawMessage
}

// toolState is what a tool call stated so far.
type toolState struct {
	fields map[string]json.RawMessage
	dirty  bool // changed live since it was last stored
	// shown is the text of the call's content the clients have: as last
	// stored, with the live increments since.
	shown string
}

func newItems(prefix string, live bool, store func(chatproto.Event, string)) *items {
	return &items{prefix: prefix, live: live, store: store, tools: map[string]*toolState{}, used: map[string]int{}}
}

// fresh is a new item id: by the agent's id of the message when it gave
// one ("m-<id>", the same in a chat and in an import of its session, so
// that HistoryParams.After finds it), else by count after the prefix (a
// chat's is random for each process, an import's "h"; an agent without
// ids, as Kimi Code and Grok, leaves no item of a chat that an import has).
func (it *items) fresh(short, id string) string {
	if id == "" {
		it.n++
		return it.prefix + "-" + short + "-" + strconv.Itoa(it.n)
	}
	base := short + "-" + id
	k := it.used[base]
	it.used[base] = k + 1
	if k == 0 {
		return base
	}
	return base + "~" + strconv.Itoa(k+1)
}

var shortKind = map[string]string{updateMessage: "m", updateThought: "t", updateUser: "u"}

// chunkHead is what items reads of a chunk.
type chunkHead struct {
	Kind      string          `json:"sessionUpdate"`
	Content   json.RawMessage `json:"content"`
	MessageID *string         `json:"messageId"`
}

type textBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// update takes one session update of the conversation's content.
func (it *items) update(kind string, raw json.RawMessage) {
	switch kind {
	case updateMessage, updateThought, updateUser:
		it.chunk(kind, raw)
	case updateToolCall, updateTool:
		it.tool(kind, raw)
	case updatePlan:
		it.close()
		if it.plan == "" {
			it.plan = it.fresh("p", "")
		}
		it.store(chatproto.Event{T: chatproto.EventUpdate, Item: it.plan, Update: raw}, "")
	}
}

func (it *items) chunk(kind string, raw json.RawMessage) {
	if kind == updateUser && it.user == nil {
		return
	}
	var h chunkHead
	var b textBlock
	if json.Unmarshal(raw, &h) != nil || json.Unmarshal(h.Content, &b) != nil {
		return
	}
	id := ""
	if h.MessageID != nil {
		id = *h.MessageID
	}
	if m := it.msg; m != nil && (m.kind != kind || m.messageID != id) {
		it.close()
	}
	if kind == updateUser {
		m := it.open(kind, id)
		switch {
		case b.Type != "text":
			m.blocks = append(m.blocks, bytes.Clone(h.Content))
		case userText(b.Text) != "":
			t, _ := json.Marshal(textBlock{Type: "text", Text: userText(b.Text)})
			m.blocks = append(m.blocks, t)
		}
		return
	}
	if b.Type != "text" {
		// An image or a resource of the agent's: an item of its own.
		it.close()
		it.store(chatproto.Event{T: chatproto.EventUpdate, Item: it.fresh(shortKind[kind], ""), Update: raw}, "")
		return
	}
	if b.Text == "" {
		return
	}
	m := it.open(kind, id)
	m.text.WriteString(b.Text)
	if it.live {
		it.store(chatproto.Event{T: chatproto.EventUpdate, Live: true, Item: m.item, Update: raw}, "")
	}
	if m.text.Len() >= splitBytes {
		it.close()
	}
}

// open is the message being streamed, a new one of kind when there is
// none.
func (it *items) open(kind, id string) *message {
	if it.msg == nil {
		it.msg = &message{kind: kind, messageID: id, item: it.fresh(shortKind[kind], id)}
	}
	return it.msg
}

// storedChunk is the stored event of a whole message.
type storedChunk struct {
	Kind      string    `json:"sessionUpdate"`
	Content   textBlock `json:"content"`
	MessageID string    `json:"messageId,omitempty"`
}

// close ends the message being streamed, storing it whole.
func (it *items) close() {
	m := it.msg
	if m == nil {
		return
	}
	it.msg = nil
	if m.kind == updateUser {
		it.user(m.blocks)
		return
	}
	if m.text.Len() == 0 {
		return
	}
	b, err := json.Marshal(storedChunk{Kind: m.kind, Content: textBlock{Type: "text", Text: m.text.String()}, MessageID: m.messageID})
	if err != nil {
		return
	}
	it.store(chatproto.Event{T: chatproto.EventUpdate, Item: m.item, Update: b}, "")
}

// reminder is what agents add to a user's message for the model (Kimi
// Code's replays hold it): it is no part of what the user wrote.
var reminder = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)

// userText is the text of a replayed user message without what the agent
// added to it.
func userText(s string) string {
	return strings.TrimSpace(reminder.ReplaceAllString(s, ""))
}

// toolHead is what items reads of a tool call's update.
type toolHead struct {
	ID     string `json:"toolCallId"`
	Status string `json:"status"`
}

// streamed are the members of a tool call that change while it runs: an
// update that changes no other goes live.
var streamed = map[string]bool{"content": true, "rawOutput": true, "_meta": true}

func (it *items) tool(kind string, raw json.RawMessage) {
	var h toolHead
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &h) != nil || h.ID == "" || json.Unmarshal(raw, &fields) != nil {
		return
	}
	it.close()
	t := it.tools[h.ID]
	if t == nil {
		if len(it.tools) == maxTools {
			it.store(chatproto.Event{T: chatproto.EventUpdate, Item: h.ID, Update: raw}, "")
			return
		}
		t = &toolState{fields: map[string]json.RawMessage{}}
		it.tools[h.ID] = t
		it.order = append(it.order, h.ID)
	}
	settled := h.Status == "completed" || h.Status == "failed"
	changed := kind == updateToolCall || settled || len(t.fields) == 0
	if kind == updateToolCall {
		// A tool_call states the call whole.
		t.fields = map[string]json.RawMessage{}
	}
	for k, v := range fields {
		if k == "sessionUpdate" {
			continue
		}
		if !streamed[k] && !bytes.Equal(t.fields[k], v) {
			changed = true
		}
		t.fields[k] = v
	}
	if changed || !it.live {
		it.storeTool(h.ID, t)
		return
	}
	text, ok := contentText(t.fields["content"])
	switch {
	case !ok || !strings.HasPrefix(text, t.shown):
		it.storeTool(h.ID, t) // not an increment of what the clients have
	case text == t.shown:
		t.dirty = true // the output, or nothing the clients show
	default:
		b, _ := json.Marshal(liveTool{Kind: updateTool, ID: h.ID, Content: []toolContent{{Type: "content", Content: textBlock{Type: "text", Text: text[len(t.shown):]}}}})
		t.shown, t.dirty = text, true
		it.store(chatproto.Event{T: chatproto.EventUpdate, Live: true, Item: h.ID, Update: b}, "")
	}
}

// liveTool is a live increment of a tool call's text.
type liveTool struct {
	Kind    string        `json:"sessionUpdate"`
	ID      string        `json:"toolCallId"`
	Content []toolContent `json:"content"`
}

type toolContent struct {
	Type    string    `json:"type"`
	Content textBlock `json:"content"`
}

// contentText is the text of a tool call's content, its text blocks one
// after the other; false for content with blocks of other kinds (a diff, a
// terminal, an image).
func contentText(raw json.RawMessage) (string, bool) {
	if !present(raw) {
		return "", true
	}
	var blocks []struct {
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return "", false
	}
	var b strings.Builder
	for _, c := range blocks {
		var t textBlock
		if c.Type != "content" || json.Unmarshal(c.Content, &t) != nil || t.Type != "text" {
			return "", false
		}
		b.WriteString(t.Text)
	}
	return b.String(), true
}

// whole is the tool call's state as one tool_call update.
func (t *toolState) whole() json.RawMessage {
	m := make(map[string]json.RawMessage, len(t.fields)+1)
	for k, v := range t.fields {
		m[k] = v
	}
	m["sessionUpdate"] = json.RawMessage(`"` + updateToolCall + `"`)
	b, _ := json.Marshal(m)
	return b
}

func (it *items) storeTool(id string, t *toolState) {
	t.dirty = false
	t.shown, _ = contentText(t.fields["content"])
	it.store(chatproto.Event{T: chatproto.EventUpdate, Item: id, Update: t.whole()}, id)
}

// toolCall is a permission's tool call with what the tool call's updates
// stated before it: some agents send a request with little more than the
// call's id (Kimi Code), others the diff only in an update (Grok).
func (it *items) toolCall(raw json.RawMessage) json.RawMessage {
	var h toolHead
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &h) != nil {
		return raw
	}
	t := it.tools[h.ID]
	if t == nil {
		return raw
	}
	m := make(map[string]json.RawMessage, len(t.fields)+len(fields))
	for k, v := range t.fields {
		m[k] = v
	}
	for k, v := range fields {
		m[k] = v
	}
	b, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return b
}

// toolKind is the kind a tool call stated, "" for none.
func (it *items) toolKind(id string) string {
	t := it.tools[id]
	if t == nil {
		return ""
	}
	var kind string
	json.Unmarshal(t.fields["kind"], &kind)
	return kind
}

// endTurn ends what streams: the message, and the tool calls that changed
// live since they were last stored. A new turn starts with no tool calls
// and no plan.
func (it *items) endTurn() {
	it.close()
	for _, id := range it.order {
		if t := it.tools[id]; t.dirty {
			it.storeTool(id, t)
		}
	}
	it.tools, it.order, it.plan = map[string]*toolState{}, nil, ""
}

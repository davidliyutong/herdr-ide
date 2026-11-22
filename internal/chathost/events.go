//go:build unix

package chathost

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatproto"
)

// elision joins the start and the end of a string that was cut, as the
// transcripts' cut tool output does.
const elision = "\n…\n"

// The notices the host stores itself (agentproto.NoticeMethod):
// agentproto.NoticeHandedOff when the chat's session went on in a terminal
// (OpHandoff); agentproto.NoticeError with {message, code} when an import
// of a session's History failed.

// secretMask stands for each answer to a secret question in the journal
// and on the connections: the agent gets the answer, nothing keeps it.
const secretMask = "••••••"

// The session updates of a tool call, whose strings a stored event cuts.
const (
	updateToolCall       = "tool_call"
	updateToolCallUpdate = "tool_call_update"
)

// line is v as one line without its newline; nil for what is no JSON.
func line(v any) []byte {
	b, err := chatproto.Line(v)
	if err != nil {
		return nil
	}
	return bytes.TrimSuffix(b, []byte("\n"))
}

// fit is the stored form of ev and its line (without the newline): ev
// itself when its line is at most chatproto.MaxEvent bytes. A longer tool
// call (a tool call update, a permission) has each of its strings longer
// than twice chatproto.ToolOutputEnd cut to that many bytes at each end;
// anything else, and a tool call still too long after that, becomes a
// notice that it was left out (agentproto.NoticeSkipped, with the bytes it
// had and its type), under the same item.
func fit(ev chatproto.Event) (chatproto.Event, []byte) {
	b := line(ev)
	if b != nil && len(b) <= chatproto.MaxEvent {
		return ev, b
	}
	n := len(b)
	if b != nil && isToolCall(ev) {
		cut := ev
		cut.Update = cutStrings(ev.Update)
		cut.ToolCall = cutStrings(ev.ToolCall)
		if c := line(cut); c != nil && len(c) <= chatproto.MaxEvent {
			return cut, c
		}
	}
	params := line(map[string]any{"bytes": n, "t": ev.T})
	skipped := chatproto.Event{Seq: ev.Seq, T: chatproto.EventNotice, At: ev.At, Item: ev.Item, Parent: ev.Parent,
		Method: agentproto.NoticeMethod(agentproto.NoticeSkipped), Params: params}
	return skipped, line(skipped)
}

// isToolCall tells whether ev is about a tool call: a permission, or a
// session update of one.
func isToolCall(ev chatproto.Event) bool {
	switch ev.T {
	case chatproto.EventPermission:
		return true
	case chatproto.EventUpdate:
		var u struct {
			Kind string `json:"sessionUpdate"`
		}
		json.Unmarshal(ev.Update, &u)
		return u.Kind == updateToolCall || u.Kind == updateToolCallUpdate
	}
	return false
}

// cutStrings is raw with every string longer than twice
// chatproto.ToolOutputEnd (and the elision) cut to its first and last
// chatproto.ToolOutputEnd bytes; raw itself when there is none, or when it
// is no JSON.
func cutStrings(raw json.RawMessage) json.RawMessage {
	if len(raw) <= 2*chatproto.ToolOutputEnd {
		return raw
	}
	var v any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&v) != nil {
		return raw
	}
	v, changed := cutValue(v)
	if !changed {
		return raw
	}
	if b := line(v); b != nil {
		return b
	}
	return raw
}

func cutValue(v any) (any, bool) {
	switch x := v.(type) {
	case string:
		if len(x) <= 2*chatproto.ToolOutputEnd+len(elision) {
			return x, false
		}
		return cutMiddle(x, chatproto.ToolOutputEnd), true
	case []any:
		changed := false
		for i := range x {
			var c bool
			x[i], c = cutValue(x[i])
			changed = changed || c
		}
		return x, changed
	case map[string]any:
		changed := false
		for k := range x {
			var c bool
			x[k], c = cutValue(x[k])
			changed = changed || c
		}
		return x, changed
	}
	return v, false
}

// cutMiddle is s without its middle: its first and last end bytes, at
// characters' starts, joined by the elision.
func cutMiddle(s string, end int) string {
	i := end
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	j := len(s) - end
	for j < len(s) && !utf8.RuneStart(s[j]) {
		j++
	}
	return s[:i] + elision + s[j:]
}

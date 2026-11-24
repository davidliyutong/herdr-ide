//go:build unix

package acp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"slices"
	"strings"
	"sync"
	"testing"

	"veldr/internal/chatproto"
)

// stream records what items makes.
type stream struct{ evs []chatproto.Event }

func (s *stream) store(ev chatproto.Event, _ string) { s.evs = append(s.evs, ev) }

// line is an event as compact text: "live item text" or "item text".
func (s *stream) lines() []string {
	var out []string
	for _, ev := range s.evs {
		var u struct {
			Kind    string `json:"sessionUpdate"`
			Content struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Status string `json:"status"`
		}
		json.Unmarshal(ev.Update, &u)
		l := ev.Item + " " + u.Kind + " "
		if u.Content.Type != "" {
			l += u.Content.Type + ":" + u.Content.Text
		} else {
			l += u.Status
		}
		if ev.Live {
			l = "live " + l
		}
		out = append(out, l)
	}
	return out
}

func chunk(kind, text, id string) json.RawMessage {
	m := map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}
	if id != "" {
		m["messageId"] = id
	}
	b, _ := json.Marshal(m)
	return b
}

func feed(it *items, updates ...json.RawMessage) {
	for _, u := range updates {
		var h struct {
			Kind string `json:"sessionUpdate"`
		}
		json.Unmarshal(u, &h)
		it.update(h.Kind, u)
	}
}

// Chunks stream live and are stored whole when another kind comes, the
// message id changes or the turn ends; empty chunks are nothing; an
// agent's image is an item of its own.
func TestItemsMessages(t *testing.T) {
	var s stream
	it := newItems("p", true, s.store)
	feed(it,
		chunk(updateThought, "Let me", ""), chunk(updateThought, " think", ""), chunk(updateThought, "", ""),
		chunk(updateMessage, "Hello", ""), chunk(updateMessage, " world", ""),
		json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"type":"image","mimeType":"image/png","data":"AA=="}}`),
		chunk(updateMessage, "a", "msg_1"), chunk(updateMessage, "b", "msg_1"), chunk(updateMessage, "c", "msg_2"),
		chunk(updateMessage, "d", "msg_1"),
		chunk(updateUser, "an echo", ""),
	)
	it.endTurn()
	want := []string{
		"live p-t-1 agent_thought_chunk text:Let me", "live p-t-1 agent_thought_chunk text: think",
		"p-t-1 agent_thought_chunk text:Let me think",
		"live p-m-2 agent_message_chunk text:Hello", "live p-m-2 agent_message_chunk text: world",
		"p-m-2 agent_message_chunk text:Hello world",
		"p-m-3 agent_message_chunk image:",
		"live m-msg_1 agent_message_chunk text:a", "live m-msg_1 agent_message_chunk text:b",
		"m-msg_1 agent_message_chunk text:ab",
		"live m-msg_2 agent_message_chunk text:c", "m-msg_2 agent_message_chunk text:c",
		"live m-msg_1~2 agent_message_chunk text:d", "m-msg_1~2 agent_message_chunk text:d",
	}
	if got := s.lines(); !slices.Equal(got, want) {
		t.Fatalf("events\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	var stored struct {
		MessageID string `json:"messageId"`
	}
	json.Unmarshal(s.evs[9].Update, &stored)
	if stored.MessageID != "msg_1" {
		t.Errorf("stored message %s", s.evs[9].Update)
	}
}

// A message longer than splitBytes is stored in items of their own, each
// within chatproto.MaxEvent however its text escapes.
func TestItemsSplit(t *testing.T) {
	var s stream
	it := newItems("p", true, s.store)
	part := strings.Repeat("\x01", 32<<10)
	for range 9 {
		feed(it, chunk(updateMessage, part, ""))
	}
	it.endTurn()
	var stored []chatproto.Event
	for _, ev := range s.evs {
		if !ev.Live {
			stored = append(stored, ev)
		}
	}
	if len(stored) != 3 || stored[0].Item == stored[1].Item || stored[1].Item == stored[2].Item {
		t.Fatalf("%d stored", len(stored))
	}
	for _, ev := range stored {
		if b, _ := json.Marshal(ev); len(b) > chatproto.MaxEvent {
			t.Fatalf("a stored event of %d bytes", len(b))
		}
	}
}

// A tool call is stored whole when it changes but for its content and
// output, which go live while it runs and are stored at the turn's end.
func TestItemsTools(t *testing.T) {
	var s stream
	it := newItems("p", true, s.store)
	feed(it,
		chunk(updateMessage, "Running it", ""),
		json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Bash","kind":"execute","status":"pending"}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"in_progress","rawInput":{"command":"ls"}}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"a"}}]}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","content":[{"type":"content","content":{"type":"text","text":"a\nb"}}]}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c2","title":"Write","status":"in_progress"}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c2","status":"completed"}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update"}`),
		json.RawMessage(`{"sessionUpdate":"plan","entries":[]}`),
		json.RawMessage(`{"sessionUpdate":"plan","entries":[{"content":"x","priority":"high","status":"pending"}]}`),
	)
	if got := it.toolKind("c1"); got != "execute" {
		t.Errorf("kind %q", got)
	}
	var merged map[string]any
	json.Unmarshal(it.toolCall(json.RawMessage(`{"toolCallId":"c1","title":"Run ls"}`)), &merged)
	if merged["title"] != "Run ls" || merged["kind"] != "execute" || merged["rawInput"] == nil || merged["sessionUpdate"] != nil {
		t.Errorf("permission's tool call %v", merged)
	}
	it.endTurn()
	want := []string{
		"live p-m-1 agent_message_chunk text:Running it", "p-m-1 agent_message_chunk text:Running it",
		"c1 tool_call pending", "c1 tool_call in_progress",
		"live c1 tool_call_update ", "live c1 tool_call_update ",
		"c2 tool_call in_progress", "c2 tool_call completed",
		"p-p-2 plan ", "p-p-2 plan ",
		"c1 tool_call in_progress",
	}
	if got := s.lines(); !slices.Equal(got, want) {
		t.Fatalf("events\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// The live updates are increments of the text, which the clients
	// append; ACP's replace the whole content.
	for i, want := range []string{"a", "\nb"} {
		ev := s.evs[4+i]
		w := fmt.Sprintf(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","content":[{"type":"content","content":{"type":"text","text":%q}}]}`, want)
		if !ev.Live || ev.Item != "c1" || string(ev.Update) != w {
			t.Errorf("live %s\nwant %s", ev.Update, w)
		}
	}
	var last map[string]json.RawMessage
	json.Unmarshal(s.evs[len(s.evs)-1].Update, &last)
	if !strings.Contains(string(last["content"]), `a\nb`) || string(last["rawInput"]) != `{"command":"ls"}` {
		t.Errorf("stored at the turn's end: %s", s.evs[len(s.evs)-1].Update)
	}
	// A new turn knows no tool calls.
	if it.toolKind("c1") != "" {
		t.Error("a tool call outlived its turn")
	}

	// Without live (an import), every change is stored.
	var imp stream
	it = newItems("h", false, imp.store)
	feed(it,
		chunk(updateMessage, "x", ""),
		json.RawMessage(`{"sessionUpdate":"tool_call","toolCallId":"c1","status":"in_progress"}`),
		json.RawMessage(`{"sessionUpdate":"tool_call_update","toolCallId":"c1","content":[]}`),
	)
	it.endTurn()
	if got := imp.lines(); !slices.Equal(got, []string{"h-m-1 agent_message_chunk text:x", "c1 tool_call in_progress", "c1 tool_call in_progress"}) {
		t.Fatalf("import %q", got)
	}
}

// What a turn holds of tool calls is bounded: beyond maxTools, updates
// are stored as they come.
func TestItemsToolBound(t *testing.T) {
	var s stream
	it := newItems("p", true, s.store)
	for i := range maxTools + 2 {
		feed(it, json.RawMessage(fmt.Sprintf(`{"sessionUpdate":"tool_call","toolCallId":"c%d","status":"pending"}`, i)))
	}
	if len(it.tools) != maxTools || len(s.evs) != maxTools+2 {
		t.Fatalf("%d kept, %d events", len(it.tools), len(s.evs))
	}
}

// A replayed user message: its chunks are its blocks, without what the
// agent added for the model.
func TestUserMessages(t *testing.T) {
	var got [][]json.RawMessage
	it := newItems("h", false, func(chatproto.Event, string) {})
	it.user = func(c []json.RawMessage) { got = append(got, c) }
	feed(it,
		chunk(updateUser, "Count to 3", ""),
		chunk(updateUser, "<system-reminder>\nThe previous turn was interrupted.\n</system-reminder>", ""),
		json.RawMessage(`{"sessionUpdate":"user_message_chunk","content":{"type":"image","mimeType":"image/png","data":"AA=="}}`),
		chunk(updateUser, "What color?<system-reminder>date</system-reminder>", ""),
		chunk(updateMessage, "Red", ""),
		chunk(updateUser, "<system-reminder>only</system-reminder>", ""),
	)
	it.close()
	b, _ := json.Marshal(got)
	want := `[[{"type":"text","text":"Count to 3"},{"type":"image","mimeType":"image/png","data":"AA=="},{"type":"text","text":"What color?"}],null]`
	if string(b) != want {
		t.Fatalf("user messages %s\nwant %s", b, want)
	}
}

func TestConfigOptions(t *testing.T) {
	got := configOptions(json.RawMessage(`[
		{"type":"select","id":"model","name":"Model","category":"model","currentValue":"b","options":[
			{"group":"fast","name":"Fast","options":[{"value":"a","name":"A"}]},{"value":"b","name":"B","description":"the best"}]},
		{"type":"boolean","id":"web","name":"Web","currentValue":true},
		{"type":"select","id":"broken","currentValue":3,"options":[]},
		{"type":"select","name":"no id","currentValue":"x","options":[]},
		"nonsense"
	]`))
	b, _ := json.Marshal(got)
	want := `[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"b","options":[{"value":"a","name":"A"},{"value":"b","name":"B","description":"the best"}]}]`
	if string(b) != want {
		t.Fatalf("options %s\nwant %s", b, want)
	}
	if configOptions(json.RawMessage(`{}`)) != nil || len(configOptions(json.RawMessage(`[]`))) != 0 {
		t.Error("no options")
	}

	o, ok := modesOption(json.RawMessage(`{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"yolo","name":"YOLO"}]}`), "mode")
	if !ok || o.ID != "mode" || o.Category != chatproto.CategoryMode || o.CurrentValue != "ask" || len(o.Options) != 2 {
		t.Fatalf("modes %+v", o)
	}
	if _, ok := modesOption(json.RawMessage(`{"availableModes":[]}`), "mode"); ok {
		t.Error("modes without any")
	}

	kimi := &chatproto.ConfigOption{Options: []chatproto.ConfigValue{{Value: "default"}, {Value: "plan"}, {Value: "auto"}, {Value: "yolo"}}}
	for mode, want := range map[string]string{
		chatproto.ModeDefault: "default", chatproto.ModePlan: "plan", chatproto.ModeFull: "yolo",
		chatproto.ModeAcceptEdits: "", "auto": "auto", "nope": "",
	} {
		if got := modeValue(kimi, mode); got != want {
			t.Errorf("mode %s: %q, want %q", mode, got, want)
		}
	}
}

func TestSlashCommands(t *testing.T) {
	got, ok := slashCommands(json.RawMessage(`{"sessionUpdate":"available_commands_update","availableCommands":[
		{"name":"compact","description":"Compact","input":{"hint":"<instructions>"}},{"name":"help","input":null},{"name":" "},{}]}`))
	want := []chatproto.SlashCommand{{Name: "compact", Description: "Compact", ArgumentHint: "<instructions>"}, {Name: "help"}}
	if !ok || !slices.Equal(got, want) {
		t.Fatalf("commands %+v", got)
	}
	if _, ok := slashCommands(json.RawMessage(`{"sessionUpdate":"available_commands_update"}`)); ok {
		t.Error("commands without any")
	}
}

func TestPermissionOptions(t *testing.T) {
	if got := permissionKind("execute") + permissionKind("edit") + permissionKind("move") + permissionKind("fetch") + permissionKind(""); got != "commandfilefiletooltool" {
		t.Errorf("kinds %s", got)
	}
}

// The outbox hands calls on in order, from its own goroutine; reached
// waits for them.
func TestOutbox(t *testing.T) {
	o := newOutbox()
	var mu sync.Mutex
	var got []int
	release := make(chan struct{})
	o.push(func() { <-release })
	for i := range 100 {
		o.push(func() {
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	mark := o.mark()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	o.reached(ctx, mark) // returns with its context
	close(release)
	o.reached(context.Background(), mark)
	mu.Lock()
	n := len(got)
	ordered := slices.IsSorted(got)
	mu.Unlock()
	if n != 100 || !ordered {
		t.Fatalf("%d calls, in order %v", n, ordered)
	}
	o.close()
	<-o.done
	o.push(func() { t.Error("a call after close") })
	o.reached(context.Background(), mark+5) // returns once done
}

// The values of a mode option that may give the agent full access are
// marked (chatproto.ConfigValue.Full), in an option of category mode and
// in the option made of the agent's session modes alike: every value but
// those known to ask (deny by default: Kimi Code's auto too); no value of
// another option is.
func TestFullModeMarked(t *testing.T) {
	full := func(cfg []chatproto.ConfigOption) []string {
		var out []string
		for _, o := range cfg {
			for _, v := range o.Options {
				if v.Full {
					out = append(out, o.ID+"="+v.Value)
				}
			}
		}
		return out
	}
	s := newSession("kimi", log.New(io.Discard, "", 0), newHost(t.TempDir()), testTiming)
	defer s.out.close()
	s.mu.Lock()
	s.setConfig(json.RawMessage(`[
		{"type":"select","id":"mode","name":"Mode","category":"mode","currentValue":"default","options":[
			{"value":"default","name":"Default"},{"value":"plan","name":"Plan"},{"value":"auto","name":"Auto"},{"value":"yolo","name":"YOLO"}]},
		{"type":"select","id":"model","name":"Model","category":"model","currentValue":"yolo","options":[{"value":"yolo","name":"A model called yolo"}]}
	]`), nil)
	got := full(s.config)
	s.mu.Unlock()
	if !slices.Equal(got, []string{"mode=auto", "mode=yolo"}) {
		t.Errorf("full values %v", got)
	}
	s = newSession("other", log.New(io.Discard, "", 0), newHost(t.TempDir()), testTiming)
	defer s.out.close()
	s.mu.Lock()
	s.setConfig(nil, json.RawMessage(`{"currentModeId":"ask","availableModes":[{"id":"ask","name":"Ask"},{"id":"bypassPermissions","name":"Bypass"},{"id":"architect","name":"Architect"},{"id":"accept-edits","name":"Accept edits"}]}`))
	got = full(s.config)
	s.mu.Unlock()
	if !slices.Equal(got, []string{"mode=bypassPermissions", "mode=architect"}) {
		t.Errorf("full values of the session modes %v", got)
	}
}

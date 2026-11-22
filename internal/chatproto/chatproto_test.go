package chatproto

import (
	"bufio"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

// line is v as its line without the newline.
func line(t *testing.T, v any) string {
	t.Helper()
	b, err := Line(v)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 || b[len(b)-1] != '\n' || strings.Count(string(b), "\n") != 1 {
		t.Fatalf("not one line: %q", b)
	}
	return string(b[:len(b)-1])
}

var at = time.Date(2026, 1, 2, 3, 4, 5, 6_000_000, time.UTC)

func raw(s string) json.RawMessage { return json.RawMessage(s) }

// testChat has every member set.
func testChat() Chat {
	return Chat{
		ID: "c0123456789abcdef", Kind: "claude", Title: "Fix it", Cwd: "/w", SessionID: "s1", State: StateFailed, Status: StatusDone,
		Error:   &Error{Code: CodeStartFailed, Message: "exited", Stderr: "boom"},
		Created: at, Updated: at, Seq: 7, Seen: 5, Closed: at, HandedOff: true, AgentVersion: "2.1.330",
		Config: []ConfigOption{{ID: "effort", Name: "Effort", Description: "d", Category: CategoryThoughtLevel, Type: ConfigSelect, CurrentValue: "low",
			Options: []ConfigValue{{Value: "low", Name: "Low", Description: "fast"}, {Value: "high", Name: "High"}}}},
		Commands: []SlashCommand{{Name: "compact", Description: "Compact", ArgumentHint: "<what>"}},
		Usage: &Usage{Used: 10, Size: 100, Percentage: 12.5, Cost: &Cost{Amount: 0.5, Currency: "USD"},
			Limits: []Limit{{ID: "five_hour", Label: "5h", UsedPercent: 40, ResetsAt: 1700000000, WindowMinutes: 300}}},
		Capabilities: Capabilities{Images: true, Compact: true, Queue: true, Plan: true, Questions: true, Effort: true, Model: true, CancelQueued: true},
	}
}

const chatJSON = `{"id":"c0123456789abcdef","kind":"claude","title":"Fix it","cwd":"/w","sessionId":"s1","state":"failed","status":"done",` +
	`"error":{"code":"start_failed","message":"exited","stderr":"boom"},` +
	`"created":"2026-01-02T03:04:05.006Z","updated":"2026-01-02T03:04:05.006Z","seq":7,"seen":5,"closed":"2026-01-02T03:04:05.006Z",` +
	`"handedOff":true,"agentVersion":"2.1.330",` +
	`"config":[{"id":"effort","name":"Effort","description":"d","category":"thought_level","type":"select","currentValue":"low",` +
	`"options":[{"value":"low","name":"Low","description":"fast"},{"value":"high","name":"High"}]}],` +
	`"commands":[{"name":"compact","description":"Compact","argumentHint":"<what>"}],` +
	`"usage":{"used":10,"size":100,"percentage":12.5,"cost":{"amount":0.5,"currency":"USD"},` +
	`"limits":[{"id":"five_hour","label":"5h","usedPercent":40,"resetsAt":1700000000,"windowMinutes":300}]},` +
	`"capabilities":{"images":true,"compact":true,"queue":true,"plan":true,"questions":true,"effort":true,"model":true,"cancelQueued":true}}`

// The names on the wire are the protocol: clients in other languages read
// them (web/src/plugins/chat/protocol.ts).
func TestWireNames(t *testing.T) {
	chat := testChat()
	state := chat.StateOf()
	const stateJSON = `{"id":"c0123456789abcdef","kind":"claude","title":"Fix it","cwd":"/w","state":"failed","status":"done",` +
		`"updated":"2026-01-02T03:04:05.006Z","seq":7,"sessionId":"s1"}`
	settings := HostSettings{IdleStopMinutes: 30, MaxLive: 8, MaxChats: 500, RetentionDays: 30, MaxTotalBytes: 1 << 29, MaxChatBytes: 1 << 26, DefaultMode: ModePlan, AllowFull: true}
	const settingsJSON = `{"idleStopMinutes":30,"maxLive":8,"maxChats":500,"retentionDays":30,"maxTotalBytes":536870912,"maxChatBytes":67108864,"defaultMode":"plan","allowFull":true}`
	minimal := Chat{ID: "c1", Kind: "codex", State: StateStarting, Status: StatusIdle, Created: at, Updated: at}
	const minimalJSON = `{"id":"c1","kind":"codex","title":"","cwd":"","sessionId":"","state":"starting","status":"idle",` +
		`"created":"2026-01-02T03:04:05.006Z","updated":"2026-01-02T03:04:05.006Z","seq":0,"seen":0,` +
		`"capabilities":{"images":false,"compact":false,"queue":false,"plan":false,"questions":false,"effort":false,"model":false,"cancelQueued":false}}`
	question := Question{ID: "q1", Header: "Color", Question: "Which?", MultiSelect: true, AllowOther: true, Secret: true,
		Options: []QuestionOption{{Label: "red", Description: "warm", Preview: "# red"}, {Label: "blue"}}}
	const questionJSON = `{"id":"q1","header":"Color","question":"Which?","multiSelect":true,"allowOther":true,"secret":true,` +
		`"options":[{"label":"red","description":"warm","preview":"# red"},{"label":"blue"}]}`

	for _, tc := range []struct {
		name string
		v    any
		want string
	}{
		{"hello", Hello{Host: HostInfo{Proto: Proto, Version: "v1", PID: 42}}, `{"host":{"proto":2,"version":"v1","pid":42}}`},
		{"agents", Request{Op: OpAgents, Kinds: []string{"claude", "kimi"}}, `{"op":"agents","kinds":["claude","kimi"]}`},
		{"chats", Request{Op: OpChats}, `{"op":"chats"}`},
		{"new", Request{Op: OpNew, Kind: "claude", Cwd: "/w", Resume: "s0", Import: true, Options: &Options{Model: "m", Effort: "low", Mode: ModeAcceptEdits}},
			`{"op":"new","kind":"claude","cwd":"/w","resume":"s0","import":true,"options":{"model":"m","effort":"low","mode":"acceptEdits"}}`},
		{"new with defaults", Request{Op: OpNew, Kind: "codex", Cwd: "/w"}, `{"op":"new","kind":"codex","cwd":"/w"}`},
		{"attach", Request{Op: OpAttach, Chat: "c1", From: 5}, `{"op":"attach","chat":"c1","from":5}`},
		{"close", Request{Op: OpClose, Chat: "c1"}, `{"op":"close","chat":"c1"}`},
		{"delete", Request{Op: OpDelete, Chat: "c1"}, `{"op":"delete","chat":"c1"}`},
		{"sessions", Request{Op: OpSessions, Kind: "kimi", Cwd: "/w", Cursor: "x"}, `{"op":"sessions","kind":"kimi","cwd":"/w","cursor":"x"}`},
		{"watch", Request{Op: OpWatch}, `{"op":"watch"}`},
		{"seen", Request{Op: OpSeen, Chat: "c1", Seq: 9}, `{"op":"seen","chat":"c1","seq":9}`},
		{"configure", Request{Op: OpConfigure, Settings: &settings}, `{"op":"configure","settings":` + settingsJSON + `}`},
		{"shutdown", Request{Op: OpShutdown}, `{"op":"shutdown"}`},

		{"ok", Response{OK: true}, `{"ok":true}`},
		{"error", Response{Error: &Error{Code: CodeBusy, Message: "m"}}, `{"error":{"code":"busy","message":"m"}}`},
		{"agents answer", Response{OK: true, Agents: []AgentStatus{
			{Kind: "claude", Available: true, Version: "2.1.330"}, {Kind: "grok", Reason: ReasonNotFound}, {Kind: "gemini", Reason: ReasonUnsupported}}},
			`{"ok":true,"agents":[{"kind":"claude","available":true,"version":"2.1.330"},{"kind":"grok","available":false,"reason":"not_found"},` +
				`{"kind":"gemini","available":false,"reason":"unsupported"}]}`},
		// A list that is asked for is there when it is empty.
		{"no chats", Response{OK: true, Chats: []Chat{}}, `{"ok":true,"chats":[]}`},
		{"no states", Response{OK: true, States: []ChatState{}}, `{"ok":true,"states":[]}`},
		{"chats answer", Response{OK: true, Chats: []Chat{minimal}}, `{"ok":true,"chats":[` + minimalJSON + `]}`},
		{"attach answer", Response{OK: true, Chat: &chat, First: 3}, `{"ok":true,"chat":` + chatJSON + `,"first":3}`},
		{"sessions answer", Response{OK: true, Sessions: []Session{{SessionID: "s", Cwd: "/w", Title: "T", UpdatedAt: at, Chat: "c1"}, {SessionID: "t", Cwd: "/w"}}, NextCursor: "n"},
			`{"ok":true,"sessions":[{"sessionId":"s","cwd":"/w","title":"T","updatedAt":"2026-01-02T03:04:05.006Z","chat":"c1"},{"sessionId":"t","cwd":"/w"}],"nextCursor":"n"}`},
		{"watch answer", Response{OK: true, States: []ChatState{state}}, `{"ok":true,"states":[` + stateJSON + `]}`},
		{"chat state", state, stateJSON},

		{"prompt", Command{Op: OpPrompt, ID: "k1", ClientID: "m1", Content: []json.RawMessage{raw(`{"type":"text","text":"<hi>"}`),
			raw(`{"type":"image","mimeType":"image/png","data":"AA=="}`), raw(`{"type":"resource_link","uri":"file:///w/a.go","name":"a.go"}`)}},
			`{"op":"prompt","id":"k1","content":[{"type":"text","text":"<hi>"},{"type":"image","mimeType":"image/png","data":"AA=="},` +
				`{"type":"resource_link","uri":"file:///w/a.go","name":"a.go"}],"clientId":"m1"}`},
		{"cancel", Command{Op: OpCancel, ID: "k2"}, `{"op":"cancel","id":"k2"}`},
		{"permission", Command{Op: OpPermission, ID: "k3", Request: "p1", Option: "allow_once"}, `{"op":"permission","id":"k3","request":"p1","option":"allow_once"}`},
		{"permission cancelled", Command{Op: OpPermission, ID: "k3", Request: "p1", Cancelled: true}, `{"op":"permission","id":"k3","request":"p1","cancelled":true}`},
		{"answer", Command{Op: OpAnswer, ID: "k4", Request: "q", Answers: map[string][]string{"q1": {"red", "my own"}}},
			`{"op":"answer","id":"k4","request":"q","answers":{"q1":["red","my own"]}}`},
		{"answer skipped", Command{Op: OpAnswer, ID: "k4", Request: "q", Cancelled: true}, `{"op":"answer","id":"k4","request":"q","cancelled":true}`},
		{"set_config", Command{Op: OpSetConfig, ID: "k5", Config: "model", Value: "big"}, `{"op":"set_config","id":"k5","config":"model","value":"big"}`},
		{"cancel_queued", Command{Op: OpCancelQueued, ID: "k6", Message: "q7"}, `{"op":"cancel_queued","id":"k6","message":"q7"}`},
		{"compact", Command{Op: OpCompact, ID: "k7"}, `{"op":"compact","id":"k7"}`},
		{"rename", Command{Op: OpRename, ID: "k8", Title: "New"}, `{"op":"rename","id":"k8","title":"New"}`},
		{"handoff", Command{Op: OpHandoff, ID: "k9"}, `{"op":"handoff","id":"k9"}`},
		{"trust", Request{Op: OpTrust, Cwd: "/w"}, `{"op":"trust","cwd":"/w"}`},
		{"attach without catch-up", Request{Op: OpAttach, Chat: "c1", From: 3, NoCatchUp: true}, `{"op":"attach","chat":"c1","from":3,"noCatchUp":true}`},
		{"full value", ConfigValue{Value: "yolo", Name: "YOLO", Full: true}, `{"value":"yolo","name":"YOLO","full":true}`},

		{"ack", Event{T: EventAck, ID: "k1"}, `{"t":"ack","id":"k1"}`},
		{"ack error", Event{T: EventAck, ID: "k1", Error: &Error{Code: CodeInTerminal, Message: "m"}}, `{"t":"ack","id":"k1","error":{"code":"in_terminal","message":"m"}}`},
		{"update", Event{Seq: 1, T: EventUpdate, At: at, Item: "msg_1", Parent: "toolu_1", Update: raw(`{"sessionUpdate":"agent_message_chunk"}`)},
			`{"seq":1,"t":"update","at":"2026-01-02T03:04:05.006Z","item":"msg_1","parent":"toolu_1","update":{"sessionUpdate":"agent_message_chunk"}}`},
		{"live update", Event{T: EventUpdate, Live: true, Item: "msg_1", Update: raw(`{"sessionUpdate":"agent_message_chunk"}`)},
			`{"t":"update","live":true,"item":"msg_1","update":{"sessionUpdate":"agent_message_chunk"}}`},
		{"user", Event{Seq: 2, T: EventUser, At: at, ClientID: "m1", Content: []json.RawMessage{raw(`{"type":"text","text":"hi"}`)}},
			`{"seq":2,"t":"user","at":"2026-01-02T03:04:05.006Z","content":[{"type":"text","text":"hi"}],"clientId":"m1"}`},
		{"turn start", Event{Seq: 3, T: EventTurn, At: at, State: TurnStart}, `{"seq":3,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"start"}`},
		{"turn end", Event{Seq: 4, T: EventTurn, At: at, State: TurnEnd, StopReason: "end_turn"},
			`{"seq":4,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"end","stopReason":"end_turn"}`},
		{"turn error", Event{Seq: 5, T: EventTurn, At: at, State: TurnError, Error: &Error{Code: CodeFailed, Message: "m"}},
			`{"seq":5,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"error","error":{"code":"failed","message":"m"}}`},
		{"permission event", Event{Seq: 6, T: EventPermission, At: at, ID: "p1", Kind: PermissionCommand, Parent: "toolu_9", ToolCall: raw(`{"toolCallId":"t"}`),
			Options: []PermissionOption{{OptionID: "allow_once", Name: "Allow", Kind: AllowOnce}, {OptionID: "reject_once", Name: "Reject", Kind: RejectOnce}}},
			`{"seq":6,"t":"permission","at":"2026-01-02T03:04:05.006Z","id":"p1","parent":"toolu_9","kind":"command","toolCall":{"toolCallId":"t"},` +
				`"options":[{"optionId":"allow_once","name":"Allow","kind":"allow_once"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}`},
		{"permission_done", Event{Seq: 7, T: EventPermissionDone, At: at, ID: "p1", Outcome: &Outcome{Outcome: OutcomeSelected, OptionID: "allow"}, By: ByUser},
			`{"seq":7,"t":"permission_done","at":"2026-01-02T03:04:05.006Z","id":"p1","outcome":{"outcome":"selected","optionId":"allow"},"by":"user"}`},
		{"permission_done cancelled", Event{Seq: 7, T: EventPermissionDone, At: at, ID: "p1", Outcome: &Outcome{Outcome: OutcomeCancelled}, By: ByCancel},
			`{"seq":7,"t":"permission_done","at":"2026-01-02T03:04:05.006Z","id":"p1","outcome":{"outcome":"cancelled"},"by":"cancel"}`},
		{"question", Event{Seq: 8, T: EventQuestion, At: at, ID: "q", Questions: []Question{question}},
			`{"seq":8,"t":"question","at":"2026-01-02T03:04:05.006Z","id":"q","questions":[` + questionJSON + `]}`},
		{"question_done", Event{Seq: 9, T: EventQuestionDone, At: at, ID: "q", Answers: map[string][]string{"q1": {"red"}}, By: ByUser},
			`{"seq":9,"t":"question_done","at":"2026-01-02T03:04:05.006Z","id":"q","by":"user","answers":{"q1":["red"]}}`},
		{"queued", Event{Seq: 10, T: EventQueued, At: at, Message: "q7", ClientID: "m2", State: QueuedWaiting, Content: []json.RawMessage{raw(`{"type":"text","text":"also"}`)}},
			`{"seq":10,"t":"queued","at":"2026-01-02T03:04:05.006Z","content":[{"type":"text","text":"also"}],"clientId":"m2","message":"q7","state":"queued"}`},
		{"queued taken", Event{Seq: 11, T: EventQueued, Message: "q7", State: QueuedTaken}, `{"seq":11,"t":"queued","message":"q7","state":"taken"}`},
		{"state", Event{Seq: 12, T: EventState, At: at, State: StateSleeping}, `{"seq":12,"t":"state","at":"2026-01-02T03:04:05.006Z","state":"sleeping"}`},
		{"info", Event{Seq: 13, T: EventInfo, At: at, Chat: &chat}, `{"seq":13,"t":"info","at":"2026-01-02T03:04:05.006Z","chat":` + chatJSON + `}`},
		{"notice", Event{Seq: 14, T: EventNotice, At: at, Method: "_x/y", Params: raw(`{"a":1}`)},
			`{"seq":14,"t":"notice","at":"2026-01-02T03:04:05.006Z","method":"_x/y","params":{"a":1}}`},
	} {
		if got := line(t, tc.v); got != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", tc.name, got, tc.want)
		}
	}
}

// What is written is read back the same, and members this version does
// not know are passed over: a newer host or client may add them.
func TestRoundTripAndUnknownMembers(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
		v    any
	}{
		{"chat", chatJSON, &Chat{}},
		{"event", `{"seq":6,"t":"permission","at":"2026-01-02T03:04:05.006Z","id":"p1","live":true,"item":"i","parent":"t","update":{"x":[1,2]},` +
			`"content":[{"type":"text","text":"a"}],"clientId":"m","message":"q","state":"queued","stopReason":"end_turn",` +
			`"error":{"code":"failed","message":"m"},"kind":"plan","toolCall":{"toolCallId":"t"},"options":[{"optionId":"plan:default","name":"Yes","kind":"allow_once"}],` +
			`"outcome":{"outcome":"selected","optionId":"plan:default"},"by":"user","questions":[{"id":"q","question":"?"}],"answers":{"q":["a"]},` +
			`"method":"_m","params":{"p":true}}`, &Event{}},
		{"request", `{"op":"new","kinds":["a"],"kind":"claude","cwd":"/w","resume":"s","import":true,"options":{"model":"m","effort":"e","mode":"plan"},` +
			`"chat":"c","from":1,"seq":2,"cursor":"x","settings":{"idleStopMinutes":5,"maxLive":1,"maxChats":50,"retentionDays":1,` +
			`"maxTotalBytes":67108864,"maxChatBytes":8388608,"defaultMode":"full"}}`, &Request{}},
		{"command", `{"op":"answer","id":"k","content":[{"type":"text","text":"a"}],"clientId":"m","request":"r","option":"o",` +
			`"answers":{"q":["a","b"]},"cancelled":true,"config":"c","value":"v","message":"q","title":"t"}`, &Command{}},
	} {
		if err := json.Unmarshal([]byte(tc.json), tc.v); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got := line(t, tc.v); got != tc.json {
			t.Errorf("%s read and written again:\n got %s\nwant %s", tc.name, got, tc.json)
		}
	}

	var ev Event
	if err := json.Unmarshal([]byte(`{"seq":3,"t":"turn","state":"end","future":{"a":1},"z":[1]}`), &ev); err != nil {
		t.Fatal(err)
	}
	if want := (Event{Seq: 3, T: EventTurn, State: TurnEnd}); !reflect.DeepEqual(ev, want) {
		t.Errorf("an event with unknown members: %+v", ev)
	}
	var resp Response
	if err := json.Unmarshal([]byte(`{"ok":true,"chats":[{"id":"c1","kind":"k","capabilities":{"images":true,"teleport":true},"later":1}],"more":2}`), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || len(resp.Chats) != 1 || resp.Chats[0].ID != "c1" || !resp.Chats[0].Capabilities.Images {
		t.Errorf("a response with unknown members: %+v", resp)
	}
}

func TestConstants(t *testing.T) {
	if Proto != 2 || MaxLine != 16<<20 || MaxPrompt != 8<<20 || MaxImage != 5<<20 || MaxEvent != 1<<20 || ToolOutputEnd != 16<<10 || SocketName != "chat.sock" ||
		MaxStderr != 2<<10 {
		t.Error("the protocol's numbers changed")
	}
	codes := []string{CodeBadRequest, CodeUnknownChat, CodeTooMany, CodeBusy, CodeNotFound, CodeStartFailed,
		CodeProtocol, CodeAuthRequired, CodeUnsupported, CodeTooLarge, CodeEnded, CodeFailed, CodeInTerminal, CodeHandedOff, CodeSleeping, CodeNotAllowed}
	want := "bad_request unknown_chat too_many busy not_found start_failed protocol auth_required unsupported too_large ended failed in_terminal handed_off sleeping not_allowed"
	if got := strings.Join(codes, " "); got != want {
		t.Errorf("codes = %s", got)
	}
	states := []string{StateStarting, StateIdle, StateWorking, StateWaiting, StateSleeping, StateFailed, StateClosed}
	if got := strings.Join(states, " "); got != "starting idle working waiting sleeping failed closed" {
		t.Errorf("states = %s", got)
	}
	statuses := []string{StatusWorking, StatusBlocked, StatusDone, StatusIdle}
	if got := strings.Join(statuses, " "); got != "working blocked done idle" {
		t.Errorf("statuses = %s", got)
	}
	kinds := []string{PermissionTool, PermissionCommand, PermissionFile, PermissionPlan, PermissionMCP, PermissionOther}
	if got := strings.Join(kinds, " "); got != "tool command file plan mcp other" {
		t.Errorf("permission kinds = %s", got)
	}
	if got := strings.Join(Modes, " "); got != "default acceptEdits plan full" {
		t.Errorf("modes = %s", got)
	}
	if e := (&Error{Code: CodeBusy, Message: "a turn runs"}); e.Error() != "busy: a turn runs" {
		t.Errorf("Error() = %q", e.Error())
	}
}

// A chat's status follows its state, then whether a turn ended after what
// the user saw.
func TestStatusOf(t *testing.T) {
	for _, tc := range []struct {
		state         string
		turnEnd, seen uint64
		want          string
	}{
		{StateWorking, 9, 3, StatusWorking},
		{StateWorking, 0, 0, StatusWorking},
		{StateWaiting, 9, 3, StatusBlocked},
		{StateIdle, 9, 3, StatusDone},
		{StateSleeping, 9, 3, StatusDone},
		{StateFailed, 9, 3, StatusDone},
		{StateIdle, 9, 9, StatusIdle},
		{StateIdle, 9, 12, StatusIdle},
		{StateIdle, 0, 0, StatusIdle},
		{StateStarting, 0, 0, StatusIdle},
		{StateClosed, 4, 4, StatusIdle},
	} {
		if got := StatusOf(tc.state, tc.turnEnd, tc.seen); got != tc.want {
			t.Errorf("StatusOf(%s, %d, %d) = %s, want %s", tc.state, tc.turnEnd, tc.seen, got, tc.want)
		}
	}
	c := testChat()
	if s := c.StateOf(); s.ID != c.ID || s.Status != c.Status || s.Seq != c.Seq || s.SessionID != c.SessionID || !s.Updated.Equal(c.Updated) {
		t.Errorf("StateOf %+v", s)
	}
}

func TestChatIDs(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := NewChatID()
		if !ValidChatID(id) {
			t.Fatalf("%q is not a chat id", id)
		}
		if seen[id] {
			t.Fatalf("%q made twice", id)
		}
		seen[id] = true
	}
	for _, bad := range []string{"", "c", "c0123456789abcde", "c0123456789abcdef0", "C0123456789abcdef", "c0123456789ABCDEF",
		"d0123456789abcdef", "c0123456789abcdeg", "c0123456789abcdef\n", " c0123456789abcdef", "../c0123456789abcd", "c0123456789abc/ef"} {
		if ValidChatID(bad) {
			t.Errorf("%q taken for a chat id", bad)
		}
	}
}

// Clamp gives a zero member its default and keeps every member within its
// bounds whatever is asked.
func TestClamp(t *testing.T) {
	const mib = 1 << 20
	def := DefaultHostSettings()
	want := HostSettings{IdleStopMinutes: 30, MaxLive: 8, MaxChats: 500, RetentionDays: 30, MaxTotalBytes: 512 * mib, MaxChatBytes: 64 * mib, DefaultMode: ModeDefault}
	if def != want {
		t.Errorf("defaults %+v", def)
	}
	low := HostSettings{IdleStopMinutes: -1, MaxLive: -5, MaxChats: 1, RetentionDays: -30, MaxTotalBytes: 1, MaxChatBytes: -1, DefaultMode: "bypassPermissions"}.Clamp()
	if want := (HostSettings{IdleStopMinutes: 5, MaxLive: 1, MaxChats: 50, RetentionDays: 1, MaxTotalBytes: 64 * mib, MaxChatBytes: 8 * mib, DefaultMode: ModeDefault}); low != want {
		t.Errorf("too low %+v", low)
	}
	high := HostSettings{IdleStopMinutes: 1 << 30, MaxLive: 1000, MaxChats: 1 << 20, RetentionDays: 100000, MaxTotalBytes: 1 << 50, MaxChatBytes: 1 << 40, DefaultMode: ModeFull, AllowFull: true}.Clamp()
	if want := (HostSettings{IdleStopMinutes: 1440, MaxLive: 32, MaxChats: 2000, RetentionDays: 365, MaxTotalBytes: 2048 * mib, MaxChatBytes: 256 * mib, DefaultMode: ModeFull, AllowFull: true}); high != want {
		t.Errorf("too high %+v", high)
	}
	// Full access as the default only where it is allowed.
	if got := (HostSettings{DefaultMode: ModeFull}).Clamp(); got.DefaultMode != ModeDefault || got.AllowFull {
		t.Errorf("full without AllowFull: %+v", got)
	}
	in := HostSettings{IdleStopMinutes: 60, MaxLive: 2, MaxChats: 100, RetentionDays: 7, MaxTotalBytes: 100 * mib, MaxChatBytes: 10 * mib, DefaultMode: ModeAcceptEdits}
	if got := in.Clamp(); got != in {
		t.Errorf("within bounds %+v", got)
	}
	if got := in.Clamp().Clamp(); got != in.Clamp() {
		t.Error("Clamp is not idempotent")
	}
}

// Raw JSON goes on one line, whatever space the agent put in it.
func TestLineKeepsRawOnOneLine(t *testing.T) {
	ev := Event{Seq: 1, T: EventUpdate, Update: json.RawMessage("{\n  \"text\": \"a<b>&c\\nd\"\n}")}
	if got, want := line(t, ev), `{"seq":1,"t":"update","update":{"text":"a<b>&c\nd"}}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if _, err := Line(Event{T: EventUpdate, Update: json.RawMessage(`{"broken`)}); err == nil {
		t.Error("raw JSON that is none was written")
	}
}

func TestReadLine(t *testing.T) {
	r := bufio.NewReaderSize(strings.NewReader("{\"a\":1}\n\n"+strings.Repeat("x", 100)+"\nrest"), 16)
	for _, want := range []string{`{"a":1}`, "", strings.Repeat("x", 100)} {
		got, err := ReadLine(r)
		if err != nil || string(got) != want {
			t.Fatalf("ReadLine = %q, %v; want %q", got, err, want)
		}
	}
	// What has no newline before the end is no line.
	if got, err := ReadLine(r); err != io.EOF || got != nil {
		t.Fatalf("at the end: %q, %v", got, err)
	}
}

func TestReadLineLimit(t *testing.T) {
	const limit = 1000
	exact := strings.Repeat("a", limit)
	r := bufio.NewReaderSize(strings.NewReader(exact+"\n"+exact+"b\nnext\n"), 64)
	got, err := readLine(r, limit)
	if err != nil || string(got) != exact {
		t.Fatalf("a line of the limit: %d bytes, %v", len(got), err)
	}
	if got, err := readLine(r, limit); err != ErrTooLarge || got != nil {
		t.Fatalf("a line over the limit: %d bytes, %v", len(got), err)
	}
	// The line's end is still to be read, wherever the limit was met.
	if rest, err := r.ReadString('\n'); err != nil || strings.Trim(rest, "ab") != "\n" {
		t.Fatalf("the rest of the line: %q, %v", rest, err)
	}
	if got, err := readLine(r, limit); err != nil || string(got) != "next" {
		t.Fatalf("the line after it: %q, %v", got, err)
	}
	for _, size := range []int{63, 64, 65, 127, 128, 129, 200} {
		// The limit met in the piece with the newline, and before it.
		r := bufio.NewReaderSize(strings.NewReader(strings.Repeat("a", size)+"\nnext\n"), 64)
		if _, err := readLine(r, 60); err != ErrTooLarge {
			t.Fatalf("a line of %d bytes: %v", size, err)
		}
		if rest, err := r.ReadString('\n'); err != nil || strings.Trim(rest, "a") != "\n" {
			t.Fatalf("the rest of a line of %d bytes: %q, %v", size, rest, err)
		}
		if got, err := readLine(r, 60); err != nil || string(got) != "next" {
			t.Fatalf("the line after one of %d bytes: %q, %v", size, got, err)
		}
	}

	// A line without an end is given up at the limit, not read for ever.
	endless := &countingReader{}
	if _, err := readLine(bufio.NewReaderSize(endless, 64), limit); err != ErrTooLarge {
		t.Fatalf("an endless line: %v", err)
	}
	if endless.n > 2*limit {
		t.Errorf("read %d bytes of a line limited to %d", endless.n, limit)
	}

	// ReadLine's own limit is MaxLine.
	big := strings.Repeat("y", MaxLine)
	r = bufio.NewReader(strings.NewReader(big + "\n" + big + "z\n"))
	if got, err := ReadLine(r); err != nil || len(got) != MaxLine {
		t.Fatalf("a line of MaxLine bytes: %d, %v", len(got), err)
	}
	if _, err := ReadLine(r); err != ErrTooLarge {
		t.Fatalf("a line of MaxLine+1 bytes: %v", err)
	}
}

// countingReader is an input of "x" without end.
type countingReader struct{ n int }

func (c *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	c.n += len(p)
	return len(p), nil
}

// Redacted leaves the agent's standard error out of an event, of its chat
// and of a chat, and changes nothing else; what it was given stays.
func TestRedacted(t *testing.T) {
	chat := testChat()
	ev := Event{Seq: 1, T: EventInfo, Chat: &chat, Error: &Error{Code: CodeEnded, Message: "m", Stderr: "secret"}}
	r := ev.Redacted()
	if r.Error.Stderr != "" || r.Chat.Error.Stderr != "" || r.Error.Message != "m" || r.Chat.Error.Code != CodeStartFailed || r.Chat.Title != "Fix it" {
		t.Errorf("redacted %+v / %+v", r.Error, r.Chat.Error)
	}
	if ev.Error.Stderr != "secret" || chat.Error.Stderr != "boom" {
		t.Error("Redacted changed what it was given")
	}
	if c := chat.Redacted(); c.Error.Stderr != "" || chat.Error.Stderr != "boom" {
		t.Errorf("chat redacted %+v", c.Error)
	}
	plain := &Error{Code: CodeFailed, Message: "m"}
	if plain.WithoutStderr() != plain || (*Error)(nil).WithoutStderr() != nil {
		t.Error("WithoutStderr copied an error without one")
	}
	none := Event{T: EventState}
	if r := none.Redacted(); r.Error != nil || r.Chat != nil {
		t.Errorf("%+v", r)
	}
}

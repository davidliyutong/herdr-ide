package agentproto

import (
	"encoding/json"
	"testing"
	"time"

	"veldr/internal/brand"
)

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The wire form of each type of event, member by member: the web UI's
// conversation view (web/src/conversation/model.ts) reads these names, an
// event log's (t, at) and ACP v1's session/update's.
func TestTranscriptEventJSON(t *testing.T) {
	at := time.Date(2026, 11, 2, 9, 30, 0, 0, time.UTC)
	for _, c := range []struct {
		ev   TranscriptEvent
		want string
	}{
		{TranscriptEvent{T: TranscriptUpdate, At: at,
			Update: json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}`)},
			`{"t":"update","at":"2026-11-02T09:30:00Z","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}}`},
		{TranscriptEvent{T: TranscriptUser, Content: []json.RawMessage{json.RawMessage(`{"type":"text","text":"a table, please"}`)}},
			`{"t":"user","content":[{"type":"text","text":"a table, please"}]}`},
		{TranscriptEvent{T: TranscriptTurn, State: TurnEnd, StopReason: "end_turn"},
			`{"t":"turn","state":"end","stopReason":"end_turn"}`},
		{TranscriptEvent{T: TranscriptTurn, State: TurnStart},
			`{"t":"turn","state":"start"}`},
		{TranscriptEvent{T: TranscriptNotice, Method: NoticeMethod(NoticeCompacted), Params: json.RawMessage(`{"trigger":"auto"}`)},
			`{"t":"notice","method":"_` + brand.Slug + `/compacted","params":{"trigger":"auto"}}`},
	} {
		if got := marshal(t, c.ev); got != c.want {
			t.Errorf("got  %s\nwant %s", got, c.want)
		}
		var back TranscriptEvent
		if err := json.Unmarshal([]byte(c.want), &back); err != nil || marshal(t, back) != c.want {
			t.Errorf("read back %s: %+v %v", c.want, back, err)
		}
	}
	for name, want := range map[string]string{
		NoticeCompacted: "compacted", NoticeCommand: "command", NoticeError: "error",
		NoticeSkipped: "skipped",
	} {
		if NoticeMethod(name) != "_"+brand.Slug+"/"+want {
			t.Errorf("notice %s: %s", name, NoticeMethod(name))
		}
	}
}

// A resolve's request and reply, and a session's usage.
func TestTranscriptMessagesJSON(t *testing.T) {
	if got, want := marshal(t, ResolveRequest{Kind: "claude", Session: "s", Cwd: "/w"}), `{"kind":"claude","session":"s","cwd":"/w"}`; got != want {
		t.Errorf("resolve %s", got)
	}
	if got := marshal(t, ResolveReply{Code: ResolveOtherCwd}); got != `{"ok":false,"code":"other_cwd"}` {
		t.Errorf("resolve reply %s", got)
	}
	u := SessionUsage{Model: "m", Input: 1, Cached: 2, CacheWrite: 3, Output: 4, Reasoning: 1, Requests: 5, Cost: 0.25, Priced: true, ContextUsed: 900, ContextSize: 200000}
	if got, want := marshal(t, u), `{"model":"m","input":1,"cached":2,"cacheWrite":3,"output":4,"reasoning":1,"requests":5,"cost":0.25,"priced":true,"contextUsed":900,"contextSize":200000}`; got != want {
		t.Errorf("usage\ngot  %s\nwant %s", got, want)
	}
	if MaxTextBytes != 256<<10 || MaxToolOutput != 32<<10 {
		t.Error("limits changed")
	}
}

// The detect op's additions are omitted while empty: an agent of this
// build and a core that does not ask for sessions speak as before.
func TestDetectSessionsJSON(t *testing.T) {
	if got := marshal(t, DetectEvent{Terminal: "t1", Agent: "claude", Status: "idle"}); got != `{"terminal":"t1","agent":"claude","status":"idle"}` {
		t.Errorf("event without a session: %s", got)
	}
	ev := DetectEvent{Terminal: "t1", Agent: "claude", Status: "working", Session: "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f", SessionSource: SessionFromPID}
	if got := marshal(t, ev); got != `{"terminal":"t1","agent":"claude","status":"working","session":"0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f","session_source":"pid"}` {
		t.Errorf("event with a session: %s", got)
	}
	if got := marshal(t, Header{Op: OpDetect}); got != `{"op":"detect"}` {
		t.Errorf("header %s", got)
	}
	if got := marshal(t, Header{Op: OpDetect, Sessions: true}); got != `{"op":"detect","sessions":true}` {
		t.Errorf("header %s", got)
	}
	for src, want := range map[string]string{
		SessionFromArgv: "argv", SessionFromPID: "pid", SessionFromFD: "fd", SessionFromStart: "start", SessionFromHook: "hook", SessionFromGuess: "guess",
	} {
		if src != want {
			t.Errorf("source %s", src)
		}
	}
}

package agentproto

import (
	"encoding/json"
	"testing"
	"time"

	"herdr-ide/internal/brand"
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
// event log's (seq, t, at) and ACP v1's session/update's.
func TestTranscriptEventJSON(t *testing.T) {
	at := time.Date(2026, 11, 2, 9, 30, 0, 0, time.UTC)
	for _, c := range []struct {
		ev   TranscriptEvent
		want string
	}{
		{TranscriptEvent{Seq: Seq(4096, 1), T: TranscriptUpdate, At: at,
			Update: json.RawMessage(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}`)},
			`{"seq":1048577,"t":"update","at":"2026-11-02T09:30:00Z","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}}`},
		{TranscriptEvent{Seq: Seq(0, 0), T: TranscriptUser, Content: []json.RawMessage{json.RawMessage(`{"type":"text","text":"a table, please"}`)}},
			`{"seq":0,"t":"user","content":[{"type":"text","text":"a table, please"}]}`},
		{TranscriptEvent{Seq: Seq(12, 2), T: TranscriptTurn, State: TurnEnd, StopReason: "end_turn"},
			`{"seq":3074,"t":"turn","state":"end","stopReason":"end_turn"}`},
		{TranscriptEvent{Seq: Seq(12, 0), T: TranscriptTurn, State: TurnStart},
			`{"seq":3072,"t":"turn","state":"start"}`},
		{TranscriptEvent{Seq: Seq(77, 0), T: TranscriptNotice, Method: NoticeMethod(NoticeCompacted), Params: json.RawMessage(`{"trigger":"auto"}`)},
			`{"seq":19712,"t":"notice","method":"_` + brand.Slug + `/compacted","params":{"trigger":"auto"}}`},
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
		NoticeCompacted: "compacted", NoticeCleared: "cleared", NoticeCommand: "command", NoticeError: "error", NoticeModel: "model",
		NoticeSkipped: "skipped",
	} {
		if NoticeMethod(name) != "_"+brand.Slug+"/"+want {
			t.Errorf("notice %s: %s", name, NoticeMethod(name))
		}
	}
}

// A Seq holds its line's offset and the event's index in it, exact as a
// JavaScript number, in the order of the transcript.
func TestSeq(t *testing.T) {
	s := Seq(1<<40, 255)
	if SeqOffset(s) != 1<<40 || SeqIndex(s) != 255 || s >= 1<<53 {
		t.Errorf("seq %d: %d %d", s, SeqOffset(s), SeqIndex(s))
	}
	// The largest offset a browser holds exactly (below 32 TiB).
	if last := Seq(1<<45-1, MaxLineEvents-1); last != 1<<53-1 || SeqOffset(last) != 1<<45-1 {
		t.Errorf("last exact seq %d", last)
	}
	if Seq(10, 3) >= Seq(11, 0) || Seq(10, 0) >= Seq(10, 1) || Seq(10, MaxLineEvents-1) >= Seq(11, 0) {
		t.Error("seqs are not in the order of the transcript")
	}
	// An index beyond the line's events saturates at the last one, never
	// reaching into the offset; one below 0 is 0.
	for _, i := range []int{MaxLineEvents, MaxLineEvents + 1, 1 << 20} {
		if got := Seq(10, i); got != Seq(10, MaxLineEvents-1) || SeqOffset(got) != 10 || SeqIndex(got) != MaxLineEvents-1 {
			t.Errorf("index %d: seq %d (offset %d, index %d)", i, got, SeqOffset(got), SeqIndex(got))
		}
	}
	if got := Seq(10, -1); got != Seq(10, 0) {
		t.Errorf("index -1: seq %d", got)
	}
	// Seq is the offset times 256 plus the index: what a reader computes
	// without bit operations.
	if Seq(4096, 1) != 4096*256+1 {
		t.Errorf("seq %d", Seq(4096, 1))
	}
}

// A read's cursor and page, a resolve's request and reply, and a
// session's usage.
func TestTranscriptMessagesJSON(t *testing.T) {
	refs := []TranscriptRef{
		{Kind: "claude", Session: "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f", From: 512},
		{Kind: "codex", Session: "1b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f", Back: true},
	}
	if got, want := marshal(t, refs), `[{"kind":"claude","session":"0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f","from":512},{"kind":"codex","session":"1b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f","from":0,"back":true}]`; got != want {
		t.Errorf("refs\ngot  %s\nwant %s", got, want)
	}
	tails := []TranscriptTail{
		{Kind: "claude", Session: "s", File: "f1", First: 256, Next: 1024, Events: []TranscriptEvent{{Seq: 256, T: TranscriptTurn, State: TurnStart}}, More: true, Unknown: 2, Title: "Tables"},
		{Kind: "codex", Session: "t", Code: TranscriptNotFound},
	}
	if got, want := marshal(t, tails), `[{"kind":"claude","session":"s","file":"f1","first":256,"next":1024,"events":[{"seq":256,"t":"turn","state":"start"}],"more":true,"unknown":2,"title":"Tables"},{"kind":"codex","session":"t","first":0,"next":0,"code":"not_found"}]`; got != want {
		t.Errorf("pages\ngot  %s\nwant %s", got, want)
	}
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
	if MaxTailBytes != 1<<20 || MaxTextBytes != 256<<10 || MaxToolOutput != 32<<10 {
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

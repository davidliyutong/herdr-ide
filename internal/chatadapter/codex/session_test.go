package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// script writes a recording for the fake app-server: what its client
// sends (out) and what it answers and sends on its own (in).
type script struct {
	lines []string
	next  int
}

const testThread = "00000000-0000-7000-8000-0000000000aa"

func (s *script) line(v map[string]any) {
	b, _ := json.Marshal(v)
	s.lines = append(s.lines, string(b))
}

// request is a request of the client the fake answers; its id in the
// recording.
func (s *script) request(method string) int {
	s.next++
	s.line(map[string]any{"dir": "out", "msg": map[string]any{"id": s.next, "method": method, "params": map[string]any{}}})
	return s.next
}

func (s *script) reply(id int, result any) {
	s.line(map[string]any{"dir": "in", "msg": map[string]any{"id": id, "result": result}})
}

func (s *script) fail(id int, message string) {
	s.line(map[string]any{"dir": "in", "msg": map[string]any{"id": id, "error": map[string]any{"code": -32600, "message": message}}})
}

func (s *script) notify(method string, params any) {
	s.line(map[string]any{"dir": "in", "msg": map[string]any{"method": method, "params": params}})
}

// ask is a request of the app-server; the fake waits for its answer.
func (s *script) ask(id any, method string, params any) {
	s.line(map[string]any{"dir": "in", "msg": map[string]any{"id": id, "method": method, "params": params}})
	s.line(map[string]any{"dir": "out", "msg": map[string]any{"id": id, "result": map[string]any{}}})
}

func (s *script) raw(l string) { s.line(map[string]any{"dir": "in", "raw": l}) }

// begin is the handshake and a new thread.
func (s *script) begin() {
	s.reply(s.request(mInitialize), map[string]any{"userAgent": clientName + "/0.171.0 (test)"})
	s.reply(s.request(mThreadStart), map[string]any{"thread": map[string]any{"id": testThread}, "model": "gpt-6-luna", "reasoningEffort": "low"})
}

func (s *script) turnStarted(turn string) {
	s.notify("turn/started", map[string]any{"threadId": testThread, "turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}})
}

func (s *script) turnCompleted(turn, status string) {
	s.notify("turn/completed", map[string]any{"threadId": testThread, "turn": map[string]any{"id": turn, "status": status, "items": []any{}}})
}

func (s *script) item(started bool, it map[string]any) {
	m := "item/completed"
	if started {
		m = "item/started"
	}
	s.notify(m, map[string]any{"threadId": testThread, "turnId": "t", "item": it})
}

func agentMessage(id, text string) map[string]any {
	return map[string]any{"type": "agentMessage", "id": id, "text": text, "phase": "final_answer"}
}

func (s *script) file(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "script.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(s.lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// replies are the client's answers to the app-server's requests, by their
// ids as text.
func replies(t *testing.T, f *fakeRun, n int) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, m := range f.received(t, n) {
		if m["method"] == nil && m["id"] != nil {
			id, _ := json.Marshal(m["id"])
			out[string(id)] = m
		}
	}
	return out
}

// The app-server's requests are told by their method: one with the id of
// a request of ours that waits for its answer is no answer; the requests
// the adapter does not serve are answered, never dropped.
func TestServerRequests(t *testing.T) {
	var sc script
	sc.begin()
	turn := sc.request(mTurnStart)
	// Our ids: initialize 1, model/list 2, account/read 3, thread/start
	// 4, turn/start 5.
	sc.ask(5, mCommandApproval, map[string]any{"threadId": testThread, "itemId": "exec-1", "command": "/bin/zsh -lc 'touch x'", "cwd": "/work"})
	sc.ask(7, mDynamicToolCall, map[string]any{"threadId": testThread, "tool": "x"})
	sc.ask(8, mAttestation, map[string]any{})
	sc.ask("s-9", "some/futureRequest", map[string]any{})
	sc.ask(10, mMCPElicitation, map[string]any{"threadId": testThread})
	sc.ask(11, mPermissionsApproval, map[string]any{"threadId": testThread})
	sc.ask(12, mAuthTokensRefresh, map[string]any{"reason": "unauthorized"})
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t1")
	sc.turnCompleted("t1", turnCompleted)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	k.permAns = []chatadapter.PermissionAnswer{{Option: chatadapter.OptionAllowOnce}}
	prompt(t, s, "m1", "touch it")
	k.wait(t, "the turn's end", turnEnds(1))
	if ts := f.requests(t, 1, mTurnStart); len(ts) != 1 {
		t.Fatalf("turn/start %v", ts)
	}
	r := replies(t, f, 1)
	check := func(id string, want string) {
		t.Helper()
		got, _ := json.Marshal(r[id])
		if !strings.Contains(string(got), want) {
			t.Errorf("the answer to %s: %s, want %s", id, got, want)
		}
	}
	check("5", `"decision":"accept"`)
	check("7", `"success":false`)
	check("8", `"code":-32601`)
	check(`"s-9"`, `"code":-32601`)
	check("10", `"action":"decline"`)
	check("11", `"permissions":{}`)
	check("12", `"code":-32601`)
	if len(k.perms) != 1 || k.perms[0].Kind != chatproto.PermissionCommand {
		t.Errorf("permissions %+v", k.perms)
	}
}

// A permission the app-server settled on its own (serverRequest/resolved)
// is not answered; a turn's cancel answers the one that waits "cancel".
func TestResolvedAndCancelledRequests(t *testing.T) {
	var sc script
	sc.begin()
	turn := sc.request(mTurnStart)
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t1")
	sc.line(map[string]any{"dir": "in", "msg": map[string]any{"id": 0, "method": mFileChangeApproval, "params": map[string]any{"threadId": testThread, "itemId": "p1"}}})
	sc.notify("serverRequest/resolved", map[string]any{"threadId": testThread, "requestId": 0})
	sc.ask(1, mRequestUserInput, map[string]any{"threadId": testThread, "itemId": "q1", "questions": []any{
		map[string]any{"id": "a", "header": "A", "question": "Which?", "isOther": false, "isSecret": false, "options": []any{map[string]any{"label": "x", "description": ""}}}}})
	sc.reply(sc.request(mTurnInterrupt), map[string]any{})
	sc.turnCompleted("t1", turnInterrupted)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "go")
	k.wait(t, "both asked", func(k *testSink) bool { return len(k.perms) == 1 && len(k.questions) == 1 })
	// The resolved permission's context ends.
	ctxDone := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.pending) == 1
	}
	deadline := time.Now().Add(5 * time.Second)
	for !ctxDone() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
	k.wait(t, "the turn's end", turnEnds(1))
	r := replies(t, f, 1)
	if _, ok := r["0"]; ok {
		t.Errorf("a resolved request was answered: %v", r["0"])
	}
	if a, _ := json.Marshal(r["1"]); !strings.Contains(string(a), `"answers":{}`) {
		t.Errorf("a cancelled question answered %s", a)
	}
	evs := k.snapshot()
	last := evs[len(evs)-1]
	if last.T != chatproto.EventTurn || last.StopReason != "cancelled" {
		t.Errorf("the turn ended with %+v", last)
	}
}

// Lines that are no JSON-RPC message, and one longer than MaxLine, are
// passed over; unknown notifications too; the turn goes on.
func TestMalformedAndOversizedLines(t *testing.T) {
	var sc script
	sc.begin()
	turn := sc.request(mTurnStart)
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t1")
	sc.raw("{not json")
	sc.raw(`[1,2,3]`)
	sc.raw(`{"id":99,"result":{}}`)
	sc.line(map[string]any{"dir": "in", "big": chatproto.MaxLine + 10})
	sc.notify("vendor/somethingNew", map[string]any{"x": 1})
	sc.item(false, map[string]any{"type": "someNewItem", "id": "n1"})
	sc.item(false, agentMessage("msg1", "still here"))
	sc.turnCompleted("t1", turnCompleted)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "go")
	k.wait(t, "the turn's end", turnEnds(1))
	evs := k.snapshot()
	if len(evs) != 3 || !strings.Contains(string(evs[1].Update), "still here") {
		t.Errorf("events:\n%s", dump(evs))
	}
	c := s.c
	if c.malformed.Load() != 2 || c.oversized.Load() != 1 || c.strayReplies.Load() != 1 || c.unknownCount() != 2 {
		t.Errorf("malformed %d oversized %d stray %d unknown %d", c.malformed.Load(), c.oversized.Load(), c.strayReplies.Load(), c.unknownCount())
	}
}

// An app-server that ends in a turn ends the session with an error and
// the turn with it.
func TestExitMidTurn(t *testing.T) {
	var sc script
	sc.begin()
	turn := sc.request(mTurnStart)
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t1")
	sc.line(map[string]any{"dir": "in", "exit": 3})
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "go")
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the session did not end")
	}
	if !isCode(s.Err(), chatproto.CodeEnded) {
		t.Errorf("ended with %v", s.Err())
	}
	evs := k.snapshot()
	if last := evs[len(evs)-1]; last.T != chatproto.EventTurn || last.State != chatproto.TurnError || last.Error.Code != chatproto.CodeEnded {
		t.Errorf("the turn ended with %+v", last)
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: text("x")}); !isCode(err, chatproto.CodeEnded) {
		t.Errorf("a prompt after the end: %v", err)
	}
}

// Close ends the app-server gracefully: its input first, SIGTERM after
// closeWait, SIGKILL after killWait more.
func TestCloseOrder(t *testing.T) {
	for _, tc := range []struct {
		mode string
		want []string
		min  time.Duration
	}{
		{"", []string{"eof"}, 0},
		{"ignore-eof", []string{"eof", "term"}, closeWait},
		{"ignore-eof,ignore-term", []string{"eof", "term"}, closeWait + killWait},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			var sc script
			sc.begin()
			f := newFake(t, tc.mode, handshake, sc.file(t))
			s, _ := start(t, f, chatproto.Options{}, "")
			began := time.Now()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.Close(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case <-s.Done():
			default:
				t.Fatal("Close returned before the session ended")
			}
			took := time.Since(began)
			if s.Err() != nil {
				t.Errorf("closed with %v", s.Err())
			}
			if got := f.events(1); !slices.Equal(got, tc.want) {
				t.Errorf("the app-server saw %v, want %v", got, tc.want)
			}
			if took < tc.min {
				t.Errorf("ended after %v, before %v", took, tc.min)
			}
		})
	}
}

// A message sent while a compaction runs (which takes no steering) waits
// for the turn's end; one withdrawn never goes; the others start the next
// turn, told taken.
func TestQueueDuringCompaction(t *testing.T) {
	var sc script
	sc.begin()
	sc.reply(sc.request(mThreadCompactStart), map[string]any{})
	sc.turnStarted("t1")
	sc.item(true, map[string]any{"type": "contextCompaction", "id": "c1"})
	sc.line(map[string]any{"dir": "in", "sleep": 500})
	sc.item(false, map[string]any{"type": "contextCompaction", "id": "c1"})
	sc.turnCompleted("t1", turnCompleted)
	turn := sc.request(mTurnStart)
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t2", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t2")
	sc.turnCompleted("t2", turnCompleted)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Compact(ctx); err != nil {
		t.Fatal(err)
	}
	k.wait(t, "the compaction's start", func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool { return ev.T == chatproto.EventNotice }) == 1
	})
	prompt(t, s, "m1", "one")
	prompt(t, s, "m2", "two")
	if err := s.CancelQueued(ctx, "m1"); err != nil {
		t.Fatal(err)
	}
	if err := s.CancelQueued(ctx, "m1"); !isCode(err, chatproto.CodeNotFound) {
		t.Errorf("withdrawn twice: %v", err)
	}
	if len(f.requests(t, 1, mTurnSteer)) != 0 {
		t.Error("steered into a compaction")
	}
	k.wait(t, "the next turn's end", turnEnds(2))
	var states []string
	for _, ev := range k.snapshot() {
		if ev.T == chatproto.EventQueued {
			states = append(states, ev.State+":"+ev.Message)
		}
	}
	if want := []string{"queued:m1", "queued:m2", "cancelled:m1", "taken:m2"}; !slices.Equal(states, want) {
		t.Errorf("queued %v, want %v", states, want)
	}
	ts := f.requests(t, 1, mTurnStart)
	if len(ts) != 1 || ts[0]["clientUserMessageId"] != "m2" {
		t.Errorf("turn/start %v", ts)
	}
}

// A plan refused keeps planning; a prompt while a plan waits for its
// approval ends the plan's turn and starts the next with the message.
func TestPlanRefusedAndSuperseded(t *testing.T) {
	plan := func(sc *script, turn string, n int) {
		id := sc.request(mTurnStart)
		sc.reply(id, map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}})
		sc.turnStarted(turn)
		sc.item(false, map[string]any{"type": "plan", "id": "plan-" + turn, "text": "# Plan " + turn})
		sc.turnCompleted(turn, turnCompleted)
	}
	var sc script
	sc.begin()
	plan(&sc, "t1", 1)
	plan(&sc, "t2", 2)
	plan(&sc, "t3", 3)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{Mode: chatproto.ModePlan}, "")
	k.permAns = []chatadapter.PermissionAnswer{{Option: chatadapter.OptionRejectOnce}}
	prompt(t, s, "m1", "plan")
	k.wait(t, "the refused plan's end", turnEnds(1))
	// The approval is asked after the turn's end; once refused, nothing
	// waits.
	k.wait(t, "the refusal", func(k *testSink) bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(k.perms) == 1 && s.ask == nil
	})
	prompt(t, s, "m2", "plan again")
	k.wait(t, "the second plan's approval", func(k *testSink) bool { return len(k.perms) == 2 })
	k.mu.Lock()
	k.permAns = []chatadapter.PermissionAnswer{{Option: chatadapter.OptionRejectOnce}}
	k.mu.Unlock()
	prompt(t, s, "m3", "change it")
	k.wait(t, "the third turn's end", turnEnds(3))
	if s.st.mode != chatproto.ModePlan {
		t.Errorf("mode %s", s.st.mode)
	}
	for i, p := range f.requests(t, 1, mTurnStart) {
		if cm := p["collaborationMode"].(map[string]any); cm["mode"] != "plan" {
			t.Errorf("turn %d in %v", i, cm)
		}
	}
	var got []string
	for _, ev := range k.snapshot() {
		switch ev.T {
		case chatproto.EventTurn:
			got = append(got, ev.State+":"+ev.Item)
		case chatproto.EventQueued, chatproto.EventUser:
			got = append(got, ev.T+":"+ev.Message+ev.State)
		}
	}
	want := []string{"start:t1", "end:t1", "start:t2", "end:t2", "queued:m3queued", "queued:m3taken", "start:t3"}
	if !slices.Equal(got[:len(want)], want) {
		t.Errorf("events %v, want %v…", got, want)
	}
}

// Options and SetConfig take only what Codex offers.
func TestConfig(t *testing.T) {
	var sc script
	sc.begin()
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{Model: "no-such-model", Effort: "ultra", Mode: "yolo"}, "")
	if s.st.model != "gpt-6-luna" || s.st.effort != "low" || s.st.mode != chatproto.ModeDefault {
		t.Errorf("settings %+v", s.st)
	}
	ctx := context.Background()
	for _, c := range [][2]string{{optModel, "nope"}, {optEffort, "ultra"}, {optMode, "yolo"}, {"other", "x"}} {
		if err := s.SetConfig(ctx, c[0], c[1]); !isCode(err, chatproto.CodeBadRequest) {
			t.Errorf("SetConfig %v: %v", c, err)
		}
	}
	if err := s.SetConfig(ctx, optModel, "gpt-6.2-sol"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetConfig(ctx, optEffort, "ultra"); err != nil {
		t.Fatal(err)
	}
	// A model without the effort falls back to its own default.
	if err := s.SetConfig(ctx, optModel, "gpt-6-luna"); err != nil || s.st.effort != "medium" {
		t.Errorf("effort %s after the model changed: %v", s.st.effort, err)
	}
	if err := s.SetConfig(ctx, optMode, chatproto.ModeFull); err != nil {
		t.Fatal(err)
	}
	k.mu.Lock()
	cfg := k.chat.Config
	k.mu.Unlock()
	if cfg[len(cfg)-1].CurrentValue != chatproto.ModeFull {
		t.Errorf("config %+v", cfg)
	}
	approval, sandbox, _ := policy(chatproto.ModeFull, "/w")
	if approval != "never" || sandbox["type"] != "dangerFullAccess" {
		t.Errorf("full: %s %v", approval, sandbox)
	}
}

// Codex without a sign-in it needs is not started.
func TestAuthRequired(t *testing.T) {
	var sc script
	sc.reply(sc.request(mInitialize), map[string]any{"userAgent": "x/1"})
	sc.reply(sc.request(mAccountRead), map[string]any{"account": nil, "requiresOpenaiAuth": true})
	f := newFake(t, "", handshake, sc.file(t))
	_, err := (&Adapter{}).Start(context.Background(), f.params(t.TempDir(), chatproto.Options{}), newSink())
	if !isCode(err, chatproto.CodeAuthRequired) {
		t.Errorf("Start: %v", err)
	}
	if len(f.requests(t, 1, mThreadStart)) != 0 {
		t.Error("a thread started")
	}
}

// Sessions lists a directory's threads through an app-server started for
// the question, which ends gracefully.
func TestSessions(t *testing.T) {
	f := newFake(t, "", handshake, fixture("13-resume.2.jsonl"))
	cwd := t.TempDir()
	p := chatadapter.SessionsParams{Kind: "codex", Argv: f.argv, Env: f.env, Cwd: cwd}
	ss, next, err := (&Adapter{}).Sessions(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(ss) == 0 || ss[0].SessionID != "00000000-0000-7000-8000-000000000006" || ss[0].Title != "Reply with the word hi." || ss[0].UpdatedAt.Unix() != 1795347638 {
		t.Errorf("sessions %+v", ss)
	}
	if next != "" {
		t.Errorf("next %q", next)
	}
	if l := f.requests(t, 1, mThreadList); len(l) != 1 || l[0]["cwd"] != cwd {
		t.Errorf("thread/list %v", l)
	}
	if ev := f.events(1); !slices.Equal(ev, []string{"eof"}) {
		t.Errorf("the probe saw %v", ev)
	}
}

// History emits a thread's turns, every item, oldest first; after an item
// or a turn, only what came after it.
func TestHistory(t *testing.T) {
	turnItems := func(n int) []any {
		id := func(s string) string { return s + string(rune('0'+n)) }
		return []any{
			map[string]any{"type": "userMessage", "id": id("u"), "content": []any{map[string]any{"type": "text", "text": id("hello "), "text_elements": []any{}}}},
			map[string]any{"type": "reasoning", "id": id("r"), "summary": []any{"thinking"}, "content": []any{}},
			map[string]any{"type": "commandExecution", "id": id("c"), "command": "/bin/zsh -lc 'ls'", "cwd": "/work", "status": "completed", "aggregatedOutput": "a\n", "exitCode": 0, "commandActions": []any{}},
			map[string]any{"type": "agentMessage", "id": id("m"), "text": id("done "), "phase": "final_answer"},
		}
	}
	turnOf := func(n int, status string) map[string]any {
		return map[string]any{"id": "turn" + string(rune('0'+n)), "status": status, "items": turnItems(n), "itemsView": "full", "startedAt": 1795347000 + n, "completedAt": 1795347010 + n}
	}
	cursor := "cursor-2"
	var sc script
	sc.reply(sc.request(mInitialize), map[string]any{"userAgent": "x/1"})
	// Oldest first: two pages.
	sc.reply(sc.request(mThreadTurnsList), map[string]any{"data": []any{turnOf(1, turnCompleted), turnOf(2, turnInterrupted)}, "nextCursor": cursor})
	sc.reply(sc.request(mThreadTurnsList), map[string]any{"data": []any{turnOf(3, turnFailed), turnOf(4, turnInProgress)}, "nextCursor": nil})
	f := newFake(t, "", "", sc.file(t))
	var evs []chatproto.Event
	p := chatadapter.HistoryParams{Kind: "codex", Argv: f.argv, Env: f.env, Cwd: "/work", SessionID: testThread}
	if err := (&Adapter{}).History(context.Background(), p, func(ev chatproto.Event) { evs = append(evs, ev) }); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, ev := range evs {
		if ev.Live || ev.Seq != 0 {
			t.Errorf("a history event %+v", ev)
		}
		got = append(got, ev.T+":"+ev.State+ev.StopReason+":"+ev.Item)
	}
	want := []string{
		"turn:start:turn1", "user::u1", "update::r1", "update::c1", "update::m1", "turn:endend_turn:turn1",
		"turn:start:turn2", "user::u2", "update::r2", "update::c2", "update::m2", "turn:endcancelled:turn2",
		"turn:start:turn3", "user::u3", "update::r3", "update::c3", "update::m3", "turn:error:turn3",
	}
	if !slices.Equal(got, want) {
		t.Errorf("history\n%v\nwant\n%v", got, want)
	}
	tl := f.requests(t, 1, mThreadTurnsList)
	if len(tl) != 2 || tl[0]["itemsView"] != "full" || tl[0]["sortDirection"] != "asc" || tl[1]["cursor"] != cursor || tl[0]["threadId"] != testThread {
		t.Errorf("turns/list %v", tl)
	}

	// After an item: newest first until it.
	since := func(after string) []string {
		var sc script
		sc.reply(sc.request(mInitialize), map[string]any{"userAgent": "x/1"})
		sc.reply(sc.request(mThreadTurnsList), map[string]any{"data": []any{turnOf(4, turnInProgress), turnOf(3, turnCompleted)}, "nextCursor": "c"})
		sc.reply(sc.request(mThreadTurnsList), map[string]any{"data": []any{turnOf(2, turnCompleted), turnOf(1, turnCompleted)}, "nextCursor": nil})
		f := newFake(t, "", "", sc.file(t))
		var got []string
		p := chatadapter.HistoryParams{Kind: "codex", Argv: f.argv, Env: f.env, Cwd: "/work", SessionID: testThread, After: after}
		if err := (&Adapter{}).History(context.Background(), p, func(ev chatproto.Event) { got = append(got, ev.T+":"+ev.Item) }); err != nil {
			t.Fatal(err)
		}
		if tl := f.requests(t, 1, mThreadTurnsList); tl[0]["sortDirection"] != "desc" {
			t.Errorf("turns/list %v", tl)
		}
		return got
	}
	if got, want := since("c2"), []string{"update:m2", "turn:turn2", "turn:turn3", "user:u3", "update:r3", "update:c3", "update:m3", "turn:turn3"}; !slices.Equal(got, want) {
		t.Errorf("after c2: %v, want %v", got, want)
	}
	if got, want := since("turn2"), []string{"turn:turn3", "user:u3", "update:r3", "update:c3", "update:m3", "turn:turn3"}; !slices.Equal(got, want) {
		t.Errorf("after turn2: %v, want %v", got, want)
	}
	if got := since("nowhere"); len(got) != 0 {
		t.Errorf("after an unknown item: %v", got)
	}
}

func TestMapping(t *testing.T) {
	for in, want := range map[string]string{
		"/bin/zsh -lc 'echo hi > hi.txt'":             "echo hi > hi.txt",
		`/bin/bash -c "echo \"a\" $HOME"`:             `echo "a" $HOME`,
		"/bin/zsh -lc 'it'\\''s'":                     "it's",
		"ls -la":                                      "ls -la",
		"/bin/zsh -lc 'a' extra":                      "/bin/zsh -lc 'a' extra",
		"/usr/bin/env zsh -c 'x'":                     "/usr/bin/env zsh -c 'x'",
		"/bin/sh -c 'for i in 1 2; do echo $i; done'": "for i in 1 2; do echo $i; done",
	} {
		if got := shellScript(in, nil); got != want {
			t.Errorf("shellScript(%q) = %q, want %q", in, got, want)
		}
	}
	if got := shellScript("", []commandAction{{Command: "a"}, {Command: "b"}}); got != "a; b" {
		t.Errorf("from the actions: %q", got)
	}

	in, err := toUserInput([]json.RawMessage{
		raw(textBlock("hi")),
		raw(obj{"type": "image", "mimeType": "image/png", "data": "AAAA"}),
		raw(obj{"type": "resource_link", "uri": "file:///work/a%20b.go", "name": "a b.go"}),
		raw(obj{"type": "resource_link", "uri": "https://example.com/x", "name": "x"}),
		raw(obj{"type": "resource", "resource": obj{"uri": "file:///x", "text": "body"}}),
	})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(in)
	if want := `[{"type":"text","text":"hi","text_elements":[]},{"type":"image","url":"data:image/png;base64,AAAA"},{"type":"mention","path":"/work/a b.go","name":"a b.go"},{"type":"text","text":"https://example.com/x","text_elements":[]},{"type":"text","text":"body","text_elements":[]}]`; string(b) != want {
		t.Errorf("input %s\nwant  %s", b, want)
	}
	for _, bad := range []json.RawMessage{raw(obj{"type": "audio", "data": "x"}), raw(obj{"type": "image", "mimeType": "text/plain", "data": "x"}), json.RawMessage(`"x"`)} {
		if _, err := toUserInput([]json.RawMessage{bad}); err == nil {
			t.Errorf("took %s", bad)
		}
	}
	if _, err := toUserInput(nil); err == nil {
		t.Error("took an empty prompt")
	}

	out := userContent(json.RawMessage(`[{"type":"text","text":"a","text_elements":[]},{"type":"image","url":"data:image/png;base64,QUJD"},{"type":"localImage","path":"/w/red.png"},{"type":"mention","name":"m","path":"/w/m.go"}]`))
	b, _ = json.Marshal(out)
	if want := `[{"text":"a","type":"text"},{"data":"QUJD","mimeType":"image/png","type":"image"},{"name":"red.png","type":"resource_link","uri":"file:///w/red.png"},{"name":"m","type":"resource_link","uri":"file:///w/m.go"}]`; string(b) != want {
		t.Errorf("content %s\nwant    %s", b, want)
	}

	if e := turnErrorOf(&turnError{Message: "x", CodexErrorInfo: json.RawMessage(`{"responseStreamDisconnected":{"httpStatusCode":401}}`)}); e.Code != chatproto.CodeAuthRequired {
		t.Errorf("401: %v", e)
	}
	if e := turnErrorOf(&turnError{Message: "x", CodexErrorInfo: json.RawMessage(`"usageLimitExceeded"`)}); e.Code != chatproto.CodeFailed || e.Message != "x" {
		t.Errorf("usage limit: %v", e)
	}
	if v := agentVersion("herdr_ide/0.171.0 (Mac OS 26.6.2; arm64) ghostty"); v != "0.171.0" {
		t.Errorf("version %q", v)
	}
	m := mapper{cwd: "/work"}
	u := m.fileCall(&item{ID: "f", Status: "completed", Changes: []fileChange{
		{Path: "/work/a.txt", Diff: "a\n", Kind: struct {
			Type     string  `json:"type"`
			MovePath *string `json:"move_path"`
		}{Type: "add"}},
		{Path: "/work/b.txt", Diff: "@@ -1 +1 @@\n-b\n+c\n", Kind: struct {
			Type     string  `json:"type"`
			MovePath *string `json:"move_path"`
		}{Type: "update", MovePath: new("/work/c.txt")}},
		{Path: "/elsewhere/d.txt", Diff: "d\n", Kind: struct {
			Type     string  `json:"type"`
			MovePath *string `json:"move_path"`
		}{Type: "delete"}},
	}})
	b, _ = json.Marshal(u)
	if want := `{"content":[{"newText":"a\n","oldText":null,"path":"/work/a.txt","type":"diff"},{"changes":[{"oldPath":"/work/b.txt","operation":"move","path":"/work/c.txt"}],"patch":{"format":"unified","text":"--- /work/b.txt\n+++ /work/c.txt\n@@ -1 +1 @@\n-b\n+c\n"},"type":"diff"},{"newText":"","oldText":"d\n","path":"/elsewhere/d.txt","type":"diff"}],"kind":"edit","locations":[{"path":"/work/a.txt"},{"path":"/work/c.txt"},{"path":"/elsewhere/d.txt"}],"sessionUpdate":"tool_call","status":"completed","title":"a.txt, c.txt, /elsewhere/d.txt","toolCallId":"f"}`; string(b) != want {
		t.Errorf("file call %s\nwant      %s", b, want)
	}
}

// The host's view of the turn is a moment behind: a prompt it did not
// record (it saw a turn run) that finds the turn ended starts the next one
// after its EventUser; one it recorded is not told again.
func TestPromptRecorded(t *testing.T) {
	var sc script
	sc.begin()
	for _, id := range []string{"t1", "t2"} {
		turn := sc.request(mTurnStart)
		sc.reply(turn, map[string]any{"turn": map[string]any{"id": id, "status": "inProgress", "items": []any{}}})
		sc.turnStarted(id)
		sc.turnCompleted(id, turnCompleted)
	}
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	send := func(msg string, recorded bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Prompt(ctx, chatadapter.PromptParams{Content: text(msg), Message: msg, ClientID: "c-" + msg, Recorded: recorded}); err != nil {
			t.Fatalf("Prompt %s: %v", msg, err)
		}
	}
	send("one", true)
	// The turn ends between the host's look and the prompt.
	k.wait(t, "the first turn's end", turnEnds(1))
	send("two", false)
	k.wait(t, "the second turn's end", turnEnds(2))
	var got []string
	for _, ev := range k.snapshot() {
		switch ev.T {
		case chatproto.EventTurn:
			got = append(got, ev.State+":"+ev.Item)
		case chatproto.EventUser, chatproto.EventQueued:
			got = append(got, ev.T+":"+ev.ClientID+ev.State)
			if ev.T == chatproto.EventUser && (len(ev.Content) != 1 || !strings.Contains(string(ev.Content[0]), `"two"`)) {
				t.Errorf("user %s", ev.Content)
			}
		}
	}
	if want := []string{"start:t1", "end:t1", "user:c-two", "start:t2", "end:t2"}; !slices.Equal(got, want) {
		t.Errorf("events %v, want %v", got, want)
	}
	ts := f.requests(t, 1, mTurnStart)
	if len(ts) != 2 || ts[1]["clientUserMessageId"] != "two" {
		t.Errorf("turn/start %v", ts)
	}
}

// A question without options takes the user's own words even when Codex
// does not say so (isOther false): it could not be answered otherwise.
// The answers go back by the questions' ids.
func TestFreeFormQuestion(t *testing.T) {
	var sc script
	sc.begin()
	turn := sc.request(mTurnStart)
	// Our ids: initialize 1, model/list 2, account/read 3, thread/start
	// 4, turn/start 5.
	sc.ask(6, mRequestUserInput, map[string]any{"threadId": testThread, "turnId": "t1", "itemId": "q-1", "questions": []any{
		map[string]any{"id": "name", "header": "Name", "question": "What is it called?", "isOther": false, "isSecret": false, "options": nil},
		map[string]any{"id": "color", "header": "Color", "question": "Which color?", "isOther": false, "isSecret": false,
			"options": []any{map[string]any{"label": "red", "description": ""}}},
	}})
	sc.reply(turn, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
	sc.turnStarted("t1")
	sc.turnCompleted("t1", turnCompleted)
	f := newFake(t, "", handshake, sc.file(t))
	s, k := start(t, f, chatproto.Options{}, "")
	k.questAns = []chatadapter.QuestionAnswer{{Answers: map[string][]string{"name": {"Widget"}, "color": {"red"}}}}
	prompt(t, s, "m1", "ask me")
	k.wait(t, "the turn's end", turnEnds(1))
	k.mu.Lock()
	qs := k.questions
	k.mu.Unlock()
	if len(qs) != 1 || len(qs[0].Questions) != 2 || !qs[0].Questions[0].AllowOther || qs[0].Questions[1].AllowOther {
		t.Fatalf("questions %+v", qs)
	}
	got, _ := json.Marshal(replies(t, f, 1)["6"])
	if !strings.Contains(string(got), `"name":{"answers":["Widget"]}`) {
		t.Errorf("the answer %s", got)
	}
}

// A message this session told (queued and taken) whose turn does not
// start ends in an error the log keeps: after a plan that waited for its
// approval, and after a steer the turn's end beat.
func TestToldTurnFails(t *testing.T) {
	turnStates := func(k *testSink) []string {
		var got []string
		for _, ev := range k.snapshot() {
			switch ev.T {
			case chatproto.EventTurn:
				got = append(got, ev.State)
			case chatproto.EventQueued:
				got = append(got, ev.State+":"+ev.Message)
			}
		}
		return got
	}
	t.Run("plan", func(t *testing.T) {
		var sc script
		sc.begin()
		id := sc.request(mTurnStart)
		sc.reply(id, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
		sc.turnStarted("t1")
		sc.item(false, map[string]any{"type": "plan", "id": "plan-t1", "text": "# Plan"})
		sc.turnCompleted("t1", turnCompleted)
		sc.fail(sc.request(mTurnStart), "the model is overloaded")
		f := newFake(t, "", handshake, sc.file(t))
		s, k := start(t, f, chatproto.Options{Mode: chatproto.ModePlan}, "")
		prompt(t, s, "m1", "plan")
		k.wait(t, "the plan's approval", func(k *testSink) bool { return len(k.perms) == 1 })
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// The host saw the approval wait: the message is not recorded.
		err := s.Prompt(ctx, chatadapter.PromptParams{Content: text("change it"), Message: "m2", ClientID: "c-m2"})
		if !isCode(err, chatproto.CodeFailed) {
			t.Fatalf("Prompt: %v", err)
		}
		want := []string{"start", "end", "queued:m2", "taken:m2", "error"}
		if got := turnStates(k); !slices.Equal(got, want) {
			t.Errorf("events %v, want %v", got, want)
		}
	})
	t.Run("steer", func(t *testing.T) {
		var sc script
		sc.begin()
		id := sc.request(mTurnStart)
		sc.reply(id, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
		sc.turnStarted("t1")
		sc.fail(sc.request(mTurnSteer), "no active turn to steer")
		sc.fail(sc.request(mTurnStart), "the model is overloaded")
		f := newFake(t, "", handshake, sc.file(t))
		s, k := start(t, f, chatproto.Options{}, "")
		prompt(t, s, "m1", "go")
		k.wait(t, "the turn's start", func(k *testSink) bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.turn == "t1"
		})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := s.Prompt(ctx, chatadapter.PromptParams{Content: text("more"), Message: "m2", ClientID: "c-m2"})
		if !isCode(err, chatproto.CodeFailed) {
			t.Fatalf("Prompt: %v", err)
		}
		want := []string{"start", "queued:m2", "taken:m2", "error"}
		if got := turnStates(k); !slices.Equal(got, want) {
			t.Errorf("events %v, want %v", got, want)
		}
	})
}

// The mode option marks full access, which the host gates.
func TestFullModeMarked(t *testing.T) {
	cfg := models{}.configOptions(settings{mode: chatproto.ModeDefault})
	mode := cfg[len(cfg)-1]
	if mode.Category != chatproto.CategoryMode {
		t.Fatalf("config %+v", cfg)
	}
	for _, v := range mode.Options {
		if v.Full != (v.Value == chatproto.ModeFull) {
			t.Errorf("%s: full %v", v.Value, v.Full)
		}
	}
}

// Every message the session told queued is told taken or cancelled in the
// end: one steered into a turn when the app-server ends in it (taken, as a
// turn's end tells), one whose turn was to start after the session ended
// (cancelled).
func TestQueuedToldAtEnd(t *testing.T) {
	queued := func(k *testSink) []string {
		var got []string
		for _, ev := range k.snapshot() {
			if ev.T == chatproto.EventQueued {
				got = append(got, ev.State+":"+ev.Message)
			}
		}
		return got
	}
	t.Run("steered", func(t *testing.T) {
		var sc script
		sc.begin()
		id := sc.request(mTurnStart)
		sc.reply(id, map[string]any{"turn": map[string]any{"id": "t1", "status": "inProgress", "items": []any{}}})
		sc.turnStarted("t1")
		sc.reply(sc.request(mTurnSteer), map[string]any{"turnId": "t1"})
		sc.line(map[string]any{"dir": "in", "sleep": 100})
		sc.line(map[string]any{"dir": "in", "exit": 3})
		f := newFake(t, "", handshake, sc.file(t))
		s, k := start(t, f, chatproto.Options{}, "")
		prompt(t, s, "m1", "go")
		k.wait(t, "the turn's start", func(k *testSink) bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.turn == "t1"
		})
		prompt(t, s, "m2", "more")
		select {
		case <-s.Done():
		case <-time.After(10 * time.Second):
			t.Fatal("the session did not end")
		}
		if got, want := queued(k), []string{"queued:m2", "taken:m2"}; !slices.Equal(got, want) {
			t.Errorf("queued %v, want %v", got, want)
		}
	})
	t.Run("late", func(t *testing.T) {
		var sc script
		sc.begin()
		f := newFake(t, "", handshake, sc.file(t))
		s, k := start(t, f, chatproto.Options{}, "")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Close(ctx)
		s.sendQueued([]message{{chatadapter.PromptParams{Content: text("late"), Message: "m3", ClientID: "c-m3"}}})
		if got, want := queued(k), []string{"cancelled:m3"}; !slices.Equal(got, want) {
			t.Errorf("queued %v, want %v", got, want)
		}
	})
}

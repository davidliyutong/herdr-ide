package codex

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// handshake is the recording whose answers (model/list, account/read)
// serve the recordings that lack them.
var handshake = fixture("01-handshake.jsonl")

// The replays: each recording of spec/vectors/chat/codex driven as the
// host would, the events checked against a golden file, what the adapter
// asked checked against the policies it must keep.

func TestReplayText(t *testing.T) {
	for _, name := range []string{"03-thread-text", "04b-reasoning", "13-resume.1"} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t, "", handshake, fixture(name+".jsonl"))
			s, k := start(t, f, chatproto.Options{Model: "gpt-6-luna", Effort: "low"}, "")
			prompt(t, s, "m1", "hello")
			k.wait(t, "the turn's end", turnEnds(1))
			golden(t, name, k)
			checkPolicies(t, f)
		})
	}
}

func TestReplayCommands(t *testing.T) {
	f := newFake(t, "", handshake, fixture("05a-command-sandboxed.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	for i, msg := range []string{"m1", "m2", "m3", "m4"} {
		prompt(t, s, msg, "run it")
		k.wait(t, "the turn's end", turnEnds(i+1))
	}
	golden(t, "05a-command-sandboxed", k)
	checkPolicies(t, f)
}

// The approvals: accepted, declined, accepted for the session, as the
// recording answered them.
func TestReplayApprovals(t *testing.T) {
	f := newFake(t, "", handshake, fixture("05b-command-approval.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	k.permAns = []chatadapter.PermissionAnswer{
		{Option: chatadapter.OptionAllowOnce}, {Option: chatadapter.OptionRejectOnce}, {Option: chatadapter.OptionAllowSession},
	}
	for i, msg := range []string{"m1", "m2", "m3", "m4"} {
		prompt(t, s, msg, "run it")
		k.wait(t, "the turn's end", turnEnds(i+1))
	}
	var decisions []string
	for _, m := range f.received(t, 1) {
		if r, _ := m["result"].(map[string]any); r != nil && m["method"] == nil {
			if d, ok := r["decision"].(string); ok {
				decisions = append(decisions, d)
			}
		}
	}
	if want := []string{"accept", "decline", "acceptForSession"}; !slices.Equal(decisions, want) {
		t.Errorf("decisions %v, want %v", decisions, want)
	}
	if len(k.perms) != 3 || k.perms[0].Kind != chatproto.PermissionCommand || len(k.perms[0].Options) != 3 {
		t.Fatalf("permissions asked: %+v", k.perms)
	}
	var tc map[string]any
	json.Unmarshal(k.perms[0].ToolCall, &tc)
	if tc["title"] != "echo hi > hi.txt" || tc["kind"] != "execute" || tc["toolCallId"] == "" {
		t.Errorf("the permission's tool call: %v", tc)
	}
	if in, _ := tc["rawInput"].(map[string]any); in["reason"] == nil || in["command"] != "echo hi > hi.txt" {
		t.Errorf("the permission's input: %v", tc["rawInput"])
	}
	// The default mode asks (E1: under on-request and read-only the model
	// refused to write instead of asking).
	for _, ts := range f.requests(t, 1, mTurnStart) {
		sp, _ := ts["sandboxPolicy"].(map[string]any)
		if ts["approvalPolicy"] != "untrusted" || sp["type"] != "workspaceWrite" {
			t.Errorf("the default mode ran with %v and %v", ts["approvalPolicy"], sp)
		}
	}
	golden(t, "05b-command-approval", k)
	checkPolicies(t, f)
}

func TestReplayFileChange(t *testing.T) {
	f := newFake(t, "", handshake, fixture("06-file-change.jsonl"))
	s, k := start(t, f, chatproto.Options{Mode: chatproto.ModeAcceptEdits}, "")
	k.permAns = []chatadapter.PermissionAnswer{{Option: chatadapter.OptionAllowOnce}}
	prompt(t, s, "m1", "create it")
	k.wait(t, "the turn's end", turnEnds(1))
	prompt(t, s, "m2", "change it")
	k.wait(t, "the turn's end", turnEnds(2))
	if len(k.perms) != 1 || k.perms[0].Kind != chatproto.PermissionFile {
		t.Fatalf("permissions asked: %+v", k.perms)
	}
	var tc map[string]any
	json.Unmarshal(k.perms[0].ToolCall, &tc)
	content, _ := tc["content"].([]any)
	if tc["kind"] != "edit" || len(content) != 1 {
		t.Errorf("the file permission's tool call: %v", tc)
	}
	ts := f.requests(t, 1, mTurnStart)
	if sp := ts[0]["sandboxPolicy"].(map[string]any); sp["type"] != "workspaceWrite" {
		t.Errorf("acceptEdits ran with %v", sp)
	}
	golden(t, "06-file-change", k)
	checkPolicies(t, f)
}

// Plan mode: the question answered, the plan approved through a permission
// of kind plan before its turn ends, carried out in the next turn in the
// mode chosen.
func TestReplayPlanAndQuestion(t *testing.T) {
	f := newFake(t, "", handshake, fixture("07-plan-and-question.jsonl"))
	s, k := start(t, f, chatproto.Options{Model: "gpt-6-luna", Effort: "low", Mode: chatproto.ModePlan}, "")
	k.questAns = []chatadapter.QuestionAnswer{{Answers: map[string][]string{"greeting": {"Hello (Recommended)"}}}}
	k.permAns = []chatadapter.PermissionAnswer{{Option: chatadapter.PlanOption(chatproto.ModeAcceptEdits)}}
	prompt(t, s, "m1", "plan it")
	k.wait(t, "the implementation's end", turnEnds(2))
	if len(k.questions) != 1 || len(k.questions[0].Questions) != 1 || !k.questions[0].Questions[0].AllowOther {
		t.Fatalf("questions asked: %+v", k.questions)
	}
	if len(k.perms) != 1 || k.perms[0].Kind != chatproto.PermissionPlan {
		t.Fatalf("permissions asked: %+v", k.perms)
	}
	ts := f.requests(t, 1, mTurnStart)
	if len(ts) != 2 {
		t.Fatalf("%d turns started", len(ts))
	}
	if cm := ts[0]["collaborationMode"].(map[string]any); cm["mode"] != "plan" {
		t.Errorf("the plan's turn ran in %v", cm)
	}
	if cm := ts[1]["collaborationMode"].(map[string]any); cm["mode"] != "default" {
		t.Errorf("the implementation ran in %v", cm)
	}
	if sp := ts[1]["sandboxPolicy"].(map[string]any); sp["type"] != "workspaceWrite" {
		t.Errorf("the implementation ran with %v, not acceptEdits'", sp)
	}
	var answers []any
	for _, m := range f.received(t, 1) {
		if r, _ := m["result"].(map[string]any); r != nil && r["answers"] != nil {
			answers = append(answers, r["answers"])
		}
	}
	if len(answers) != 1 {
		t.Errorf("answers sent: %v", answers)
	}
	golden(t, "07-plan-and-question", k)
	checkPolicies(t, f)
}

// An interrupt whose command still runs: the turn ends cancelled, and the
// app-server is ended gracefully and started again on the thread.
func TestReplayInterruptRestarts(t *testing.T) {
	// The second process resumes the thread of the first.
	f := newFake(t, "", handshake, fixture("09-interrupt.jsonl"), edited(t, "13-resume.2.jsonl", nil,
		"00000000-0000-7000-8000-000000000006", "00000000-0000-7000-8000-000000000001"))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "count")
	k.wait(t, "the command", func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool {
			return ev.T == chatproto.EventUpdate && !ev.Live && ev.Item != "" && ev.Parent == ""
		}) > 0
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
	k.wait(t, "the restart", func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool {
			return ev.T == chatproto.EventNotice && ev.Method == noticeMethodOf(agentproto.NoticeRestarted)
		}) == 1
	})
	if f.started() != 2 {
		t.Fatalf("%d processes", f.started())
	}
	if ev := f.events(1); len(ev) == 0 || ev[0] != "eof" {
		t.Errorf("the first app-server saw %v, not its input's end first", ev)
	}
	rs := f.requests(t, 2, mThreadResume)
	if len(rs) != 1 || rs[0]["threadId"] != s.ID() || rs[0]["excludeTurns"] != true {
		t.Errorf("resumed with %v", rs)
	}
	if len(f.requests(t, 1, mTurnInterrupt)) != 1 {
		t.Error("no turn/interrupt")
	}
	// The session goes on on the new process.
	prompt(t, s, "m2", "again")
	k.wait(t, "the next turn's end", turnEnds(2))
	golden(t, "09-interrupt", k)
	checkPolicies(t, f)
}

// A message sent while a turn runs is steered into it: queued, then taken
// with its user message when the item shows.
func TestReplaySteer(t *testing.T) {
	// The recording's client steered twice more (with a wrong turn, and
	// after the turn): what followed those belongs to the first steer.
	f := newFake(t, "", handshake, edited(t, "10-steer.jsonl", func(method string, n int) bool { return method == mTurnSteer && n > 0 }))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "sleep")
	k.wait(t, "the command", func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool { return ev.T == chatproto.EventUpdate && ev.Item != "" }) == 1
	})
	prompt(t, s, "m2", "Also end your answer with the word banana.")
	k.wait(t, "the turn's end", turnEnds(1))
	st := f.requests(t, 1, mTurnSteer)
	if len(st) != 1 || st[0]["expectedTurnId"] == nil || st[0]["clientUserMessageId"] != "m2" {
		t.Errorf("steered with %v", st)
	}
	var states []string
	for _, ev := range k.snapshot() {
		if ev.T == chatproto.EventQueued {
			states = append(states, ev.State+":"+ev.Message)
		}
	}
	if want := []string{"queued:m2", "taken:m2"}; !slices.Equal(states, want) {
		t.Errorf("queued events %v, want %v", states, want)
	}
	golden(t, "10-steer", k)
	checkPolicies(t, f)
}

func TestReplayCompact(t *testing.T) {
	f := newFake(t, "", handshake, fixture("11-compact.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "think")
	k.wait(t, "the turn's end", turnEnds(1))
	// The slash command compacts.
	prompt(t, s, "m2", " /compact ")
	k.wait(t, "the compaction's end", turnEnds(2))
	if len(f.requests(t, 1, mThreadCompactStart)) != 1 {
		t.Error("no thread/compact/start")
	}
	golden(t, "11-compact", k)
	checkPolicies(t, f)
}

func TestReplayImages(t *testing.T) {
	f := newFake(t, "", handshake, fixture("12-images.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	img := raw(obj{"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="})
	for i, msg := range []string{"m1", "m2"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := s.Prompt(ctx, chatadapter.PromptParams{Content: []json.RawMessage{img, raw(textBlock("What color?"))}, Message: msg, Recorded: recorded(s)})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		k.wait(t, "the turn's end", turnEnds(i+1))
	}
	for _, p := range f.requests(t, 1, mTurnStart) {
		in := p["input"].([]any)
		first := in[0].(map[string]any)
		if first["type"] != "image" || first["url"] != "data:image/png;base64,iVBORw0KGgo=" {
			t.Errorf("an image sent as %v", first)
		}
	}
	golden(t, "12-images", k)
	checkPolicies(t, f)
}

// A resumed thread: thread/resume read-only without its turns, then a turn.
func TestReplayResume(t *testing.T) {
	f := newFake(t, "", handshake, fixture("13-resume.2.jsonl"))
	s, k := start(t, f, chatproto.Options{Model: "gpt-6-luna"}, "00000000-0000-7000-8000-000000000006")
	if s.ID() != "00000000-0000-7000-8000-000000000006" {
		t.Errorf("session %s", s.ID())
	}
	if len(f.requests(t, 1, mThreadStart)) != 0 || len(f.requests(t, 1, mThreadResume)) != 1 {
		t.Error("not resumed")
	}
	prompt(t, s, "m1", "again")
	k.wait(t, "the turn's end", turnEnds(1))
	golden(t, "13-resume.2", k)
	checkPolicies(t, f)
}

// A subagent: its tool call, and its thread's events under it.
func TestReplaySubagent(t *testing.T) {
	f := newFake(t, "", handshake, fixture("14-subagent.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "spawn")
	k.wait(t, "the turn's end", turnEnds(1))
	var spawn string
	children := 0
	for _, ev := range k.snapshot() {
		if ev.T == chatproto.EventUpdate && ev.Parent == "" {
			var u map[string]any
			json.Unmarshal(ev.Update, &u)
			if u["kind"] == "think" && u["title"] == "/root/run_echo" {
				spawn = ev.Item
			}
		}
		if ev.Parent != "" {
			if ev.Parent != spawn {
				t.Errorf("a subagent's event under %q, not %q", ev.Parent, spawn)
			}
			children++
		}
		if ev.T == chatproto.EventTurn && ev.Item != "" && ev.Item != "00000000-0000-7000-8000-000000000002" {
			t.Errorf("a subagent's turn told as the chat's: %+v", ev)
		}
	}
	if spawn == "" || children == 0 {
		t.Errorf("subagent %q with %d events", spawn, children)
	}
	k.mu.Lock()
	used := k.chat.Usage
	k.mu.Unlock()
	if used == nil || used.Used != 19789 || used.Size != 828400 {
		t.Errorf("usage %+v: a subagent's usage counted as the chat's?", used)
	}
	golden(t, "14-subagent", k)
	checkPolicies(t, f)
}

// Errors: a thread Codex has no rollout of is not found; a start Codex
// refuses fails with its message.
func TestReplayErrors(t *testing.T) {
	f := newFake(t, "", handshake, fixture("15-errors.1.jsonl"))
	k := newSink()
	p := f.params(t.TempDir(), chatproto.Options{})
	p.Resume = "00000000-0000-7000-8000-000000000001"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := (&Adapter{}).Start(ctx, p, k); !isCode(err, chatproto.CodeNotFound) {
		t.Errorf("resuming an unknown thread: %v", err)
	}
	f2 := newFake(t, "", handshake, fixture("15-errors.2.jsonl"))
	if _, err := (&Adapter{}).Start(ctx, f2.params(t.TempDir(), chatproto.Options{}), k); !isCode(err, chatproto.CodeFailed) {
		t.Errorf("a refused thread/start: %v", err)
	}
	// Both ended their app-server gracefully.
	for _, f := range []*fakeRun{f, f2} {
		if ev := f.events(1); !slices.Contains(ev, "eof") {
			t.Errorf("the app-server saw %v", ev)
		}
	}
	if len(k.snapshot()) != 0 {
		t.Errorf("a session that did not start told %s", dump(k.snapshot()))
	}
}

// Retried errors are notices; a turn that never ends is cancelled when the
// chat closes.
func TestReplayRetriedErrors(t *testing.T) {
	f := newFake(t, "", handshake, fixture("16-trust-write-isolated-home.jsonl"))
	s, k := start(t, f, chatproto.Options{}, "")
	prompt(t, s, "m1", "hi")
	k.wait(t, "the retries", func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool { return ev.T == chatproto.EventNotice }) == 3
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	<-s.Done()
	if s.Err() != nil {
		t.Errorf("closed with %v", s.Err())
	}
	golden(t, "16-trust-write-isolated-home", k)
	checkPolicies(t, f)
}

// The handshake: the client named, experimental API on, attestation
// refused; models, efforts and modes as configuration options.
func TestReplayHandshake(t *testing.T) {
	f := newFake(t, "", handshake, fixture("03-thread-text.jsonl"))
	_, k := start(t, f, chatproto.Options{Model: "gpt-6-luna", Effort: "high", Mode: chatproto.ModeFull}, "")
	in := f.requests(t, 1, mInitialize)
	if len(in) != 1 {
		t.Fatalf("initialize %v", in)
	}
	ci := in[0]["clientInfo"].(map[string]any)
	caps := in[0]["capabilities"].(map[string]any)
	if ci["name"] != clientName || ci["title"] != "veldr" || ci["version"] != "1.2.3" || caps["experimentalApi"] != true || caps["requestAttestation"] != false {
		t.Errorf("initialize %v", in[0])
	}
	recv := f.received(t, 1)
	if recv[1]["method"] != mInitialized {
		t.Errorf("after initialize: %v", recv[1])
	}
	k.mu.Lock()
	chat := k.chat
	k.mu.Unlock()
	if chat.SessionID != "00000000-0000-7000-8000-000000000001" || chat.AgentVersion != "0.171.0" {
		t.Errorf("chat %+v", chat)
	}
	cur := map[string]string{}
	for _, o := range chat.Config {
		cur[o.ID] = o.CurrentValue
	}
	if cur[optModel] != "gpt-6-luna" || cur[optEffort] != "high" || cur[optMode] != chatproto.ModeFull {
		t.Errorf("config %v", cur)
	}
	if !chat.Capabilities.Images || !chat.Capabilities.Model || !chat.Capabilities.Effort || chat.Capabilities.CancelQueued {
		t.Errorf("capabilities %+v", chat.Capabilities)
	}
}

func noticeMethodOf(name string) string { return noticeEvent(name, "", nil, time.Time{}).Method }

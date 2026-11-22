//go:build unix

package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

var update = flag.Bool("update", false, "rewrite the golden files of testdata/")

// patience is how long a test waits for what must happen.
const patience = 10 * time.Second

var testTiming = timing{
	initialize: patience, session: patience, load: patience, call: patience,
	grace: 2 * time.Second, term: 2 * time.Second, drain: time.Second,
}

func init() { itemPrefix = func() string { return "x" } }

// host is a chatadapter.Sink that records what a host gets, as JSON lines
// with the test's directory written /work: {"event": ...} and
// {"permission": ...} in their order, and the chat as the Updates left it
// ({"chat": ...}, last): the order of the Updates and the events is not
// fixed (an agent's notification that follows the answer that ends a turn,
// as Kimi Code's usage_update, races with the turn's end).
type host struct {
	dir string

	mu      sync.Mutex
	chat    chatproto.Chat
	recs    [][]byte
	answers []string // the permissions' answers in order: an option, or "" to wait for the cancel
	asked   func(r chatadapter.PermissionRequest)

	events chan chatproto.Event
	perms  chan chatadapter.PermissionRequest
}

func newHost(dir string) *host {
	return &host{dir: dir, events: make(chan chatproto.Event, 10000), perms: make(chan chatadapter.PermissionRequest, 100)}
}

func (h *host) record(kind string, v any) {
	b, err := json.Marshal(map[string]any{kind: v})
	if err != nil {
		panic(err)
	}
	h.recs = append(h.recs, bytes.ReplaceAll(b, []byte(h.dir), []byte("/work")))
}

func (h *host) Event(ev chatproto.Event) {
	h.mu.Lock()
	h.record("event", ev)
	h.mu.Unlock()
	h.events <- ev
}

func (h *host) Update(fn func(c *chatproto.Chat)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	fn(&h.chat)
}

func (h *host) Permission(ctx context.Context, r chatadapter.PermissionRequest) (chatadapter.PermissionAnswer, error) {
	h.mu.Lock()
	h.record("permission", r)
	answer := ""
	if len(h.answers) > 0 {
		answer, h.answers = h.answers[0], h.answers[1:]
	}
	asked := h.asked
	h.mu.Unlock()
	h.perms <- r
	if asked != nil {
		asked(r)
	}
	if answer == "" {
		<-ctx.Done()
		return chatadapter.PermissionAnswer{}, ctx.Err()
	}
	return chatadapter.PermissionAnswer{Option: answer}, nil
}

func (h *host) Question(ctx context.Context, r chatadapter.QuestionRequest) (chatadapter.QuestionAnswer, error) {
	return chatadapter.QuestionAnswer{}, errors.New("no questions in ACP")
}

// await takes events until one that want takes.
func (h *host) await(t *testing.T, what string, want func(chatproto.Event) bool) chatproto.Event {
	t.Helper()
	deadline := time.After(patience)
	for {
		select {
		case ev := <-h.events:
			if want(ev) {
				return ev
			}
		case <-deadline:
			t.Fatalf("timeout waiting for %s", what)
		}
	}
}

func turnState(state string) func(chatproto.Event) bool {
	return func(ev chatproto.Event) bool { return ev.T == chatproto.EventTurn && ev.State == state }
}

func turnOver(ev chatproto.Event) bool {
	return ev.T == chatproto.EventTurn && (ev.State == chatproto.TurnEnd || ev.State == chatproto.TurnError)
}

// golden compares what the host got with testdata/<name>.jsonl.
func (h *host) golden(t *testing.T, name string) {
	t.Helper()
	h.mu.Lock()
	chat, _ := json.Marshal(map[string]any{"chat": h.chat})
	got := bytes.Join(append(slices.Clone(h.recs), bytes.ReplaceAll(chat, []byte(h.dir), []byte("/work"))), []byte("\n"))
	h.mu.Unlock()
	got = append(got, '\n')
	path := filepath.Join("testdata", name+".jsonl")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test -run %s -update writes it)", err, t.Name())
	}
	if !bytes.Equal(got, want) {
		gl, wl := bytes.Split(got, []byte("\n")), bytes.Split(want, []byte("\n"))
		for i := range max(len(gl), len(wl)) {
			var g, w []byte
			if i < len(gl) {
				g = gl[i]
			}
			if i < len(wl) {
				w = wl[i]
			}
			if !bytes.Equal(g, w) {
				t.Fatalf("%s: line %d differs\n got %.600s\nwant %.600s", path, i+1, g, w)
			}
		}
	}
}

// harness runs the fake agent of a script.
type harness struct {
	t    *testing.T
	dir  string // the session's directory: the recordings' /work
	host *host
	a    *Adapter
	logs *syncBuffer
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func newHarness(t *testing.T) *harness {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, dir: dir, host: newHost(dir), a: &Adapter{t: testTiming}, logs: &syncBuffer{}}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("adapter log:\n%s", h.logs.String())
		}
	})
	return h
}

func (h *harness) rec(agent, name string) []step { return recording(h.t, agent, name, h.dir) }

func (h *harness) params(steps []step, extra ...string) chatadapter.StartParams {
	h.host.answers = answers(steps)
	return chatadapter.StartParams{
		Kind: "test", Argv: fakeArgv(h.t), Env: fakeEnv(h.t, writeScript(h.t, steps), extra...), Cwd: h.dir,
		Client:   chatadapter.ClientInfo{Name: "test-client", Version: "1.0"},
		Settings: chatproto.DefaultHostSettings(), Logger: log.New(h.logs, "", 0),
	}
}

// start starts a session; it is closed when the test ends.
func (h *harness) start(p chatadapter.StartParams) *session {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), patience)
	defer cancel()
	cs, err := h.a.Start(ctx, p, h.host)
	if err != nil {
		h.t.Fatalf("start: %v", err)
	}
	s := cs.(*session)
	h.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), patience)
		defer cancel()
		s.Close(ctx)
	})
	return s
}

// settled returns once the host has what the session made so far: the
// session hands it on from a goroutine of its own.
func settled(s *session) {
	ctx, cancel := context.WithTimeout(context.Background(), patience)
	defer cancel()
	s.out.reached(ctx, s.out.mark())
}

// recorded is what the host would make of a prompt to s now: recorded
// when no turn runs (and nothing waits for one).
func recorded(s *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.turn == nil && len(s.queue) == 0
}

// turn sends a prompt and waits for its turn's end.
func (h *harness) turn(s *session, content []json.RawMessage) chatproto.Event {
	h.t.Helper()
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: content, Message: "m", ClientID: "c"}); err != nil {
		h.t.Fatalf("prompt: %v", err)
	}
	return h.host.await(h.t, "the turn's end", turnOver)
}

// close closes the session and checks it ended without an error.
func (h *harness) close(s *session) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), patience)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		h.t.Fatalf("close: %v", err)
	}
	if err := s.Err(); err != nil {
		h.t.Fatalf("Err after Close = %v", err)
	}
}

// from is steps from the first client message of method on.
func from(steps []step, method string) []step {
	for i, s := range steps {
		var w wire
		json.Unmarshal(s.Msg, &w)
		if s.Dir == "out" && w.Method == method {
			return steps[i:]
		}
	}
	return nil
}

// checkOptions fails for a permission that offers to allow or reject for
// good.
func (h *host) checkOptions(t *testing.T) int {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, r := range h.recs {
		var rec struct {
			Permission *chatadapter.PermissionRequest `json:"permission"`
		}
		json.Unmarshal(r, &rec)
		if rec.Permission == nil {
			continue
		}
		n++
		for _, o := range rec.Permission.Options {
			if o.Kind != chatproto.AllowOnce && o.Kind != chatproto.RejectOnce {
				t.Errorf("a permission offers %+v", o)
			}
		}
	}
	return n
}

// A Kimi Code session: text, a file written and a command run with
// permissions, the mode set, a turn cancelled, an image.
func TestKimiSession(t *testing.T) {
	h := newHarness(t)
	var steps []step
	turns := map[string][]step{}
	for _, n := range []string{"01-initialize", "02-session-new", "03-prompt-hi", "04-permission-write", "05-execute-permission"} {
		turns[n] = h.rec("kimi", n)
		steps = append(steps, turns[n]...)
	}
	// The mode through its configuration option (the recording also has
	// session/set_mode, which a session with the option does not send).
	steps = append(steps, from(h.rec("kimi", "06-set-mode-and-config-option"), "session/set_config_option")...)
	for _, n := range []string{"07-cancel", "08-image"} {
		turns[n] = h.rec("kimi", n)
		steps = append(steps, turns[n]...)
	}
	s := h.start(h.params(steps))
	if s.ID() != "session_00000000-0000-4000-8000-000000000001" {
		t.Fatalf("session id %q", s.ID())
	}
	if pgid, err := syscall.Getpgid(s.PID()); err != nil || pgid != s.PID() || pgid == syscall.Getpgrp() {
		t.Fatalf("the agent %d is in group %d (%v), the test in %d", s.PID(), pgid, err, syscall.Getpgrp())
	}
	for _, n := range []string{"03-prompt-hi", "04-permission-write", "05-execute-permission"} {
		if ev := h.turn(s, promptOf(t, turns[n])); ev.State != chatproto.TurnEnd || ev.StopReason != "end_turn" {
			t.Fatalf("%s: turn ended %+v", n, ev)
		}
	}
	for _, v := range []string{"plan", "default"} {
		if err := s.SetConfig(context.Background(), "mode", v); err != nil {
			t.Fatalf("set mode %s: %v", v, err)
		}
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, turns["07-cancel"])}); err != nil {
		t.Fatal(err)
	}
	h.host.await(t, "the turn's start", turnState(chatproto.TurnStart))
	if err := s.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ev := h.host.await(t, "the cancelled turn's end", turnOver); ev.StopReason != "cancelled" {
		t.Fatalf("cancelled turn ended %+v; agent: %#v", ev, s.Err())
	}
	h.turn(s, promptOf(t, turns["08-image"]))
	h.close(s)
	if n := h.host.checkOptions(t); n != 2 {
		t.Errorf("%d permissions, want 2", n)
	}
	h.host.golden(t, "kimi-session")
}

// A Grok session, told not to approve everything: permissions, the
// effort set, a turn cancelled, an image; its cost and context from the
// answers' _meta.
func TestGrokSession(t *testing.T) {
	h := newHarness(t)
	var steps []step
	turns := map[string][]step{}
	for _, n := range []string{"01-initialize", "02-session-new-yolo-off", "04-permission-write", "05c-execute-permission",
		"06-set-config-option-effort", "07-cancel", "08b-image-32px"} {
		turns[n] = h.rec("grok", n)
		steps = append(steps, turns[n]...)
	}
	p := h.params(steps)
	p.NewSessionMeta = json.RawMessage(`{"yoloMode":false}`) // the fake checks session/new's params
	s := h.start(p)
	for _, n := range []string{"04-permission-write", "05c-execute-permission"} {
		if ev := h.turn(s, promptOf(t, turns[n])); ev.StopReason != "end_turn" {
			t.Fatalf("%s: turn ended %+v", n, ev)
		}
	}
	for _, v := range []string{"low", "high"} {
		if err := s.SetConfig(context.Background(), "reasoning_effort", v); err != nil {
			t.Fatalf("set effort %s: %v", v, err)
		}
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, turns["07-cancel"])}); err != nil {
		t.Fatal(err)
	}
	h.host.await(t, "the turn's start", turnState(chatproto.TurnStart))
	if err := s.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ev := h.host.await(t, "the cancelled turn's end", turnOver); ev.StopReason != "cancelled" {
		t.Fatalf("cancelled turn ended %+v; agent: %#v", ev, s.Err())
	}
	h.turn(s, promptOf(t, turns["08b-image-32px"]))
	h.close(s)
	if n := h.host.checkOptions(t); n != 2 {
		t.Errorf("%d permissions, want 2", n)
	}

	h.host.mu.Lock()
	u, c := h.host.chat.Usage, h.host.chat
	h.host.mu.Unlock()
	// The turns' costUsdTicks, 10^10 to the dollar; the context of the
	// last turn's last model call, of the model's window.
	const ticks = 201116800 + 200668000 + 167055600
	if u == nil || u.Cost == nil || u.Cost.Currency != "USD" || abs(u.Cost.Amount-ticks/1e10) > 1e-12 || u.Used != 25008 || u.Size != 256000 {
		t.Errorf("usage %+v, cost %+v", u, u.Cost)
	}
	if !c.Capabilities.Images || !c.Capabilities.Model || !c.Capabilities.Effort || c.Capabilities.Plan || c.Capabilities.Compact ||
		!c.Capabilities.Queue || !c.Capabilities.CancelQueued || c.AgentVersion == "" {
		t.Errorf("chat %+v", c)
	}
	h.host.golden(t, "grok-session")
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// A session taken up by session/load (an agent without session/resume):
// its replay is dropped, the chat's log has it.
func TestResumeByLoad(t *testing.T) {
	h := newHarness(t)
	steps := without(h.rec("kimi", "09-list-load"), "session/list")
	edit(t, steps, func(m map[string]any) bool {
		res, ok := m["result"].(map[string]any)
		if !ok || res["agentCapabilities"] == nil {
			return false
		}
		delete(res["agentCapabilities"].(map[string]any)["sessionCapabilities"].(map[string]any), "resume")
		return true
	})
	after := h.rec("kimi", "09b-prompt-after-load")
	steps = append(steps, after...)
	p := h.params(steps)
	p.Resume = "session_00000000-0000-4000-8000-000000000001"
	s := h.start(p)
	h.turn(s, promptOf(t, after))
	h.close(s)
	h.host.golden(t, "kimi-load")
}

// A session taken up by session/resume, which replays nothing.
func TestResume(t *testing.T) {
	for _, tt := range []struct{ agent, id string }{
		{"kimi", "session_00000000-0000-4000-8000-000000000001"},
		{"grok", "00000000-0000-4000-8000-000000000003"},
	} {
		t.Run(tt.agent, func(t *testing.T) {
			h := newHarness(t)
			p := h.params(h.rec(tt.agent, "10-resume"))
			p.Resume = tt.id
			s := h.start(p)
			if s.ID() != tt.id {
				t.Fatalf("session %q", s.ID())
			}
			h.close(s)
			h.host.golden(t, tt.agent+"-resume")
		})
	}
}

// An import: the title the agent lists the session with (session/list),
// then the replay of session/load as stored events, turn by turn; then
// again from where the first ended, without the title.
func TestHistory(t *testing.T) {
	for _, tt := range []struct{ agent, id, title string }{
		{"kimi", "session_00000000-0000-4000-8000-000000000001", "Reply with the word hi"},
		{"grok", "00000000-0000-4000-8000-000000000007", "Create hello.txt containing hi"},
	} {
		t.Run(tt.agent, func(t *testing.T) {
			h := newHarness(t)
			listed := h.rec(tt.agent, "09-list-load")
			steps := without(listed, "session/list")
			hp := func(steps []step) chatadapter.HistoryParams {
				p := h.params(steps)
				return chatadapter.HistoryParams{Kind: tt.agent, Argv: p.Argv, Env: p.Env, Cwd: p.Cwd, SessionID: tt.id, Logger: p.Logger}
			}
			var all []chatproto.Event
			if err := h.a.History(context.Background(), hp(listed), func(ev chatproto.Event) {
				all = append(all, ev)
				h.host.Event(ev)
			}); err != nil {
				t.Fatal(err)
			}
			h.host.golden(t, tt.agent+"-history")

			// Every event is stored; the import starts with its notice and
			// the session's title.
			users := 0
			for _, ev := range all {
				if ev.Live || ev.Seq != 0 {
					t.Fatalf("an import's event %+v", ev)
				}
				if ev.T == chatproto.EventUser {
					users++
				}
			}
			if users < 3 || all[0].T != chatproto.EventNotice || !strings.HasSuffix(all[0].Method, "/"+agentproto.NoticeImported) {
				t.Fatalf("%d user messages; first event %+v", users, all[0])
			}
			if all[1].T != chatproto.EventInfo || all[1].Chat == nil || all[1].Chat.Title != tt.title {
				t.Fatalf("the title's event %+v", all[1])
			}
			all = append(all[:1:1], all[2:]...)

			// From the last item of the second turn on: the turns after it.
			second, third := -1, -1
			n := 0
			for i, ev := range all {
				if ev.T == chatproto.EventUser {
					n++
					if n == 3 {
						third = i
						break
					}
				}
				if n == 2 && ev.Item != "" {
					second = i
				}
			}
			p := hp(steps)
			p.After = all[second].Item
			var rest []chatproto.Event
			if err := h.a.History(context.Background(), p, func(ev chatproto.Event) { rest = append(rest, ev) }); err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(all[third:])
			got, _ := json.Marshal(rest)
			if !bytes.Equal(got, want) {
				t.Fatalf("after %s:\n got %.500s\nwant %.500s", p.After, got, want)
			}

			// A tool call's item is its id, as in a chat's live events: an
			// earlier item of the same turn gives the same.
			tool := ""
			n = 0
			for _, ev := range all {
				if ev.T == chatproto.EventUser {
					n++
				}
				if n == 2 && ev.Item != "" && !strings.HasPrefix(ev.Item, "h-") {
					tool = ev.Item
					break
				}
			}
			p.After, rest = tool, nil
			if err := h.a.History(context.Background(), p, func(ev chatproto.Event) { rest = append(rest, ev) }); err != nil {
				t.Fatal(err)
			}
			if got, _ := json.Marshal(rest); tool == "" || !bytes.Equal(got, want) {
				t.Fatalf("after the tool call %q: %.300s", tool, got)
			}

			// An item the replay does not have: nothing.
			p.After = "x-m-404"
			rest = nil
			if err := h.a.History(context.Background(), p, func(ev chatproto.Event) { rest = append(rest, ev) }); err != nil || len(rest) != 0 {
				t.Fatalf("after an unknown item: %d events, %v", len(rest), err)
			}
		})
	}
}

// Sessions lists the agent's sessions of a directory, the most recent
// first.
func TestSessions(t *testing.T) {
	for _, tt := range []struct {
		agent string
		want  []string
	}{
		{"kimi", []string{"session_00000000-0000-4000-8000-000000000001 Reply with the word hi", "session_00000000-0000-4000-8000-000000000002 "}},
		{"grok", []string{"00000000-0000-4000-8000-000000000003 Image Color Query Without Attached File",
			"00000000-0000-4000-8000-000000000004 Run printf hi redirect to out.txt", "00000000-0000-4000-8000-000000000005 Create subdirectory with mkdir -p",
			"00000000-0000-4000-8000-000000000006 Create hello.txt and run echo hi", "00000000-0000-4000-8000-000000000007 Create hello.txt containing hi",
			"00000000-0000-4000-8000-000000000008 "}},
	} {
		t.Run(tt.agent, func(t *testing.T) {
			h := newHarness(t)
			steps := h.rec(tt.agent, "09-list-load")
			list := from(steps, "session/load")
			steps = steps[:len(steps)-len(list)]
			p := h.params(steps)
			got, next, err := h.a.Sessions(context.Background(), chatadapter.SessionsParams{Kind: tt.agent, Argv: p.Argv, Env: p.Env, Cwd: h.dir})
			if err != nil || next != "" {
				t.Fatalf("next %q, err %v", next, err)
			}
			var ids []string
			for i, s := range got {
				ids = append(ids, s.SessionID+" "+s.Title)
				if s.Cwd != h.dir || s.UpdatedAt.IsZero() || i > 0 && s.UpdatedAt.After(got[i-1].UpdatedAt) {
					t.Errorf("session %+v", s)
				}
			}
			if !slices.Equal(ids, tt.want) {
				t.Fatalf("sessions %q", ids)
			}
		})
	}
}

// Requests the client does not serve are answered "method not found",
// never left waiting; vendor notifications and unknown updates are passed
// over; the session goes on.
func TestUnknownRequests(t *testing.T) {
	h := newHarness(t)
	hi := h.rec("kimi", "03-prompt-hi")
	// During a turn, after the prompt.
	steps := append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), hi[0])
	const sid = `"sessionId":"session_00000000-0000-4000-8000-000000000001"`
	steps = append(steps,
		msgLine("in", `{"jsonrpc":"2.0","id":7,"method":"fs/write_text_file","params":{`+sid+`,"path":"/etc/x","content":"y"}}`),
		msgLine("out", `{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}`),
		msgLine("in", `{"jsonrpc":"2.0","id":"t-8","method":"terminal/create","params":{`+sid+`,"command":"sh"}}`),
		msgLine("out", `{"jsonrpc":"2.0","id":"t-8","error":{"code":-32601,"message":"Method not found"}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"_x.ai/sessions/changed","params":{"upserted":[]}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"session/update","params":{`+sid+`,"update":{"sessionUpdate":"brand_new_kind","x":1}}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"another","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"not ours"}}}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"session/update","params":{`+sid+`,"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"an echo"}}}}`),
		msgLine("in", `{"jsonrpc":"2.0","id":9,"method":"_vendor/ask","params":{}}`),
		msgLine("out", `{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"Method not found"}}`),
	)
	steps = append(steps, hi[1:]...)
	s := h.start(h.params(steps))
	if ev := h.turn(s, promptOf(t, hi)); ev.State != chatproto.TurnEnd {
		t.Fatalf("turn %+v; agent: %#v", ev, s.Err())
	}
	h.close(s)
	if s.conn.Vendor() != 1 {
		t.Errorf("vendor notifications %d", s.conn.Vendor())
	}
	h.host.mu.Lock()
	defer h.host.mu.Unlock()
	for _, r := range h.host.recs {
		if bytes.Contains(r, []byte("not ours")) || bytes.Contains(r, []byte("an echo")) || bytes.Contains(r, []byte("brand_new_kind")) {
			t.Errorf("handed on: %s", r)
		}
	}
}

// A prompt while a turn runs waits for the turn's end, then is sent as the
// next turn; one withdrawn before is not.
func TestQueue(t *testing.T) {
	h := newHarness(t)
	write, hi := h.rec("kimi", "04-permission-write"), h.rec("kimi", "03-prompt-hi")
	steps := append(append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), write...), hi...)
	s := h.start(h.params(steps))
	var errs []error
	h.host.asked = func(chatadapter.PermissionRequest) {
		bg := context.Background()
		errs = append(errs,
			s.Prompt(bg, chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, hi), Message: "q1", ClientID: "c1"}),
			s.Prompt(bg, chatadapter.PromptParams{Recorded: recorded(s), Content: []json.RawMessage{json.RawMessage(`{"type":"text","text":"never mind"}`)}, Message: "q2", ClientID: "c2"}),
			s.CancelQueued(bg, "q2"),
			s.CancelQueued(bg, "q2"))
	}
	h.turn(s, promptOf(t, write))
	taken := h.host.await(t, "the queued message taken", func(ev chatproto.Event) bool { return ev.T == chatproto.EventQueued })
	if taken.State != chatproto.QueuedTaken || taken.Message != "q1" || taken.ClientID != "c1" {
		t.Fatalf("queued %+v", taken)
	}
	h.host.await(t, "the queued message's turn", turnState(chatproto.TurnStart))
	h.host.await(t, "the queued message's turn's end", turnOver)
	h.close(s)
	var e *chatproto.Error
	if errs[0] != nil || errs[1] != nil || errs[2] != nil || !errors.As(errs[3], &e) || e.Code != chatproto.CodeNotFound {
		t.Fatalf("errors %v", errs)
	}
	h.host.golden(t, "kimi-queue")
}

// Cancel during a permission: the agent is told, the permission is
// answered cancelled, the queued message is withdrawn.
func TestCancelPermission(t *testing.T) {
	h := newHarness(t)
	run := h.rec("kimi", "05-execute-permission")
	var upTo []step
	for _, st := range run {
		upTo = append(upTo, st)
		if bytes.Contains(st.Msg, []byte("session/request_permission")) {
			break
		}
	}
	steps := append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), upTo...)
	steps = append(steps,
		msgLine("out", `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session_00000000-0000-4000-8000-000000000001"}}`),
		msgLine("out", `{"jsonrpc":"2.0","id":1,"result":{"outcome":{"outcome":"cancelled"}}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session_00000000-0000-4000-8000-000000000001","update":{"sessionUpdate":"tool_call_update","toolCallId":"2:tool_fake0002","status":"failed"}}}`),
		msgLine("in", `{"jsonrpc":"2.0","id":5,"result":{"stopReason":"cancelled"}}`),
	)
	s := h.start(h.params(steps))
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, run)}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.host.perms:
	case <-time.After(patience):
		t.Fatal("no permission")
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, run), Message: "q1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ev := h.host.await(t, "the turn's end", turnOver); ev.StopReason != "cancelled" {
		t.Fatalf("turn %+v; agent: %#v", ev, s.Err())
	}
	h.close(s)
	h.host.golden(t, "kimi-cancel-permission")
}

// An agent that exits during a turn: the turn ends with an error, the
// session with the agent's exit and the end of its standard error.
func TestAgentExits(t *testing.T) {
	h := newHarness(t)
	hi := h.rec("kimi", "03-prompt-hi")
	steps := append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), hi[:5]...)
	steps = append(steps, step{Dir: "exit", Code: 2, Stderr: "panic: boom\n"})
	s := h.start(h.params(steps))
	h.turn(s, promptOf(t, hi))
	select {
	case <-s.Done():
	case <-time.After(patience):
		t.Fatal("not done")
	}
	var e *chatproto.Error
	if err := s.Err(); !errors.As(err, &e) || e.Code != chatproto.CodeEnded || !strings.Contains(e.Message, "exit status 2") || e.Stderr != "panic: boom\n" {
		t.Fatalf("Err = %#v", err)
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: promptOf(t, hi)}); !errors.As(err, &e) || e.Code != chatproto.CodeEnded {
		t.Fatalf("prompt to a session that ended: %v", err)
	}
	h.host.golden(t, "kimi-exit")
}

// Agents that do not get to a session.
func TestStartErrors(t *testing.T) {
	init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"x","version":"1"}}}`
	initOK := `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}`
	tests := []struct {
		name   string
		steps  []step
		resume string
		code   string
		stderr string
	}{
		{"auth", []step{msgLine("out", init), msgLine("in", initOK), msgLine("out", `{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"DIR","mcpServers":[]}}`),
			msgLine("in", `{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}`)}, "", chatproto.CodeAuthRequired, ""},
		{"version", []step{msgLine("out", init), msgLine("in", `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}`)}, "", chatproto.CodeProtocol, ""},
		{"exit", []step{msgLine("out", init), {Dir: "exit", Code: 1, Stderr: "no configuration\n"}}, "", chatproto.CodeStartFailed, "no configuration\n"},
		{"no resume", []step{msgLine("out", init), msgLine("in", initOK)}, "s1", chatproto.CodeUnsupported, ""},
		// The protocol's "not there" for a session to take up.
		{"unknown session", []step{msgLine("out", init),
			msgLine("in", `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}`),
			msgLine("out", `{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"s1","cwd":"DIR","mcpServers":[]}}`),
			msgLine("in", `{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"Resource not found","data":{"uri":"s1"}}}`)}, "s1", chatproto.CodeNotFound, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			for i := range tt.steps {
				tt.steps[i].Msg = bytes.ReplaceAll(tt.steps[i].Msg, []byte("DIR"), []byte(h.dir))
			}
			p := h.params(tt.steps)
			p.Resume = tt.resume
			_, err := h.a.Start(context.Background(), p, h.host)
			var e *chatproto.Error
			if !errors.As(err, &e) || e.Code != tt.code || e.Stderr != tt.stderr {
				t.Fatalf("err = %#v", err)
			}
		})
	}
	h := newHarness(t)
	p := h.params(nil)
	p.Argv = []string{"kimi", "acp"}
	if _, err := h.a.Start(context.Background(), p, h.host); err == nil || err.(*chatproto.Error).Code != chatproto.CodeBadRequest {
		t.Fatalf("a command that is no absolute path: %v", err)
	}
}

// What a chat starts with: the mode of the host's settings, the agent's
// value of it; a model the agent does not offer is left.
func TestStartOptions(t *testing.T) {
	h := newHarness(t)
	six := from(h.rec("kimi", "06-set-mode-and-config-option"), "session/set_config_option")
	steps := append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), six[:4]...) // mode plan
	p := h.params(steps)
	p.Options = chatproto.Options{Model: "no-such-model", Mode: chatproto.ModePlan, Effort: "max"}
	s := h.start(p)
	h.close(s)
	h.host.mu.Lock()
	defer h.host.mu.Unlock()
	if o := optionOf(h.host.chat.Config, chatproto.CategoryMode); o == nil || o.CurrentValue != "plan" {
		t.Fatalf("mode %+v", o)
	}
	if o := optionOf(h.host.chat.Config, chatproto.CategoryModel); o == nil || o.CurrentValue != "kimi-code/k3.1-pro" {
		t.Fatalf("model %+v", o)
	}
}

// An agent's session modes without a configuration option of category
// mode: an option of the chat's own, set by session/set_mode.
func TestLegacyModes(t *testing.T) {
	h := newHarness(t)
	steps := append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...)
	edit(t, steps, func(m map[string]any) bool {
		res, ok := m["result"].(map[string]any)
		if !ok || res["configOptions"] == nil {
			return false
		}
		opts := res["configOptions"].([]any)
		res["configOptions"] = opts[:2] // model and thinking
		return true
	})
	const sid = `"sessionId":"session_00000000-0000-4000-8000-000000000001"`
	steps = append(steps,
		msgLine("out", `{"jsonrpc":"2.0","id":3,"method":"session/set_mode","params":{`+sid+`,"modeId":"plan"}}`),
		msgLine("in", `{"jsonrpc":"2.0","method":"session/update","params":{`+sid+`,"update":{"sessionUpdate":"current_mode_update","currentModeId":"yolo"}}}`),
		msgLine("in", `{"jsonrpc":"2.0","id":3,"result":{}}`),
	)
	s := h.start(h.params(steps))
	settled(s)
	h.host.mu.Lock()
	o := optionByID(h.host.chat.Config, "mode")
	h.host.mu.Unlock()
	if o == nil || o.Category != chatproto.CategoryMode || o.CurrentValue != "default" || len(o.Options) != 4 {
		t.Fatalf("mode option %+v", o)
	}
	var e *chatproto.Error
	if err := s.SetConfig(context.Background(), "mode", "nope"); !errors.As(err, &e) || e.Code != chatproto.CodeBadRequest {
		t.Fatalf("a value the option does not have: %v", err)
	}
	if err := s.SetConfig(context.Background(), "nope", "plan"); !errors.As(err, &e) || e.Code != chatproto.CodeBadRequest {
		t.Fatalf("an option the chat does not have: %v", err)
	}
	if err := s.SetConfig(context.Background(), "mode", "plan"); err != nil {
		t.Fatal(err)
	}
	h.close(s)
	h.host.mu.Lock()
	defer h.host.mu.Unlock()
	// The agent's notification came before its answer; the answer sets
	// what was asked.
	if o := optionByID(h.host.chat.Config, "mode"); o.CurrentValue != "plan" {
		t.Fatalf("mode %+v", o)
	}
}

// Content the agent does not take is refused before it is sent.
func TestPromptContent(t *testing.T) {
	h := newHarness(t)
	steps := append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...)
	edit(t, steps, func(m map[string]any) bool {
		res, ok := m["result"].(map[string]any)
		if !ok || res["agentCapabilities"] == nil {
			return false
		}
		res["agentCapabilities"].(map[string]any)["promptCapabilities"] = map[string]any{}
		return true
	})
	s := h.start(h.params(steps))
	for content, code := range map[string]string{
		`{"type":"image","mimeType":"image/png","data":"AA=="}`:        chatproto.CodeUnsupported,
		`{"type":"resource","resource":{"uri":"file:///x","text":""}}`: chatproto.CodeUnsupported,
		`{"type":"video"}`: chatproto.CodeBadRequest,
		`"text"`:           chatproto.CodeBadRequest,
	} {
		var e *chatproto.Error
		err := s.Prompt(context.Background(), chatadapter.PromptParams{Recorded: recorded(s), Content: []json.RawMessage{json.RawMessage(content)}})
		if !errors.As(err, &e) || e.Code != code {
			t.Errorf("%s: %v", content, err)
		}
	}
	var e *chatproto.Error
	if err := s.Compact(context.Background()); !errors.As(err, &e) || e.Code != chatproto.CodeUnsupported {
		t.Errorf("compact: %v", err)
	}
	settled(s)
	h.host.mu.Lock()
	images := h.host.chat.Capabilities.Images
	h.host.mu.Unlock()
	if images {
		t.Error("images without the capability")
	}
	h.close(s)
}

// Close closes the agent's input; an agent that stays gets SIGTERM, then
// SIGKILL; what it started in its group goes with it.
func TestClose(t *testing.T) {
	t.Run("input", func(t *testing.T) {
		h := newHarness(t)
		s := h.start(h.params(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...)))
		began := time.Now()
		h.close(s)
		if d := time.Since(began); d > time.Second {
			t.Fatalf("an agent that ends with its input took %v", d)
		}
		if st := s.proc.status(); st != "exit status 0" {
			t.Fatalf("status %q", st)
		}
	})
	t.Run("stubborn", func(t *testing.T) {
		h := newHarness(t)
		h.a.t.grace, h.a.t.term = 100*time.Millisecond, 200*time.Millisecond
		pidfile := filepath.Join(t.TempDir(), "pid")
		steps := append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), step{Dir: "child"}, step{Dir: "stubborn"})
		s := h.start(h.params(steps, fakePIDFile+"="+pidfile))
		var child int
		deadline := time.Now().Add(patience)
		for child == 0 && time.Now().Before(deadline) {
			b, _ := os.ReadFile(pidfile)
			child, _ = strconv.Atoi(string(b))
			time.Sleep(10 * time.Millisecond)
		}
		if child == 0 {
			t.Fatal("no child")
		}
		h.close(s)
		if st := s.proc.status(); st != "signal: killed" {
			t.Fatalf("status %q", st)
		}
		for syscall.Kill(child, 0) == nil && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if syscall.Kill(child, 0) == nil {
			syscall.Kill(child, syscall.SIGKILL)
			t.Fatal("the agent's child outlived it")
		}
	})
}

// The host's view of the turn is a moment behind: a prompt it did not
// record (it saw a turn run) that finds the turn ended starts the next one
// after its EventUser; a recorded one is not told again.
func TestPromptRecorded(t *testing.T) {
	h := newHarness(t)
	hi := h.rec("kimi", "03-prompt-hi")
	steps := append(append(append(h.rec("kimi", "01-initialize"), h.rec("kimi", "02-session-new")...), hi...), hi...)
	s := h.start(h.params(steps))
	send := func(clientID string, recorded bool) {
		t.Helper()
		if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: promptOf(t, hi), Message: "m-" + clientID,
			ClientID: clientID, Recorded: recorded}); err != nil {
			t.Fatalf("prompt: %v", err)
		}
	}
	send("c1", true)
	h.host.await(t, "the first turn's end", turnOver)
	// The turn ends between the host's look and the prompt.
	send("c2", false)
	first := h.host.await(t, "the prompt's user event", func(ev chatproto.Event) bool {
		return ev.T == chatproto.EventUser || ev.T == chatproto.EventTurn
	})
	if first.T != chatproto.EventUser || first.ClientID != "c2" || len(first.Content) != len(promptOf(t, hi)) {
		t.Errorf("before the turn: %+v", first)
	}
	h.host.await(t, "the second turn's start", turnState(chatproto.TurnStart))
	h.host.await(t, "the second turn's end", turnOver)
	h.close(s)
	h.host.mu.Lock()
	defer h.host.mu.Unlock()
	users := 0
	for _, r := range h.host.recs {
		var rec struct {
			Event *chatproto.Event `json:"event"`
		}
		if json.Unmarshal(r, &rec) == nil && rec.Event != nil && rec.Event.T == chatproto.EventUser {
			users++
		}
	}
	if users != 1 {
		t.Errorf("%d user events", users)
	}
}

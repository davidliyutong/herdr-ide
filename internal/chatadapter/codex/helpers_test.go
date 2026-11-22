package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

var update = flag.Bool("update", false, "rewrite the golden files of the replays")

// fixtures is the recordings' directory.
const fixtures = "../../../design/testdata/chat/codex"

func fixture(name string) string { return filepath.Join(fixtures, name) }

func init() {
	// Short waits: a fake ends at once, or never.
	closeWait = time.Second
	killWait = 500 * time.Millisecond
	drainWait = 100 * time.Millisecond
	interruptGrace = 200 * time.Millisecond
	usageEvery = 0
}

// testSink records what a session reports and answers its permissions and
// questions from queues (or waits, when a queue is empty, for its
// context).
type testSink struct {
	mu        sync.Mutex
	events    []chatproto.Event
	chat      chatproto.Chat
	perms     []chatadapter.PermissionRequest
	questions []chatadapter.QuestionRequest
	permAns   []chatadapter.PermissionAnswer
	questAns  []chatadapter.QuestionAnswer
	changed   chan struct{}
}

func newSink() *testSink { return &testSink{changed: make(chan struct{}, 1)} }

func (k *testSink) poke() {
	select {
	case k.changed <- struct{}{}:
	default:
	}
}

func (k *testSink) Event(ev chatproto.Event) {
	k.mu.Lock()
	k.events = append(k.events, ev)
	k.mu.Unlock()
	k.poke()
}

func (k *testSink) Permission(ctx context.Context, r chatadapter.PermissionRequest) (chatadapter.PermissionAnswer, error) {
	k.mu.Lock()
	k.perms = append(k.perms, r)
	var ans *chatadapter.PermissionAnswer
	if len(k.permAns) > 0 {
		ans = &k.permAns[0]
		k.permAns = k.permAns[1:]
	}
	k.mu.Unlock()
	k.poke()
	if ans != nil {
		return *ans, nil
	}
	<-ctx.Done()
	return chatadapter.PermissionAnswer{}, ctx.Err()
}

func (k *testSink) Question(ctx context.Context, r chatadapter.QuestionRequest) (chatadapter.QuestionAnswer, error) {
	k.mu.Lock()
	k.questions = append(k.questions, r)
	var ans *chatadapter.QuestionAnswer
	if len(k.questAns) > 0 {
		ans = &k.questAns[0]
		k.questAns = k.questAns[1:]
	}
	k.mu.Unlock()
	k.poke()
	if ans != nil {
		return *ans, nil
	}
	<-ctx.Done()
	return chatadapter.QuestionAnswer{}, ctx.Err()
}

func (k *testSink) Update(fn func(c *chatproto.Chat)) {
	k.mu.Lock()
	fn(&k.chat)
	k.mu.Unlock()
	k.poke()
}

func (k *testSink) snapshot() []chatproto.Event {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.events)
}

// wait waits until cond holds of what the sink has.
func (k *testSink) wait(t *testing.T, what string, cond func(k *testSink) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		k.mu.Lock()
		ok := cond(k)
		k.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-k.changed:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			t.Fatalf("timed out waiting for %s; events:\n%s", what, dump(k.snapshot()))
		}
	}
}

// count is how many events match; k.mu is held.
func (k *testSink) count(match func(ev chatproto.Event) bool) int {
	n := 0
	for _, ev := range k.events {
		if match(ev) {
			n++
		}
	}
	return n
}

func turnEnds(n int) func(k *testSink) bool {
	return func(k *testSink) bool {
		return k.count(func(ev chatproto.Event) bool {
			return ev.T == chatproto.EventTurn && (ev.State == chatproto.TurnEnd || ev.State == chatproto.TurnError)
		}) >= n
	}
}

func dump(evs []chatproto.Event) string {
	var b strings.Builder
	for _, ev := range evs {
		ev.At = time.Time{}
		l, _ := chatproto.Line(ev)
		b.Write(l)
	}
	return b.String()
}

// edited is a copy of a recording without the client's requests drop
// tells (by method and the how-manieth of it), and with the pairs of
// replace replaced.
func edited(t *testing.T, name string, drop func(method string, n int) bool, replace ...string) string {
	t.Helper()
	b, err := os.ReadFile(fixture(name))
	if err != nil {
		t.Fatal(err)
	}
	b = []byte(strings.NewReplacer(replace...).Replace(string(b)))
	seen := map[string]int{}
	var out bytes.Buffer
	for _, l := range bytes.Split(b, []byte("\n")) {
		var sl scriptLine
		var w wire
		if json.Unmarshal(l, &sl) == nil && sl.Dir == "out" && json.Unmarshal(sl.Msg, &w) == nil && w.Method != "" && len(w.ID) > 0 {
			n := seen[w.Method]
			seen[w.Method]++
			if drop != nil && drop(w.Method, n) {
				continue
			}
		}
		out.Write(l)
		out.WriteByte('\n')
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, out.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeRun is a fake app-server's records.
type fakeRun struct {
	dir  string
	argv []string
	env  []string
}

// newFake prepares fake app-servers playing scripts (the first process the
// first, and so on), with fallback's answers for what they lack.
func newFake(t *testing.T, mode string, fallback string, scripts ...string) *fakeRun {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	var abs []string
	for _, s := range scripts {
		a, err := filepath.Abs(s)
		if err != nil {
			t.Fatal(err)
		}
		abs = append(abs, a)
	}
	env := []string{
		fakeEnv + "=1", "FAKE_DIR=" + dir, "FAKE_SCRIPTS=" + strings.Join(abs, string(os.PathListSeparator)),
		"FAKE_MODE=" + mode, "HOME=" + t.TempDir(), "PATH=/usr/bin:/bin",
		// A race-enabled fake would wait a second before it exits
		// through os.Exit (it exits through exitNow).
		"GORACE=atexit_sleep_ms=0",
	}
	if fallback != "" {
		var fbs []string
		for _, fb := range filepath.SplitList(fallback) {
			a, _ := filepath.Abs(fb)
			fbs = append(fbs, a)
		}
		env = append(env, "FAKE_FALLBACK="+strings.Join(fbs, string(os.PathListSeparator)))
	}
	return &fakeRun{dir: dir, argv: []string{exe, "-test.run=^$"}, env: env}
}

// received is what the client sent the n-th process, line by line.
func (f *fakeRun) received(t *testing.T, n int) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.dir, fmt.Sprintf("recv-%d.jsonl", n)))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, l := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(l)) == 0 {
			continue
		}
		var m map[string]any
		if json.Unmarshal(l, &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// requests are the client's requests of a method to the n-th process.
func (f *fakeRun) requests(t *testing.T, n int, method string) []map[string]any {
	var out []map[string]any
	for _, m := range f.received(t, n) {
		if m["method"] == method && m["id"] != nil {
			p, _ := m["params"].(map[string]any)
			out = append(out, p)
		}
	}
	return out
}

// events is what the n-th process saw happen to it (eof, term).
func (f *fakeRun) events(n int) []string {
	b, _ := os.ReadFile(filepath.Join(f.dir, fmt.Sprintf("events-%d.txt", n)))
	return strings.Fields(string(b))
}

func (f *fakeRun) started() int {
	m, _ := filepath.Glob(filepath.Join(f.dir, "started-*"))
	return len(m)
}

func (f *fakeRun) params(cwd string, opts chatproto.Options) chatadapter.StartParams {
	return chatadapter.StartParams{
		Kind: "codex", Argv: f.argv, Env: f.env, Cwd: cwd, SessionID: "", Options: opts,
		Client:   chatadapter.ClientInfo{Name: "herdr-ide", Version: "1.2.3"},
		Settings: chatproto.DefaultHostSettings(),
		Logger:   log.New(testWriter{}, "", 0),
	}
}

type testWriter struct{}

func (testWriter) Write(p []byte) (int, error) {
	if testing.Verbose() {
		os.Stderr.Write(p)
	}
	return len(p), nil
}

func start(t *testing.T, f *fakeRun, opts chatproto.Options, resume string) (*session, *testSink) {
	t.Helper()
	k := newSink()
	p := f.params(t.TempDir(), opts)
	p.Resume = resume
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := (&Adapter{}).Start(ctx, p, k)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.Close(ctx)
	})
	return s.(*session), k
}

func text(s string) []json.RawMessage { return []json.RawMessage{raw(textBlock(s))} }

// prompt sends a message as the host does: recorded when it sees no turn
// run and nothing wait (recorded).
func prompt(t *testing.T, s *session, msg, body string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.Prompt(ctx, chatadapter.PromptParams{Content: text(body), Message: msg, ClientID: "c-" + msg, Recorded: recorded(s)}); err != nil {
		t.Fatalf("Prompt %s: %v", msg, err)
	}
}

// recorded is what the host would make of a prompt to s now: recorded
// when no turn runs and no plan waits for its approval.
func recorded(s *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.active && s.ask == nil
}

// golden compares the events (their times left out) and the chat's state
// with testdata/<name>.golden, or writes it with -update.
func golden(t *testing.T, name string, k *testSink) {
	t.Helper()
	k.mu.Lock()
	var b bytes.Buffer
	for _, ev := range k.events {
		ev.At = time.Time{}
		l, err := chatproto.Line(ev)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(l)
	}
	chat := k.chat
	k.mu.Unlock()
	l, _ := chatproto.Line(map[string]any{"chat": chat})
	b.Write(l)
	path := filepath.Join("testdata", name+".golden")
	if *update {
		os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to write it)", err)
	}
	if !bytes.Equal(want, b.Bytes()) {
		t.Errorf("events differ from %s (run with -update after checking):\n%s", path, lineDiff(string(want), b.String()))
	}
}

func lineDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	var b strings.Builder
	for i := 0; i < max(len(w), len(g)); i++ {
		var wl, gl string
		if i < len(w) {
			wl = w[i]
		}
		if i < len(g) {
			gl = g[i]
		}
		if wl != gl {
			fmt.Fprintf(&b, "line %d:\n- %s\n+ %s\n", i+1, wl, gl)
			if b.Len() > 4000 {
				break
			}
		}
	}
	return b.String()
}

// checkPolicies checks what every process was asked: threads only
// read-only and asking the user, turns with their policies, model and
// collaboration mode, never excludeTmpdirEnvVar, approvals never with an
// amendment.
func checkPolicies(t *testing.T, f *fakeRun) {
	t.Helper()
	for n := 1; n <= f.started(); n++ {
		for _, m := range []string{mThreadStart, mThreadResume} {
			for _, p := range f.requests(t, n, m) {
				if p["sandbox"] != "read-only" || p["approvalPolicy"] != "on-request" || p["approvalsReviewer"] != "user" {
					t.Errorf("process %d: %s with %v", n, m, p)
				}
			}
		}
		for _, p := range f.requests(t, n, mTurnStart) {
			sp, _ := p["sandboxPolicy"].(map[string]any)
			cm, _ := p["collaborationMode"].(map[string]any)
			if sp == nil || cm == nil || p["approvalPolicy"] == nil || p["approvalsReviewer"] != "user" || p["model"] == nil {
				t.Errorf("process %d: turn/start without its policies: %v", n, p)
			}
			if sp["excludeTmpdirEnvVar"] == true {
				t.Errorf("process %d: excludeTmpdirEnvVar set", n)
			}
		}
		for _, m := range f.received(t, n) {
			if m["method"] != nil || m["result"] == nil {
				continue
			}
			if r, _ := m["result"].(map[string]any); r != nil {
				if d, ok := r["decision"]; ok {
					if _, isString := d.(string); !isString {
						t.Errorf("process %d: a decision with an amendment: %v", n, d)
					}
				}
			}
		}
	}
}

func isCode(err error, code string) bool {
	var ce *chatproto.Error
	return errors.As(err, &ce) && ce.Code == code
}

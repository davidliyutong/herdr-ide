//go:build unix

package chathost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// The roles the test binary plays when started by a test (roleVar): a fake
// agent's process, a process of that agent's group, a chat host of its
// own (signal tests).
const (
	roleVar     = "CHATHOST_TEST_ROLE"
	roleAgent   = "agent"
	roleSleeper = "sleeper"
	roleHost    = "host"
	// envOutVar names a file the fake agent writes its environment to,
	// stubbornVar makes it ignore SIGTERM and its input's end, and
	// grandchildVar names a file it writes the pid of a process of its
	// group to.
	envOutVar     = "CHATHOST_ENV_OUT"
	stubbornVar   = "CHATHOST_STUBBORN"
	grandchildVar = "CHATHOST_GRANDCHILD"
)

func TestMain(m *testing.M) {
	switch os.Getenv(roleVar) {
	case roleAgent:
		runFakeAgent()
		return
	case roleSleeper:
		time.Sleep(time.Hour)
		return
	case roleHost:
		runTestHost()
		return
	}
	os.Exit(m.Run())
}

// runFakeAgent is a fake agent's process: it reads its input until it
// ends.
func runFakeAgent() {
	if out := os.Getenv(envOutVar); out != "" {
		os.WriteFile(out, []byte(strings.Join(os.Environ(), "\x00")), 0o600)
	}
	stubborn := os.Getenv(stubbornVar) != ""
	if stubborn {
		signal.Ignore(syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT)
	}
	if file := os.Getenv(grandchildVar); file != "" {
		exe, _ := os.Executable()
		cmd := exec.Command(exe)
		cmd.Env = append(os.Environ(), roleVar+"="+roleSleeper)
		if cmd.Start() == nil {
			os.WriteFile(file, []byte(itoa(cmd.Process.Pid)), 0o600)
		}
	}
	io.Copy(io.Discard, os.Stdin)
	if stubborn {
		time.Sleep(time.Hour)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// fakeKind is the kind of the fake agent, fakeAdapterName its adapter's
// name.
const (
	fakeKind        = "fake"
	fakeAdapterName = "fake"
)

// testExecutable is the test binary, which the fake agent's spec runs.
func testExecutable(t testing.TB) string {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

// fakeSpecs are the kinds a test host knows: fake, run by the fake
// adapter; nochat, a kind without one; missing, whose program is nowhere;
// noadapter, whose adapter is not registered.
func fakeSpecs(exe string) func(string) (*agentkinds.ChatSpec, bool) {
	return func(id string) (*agentkinds.ChatSpec, bool) {
		switch id {
		case fakeKind:
			return &agentkinds.ChatSpec{Adapter: fakeAdapterName, Argv: []string{exe, "--fake"},
				Env: map[string]string{"FAKE_SPEC_VAR": "spec"}}, true
		case "missing":
			return &agentkinds.ChatSpec{Adapter: fakeAdapterName, Argv: []string{"no-such-agent-program-x"}}, true
		case "noadapter":
			return &agentkinds.ChatSpec{Adapter: "none", Argv: []string{exe}}, true
		}
		return nil, false
	}
}

// fakeAdapter is an adapter whose sessions the test drives: what the host
// asks of them is recorded, what they report the test makes them report.
// With proc, each session runs the fake agent's process (the spec's
// program) in a process group of its own.
type fakeAdapter struct {
	proc    bool
	procEnv []string
	// pid: the sessions tell their process (pider).
	pid bool
	// closeWait is how long Close waits for a process to end by itself
	// before it signals it.
	closeWait time.Duration

	mu       sync.Mutex
	starts   []chatadapter.StartParams
	started  chan *fakeSession
	startErr error
	// startGate holds Start up until it is closed, or Start's context
	// ends unless lateStart: then the session comes all the same.
	startGate chan struct{}
	lateStart bool
	// closeDelay is how long Close takes; historyGate holds History up.
	closeDelay  time.Duration
	historyGate chan struct{}
	promptErr   error
	// setConfigErr is SetConfig's answer; untrusted: a session started in
	// a folder not Trusted tells so.
	setConfigErr error
	untrusted    bool
	// running are the sessions another process runs (InTerminal).
	running    map[string]bool
	caps       chatproto.Capabilities
	config     []chatproto.ConfigOption
	list       []chatproto.Session
	history    []chatproto.Event
	historyErr error
	histories  []chatadapter.HistoryParams
	sessionsP  []chatadapter.SessionsParams
}

func newFakeAdapter() *fakeAdapter {
	return &fakeAdapter{
		started:   make(chan *fakeSession, 64),
		closeWait: 2 * time.Second,
		caps:      chatproto.Capabilities{Images: true, Compact: true, Queue: true, Model: true},
		config: []chatproto.ConfigOption{{ID: "model", Name: "Model", Category: chatproto.CategoryModel, Type: chatproto.ConfigSelect,
			CurrentValue: "small", Options: []chatproto.ConfigValue{{Value: "small", Name: "Small"}, {Value: "large", Name: "Large"}}}},
	}
}

func (a *fakeAdapter) Start(ctx context.Context, p chatadapter.StartParams, sink chatadapter.Sink) (chatadapter.Session, error) {
	a.mu.Lock()
	a.starts = append(a.starts, p)
	gate, startErr, late := a.startGate, a.startErr, a.lateStart
	a.mu.Unlock()
	if gate != nil && late {
		<-gate
	} else if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if startErr != nil {
		return nil, startErr
	}
	id := p.Resume
	if id == "" {
		id = p.SessionID
	}
	s := &fakeSession{a: a, id: id, p: p, sink: sink, calls: make(chan string, 256), done: make(chan struct{})}
	if a.proc {
		cmd := exec.Command(p.Argv[0], p.Argv[1:]...)
		cmd.Env = append(append(append([]string{}, p.Env...), roleVar+"="+roleAgent), a.procEnv...)
		cmd.Dir = p.Cwd
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		s.cmd, s.stdin = cmd, stdin
		go func() {
			err := cmd.Wait()
			s.mu.Lock()
			closing := s.closing
			s.mu.Unlock()
			if closing {
				err = nil
			}
			s.end(err)
		}()
	}
	if a.untrusted && !p.Trusted {
		sink.Event(chatproto.Event{T: chatproto.EventNotice, Method: agentproto.NoticeMethod(agentproto.NoticeUntrustedFolder),
			Params: json.RawMessage(`{"cwd":"` + p.Cwd + `"}`)})
	}
	sink.Update(func(c *chatproto.Chat) {
		c.Capabilities = a.caps
		c.Config = a.config
		c.AgentVersion = "fake 1"
		if s.cmd != nil {
			c.AgentVersion = "pid " + itoa(s.cmd.Process.Pid)
		}
	})
	a.started <- s
	if a.pid {
		return pidSession{s}, nil
	}
	return s, nil
}

func (a *fakeAdapter) Sessions(ctx context.Context, p chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sessionsP = append(a.sessionsP, p)
	return append([]chatproto.Session(nil), a.list...), "next-page", nil
}

func (a *fakeAdapter) History(ctx context.Context, p chatadapter.HistoryParams, emit func(chatproto.Event)) error {
	a.mu.Lock()
	a.histories = append(a.histories, p)
	evs := append([]chatproto.Event(nil), a.history...)
	err, gate := a.historyErr, a.historyGate
	a.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err != nil {
		return err
	}
	after := p.After != ""
	for _, ev := range evs {
		if after {
			after = ev.Item != p.After
			continue
		}
		emit(ev)
	}
	return nil
}

// InTerminal tells the sessions of running (chatadapter.Running).
func (a *fakeAdapter) InTerminal(ctx context.Context, p chatadapter.HistoryParams) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.running[p.SessionID] {
		return &chatproto.Error{Code: chatproto.CodeInTerminal, Message: "runs in a terminal"}
	}
	return nil
}

// lastStart is the last start's parameters.
func (a *fakeAdapter) lastStart(t *testing.T) chatadapter.StartParams {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.starts) == 0 {
		t.Fatal("no start")
	}
	return a.starts[len(a.starts)-1]
}

// session is the next session started.
func (a *fakeAdapter) session(t *testing.T) *fakeSession {
	t.Helper()
	select {
	case s := <-a.started:
		return s
	case <-time.After(patience):
		t.Fatal("no session started")
		return nil
	}
}

// fakeSession is a session of the fake adapter.
type fakeSession struct {
	a     *fakeAdapter
	id    string
	p     chatadapter.StartParams
	sink  chatadapter.Sink
	calls chan string
	done  chan struct{}
	once  sync.Once
	err   error
	cmd   *exec.Cmd
	stdin io.WriteCloser

	mu      sync.Mutex
	turn    bool
	closing bool
	prompts []chatadapter.PromptParams
}

// pidSession is a fake session that tells its process.
type pidSession struct{ *fakeSession }

func (s pidSession) PID() int { return s.cmd.Process.Pid }

func (s *fakeSession) record(call string) {
	select {
	case s.calls <- call:
	default:
	}
}

// call is the next call the host made of the session.
func (s *fakeSession) call(t *testing.T) string {
	t.Helper()
	select {
	case c := <-s.calls:
		return c
	case <-time.After(patience):
		t.Fatal("no call of the session")
		return ""
	}
}

// expect fails the test unless the next call is want.
func (s *fakeSession) expect(t *testing.T, want string) {
	t.Helper()
	if got := s.call(t); got != want {
		t.Fatalf("the session's call %q, want %q", got, want)
	}
}

func (s *fakeSession) ID() string { return s.id }

// promptText is the text of a prompt's first text block.
func promptText(content []json.RawMessage) string {
	for _, b := range content {
		var t struct{ Type, Text string }
		if json.Unmarshal(b, &t) == nil && t.Type == "text" {
			return t.Text
		}
	}
	return ""
}

// Prompt follows the adapters' rule of a prompt's EventUser: it queues a
// prompt while its turn runs, and tells the EventUser of a prompt the host
// did not record (PromptParams.Recorded) that starts a turn.
func (s *fakeSession) Prompt(ctx context.Context, p chatadapter.PromptParams) error {
	s.mu.Lock()
	inTurn := s.turn
	s.turn = true
	s.prompts = append(s.prompts, p)
	s.mu.Unlock()
	s.record("prompt:" + promptText(p.Content))
	if err := s.a.promptErr; err != nil {
		s.mu.Lock()
		s.turn = inTurn
		s.mu.Unlock()
		return err
	}
	switch {
	case inTurn:
		s.sink.Event(chatproto.Event{T: chatproto.EventQueued, Message: p.Message, ClientID: p.ClientID, Content: p.Content,
			State: chatproto.QueuedWaiting})
	case !p.Recorded:
		s.sink.Event(chatproto.Event{T: chatproto.EventUser, Content: p.Content, ClientID: p.ClientID})
		fallthrough
	default:
		s.sink.Event(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnStart})
	}
	return nil
}

func (s *fakeSession) Cancel(ctx context.Context) error {
	s.record("cancel")
	s.endTurn("cancelled")
	return nil
}

func (s *fakeSession) CancelQueued(ctx context.Context, m string) error {
	s.record("cancel_queued:" + m)
	return nil
}

func (s *fakeSession) SetConfig(ctx context.Context, id, value string) error {
	s.record("set_config:" + id + "=" + value)
	s.a.mu.Lock()
	defer s.a.mu.Unlock()
	return s.a.setConfigErr
}

func (s *fakeSession) Compact(ctx context.Context) error {
	s.record("compact")
	return nil
}

func (s *fakeSession) Close(ctx context.Context) error {
	s.record("close")
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.a.mu.Lock()
	delay := s.a.closeDelay
	s.a.mu.Unlock()
	time.Sleep(delay)
	if s.cmd == nil {
		s.end(nil)
		return nil
	}
	s.stdin.Close()
	t := time.NewTimer(s.a.closeWait)
	defer t.Stop()
	select {
	case <-s.done:
		return nil
	case <-t.C:
	case <-ctx.Done():
	}
	syscall.Kill(-s.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *fakeSession) Done() <-chan struct{} { return s.done }

func (s *fakeSession) Err() error { return s.err }

// end ends the session with err.
func (s *fakeSession) end(err error) {
	s.once.Do(func() {
		s.err = err
		close(s.done)
	})
}

// crash ends the session as an agent that exited would.
func (s *fakeSession) crash() { s.end(errors.New("the agent exited (exit status 3)")) }

// endTurn ends the turn with a stop reason.
func (s *fakeSession) endTurn(reason string) {
	s.mu.Lock()
	s.turn = false
	s.mu.Unlock()
	s.sink.Event(chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd, StopReason: reason})
}

// say stores a message of the agent under an item.
func (s *fakeSession) say(item, text string) {
	s.sink.Event(chatproto.Event{T: chatproto.EventUpdate, Item: item, Update: agentChunk(text)})
}

// stream sends a live increment of an item.
func (s *fakeSession) stream(item, text string) {
	s.sink.Event(chatproto.Event{T: chatproto.EventUpdate, Item: item, Live: true, Update: agentChunk(text)})
}

func agentChunk(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": text}})
	return b
}

// permission asks a permission in the background; the answer comes on the
// channel.
func (s *fakeSession) permission(ctx context.Context, kind string) chan permResult {
	out := make(chan permResult, 1)
	go func() {
		a, err := s.sink.Permission(ctx, chatadapter.PermissionRequest{Kind: kind,
			ToolCall: json.RawMessage(`{"toolCallId":"t1","title":"run ls","kind":"execute"}`),
			Options: []chatproto.PermissionOption{
				{OptionID: chatadapter.OptionAllowOnce, Name: "Allow", Kind: chatproto.AllowOnce},
				{OptionID: chatadapter.OptionRejectOnce, Name: "Reject", Kind: chatproto.RejectOnce}}})
		out <- permResult{a, err}
	}()
	return out
}

type permResult struct {
	a   chatadapter.PermissionAnswer
	err error
}

// question asks a question in the background.
func (s *fakeSession) question(ctx context.Context) chan questionResult {
	out := make(chan questionResult, 1)
	go func() {
		a, err := s.sink.Question(ctx, chatadapter.QuestionRequest{Questions: []chatproto.Question{
			{ID: "color", Question: "Which color?", Options: []chatproto.QuestionOption{{Label: "red"}, {Label: "blue"}}},
			{Question: "Why?", AllowOther: true},
		}})
		out <- questionResult{a, err}
	}()
	return out
}

type questionResult struct {
	a   chatadapter.QuestionAnswer
	err error
}

// runTestHost is a chat host of its own process (roleHost): its run
// directory and its base in CHATHOST_RUN and CHATHOST_BASE, the fake
// adapter running processes, sessions telling their process unless
// CHATHOST_NO_PID is set, the terminal core's signals.
func runTestHost() {
	a := newFakeAdapter()
	a.proc, a.pid = true, os.Getenv("CHATHOST_NO_PID") == ""
	a.closeWait = time.Hour // only the host's signals end the agents
	if g := os.Getenv(grandchildVar); g != "" {
		a.procEnv = append(a.procEnv, grandchildVar+"="+g)
	}
	if os.Getenv(stubbornVar) != "" {
		a.procEnv = append(a.procEnv, stubbornVar+"=1")
	}
	exe, _ := os.Executable()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	err := Serve(context.Background(), Options{Base: os.Getenv("CHATHOST_BASE"), Run: os.Getenv("CHATHOST_RUN"),
		Logger: log.New(os.Stderr, "", log.Lmicroseconds), Signals: signals, closeGrace: time.Hour,
		environ:  func(context.Context) []string { return os.Environ() },
		kinds:    fakeSpecs(exe),
		adapters: func(name string) (chatadapter.Adapter, bool) { return a, name == fakeAdapterName },
	})
	if err != nil {
		os.Exit(1)
	}
}

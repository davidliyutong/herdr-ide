//go:build unix

package chat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chathost"
	"herdr-ide/internal/chatproto"
)

// patience is how long a test waits for something that must happen.
const patience = 15 * time.Second

// testExe is the program the terminal core is asked to run as the host.
const testExe = "/opt/agent/bin/agent"

func TestMain(m *testing.M) {
	executable = func() (string, error) { return testExe, nil }
	chatadapter.Register(agentkinds.AdapterACP, failing{})
	os.Exit(m.Run())
}

// failing is an adapter whose agents never start: a chat of its kinds is
// made, starts and fails, without an agent's program run.
type failing struct{}

func (failing) Start(context.Context, chatadapter.StartParams, chatadapter.Sink) (chatadapter.Session, error) {
	return nil, &chatproto.Error{Code: chatproto.CodeStartFailed, Message: "a test's agent"}
}

func (failing) Sessions(context.Context, chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	return nil, "", &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "a test's agent"}
}

func (failing) History(context.Context, chatadapter.HistoryParams, func(chatproto.Event)) error {
	return &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "a test's agent"}
}

// machine is a machine as the plugin sees it: a run directory with a path
// short enough for a socket, and a terminal core that runs chat hosts in the
// test's process.
type machine struct {
	t   *testing.T
	env *plugin.Env

	mu      sync.Mutex
	asked   [][]string         // the argv of each RunHidden
	names   []string           // and its name
	taken   int                // how often the name is still another terminal's
	fail    error              // RunHidden's error
	stop    context.CancelFunc // ends the host that runs
	stopped chan struct{}      // closed when it returned
}

func newMachine(t *testing.T) *machine {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "chp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	t.Setenv("HOME", dir)
	t.Setenv("SHELL", "/bin/sh")
	m := &machine{t: t}
	m.env = &plugin.Env{
		Home: dir, Base: filepath.Join(dir, "base"), RunDir: dir,
		Logger:    log.New(io.Discard, "", 0),
		RunHidden: m.runHidden,
	}
	t.Cleanup(m.stopHost)
	return m
}

func (m *machine) sock() string { return filepath.Join(m.env.RunDir, chatproto.SocketName) }

// runHidden is the terminal core: it runs a chat host of this build unless
// the name is taken, by a host that runs or by one that is still ending.
func (m *machine) runHidden(ctx context.Context, name string, argv []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.asked = append(m.asked, argv)
	m.names = append(m.names, name)
	switch {
	case m.fail != nil:
		return m.fail
	case m.taken > 0:
		m.taken--
		return nil
	case m.stop != nil:
		return nil
	}
	m.startLocked()
	return nil
}

// startLocked serves a chat host of this build on the run directory.
func (m *machine) startLocked() {
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	m.stop, m.stopped = cancel, stopped
	go func() {
		defer close(stopped)
		chathost.Serve(ctx, chathost.Options{Base: m.env.Base, Run: m.env.RunDir})
	}()
}

func (m *machine) stopHost() {
	m.mu.Lock()
	stop, stopped := m.stop, m.stopped
	m.stop = nil
	m.mu.Unlock()
	if stop == nil {
		return
	}
	stop()
	select {
	case <-stopped:
	case <-time.After(patience):
		m.t.Error("the chat host did not stop")
	}
}

func (m *machine) runs() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.asked)
}

// stream is the core's end of an open action.
type stream struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
	rep  agentproto.Reply
	done chan struct{} // closed when the action returned
}

// open runs the open action as the agent does, and reads its reply.
func (m *machine) open(ctx context.Context) *stream {
	m.t.Helper()
	return m.openWith(ctx, nil)
}

// openWith is open with the action's params.
func (m *machine) openWith(ctx context.Context, params json.RawMessage) *stream {
	m.t.Helper()
	agent, core := net.Pipe()
	m.t.Cleanup(func() { core.Close() })
	s := &stream{t: m.t, conn: core, done: make(chan struct{})}
	go func() {
		handle(ctx, agent, ActionOpen, params, m.env)
		close(s.done)
	}()
	core.SetDeadline(time.Now().Add(2 * patience))
	if err := agentproto.ReadLine(core, &s.rep); err != nil {
		m.t.Fatalf("reading the reply: %v", err)
	}
	s.r = bufio.NewReader(core)
	return s
}

// hello reads the host's first line through the stream.
func (s *stream) hello() chatproto.HostInfo {
	s.t.Helper()
	if !s.rep.OK {
		s.t.Fatalf("open: %+v", s.rep)
	}
	var h chatproto.Hello
	line, err := s.r.ReadString('\n')
	if err != nil || json.Unmarshal([]byte(line), &h) != nil {
		s.t.Fatalf("the host's hello: %q %v", line, err)
	}
	return h.Host
}

// ask sends a request and reads its answer.
func (s *stream) ask(op string) string {
	s.t.Helper()
	if _, err := fmt.Fprintf(s.conn, `{"op":%q}`+"\n", op); err != nil {
		s.t.Fatal(err)
	}
	line, err := s.r.ReadString('\n')
	if err != nil {
		s.t.Fatalf("the answer to %s: %v", op, err)
	}
	return strings.TrimSuffix(line, "\n")
}

// ok sends a request and checks that the answer is a success.
func (s *stream) ok(op string) {
	s.t.Helper()
	var res chatproto.Response
	if got := s.ask(op); json.Unmarshal([]byte(got), &res) != nil || !res.OK {
		s.t.Fatalf("the answer to %s: %s", op, got)
	}
}

func (s *stream) ended(what string) {
	s.t.Helper()
	select {
	case <-s.done:
	case <-time.After(patience):
		s.t.Fatalf("%s: the action did not end", what)
	}
}

// fakeHost is a chat host of another build on the socket: it says who it
// is, and answers a shutdown as a host with a busy chat or without.
type fakeHost struct {
	sock string
	ln   net.Listener
	info chatproto.HostInfo
	busy bool

	mu        sync.Mutex
	shutdowns int
}

func (m *machine) fakeHost(info chatproto.HostInfo, busy bool) *fakeHost {
	m.t.Helper()
	ln, err := net.Listen("unix", m.sock())
	if err != nil {
		m.t.Fatal(err)
	}
	f := &fakeHost{sock: m.sock(), ln: ln, info: info, busy: busy}
	m.t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeHost) serve(c net.Conn) {
	defer c.Close()
	line, _ := chatproto.Line(chatproto.Hello{Host: f.info})
	c.Write(line)
	var req chatproto.Request
	in, err := chatproto.ReadLine(bufio.NewReader(c))
	if err != nil || json.Unmarshal(in, &req) != nil {
		return
	}
	switch {
	case req.Op != chatproto.OpShutdown:
		io.WriteString(c, `{"ok":true,"from":"`+f.info.Version+`"}`+"\n")
	case f.isBusy():
		f.count()
		io.WriteString(c, `{"error":{"code":"busy","message":"a chat works"}}`+"\n")
	default:
		f.count()
		// The socket goes before the answer: the host that follows finds
		// the path free.
		f.ln.Close()
		os.Remove(f.sock)
		io.WriteString(c, `{"ok":true}`+"\n")
	}
}

func (f *fakeHost) isBusy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busy
}

func (f *fakeHost) setBusy(busy bool) {
	f.mu.Lock()
	f.busy = busy
	f.mu.Unlock()
}

func (f *fakeHost) count() {
	f.mu.Lock()
	f.shutdowns++
	f.mu.Unlock()
}

func (f *fakeHost) asked() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.shutdowns
}

// quick shortens the waits of a start.
func quick(t *testing.T, timeout, again time.Duration) {
	t.Helper()
	oldTimeout, oldPoll, oldAgain, oldMax := startTimeout, pollEvery, askAgain, askMax
	startTimeout, pollEvery, askAgain, askMax = timeout, 5*time.Millisecond, again, again
	t.Cleanup(func() { startTimeout, pollEvery, askAgain, askMax = oldTimeout, oldPoll, oldAgain, oldMax })
}

// Without a host, open has the terminal core run one under the chat host's
// name, the agent's own executable, and joins the stream to it: the host's
// hello first, then the bytes of both sides.
func TestOpenStartsTheHost(t *testing.T) {
	m := newMachine(t)
	s := m.open(context.Background())
	if h := s.hello(); h.Proto != chatproto.Proto || h.Version != agentproto.Version || h.PID != os.Getpid() {
		t.Fatalf("hello %+v", h)
	}
	s.ok(chatproto.OpChats)
	// The host ends the connection after its answer, and with it the stream.
	s.ended("the host closed the connection")
	if _, err := s.r.ReadByte(); err == nil {
		t.Error("the stream is still open")
	}
	want := []string{testExe, "chat-host", "--base", m.env.Base, "--run", m.env.RunDir}
	m.mu.Lock()
	if len(m.asked) != 1 || !reflect.DeepEqual(m.asked[0], want) || m.names[0] != agentproto.ChatHostName {
		t.Errorf("the terminal core was asked for %q %q, want once %q", m.names, m.asked, want)
	}
	m.mu.Unlock()
	if st, err := os.Stat(m.sock()); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("the socket: %v %v", st, err)
	}

	// The next one finds the host, and asks the terminal core for nothing.
	s = m.open(context.Background())
	s.hello()
	if got := s.ask("nonsense"); !strings.Contains(got, `"bad_request"`) {
		t.Errorf("answer %s", got)
	}
	s.ended("the host closed the connection")
	if m.runs() != 1 {
		t.Errorf("the terminal core was asked %d times", m.runs())
	}

	// The core closes its stream: the action ends, and the host's
	// connection with it.
	s = m.open(context.Background())
	s.hello()
	s.conn.Close()
	s.ended("the core closed the stream")
	// The agent stops: the action ends.
	ctx, cancel := context.WithCancel(context.Background())
	s = m.open(ctx)
	s.hello()
	cancel()
	s.ended("the agent stopped")
	if _, err := s.r.ReadByte(); err == nil {
		t.Error("the stream is still open after the agent stopped")
	}
}

// A watch carries the host's lines as they come, after its answer, for as
// long as both sides keep the stream.
func TestOpenCarriesAWatch(t *testing.T) {
	m := newMachine(t)
	w := m.open(context.Background())
	w.hello()
	w.ok(chatproto.OpWatch)
	// A chat made on another connection reaches the watch: it starts, and
	// fails (the test's adapter starts no agent).
	s := m.open(context.Background())
	s.hello()
	var res chatproto.Response
	if _, err := fmt.Fprintf(s.conn, `{"op":"new","kind":"kimi","cwd":%q}`+"\n", m.env.Home); err != nil {
		t.Fatal(err)
	}
	line, err := s.r.ReadString('\n')
	if err != nil || json.Unmarshal([]byte(line), &res) != nil || !res.OK || res.Chat == nil {
		t.Fatalf("new chat: %q %v", line, err)
	}
	s.ended("a one-shot request")
	var states []string
	for len(states) == 0 || states[len(states)-1] != chatproto.StateFailed {
		line, err := w.r.ReadString('\n')
		var st chatproto.ChatState
		if err != nil || json.Unmarshal([]byte(line), &st) != nil || st.ID != res.Chat.ID {
			t.Fatalf("the watch: %q %v (states %q)", line, err, states)
		}
		states = append(states, st.State)
	}
	if states[0] != chatproto.StateStarting {
		t.Errorf("states %q", states)
	}
	w.conn.Close()
	w.ended("the core closed the watch")
}

// open is the only action.
func TestUnknownAction(t *testing.T) {
	if plugin.Lookup(ID) == nil {
		t.Fatal("not registered")
	}
	agent, core := net.Pipe()
	defer core.Close()
	go handle(context.Background(), agent, "dial", nil, &plugin.Env{})
	core.SetDeadline(time.Now().Add(patience))
	var rep agentproto.Reply
	if err := agentproto.ReadLine(core, &rep); err != nil || rep.OK || rep.Code != "bad_params" {
		t.Fatalf("reply %+v %v", rep, err)
	}
}

// The chat host needs the terminal core: without one, and when the host
// does not start or does not serve in time, open says which.
func TestOpenFailures(t *testing.T) {
	quick(t, 200*time.Millisecond, time.Hour)
	m := newMachine(t)
	set := func(fail error, taken int) {
		m.mu.Lock()
		m.fail, m.taken = fail, taken
		m.mu.Unlock()
	}
	set(fmt.Errorf("%w: dial unix: no such file", plugin.ErrNoTerminalCore), 0)
	if s := m.open(context.Background()); s.rep.OK || s.rep.Code != CodeNoTerminalCore {
		t.Errorf("without a terminal core: %+v", s.rep)
	}
	set(errors.New("terminal core: run: spawn_failed"), 0)
	if s := m.open(context.Background()); s.rep.OK || s.rep.Code != CodeStartFailed {
		t.Errorf("a host that does not start: %+v", s.rep)
	}
	// The terminal core took the host, which never serves.
	set(nil, 1000)
	s := m.open(context.Background())
	if s.rep.OK || s.rep.Code != CodeStartFailed || strings.Contains(s.rep.Error, m.env.RunDir) {
		t.Errorf("a host that does not serve: %+v", s.rep)
	}
	s.ended("the failure")
	// Something that is no chat host on the socket is none.
	ln, err := net.Listen("unix", m.sock())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			io.WriteString(c, "SSH-2.0-other\n")
			c.Close()
		}
	}()
	if s := m.open(context.Background()); s.rep.OK || s.rep.Code != CodeStartFailed {
		t.Errorf("another program on the socket: %+v", s.rep)
	}
	// An agent without hidden terminals starts nothing.
	m.env.RunHidden = nil
	ln.Close()
	os.Remove(m.sock())
	if s := m.open(context.Background()); s.rep.OK || s.rep.Code != CodeStartFailed {
		t.Errorf("without RunHidden: %+v", s.rep)
	}
}

// The name of a host that is ending is still taken for a moment: the
// terminal core is asked again until it runs one.
func TestOpenAsksAgainWhileTheNameIsTaken(t *testing.T) {
	quick(t, patience, 20*time.Millisecond)
	m := newMachine(t)
	m.mu.Lock()
	m.taken = 2
	m.mu.Unlock()
	s := m.open(context.Background())
	if h := s.hello(); h.Version != agentproto.Version {
		t.Fatalf("hello %+v", h)
	}
	if m.runs() != 3 {
		t.Errorf("the terminal core was asked %d times, want 3", m.runs())
	}
}

// A host of another build makes way for one of this build when no chat
// works or waits.
func TestHandover(t *testing.T) {
	m := newMachine(t)
	old := m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto, Version: "older", PID: 4242}, false)
	s := m.open(context.Background())
	if h := s.hello(); h.Version != agentproto.Version || h.PID != os.Getpid() {
		t.Fatalf("hello %+v, want this build's host", h)
	}
	s.ok(chatproto.OpChats)
	if old.asked() != 1 || m.runs() != 1 {
		t.Errorf("the old host was asked to end %d times, the terminal core to run one %d times", old.asked(), m.runs())
	}
}

// One that is busy stays, and is used as it is while it speaks this
// agent's protocol.
func TestHandoverRefused(t *testing.T) {
	m := newMachine(t)
	old := m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto, Version: "older", PID: 4242}, true)
	s := m.open(context.Background())
	// The hello comes as the host wrote it.
	want, _ := chatproto.Line(chatproto.Hello{Host: old.info})
	if !s.rep.OK {
		t.Fatalf("open: %+v", s.rep)
	}
	if line, err := s.r.ReadString('\n'); err != nil || line != string(want) {
		t.Fatalf("hello %q %v, want %q", line, err, want)
	}
	if got := s.ask(chatproto.OpChats); got != `{"ok":true,"from":"older"}` {
		t.Errorf("the stream is not the old host's: %s", got)
	}
	if old.asked() != 1 || m.runs() != 0 {
		t.Errorf("the old host was asked to end %d times, the terminal core to run one %d times", old.asked(), m.runs())
	}
	// Each open asks again: once it makes way, this build's host follows.
	old.setBusy(false)
	s = m.open(context.Background())
	if h := s.hello(); h.Version != agentproto.Version {
		t.Fatalf("hello %+v, want this build's host", h)
	}
	if old.asked() != 2 || m.runs() != 1 {
		t.Errorf("the old host was asked to end %d times, the terminal core to run one %d times", old.asked(), m.runs())
	}
}

// A host of this build is not asked to end.
func TestSameBuildIsKept(t *testing.T) {
	m := newMachine(t)
	same := m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto, Version: agentproto.Version, PID: 4242}, false)
	s := m.open(context.Background())
	if h := s.hello(); h.PID != 4242 {
		t.Fatalf("hello %+v", h)
	}
	if same.asked() != 0 || m.runs() != 0 {
		t.Errorf("the host was asked to end %d times, the terminal core to run one %d times", same.asked(), m.runs())
	}
}

// A host of another protocol, newer or older, is upgrading while a busy
// chat keeps it; without one it makes way like any other build's.
func TestOtherProtocol(t *testing.T) {
	m := newMachine(t)
	for _, proto := range []int{chatproto.Proto + 1, chatproto.Proto - 1} {
		other := m.fakeHost(chatproto.HostInfo{Proto: proto, Version: "other", PID: 4242}, true)
		s := m.open(context.Background())
		if s.rep.OK || s.rep.Code != CodeUpgrading {
			t.Fatalf("a busy host of protocol %d: %+v", proto, s.rep)
		}
		s.ended("the refusal")
		if other.asked() != 1 || m.runs() != 0 {
			t.Errorf("protocol %d: the host was asked to end %d times, the terminal core to run one %d times", proto, other.asked(), m.runs())
		}
		other.ln.Close()
		os.Remove(m.sock())
	}

	m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto + 1, Version: "newer", PID: 4242}, false)
	s := m.open(context.Background())
	if h := s.hello(); h.Proto != chatproto.Proto || h.Version != agentproto.Version {
		t.Fatalf("hello %+v, want this build's host", h)
	}
}

// Streams opened at the same time while no host serves get the one host,
// which the terminal core is asked for once.
func TestOpenTogether(t *testing.T) {
	m := newMachine(t)
	const n = 8
	var wg sync.WaitGroup
	pids := make([]int, n)
	for i := range n {
		wg.Go(func() {
			agent, core := net.Pipe()
			defer core.Close()
			go handle(context.Background(), agent, ActionOpen, nil, m.env)
			core.SetDeadline(time.Now().Add(2 * patience))
			var rep agentproto.Reply
			var h chatproto.Hello
			if err := agentproto.ReadLine(core, &rep); err != nil || !rep.OK {
				t.Errorf("open %d: %+v %v", i, rep, err)
				return
			}
			if line, err := bufio.NewReader(core).ReadString('\n'); err != nil || json.Unmarshal([]byte(line), &h) != nil {
				t.Errorf("hello %d: %q %v", i, line, err)
				return
			}
			pids[i] = h.Host.PID
		})
	}
	wg.Wait()
	for i, pid := range pids {
		if pid != os.Getpid() {
			t.Errorf("stream %d reached the host of pid %d", i, pid)
		}
	}
	if m.runs() != 1 {
		t.Errorf("the terminal core was asked %d times", m.runs())
	}
}

// An open that is not to start a host takes the one that serves, of any
// build that speaks this agent's protocol, without asking it to make way,
// and starts none.
func TestOpenWithoutStart(t *testing.T) {
	m := newMachine(t)
	noStart := json.RawMessage(`{"start":false}`)
	s := m.openWith(context.Background(), noStart)
	if s.rep.OK || s.rep.Code != CodeNotRunning {
		t.Fatalf("without a host: %+v", s.rep)
	}
	s.ended("the refusal")
	if m.runs() != 0 {
		t.Fatalf("the terminal core was asked %d times", m.runs())
	}
	old := m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto, Version: "older", PID: 4242}, false)
	s = m.openWith(context.Background(), noStart)
	if h := s.hello(); h.PID != 4242 {
		t.Fatalf("hello %+v", h)
	}
	if got := s.ask(chatproto.OpWatch); got != `{"ok":true,"from":"older"}` {
		t.Errorf("the stream is not the old host's: %s", got)
	}
	if old.asked() != 0 || m.runs() != 0 {
		t.Errorf("the host was asked to end %d times, the terminal core to run one %d times", old.asked(), m.runs())
	}
	old.ln.Close()
	os.Remove(m.sock())
	other := m.fakeHost(chatproto.HostInfo{Proto: chatproto.Proto + 1, Version: "newer", PID: 4343}, false)
	if s := m.openWith(context.Background(), noStart); s.rep.OK || s.rep.Code != CodeUpgrading {
		t.Fatalf("a host of another protocol: %+v", s.rep)
	}
	if other.asked() != 0 {
		t.Errorf("the host was asked to end %d times", other.asked())
	}
	other.ln.Close()
	os.Remove(m.sock())
	// Start true is the default's.
	s = m.openWith(context.Background(), json.RawMessage(`{"start":true}`))
	if h := s.hello(); h.Version != agentproto.Version || m.runs() != 1 {
		t.Fatalf("hello %+v after %d runs", h, m.runs())
	}
	// Parameters that are none are refused.
	if s := m.openWith(context.Background(), json.RawMessage(`{"start":"no"}`)); s.rep.OK || s.rep.Code != "bad_params" {
		t.Fatalf("bad params: %+v", s.rep)
	}
}

//go:build unix && integration

package agent_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agent/agenttest"
	"veldr/internal/agentkinds"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/chatadapter"
	"veldr/internal/chathost"
	"veldr/internal/chatproto"
	"veldr/internal/hc"
	"veldr/internal/hostdirs"
)

// The test binary is also the chat host the terminal core runs: the chat
// plugin has the core run the agent's own executable with chat-host.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "chat-host" {
		os.Exit(itChatHost(os.Args[2:]))
	}
	os.Exit(m.Run())
}

// itChatHost is the chat-host command (cmd/veldr) with the test's
// adapter for the ACP kinds, logging to the data directory.
func itChatHost(args []string) int {
	fs := flag.NewFlagSet("chat-host", flag.ContinueOnError)
	base := fs.String("base", "", "")
	run := fs.String("run", "", "")
	if fs.Parse(args) != nil || *base == "" || *run == "" {
		return 2
	}
	os.MkdirAll(*base, 0o700)
	out, err := os.OpenFile(filepath.Join(*base, "it-chat-host.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 1
	}
	defer out.Close()
	logger := log.New(out, "chat-host: ", log.LstdFlags|log.Lmicroseconds)
	chatadapter.Register(agentkinds.AdapterACP, itAdapter{})
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	err = chathost.Serve(context.Background(), chathost.Options{Base: *base, Run: *run, Logger: logger, Signals: signals})
	logger.Printf("exit: %v", err)
	if err != nil {
		return 1
	}
	return 0
}

// itAdapter runs the agent's program in a process group of its own and
// speaks no protocol with it: its session is there while the program runs.
type itAdapter struct{}

func (itAdapter) Start(_ context.Context, p chatadapter.StartParams, _ chatadapter.Sink) (chatadapter.Session, error) {
	cmd := exec.Command(p.Argv[0], p.Argv[1:]...)
	cmd.Env, cmd.Dir = p.Env, p.Cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &itSession{cmd: cmd, in: in, done: make(chan struct{}), id: p.SessionID}
	go func() {
		s.err = cmd.Wait()
		close(s.done)
	}()
	return s, nil
}

func (itAdapter) Sessions(context.Context, chatadapter.SessionsParams) ([]chatproto.Session, string, error) {
	return nil, "", nil
}

func (itAdapter) History(context.Context, chatadapter.HistoryParams, func(chatproto.Event)) error {
	return nil
}

type itSession struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	id   string
	done chan struct{}
	err  error
	once sync.Once
}

var errIT = &chatproto.Error{Code: chatproto.CodeUnsupported, Message: "the integration test's agent"}

func (s *itSession) ID() string { return s.id }
func (s *itSession) PID() int   { return s.cmd.Process.Pid }
func (s *itSession) Prompt(context.Context, chatadapter.PromptParams) error {
	return errIT
}
func (s *itSession) Cancel(context.Context) error                    { return nil }
func (s *itSession) CancelQueued(context.Context, string) error      { return errIT }
func (s *itSession) SetConfig(context.Context, string, string) error { return errIT }
func (s *itSession) Compact(context.Context) error                   { return errIT }
func (s *itSession) Done() <-chan struct{}                           { return s.done }
func (s *itSession) Err() error                                      { return nil }
func (s *itSession) Close(ctx context.Context) error {
	s.once.Do(func() {
		s.in.Close()
		syscall.Kill(-s.cmd.Process.Pid, syscall.SIGTERM)
	})
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// fakeKimi is the program of the kind kimi: it says its pid and its
// child's, and waits.
const fakeKimi = `#!/bin/sh
echo $$ > agent.pid.tmp && mv agent.pid.tmp agent.pid
sleep 600 &
echo $! > child.pid.tmp && mv child.pid.tmp child.pid
wait
`

// sameDir reports whether two paths name one directory.
func sameDir(a, b string) bool {
	x, err1 := filepath.EvalSymlinks(a)
	y, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && x == y
}

// alive reports whether a process runs (a zombie does not).
func alive(pid int) bool {
	if pid <= 1 {
		return false
	}
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return false
	}
	if runtime.GOOS == "linux" {
		if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
			if i := strings.LastIndexByte(string(b), ')'); i > 0 && strings.HasPrefix(string(b[i+1:]), " Z") {
				return false
			}
		}
	}
	return true
}

// waitFile waits for a file the fake agent writes and returns its number.
func waitFile(t *testing.T, path string, within time.Duration) int {
	t.Helper()
	for deadline := time.Now().Add(within); ; time.Sleep(50 * time.Millisecond) {
		if b, err := os.ReadFile(path); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				return n
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s within %s", filepath.Base(path), within)
		}
	}
}

// hostRecords are the terminal core's records of the terminals named as
// the chat host, finished ones included.
func hostRecords(t *testing.T, ctx context.Context, socket string) []map[string]any {
	t.Helper()
	nc, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn, _, err := hc.Dial(ctx, nc)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var list struct {
		Terminals []map[string]any `json:"terminals"`
	}
	if err := conn.Call(ctx, "terminal.list", map[string]any{"all": true}, &list); err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, rec := range list.Terminals {
		if rec["name"] == agentproto.ChatHostName {
			out = append(out, rec)
		}
	}
	return out
}

// openChat opens the chat plugin's stream on the agent and reads the
// host's hello.
func openChat(t *testing.T, ctx context.Context, s *agenttest.Session) (net.Conn, *bufio.Reader, chatproto.HostInfo) {
	t.Helper()
	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpPlugin, Plugin: "chat", Action: "open"})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	r := bufio.NewReader(conn)
	line, err := chatproto.ReadLine(r)
	var hello chatproto.Hello
	if err != nil || json.Unmarshal(line, &hello) != nil {
		t.Fatalf("hello %q: %v", line, err)
	}
	return conn, r, hello.Host
}

func request(t *testing.T, conn net.Conn, r *bufio.Reader, req chatproto.Request) chatproto.Response {
	t.Helper()
	b, _ := chatproto.Line(req)
	if _, err := conn.Write(b); err != nil {
		t.Fatal(err)
	}
	line, err := chatproto.ReadLine(r)
	var res chatproto.Response
	if err != nil || json.Unmarshal(line, &res) != nil {
		t.Fatalf("%s: %q %v", req.Op, line, err)
	}
	return res
}

// TestIntegrationChatHost has the agent's terminal core, a real herdr-core
// in the integration tests' session, run the chat host as a hidden
// terminal: the first open starts it (the record carries the hidden label
// and the name, without a parent, not notifying, removed when it ends), a
// second open finds it, and the terminal core's stop ends the host and the
// agent it started, with the agent's child, and leaves no record.
func TestIntegrationChatHost(t *testing.T) {
	bin := os.Getenv("HC_TEST_BIN")
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("hc"); err != nil {
			t.Skip("herdr-core not installed (HC_TEST_BIN)")
		}
	}
	exe, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	// The host asks the login shell for the agents' environment: /bin/sh,
	// whose profile puts the fake agent on the PATH.
	t.Setenv("SHELL", "/bin/sh")
	s, home := hcAgent(t, "it")
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "kimi"), []byte(fakeKimi), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".profile"), []byte("PATH=\""+binDir+":$PATH\"; export PATH\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	rep, _ := installHC(t, s, string(exe), "")
	if !rep.OK {
		t.Fatalf("install: %+v", rep)
	}
	r, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"})
	if err != nil || !r.HC.Running {
		t.Fatalf("start: %+v %v", r, err)
	}
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			s.Request(context.Background(), agentproto.Header{Op: agentproto.OpHC, Action: "stop"})
		}
	})
	base := filepath.Join(home, brand.DataDir("it"))
	runDir := hostdirs.RunDir(base)
	defer func() {
		if t.Failed() {
			if b, err := os.ReadFile(filepath.Join(base, "it-chat-host.log")); err == nil {
				t.Logf("the host's log:\n%s", b)
			}
		}
	}()

	// The first open starts the host.
	conn, br, h1 := openChat(t, ctx, s)
	if h1.Proto != chatproto.Proto || h1.Version != agentproto.Version || h1.PID <= 1 || h1.PID == os.Getpid() {
		t.Fatalf("hello %+v", h1)
	}
	recs := hostRecords(t, ctx, r.HC.Socket)
	if len(recs) != 1 {
		t.Fatalf("records of the host: %v", recs)
	}
	rec := recs[0]
	labels, _ := rec["labels"].(map[string]any)
	cwd, _ := rec["cwd"].(string)
	if labels[agentproto.HiddenLabel] != agentproto.HiddenChatHost || rec["rm"] != true || rec["notify"] == true ||
		rec["parent"] != nil || rec["state"] != "live" || rec["pid"] != float64(h1.PID) || !sameDir(cwd, home) {
		t.Fatalf("the host's record: %v", rec)
	}
	argv, _ := rec["argv"].([]any)
	if len(argv) != 6 || argv[1] != "chat-host" || argv[3] != base || argv[5] != runDir {
		t.Fatalf("the host's argv: %v", argv)
	}
	t.Logf("the host runs as %s, pid %d", rec["address"], h1.PID)

	// A chat whose agent runs.
	res := request(t, conn, br, chatproto.Request{Op: chatproto.OpNew, Kind: "kimi", Cwd: home})
	conn.Close()
	if !res.OK || res.Chat == nil {
		t.Fatalf("new: %+v %v", res, res.Error)
	}
	chat := res.Chat.ID
	agentPID := waitFile(t, filepath.Join(home, "agent.pid"), time.Minute)
	childPID := waitFile(t, filepath.Join(home, "child.pid"), 10*time.Second)
	if !alive(agentPID) || !alive(childPID) {
		t.Fatalf("the agent (%d) or its child (%d) does not run", agentPID, childPID)
	}

	// The second open finds the host: the terminal core runs no other.
	conn, br, h2 := openChat(t, ctx, s)
	if h2.PID != h1.PID {
		t.Fatalf("the second open reached pid %d, not %d", h2.PID, h1.PID)
	}
	res = request(t, conn, br, chatproto.Request{Op: chatproto.OpChats})
	conn.Close()
	if !res.OK || len(res.Chats) != 1 || res.Chats[0].ID != chat || res.Chats[0].Kind != "kimi" {
		t.Fatalf("chats: %+v", res)
	}
	if recs := hostRecords(t, ctx, r.HC.Socket); len(recs) != 1 {
		t.Fatalf("records of the host after the second open: %v", recs)
	}

	// The terminal core stops: the host ends its agent, the agent's child
	// goes with its group, and the host's record is removed.
	if r, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "stop"}); err != nil || r.HC.Running {
		t.Fatalf("stop: %+v %v", r, err)
	}
	stopped = true
	for deadline := time.Now().Add(10 * time.Second); alive(h1.PID) || alive(agentPID) || alive(childPID); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("after the stop: host %d alive %v, agent %d alive %v, child %d alive %v",
				h1.PID, alive(h1.PID), agentPID, alive(agentPID), childPID, alive(childPID))
		}
	}
	if _, err := os.Lstat(filepath.Join(runDir, chatproto.SocketName)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the host's socket is left: %v", err)
	}

	// The terminal core starts again: no record holds the host's name, and
	// the next open starts a host of its own, at a new address (the
	// terminal core never gives an address twice), which the core's
	// clients keep hidden whatever they knew of the old one.
	r, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"})
	if err != nil || !r.HC.Running {
		t.Fatalf("start again: %+v %v", r, err)
	}
	stopped = false
	if recs := hostRecords(t, ctx, r.HC.Socket); len(recs) != 0 {
		t.Fatalf("records of the host after the core started again: %v", recs)
	}
	conn, br, h3 := openChat(t, ctx, s)
	res = request(t, conn, br, chatproto.Request{Op: chatproto.OpChats})
	conn.Close()
	if h3.PID == h1.PID || !res.OK {
		t.Fatalf("the open after the restart: hello %+v, chats %+v", h3, res)
	}
	recs = hostRecords(t, ctx, r.HC.Socket)
	if len(recs) != 1 || recs[0]["address"] == rec["address"] || recs[0]["pid"] != float64(h3.PID) || recs[0]["state"] != "live" {
		t.Fatalf("records of the host after the restart: %v (the first was %s)", recs, rec["address"])
	}
	labels, _ = recs[0]["labels"].(map[string]any)
	if labels[agentproto.HiddenLabel] != agentproto.HiddenChatHost {
		t.Fatalf("the new host's record: %v", recs[0])
	}
	t.Logf("after the restart the host runs as %s, pid %d", recs[0]["address"], h3.PID)
	if r, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "stop"}); err != nil || r.HC.Running {
		t.Fatalf("stop: %+v %v", r, err)
	}
	stopped = true
	for deadline := time.Now().Add(10 * time.Second); alive(h3.PID); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the second host %d outlived the stop", h3.PID)
		}
	}
	if b, err := os.ReadFile(filepath.Join(base, "it-chat-host.log")); err == nil {
		t.Logf("the host's log:\n%s", b)
	}
}

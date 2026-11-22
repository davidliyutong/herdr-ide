//go:build unix

package chathost

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/chatproto"
)

// subHost is a chat host of its own process (roleHost).
type subHost struct {
	t    *testing.T
	cmd  *exec.Cmd
	sock string
	cwd  string
	done chan error
	log  *syncBuffer
}

// startSubHost runs the test binary as a chat host with env added.
func startSubHost(t *testing.T, env ...string) *subHost {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	run := runDir(t)
	h := &subHost{t: t, sock: filepath.Join(run, chatproto.SocketName), cwd: t.TempDir(), done: make(chan error, 1), log: &syncBuffer{}}
	h.cmd = exec.Command(testExecutable(t))
	h.cmd.Env = append(append(os.Environ(), roleVar+"="+roleHost, "CHATHOST_RUN="+run,
		// The race detector waits a second at exit by default.
		"GORACE=atexit_sleep_ms=0", "CHATHOST_BASE="+filepath.Join(t.TempDir(), "base")), env...)
	h.cmd.Stderr = h.log
	// A group of its own, as the terminal core's program has.
	h.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := h.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { h.done <- h.cmd.Wait() }()
	t.Cleanup(func() {
		syscall.Kill(-h.cmd.Process.Pid, syscall.SIGKILL)
		h.cmd.Process.Kill()
		if t.Failed() {
			t.Logf("the host's log:\n%s", h.log)
		}
	})
	eventually(t, "the host's socket", func() bool {
		conn, err := net.Dial("unix", h.sock)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	})
	return h
}

// do sends a request and reads the answer.
func (h *subHost) do(req chatproto.Request) chatproto.Response {
	h.t.Helper()
	conn, err := net.Dial("unix", h.sock)
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(patience))
	r := bufio.NewReader(conn)
	chatproto.ReadLine(r) // the hello
	b, _ := chatproto.Line(req)
	conn.Write(b)
	line, err := chatproto.ReadLine(r)
	if err != nil {
		h.t.Fatal(err)
	}
	var res chatproto.Response
	json.Unmarshal(line, &res)
	return res
}

// agent makes a chat and returns its agent's process once it is idle.
func (h *subHost) agent() int {
	h.t.Helper()
	res := h.do(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd})
	if !res.OK {
		h.t.Fatalf("new: %+v", res.Error)
	}
	var pid int
	eventually(h.t, "the agent's process", func() bool {
		for _, c := range h.do(chatproto.Request{Op: chatproto.OpChats}).Chats {
			if c.ID == res.Chat.ID && c.State == chatproto.StateIdle {
				pid, _ = strconv.Atoi(strings.TrimPrefix(c.AgentVersion, "pid "))
				return pid > 0
			}
		}
		return false
	})
	return pid
}

// stop sends the terminal core's first signal and checks that the host and
// every agent process are gone soon.
func (h *subHost) stop(sig syscall.Signal, pids ...int) {
	h.t.Helper()
	start := time.Now()
	h.cmd.Process.Signal(sig)
	select {
	case err := <-h.done:
		if err != nil {
			h.t.Errorf("the host ended with %v", err)
		}
	case <-time.After(patience):
		h.t.Fatal("the host did not end")
	}
	// The terminal core kills the host a second after the first signal.
	if d := time.Since(start); d > time.Second {
		h.t.Errorf("the host took %s", d)
	}
	for _, pid := range pids {
		eventually(h.t, "process "+strconv.Itoa(pid)+" gone", func() bool { return !alive(pid) })
	}
	if _, err := os.Lstat(h.sock); !os.IsNotExist(err) {
		h.t.Errorf("the socket is left: %v", err)
	}
}

// On the terminal core's SIGHUP every agent's process group is ended, the
// processes the agents started with it.
func TestSignalEndsAgentGroups(t *testing.T) {
	grandchild := filepath.Join(t.TempDir(), "grandchild")
	h := startSubHost(t, grandchildVar+"="+grandchild)
	a := h.agent()
	g := pidIn(t, grandchild)
	b := h.agent()
	h.stop(syscall.SIGHUP, a, b, g)
}

// Without sessions that tell their process, the host's children are found
// and ended all the same.
func TestSignalEndsChildren(t *testing.T) {
	h := startSubHost(t, "CHATHOST_NO_PID=1")
	a, b := h.agent(), h.agent()
	h.stop(syscall.SIGTERM, a, b)
}

// An agent that ignores SIGTERM is killed killAfter later.
func TestSignalKillsStubbornAgents(t *testing.T) {
	grandchild := filepath.Join(t.TempDir(), "grandchild")
	h := startSubHost(t, stubbornVar+"=1", grandchildVar+"="+grandchild)
	a := h.agent()
	g := pidIn(t, grandchild)
	h.stop(syscall.SIGHUP, a, g)
}

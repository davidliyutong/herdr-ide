//go:build unix

package agent

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"herdr-ide/internal/agentproto"
)

// startTestNode runs the node of a temporary home in this process.
// done closes when RunNode returned, which it did without an error.
func startTestNode(t *testing.T) (sock string, done <-chan struct{}) {
	t.Helper()
	// Short: macOS limits socket paths to 104 bytes.
	home, err := os.MkdirTemp("/tmp", "hnd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	sock = nodeSocket(filepath.Join(home, ".herdr-ide", "run"))
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan struct{})
	go func() {
		defer close(ch)
		if err := RunNode(ctx, Options{Logger: log.New(io.Discard, "", 0)}, false); err != nil {
			t.Errorf("node: %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-ch:
		case <-time.After(10 * time.Second):
			t.Error("the node did not stop")
		}
	})
	for i := 0; ; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		if i > 200 {
			t.Fatal("the node does not listen")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return sock, ch
}

// hello opens a session through the node and returns its hello reply.
func helloThrough(t *testing.T, sock, sshConn string) (*agentproto.Reply, *yamux.Session) {
	t.Helper()
	c, node, err := dialNodeSocket(sock, agentproto.NodeHello{Op: agentproto.NodeServe, SSHConnection: sshConn})
	if err != nil {
		t.Fatal(err)
	}
	if me, _ := selfInfo(); node == nil || node.Build != me.Build {
		t.Fatalf("node %+v", node)
	}
	ys, err := yamux.Client(c, agentproto.YamuxConfig(log.New(io.Discard, "", 0)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ys.Close() })
	st, err := ys.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	_ = st.SetDeadline(time.Now().Add(10 * time.Second))
	if err := agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpHello}); err != nil {
		t.Fatal(err)
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil {
		t.Fatal(err)
	}
	return &rep, ys
}

// A node serves several clients at once, each its own agent session with
// the ssh session its client came through, on a private socket.
func TestNodeServesClients(t *testing.T) {
	sock, _ := startTestNode(t)
	st, err := os.Stat(sock)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket: %v %v", st.Mode(), err)
	}
	a, _ := helloThrough(t, sock, "10.0.0.2 51000 10.0.0.9 22")
	b, _ := helloThrough(t, sock, "")
	if !a.OK || a.SSH != "10.0.0.2 51000 10.0.0.9 22" || !b.OK || b.SSH != "" {
		t.Fatalf("replies: %+v %+v", a, b)
	}
}

// A second node leaves the instance to the one that serves.
func TestNodeOnePerInstance(t *testing.T) {
	sock, _ := startTestNode(t)
	if err := RunNode(context.Background(), Options{Logger: log.New(io.Discard, "", 0)}, false); err != nil {
		t.Fatal(err)
	}
	if rep, _ := helloThrough(t, sock, ""); !rep.OK {
		t.Fatalf("hello: %+v", rep)
	}
}

// A node ends once it has had no client for NodeIdle, not while one is
// connected; StopNodes ends it at once.
func TestNodeIdleAndStop(t *testing.T) {
	old := NodeIdle
	NodeIdle = 300 * time.Millisecond
	t.Cleanup(func() { NodeIdle = old })
	sock, done := startTestNode(t)
	_, ys := helloThrough(t, sock, "")
	select {
	case <-done:
		t.Fatal("the node stopped with a client")
	case <-time.After(time.Second):
	}
	ys.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the idle node did not stop")
	}
	if _, err := os.Stat(sock); !os.IsNotExist(err) {
		t.Fatalf("socket left: %v", err)
	}

	NodeIdle = time.Hour
	_, done = startTestNode(t)
	if n, err := StopNodes(""); err != nil || n != 1 {
		t.Fatalf("stopped %d: %v", n, err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the node did not stop when asked")
	}
}

// A node whose executable is removed gives its socket and lock to a node
// of the same build started from another file, and serves its clients on.
func TestNodeRetiresWhenItsExecutableIsGone(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "exe")
	if err := os.WriteFile(exe, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	oldExe, oldCheck := nodeExecutable, nodeExeCheck
	nodeExecutable = func() (string, error) { return exe, nil }
	nodeExeCheck = 20 * time.Millisecond
	t.Cleanup(func() { nodeExecutable, nodeExeCheck = oldExe, oldCheck })
	sock, done := startTestNode(t)
	_, ys := helloThrough(t, sock, "")
	if err := os.Remove(exe); err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		if _, err := os.Stat(sock); os.IsNotExist(err) {
			break
		}
		if i > 200 {
			t.Fatal("the node kept its socket")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := net.Dial("unix", sock); err == nil {
		t.Fatal("the retired node took a client")
	}
	select {
	case <-done:
		t.Fatal("the retired node left its client")
	default:
	}
	if _, err := ys.Ping(); err != nil {
		t.Fatalf("client: %v", err)
	}
	// Another node of the build takes the instance.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	next := make(chan error, 1)
	go func() { next <- RunNode(ctx, Options{Logger: log.New(io.Discard, "", 0)}, false) }()
	for i := 0; ; i++ {
		if c, err := net.Dial("unix", sock); err == nil {
			c.Close()
			break
		}
		if i > 200 {
			t.Fatal("no node took the instance")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-next
}

// A node taking over gets the socket at once: the old node tells its
// sessions' cores to move (OpNodeDrain), serves them until they left and
// ends then; new clients reach the new node.
func TestNodeTakeover(t *testing.T) {
	sock, oldDone := startTestNode(t)
	_, ys := helloThrough(t, sock, "")
	drained := make(chan struct{})
	go func() {
		st, err := ys.AcceptStream()
		if err != nil {
			return
		}
		var h agentproto.Header
		if agentproto.ReadLine(st, &h) == nil && h.Op == agentproto.OpNodeDrain {
			agentproto.WriteLine(st, agentproto.Reply{OK: true})
			close(drained)
		}
		st.Close()
	}()
	ctx, cancel := context.WithCancel(context.Background())
	next := make(chan struct{})
	go func() {
		defer close(next)
		if err := RunNode(ctx, Options{Logger: log.New(io.Discard, "", 0)}, true); err != nil {
			t.Errorf("new node: %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		<-next
	})
	select {
	case <-drained:
	case <-time.After(10 * time.Second):
		t.Fatal("the old node's session was not told to move")
	}
	// The old session still works until its core leaves.
	if _, err := ys.Ping(); err != nil {
		t.Fatalf("old session: %v", err)
	}
	for i := 0; ; i++ {
		if rep, _ := helloThrough(t, sock, ""); rep.OK {
			break
		}
		if i > 100 {
			t.Fatal("no node answers")
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case <-oldDone:
		t.Fatal("the old node left a session that had not moved")
	default:
	}
	ys.Close()
	select {
	case <-oldDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the drained node did not end")
	}
	if _, err := os.Stat(sock); err != nil {
		t.Fatalf("the new node's socket: %v", err)
	}
}

// A build is newer by its version when both are known, else by when its
// executable was written.
func TestNodeBuildOrder(t *testing.T) {
	a := agentproto.NodeInfo{Build: "a", Version: "v1.2.0", ExeTime: 2}
	b := agentproto.NodeInfo{Build: "b", Version: "v1.3.0", ExeTime: 1}
	dev1 := agentproto.NodeInfo{Build: "c", Version: "dev", ExeTime: 1}
	dev2 := agentproto.NodeInfo{Build: "d", Version: "dev", ExeTime: 2}
	if !b.Newer(a) || a.Newer(b) || !dev2.Newer(dev1) || dev1.Newer(dev2) || a.Newer(a) {
		t.Fatal("order")
	}
}

package agent

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/jezek/xgb/res"
)

// TestHelperHerdrServer is not a test of its own: started by the keeper's
// tests, it stands in for a herdr server listening on a socket.
func TestHelperHerdrServer(t *testing.T) {
	socket := os.Getenv("GUI_TEST_HERDR_SOCKET")
	if socket == "" {
		t.Skip("helper")
	}
	os.Remove(socket)
	l, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(1)
	}
	for {
		c, err := l.Accept()
		if err != nil {
			os.Exit(1)
		}
		c.Close()
	}
}

// fakeServer starts a stand-in herdr server on socket and waits until it
// listens.
func fakeServer(t *testing.T, socket string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperHerdrServer$")
	cmd.Env = append(os.Environ(), "GUI_TEST_HERDR_SOCKET="+socket)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	for i := 0; findServer(socket).pid != cmd.Process.Pid; i++ {
		if i > 200 {
			t.Fatal("stand-in server did not listen")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cmd
}

func stopServer(cmd *exec.Cmd) {
	cmd.Process.Kill()
	cmd.Wait()
}

// The watch lasts while a server runs, follows one that restarts within
// the grace period, and ends after the grace period without one.
func TestWatchServer(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	socket := filepath.Join(t.TempDir(), "herdr.sock")
	srv := fakeServer(t, socket)
	done := make(chan error, 1)
	go func() { done <- watchServer(context.Background(), socket, 20*time.Millisecond, 500*time.Millisecond) }()
	select {
	case err := <-done:
		t.Fatalf("ended while the server runs: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	stopServer(srv)
	srv = fakeServer(t, socket) // restarted
	select {
	case err := <-done:
		t.Fatalf("ended although the server restarted: %v", err)
	case <-time.After(800 * time.Millisecond):
	}
	stopServer(srv)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the watch outlived the server")
	}
	// Nothing listening from the start: over after the grace period.
	start := time.Now()
	if err := watchServer(context.Background(), socket, 20*time.Millisecond, 100*time.Millisecond); err != nil || time.Since(start) > time.Second {
		t.Fatalf("no server: %v after %v", err, time.Since(start))
	}
}

// The keeper is a client of the display while the server runs; a second
// keeper of the instance leaves at once.
func TestKeeperHoldsDisplay(t *testing.T) {
	g := guiTestXvfb(t)
	n, _ := g.display()
	socket := g.a.herdrSocket("keep")
	os.MkdirAll(filepath.Dir(socket), 0o700)
	srv := fakeServer(t, socket)

	x, err := g.connect(n)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	if err := res.Init(x); err != nil {
		t.Skip("no X-Resource extension")
	}
	clients := func() int {
		r, err := res.QueryClients(x).Reply()
		if err != nil {
			t.Fatal(err)
		}
		return int(r.NumClients)
	}
	before := clients()
	done := make(chan error, 1)
	go func() { done <- g.keepDisplay(context.Background(), "keep", 20*time.Millisecond, 200*time.Millisecond) }()
	for i := 0; clients() != before+1; i++ {
		if i > 200 {
			t.Fatalf("keeper did not connect: %d clients, %d before", clients(), before)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := g.keepDisplay(context.Background(), "keep", time.Hour, time.Hour); err != nil {
		t.Fatalf("second keeper: %v", err)
	}
	stopServer(srv)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the keeper outlived the server")
	}
	for i := 0; clients() != before; i++ {
		if i > 200 {
			t.Fatalf("keeper still connected: %d clients", clients())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

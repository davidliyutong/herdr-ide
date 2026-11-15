package transport

import (
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"herdr-ide/internal/agentproto"
)

// pair connects a core session to a bare yamux server standing in for the
// agent.
func pair(t *testing.T, lost func()) (*Session, *yamux.Session, net.Conn) {
	t.Helper()
	c1, c2 := net.Pipe()
	logger := log.New(io.Discard, "", 0)
	s, err := newSession(c1, nil, logger, lost)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := yamux.Server(c2, agentproto.YamuxConfig(logger))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.Close()
		srv.Close()
	})
	return s, srv, c2
}

func TestLostRunsOnlyWhenTheSessionEndsByItself(t *testing.T) {
	lost := make(chan struct{}, 1)
	s, _, _ := pair(t, func() { lost <- struct{}{} })
	s.Close()
	<-s.Done()
	select {
	case <-lost:
		t.Fatal("lost ran after Close")
	case <-time.After(100 * time.Millisecond):
	}

	s, _, peer := pair(t, func() { lost <- struct{}{} })
	peer.Close()
	select {
	case <-lost:
	case <-time.After(5 * time.Second):
		t.Fatal("lost did not run when the connection failed")
	}
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end")
	}
}

// The control master is told to take no new sessions (not to exit, which
// would end every session through it), with this core's control path.
func TestStopMasterArgs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ssh on Windows has no control master; the stand-in for ssh is a shell script")
	}
	bin := t.TempDir()
	out := filepath.Join(t.TempDir(), "args")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > " + out + "\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	SSHOptions{Target: "user@gpu", ControlDir: "/tmp/ctl", Logger: log.New(io.Discard, "", 0)}.stopMaster()
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if want := "-o\nControlPath=/tmp/ctl/%C\n-O\nstop\n--\nuser@gpu\n"; string(got) != want {
		t.Fatalf("ssh args %q, want %q", got, want)
	}
}

// The master is stopped only when ssh keeps running after the session
// ended by itself.
func TestStopMasterOnlyWhenSSHStaysUp(t *testing.T) {
	var stops atomic.Int32
	exited := make(chan struct{})
	close(exited)
	stopMasterIfStuck(exited, 50*time.Millisecond, func() { stops.Add(1) })()
	if stops.Load() != 0 {
		t.Fatal("stopped the master although ssh exited")
	}
	stopMasterIfStuck(make(chan struct{}), 10*time.Millisecond, func() { stops.Add(1) })()
	if stops.Load() != 1 {
		t.Fatal("did not stop the master of an ssh that kept running")
	}
}

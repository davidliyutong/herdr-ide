//go:build unix

package main

import (
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agentkinds"
	"veldr/internal/chatadapter"
	"veldr/internal/chathost"
	"veldr/internal/chatproto"
	"veldr/internal/store"
)

// The chat-host command serves the run directory's socket until a signal
// of the terminal core ends it.
func TestChatHostCommand(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, args := range [][]string{nil, {"--base", t.TempDir()}, {"--run", t.TempDir()}, {"--base", "/b", "--run", "/r", "more"}, {"--nope"}} {
		if got := chatHost(args); got != 2 {
			t.Errorf("%q: exit status %d, want 2", args, got)
		}
	}

	// A path short enough for a socket.
	dir, err := os.MkdirTemp("/tmp", "chc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	base := filepath.Join(dir, "base")
	status := make(chan int, 1)
	go func() { status <- chatHost([]string{"--base", base, "--run", dir}) }()
	sock := filepath.Join(dir, chatproto.SocketName)
	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := net.Dial("unix", sock)
		if err == nil {
			conn.Close()
			break
		}
		select {
		case got := <-status:
			t.Fatalf("the command ended with status %d", got)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("no socket: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A second one finds the first.
	if got := chatHost([]string{"--base", base, "--run", dir}); got != 1 {
		t.Errorf("a second host: exit status %d, want 1", got)
	}
	if _, err := os.Stat(store.HostFile(base, chathost.DBName)); err != nil {
		t.Errorf("no journal: %v", err)
	}
	// It logs to its file in the data directory too, the user's alone.
	logFile := store.HostFile(base, chathost.LogName)
	for {
		// The socket listens before the host says it serves.
		b, err := os.ReadFile(logFile)
		if err == nil && strings.Contains(string(b), " serving "+sock) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the log file %s: %q, %v", logFile, b, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st, err := os.Stat(logFile); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("the log file's mode: %v", err)
	}
	// The terminal core's stop starts with SIGHUP.
	syscall.Kill(os.Getpid(), syscall.SIGHUP)
	select {
	case got := <-status:
		if got != 0 {
			t.Errorf("exit status %d after SIGHUP", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the command did not end with SIGHUP")
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Errorf("the socket is still there: %v", err)
	}
}

// The chat host of this binary has an adapter for each protocol of the
// agent kinds' chats.
func TestChatHostAdapters(t *testing.T) {
	if got := chatadapter.Names(); !slices.Equal(got, []string{"acp", "claude", "codex"}) {
		t.Errorf("adapters %v", got)
	}
	for _, name := range agentkinds.Adapters {
		if _, ok := chatadapter.Lookup(name); !ok {
			t.Errorf("no adapter %s", name)
		}
	}
}

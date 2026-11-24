//go:build unix

package vaultmcp

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agentproto"
)

// runCall is a run_with_env call of command in dir with the variable V.
func runCall(id int, command, dir string) []byte {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "tools/call",
		"params": map[string]any{"name": "run_with_env", "arguments": map[string]any{"command": command, "names": []string{"V"}, "cwd": dir}},
	})
	return append(b, '\n')
}

// pidsIn waits for the files names in dir to hold a process id each.
func pidsIn(t *testing.T, dir string, names ...string) []int {
	t.Helper()
	var pids []int
	for deadline := time.Now().Add(10 * time.Second); len(pids) < len(names); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("no process ids in %s", dir)
		}
		pids = pids[:0]
		for _, n := range names {
			b, _ := os.ReadFile(filepath.Join(dir, n))
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && strings.HasSuffix(string(b), "\n") {
				pids = append(pids, pid)
			}
		}
		if len(pids) < len(names) {
			pids = nil
		}
	}
	return pids
}

// gone waits for the processes to end (a killed one is a zombie until
// reaped); those still running are killed and reported.
func gone(t *testing.T, pids ...int) {
	t.Helper()
	for _, pid := range pids {
		ended := false
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			if err := syscall.Kill(pid, 0); err != nil || zombie(pid) {
				ended = true
				break
			}
		}
		if !ended {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Errorf("process %d outlived the server", pid)
		}
	}
}

// A server ended by a signal kills the commands it runs, and the programs
// they left in the background: SIGTERM (as SIGINT and SIGHUP) ends it in
// order, and SIGKILL, which it cannot see, ends them through the watcher
// in their group.
func TestSignalEndsCommands(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGHUP, syscall.SIGKILL} {
		t.Run(sig.String(), func(t *testing.T) {
			dir := t.TempDir()
			srv := exec.Command(os.Args[0])
			srv.Env = append(os.Environ(), helperEnv+"=1")
			in, err := srv.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := srv.Start(); err != nil {
				t.Fatal(err)
			}
			defer srv.Process.Kill()
			in.Write(runCall(1, "sleep 300 & echo $! > bg; echo $$ > sh; wait", dir))
			pids := pidsIn(t, dir, "bg", "sh")
			srv.Process.Signal(sig)
			exited := make(chan error, 1)
			go func() { exited <- srv.Wait() }()
			select {
			case err := <-exited:
				// A signal it handles ends it in order, once its
				// commands are killed.
				if sig != syscall.SIGKILL && err != nil {
					t.Errorf("the server ended with %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("the server did not end")
			}
			gone(t, pids...)
		})
	}
}

// A call the client cancels (notifications/cancelled) ends: its command
// is killed, with what it left in the background, and it gets no
// response.
func TestCancelledCommandIsKilled(t *testing.T) {
	core := fakeCore(t, func(req agentproto.VaultRequest) agentproto.VaultResponse {
		return agentproto.VaultResponse{OK: true, Values: map[string]string{"V": "secret"}}
	}, nil)
	c, done := startServer(t, &Server{Dial: core})
	defer func() {
		c.in.Close()
		<-done
	}()
	dir := t.TempDir()
	c.in.Write(runCall(41, "sleep 300 & echo $! > bg; echo $$ > sh; wait", dir))
	pids := pidsIn(t, dir, "bg", "sh")
	c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 41, "reason": "the user pressed Esc"}})
	gone(t, pids...)
	// The next line answers the ping: the cancelled call has none.
	if r := c.call("ping", nil); r["result"] == nil {
		t.Errorf("ping %v", r)
	}
}

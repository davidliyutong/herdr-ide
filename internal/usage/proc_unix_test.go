//go:build unix

package usage

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeAgy writes a script that leaves `sleep 300` behind and records its
// pid; it prints JSON and exits (wait: false) or waits for the sleep.
func fakeAgy(t *testing.T, wait bool) (bin, pidFile string) {
	dir := t.TempDir()
	bin, pidFile = filepath.Join(dir, "agy"), filepath.Join(dir, "sleep.pid")
	script := "#!/bin/sh\nsleep 300 >/dev/null 2>&1 &\necho $! > " + pidFile + "\n"
	if wait {
		script += "wait\n"
	} else {
		script += "echo '{\"models\":[{\"model\":\"m\",\"remainingFraction\":0.5}]}'\n"
	}
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return bin, pidFile
}

// gone waits until the process recorded in pidFile no longer exists.
func gone(t *testing.T, pidFile string) {
	t.Helper()
	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(pidFile)
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			pid = n
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("no pid recorded")
	}
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	syscall.Kill(pid, syscall.SIGKILL)
	t.Errorf("process %d outlived agy", pid)
}

func TestAgyGroupKilledAfterExit(t *testing.T) {
	bin, pidFile := fakeAgy(t, false)
	e := testEnv(t, nil)
	e.Command = runCommand
	e.LookPath = func(string) (string, error) { return bin, nil }
	a, ok := agyUsage(context.Background(), e)
	if !ok || a.Status != StatusOK || len(a.Windows) != 1 {
		t.Fatalf("account %+v", a)
	}
	gone(t, pidFile)
}

func TestAgyGroupKilledOnCancel(t *testing.T) {
	bin, pidFile := fakeAgy(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := runCommand(ctx, nil, bin); err == nil {
		t.Error("no error from a cancelled command")
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Errorf("took %v", d)
	}
	gone(t, pidFile)
}

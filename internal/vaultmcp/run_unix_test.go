//go:build unix

package vaultmcp

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Programs a command leaves in the background, with the values in their
// environment, do not outlive the call: the process group is killed when
// the command returns, also while they hold the output's pipe.
func TestRunKillsBackgroundPrograms(t *testing.T) {
	for _, command := range []string{"sleep 30 >/dev/null 2>&1 & echo $!", "sleep 30 & echo $!"} {
		out, failed := Runner{}.Run(context.Background(), command, map[string]string{"V": "secret"}, "", 0)
		if failed {
			t.Errorf("%s: failed %q", command, out)
		}
		lines := strings.Split(strings.TrimSpace(out), "\n")
		pid, err := strconv.Atoi(lines[len(lines)-1])
		if err != nil {
			t.Fatalf("%s: %q", command, out)
		}
		gone := false
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			// A killed child is reaped by init; until then it is a zombie
			// and Kill(pid, 0) still succeeds.
			if err := syscall.Kill(pid, 0); err != nil || zombie(pid) {
				gone = true
				break
			}
		}
		if !gone {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Errorf("%s: background program %d still runs", command, pid)
		}
	}
}

// zombie reports whether pid has exited and waits to be reaped.
func zombie(pid int) bool {
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

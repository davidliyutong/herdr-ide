//go:build unix

package sessions

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"
)

func TestProcfs(t *testing.T) {
	boot := time.Date(2026, 11, 20, 8, 0, 0, 0, time.Local)
	fs := newProcfs(t, boot)
	start := boot.Add(49*time.Hour + 1230*time.Millisecond)
	// A command name with parentheses, spaces and digits in it.
	fs.add(42, 7, 40, ") 9 9 (x y", start, []string{"A=1", "CLAUDE_CONFIG_DIR=/c=d", "CODEX_HOME=", "junk"}, map[string]string{"3": "/a/b", "4": "relative"})
	fs.add(43, 42, 40, "sh", start, nil, nil)
	os.MkdirAll(filepath.Join(fs.root, "self"), 0o700)
	os.WriteFile(filepath.Join(fs.root, "44"), []byte("not a process"), 0o600)

	ppid, pgid, ticks, ok := procfsStat(fs.root, 42)
	if !ok || ppid != 7 || pgid != 40 || ticks != uint64(49*3600*clockTicks+123) {
		t.Errorf("procfsStat = %d %d %d %v", ppid, pgid, ticks, ok)
	}
	if got, ok := procfsStart(fs.root, 42); !ok || !got.Equal(start) {
		t.Errorf("procfsStart = %v %v, want %v", got, ok, start)
	}
	if _, ok := procfsStart(fs.root, 99); ok {
		t.Error("start of a missing process")
	}
	table, err := procfsTable(fs.root)
	slices.SortFunc(table, func(a, b procEntry) int { return a.PID - b.PID })
	if err != nil || len(table) != 2 || table[0] != (procEntry{42, 7, 40}) || table[1] != (procEntry{43, 42, 40}) {
		t.Errorf("procfsTable = %v %v", table, err)
	}
	env, ok := procfsEnviron(fs.root, 42)
	if !ok || len(env) != 2 || env["CLAUDE_CONFIG_DIR"] != "/c=d" || env["CODEX_HOME"] != "" {
		t.Errorf("procfsEnviron = %v %v", env, ok)
	}
	if _, ok := procfsEnviron(fs.root, 43); ok {
		t.Error("environment of a process without one")
	}
	if got := procfsFDs(fs.root, 42); len(got) != 1 || got[0] != "/a/b" {
		t.Errorf("procfsFDs = %v", got)
	}
	r := &Resolver{procRoot: fs.root}
	if got := r.candidates(42); len(got) != 2 || got[1] != 43 {
		t.Errorf("candidates = %v", got)
	}

	// A stat without btime, a stat line cut short.
	os.WriteFile(filepath.Join(fs.root, "stat"), []byte("cpu 1 2\n"), 0o600)
	if _, ok := procfsStart(fs.root, 42); ok {
		t.Error("start without a boot time")
	}
	os.WriteFile(filepath.Join(fs.root, "43", "stat"), []byte("43 (sh) S 42 40"), 0o600)
	if _, _, _, ok := procfsStat(fs.root, 43); ok {
		t.Error("a short stat line")
	}
}

// TestOwnProcess reads the test's own process from the system (sysctl on
// macOS, /proc on Linux).
func TestOwnProcess(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("no process table here")
	}
	var r Resolver
	pid := os.Getpid()
	start, ok := r.startOf(pid)
	// /proc's boot time is in whole seconds: a start a little after now is
	// a rounding, not an error.
	if !ok || start.After(time.Now().Add(2*time.Second)) || time.Since(start) > time.Hour {
		t.Errorf("start of the test process = %v %v", start, ok)
	}
	table, err := r.procTable(pid)
	if err != nil || !slices.ContainsFunc(table, func(e procEntry) bool { return e.PID == pid && e.PPID == os.Getppid() }) {
		t.Errorf("the table has no test process: %v", err)
	}
	if got := r.candidates(pid); len(got) == 0 || got[0] != pid {
		t.Errorf("candidates = %v", got)
	}
	if _, ok := r.startOf(1 << 30); ok {
		t.Error("start of a missing process")
	}
}

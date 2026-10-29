package agent

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func testAgent(t *testing.T) *Agent {
	home := t.TempDir()
	base := filepath.Join(home, ".x")
	run := filepath.Join(base, "run")
	os.MkdirAll(run, 0o700)
	return &Agent{logger: log.New(io.Discard, "", 0), home: home, base: base, runDir: run, herdrCache: map[string]string{}}
}

// A code-server whose owning agent died is stopped by the next agent.
func TestReapOrphanedCodeServer(t *testing.T) {
	a := testAgent(t)
	proc := exec.Command("sleep", "60")
	proc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	defer proc.Process.Kill()
	done := make(chan struct{})
	go func() { proc.Wait(); close(done) }()
	b, _ := json.Marshal(csPid{Pid: proc.Process.Pid, Owner: 999999999})
	os.WriteFile(filepath.Join(a.runDir, "cs.pid"), b, 0o600)

	newCodeServer(a) // reaps on construction
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("orphaned process still running")
	}
	if _, err := os.Stat(filepath.Join(a.runDir, "cs.pid")); !os.IsNotExist(err) {
		t.Fatal("pid file left behind")
	}
}

// A code-server owned by another live agent is left alone on exit.
func TestStopAllOnlyOwnProcess(t *testing.T) {
	a := testAgent(t)
	proc := exec.Command("sleep", "60")
	proc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	defer proc.Process.Kill()
	b, _ := json.Marshal(csPid{Pid: proc.Process.Pid, Owner: os.Getppid()}) // alive, not us
	os.WriteFile(filepath.Join(a.runDir, "cs.pid"), b, 0o600)
	c := newCodeServer(a)
	c.stopAll()
	if !processAlive(proc.Process.Pid) {
		t.Fatal("stopped a code-server owned by another agent")
	}
}

func TestHousekeepingAndMigration(t *testing.T) {
	a := testAgent(t)
	up := filepath.Join(a.base, "uploads")
	os.MkdirAll(up, 0o755)
	old, fresh := filepath.Join(up, "old.png"), filepath.Join(up, "new.png")
	os.WriteFile(old, nil, 0o644)
	os.WriteFile(fresh, nil, 0o644)
	past := time.Now().Add(-30 * 24 * time.Hour)
	os.Chtimes(old, past, past)
	housekeeping(a.base, a.logger)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("expired upload kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh upload removed")
	}

	home := t.TempDir()
	legacy := filepath.Join(home, ".oldname")
	os.MkdirAll(filepath.Join(legacy, "cs-data"), 0o700)
	saved := brandLegacy(".oldname")
	defer saved()
	migrateLegacyDataDir(home, filepath.Join(home, ".newname"), a.logger)
	if _, err := os.Stat(filepath.Join(home, ".newname", "cs-data")); err != nil {
		t.Fatalf("legacy data dir not migrated: %v", err)
	}
}

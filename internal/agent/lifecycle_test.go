//go:build unix

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

func testAgent(t testing.TB) *Agent {
	home := t.TempDir()
	base := filepath.Join(home, ".x")
	run := filepath.Join(base, "run")
	host := filepath.Join(base, "hosts", "h")
	os.MkdirAll(run, 0o700)
	os.MkdirAll(host, 0o700)
	return &Agent{logger: log.New(io.Discard, "", 0), home: home, base: base, hostDir: host, runDir: run}
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

func TestHousekeeping(t *testing.T) {
	a := testAgent(t)
	up := filepath.Join(a.base, "uploads")
	os.MkdirAll(up, 0o755)
	old, fresh := filepath.Join(up, "old.png"), filepath.Join(up, "new.png")
	os.WriteFile(old, nil, 0o644)
	os.WriteFile(fresh, nil, 0o644)
	past := time.Now().Add(-30 * 24 * time.Hour)
	os.Chtimes(old, past, past)
	housekeeping(a.base, a.hostDir, a.logger)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("expired upload kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh upload removed")
	}
}

// Other hosts' directories (a shared home): files of one unused for 30
// days go, but its terminal core's executable stays, which a core may run
// from; one unused for 180 days goes whole. This host's and recent ones
// stay, and this host's is marked used.
func TestPruneHosts(t *testing.T) {
	a := testAgent(t)
	hosts := filepath.Dir(a.hostDir)
	mk := func(name string, age time.Duration) string {
		d := filepath.Join(hosts, name)
		os.MkdirAll(filepath.Join(d, "hc"), 0o700)
		os.MkdirAll(filepath.Join(d, "cs-data"), 0o700)
		os.WriteFile(filepath.Join(d, "hc", "herdr-core"), nil, 0o700)
		os.WriteFile(filepath.Join(d, "node.log"), nil, 0o600)
		when := time.Now().Add(-age)
		os.Chtimes(d, when, when)
		return d
	}
	recent := mk("recent", 10*24*time.Hour)
	idle := mk("idle", 40*24*time.Hour)
	gone := mk("gone", 200*24*time.Hour)
	mine := a.hostDir
	past := time.Now().Add(-300 * 24 * time.Hour)
	os.Chtimes(mine, past, past)
	housekeeping(a.base, a.hostDir, a.logger)
	exists := func(p string) bool { _, err := os.Lstat(p); return err == nil }
	if !exists(filepath.Join(recent, "node.log")) || !exists(filepath.Join(recent, "cs-data")) {
		t.Error("a recent host's files were removed")
	}
	if exists(filepath.Join(idle, "node.log")) || exists(filepath.Join(idle, "cs-data")) || !exists(filepath.Join(idle, "hc", "herdr-core")) {
		t.Error("an idle host: files kept or executable removed")
	}
	if fi, err := os.Stat(idle); err != nil || time.Since(fi.ModTime()) < 39*24*time.Hour {
		t.Error("pruning made an idle host's directory look used")
	}
	if exists(gone) {
		t.Error("a host gone for long was kept")
	}
	if fi, err := os.Stat(mine); err != nil || time.Since(fi.ModTime()) > time.Minute {
		t.Error("this host's directory was not marked used")
	}
}

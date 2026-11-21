//go:build unix

package usage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A FIFO where a WAL, a database or a log should be is refused at once:
// opening it does not wait for a writer.
func TestSQLiteFIFO(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "opencode", "wal.db"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	db := filepath.Join(dir, "opencode.db")
	os.WriteFile(db, src, 0o600)
	fifo := func(p string) {
		if err := syscall.Mkfifo(p, 0o600); err != nil {
			t.Skip("no FIFOs here:", err)
		}
	}
	within := func(what string, fn func() error) {
		t.Helper()
		done := make(chan error, 1)
		go func() { done <- fn() }()
		select {
		case err := <-done:
			if !errors.Is(err, errNotRegular) {
				t.Errorf("%s: %v", what, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: the open waits", what)
		}
	}
	fifo(db + "-wal")
	within("the WAL", func() error {
		_, _, err := readOpenCode(context.Background(), db, 0)
		return err
	})
	os.Remove(db + "-wal")
	os.Remove(db)
	fifo(db)
	within("the database", func() error {
		_, _, err := readOpenCode(context.Background(), db, 0)
		return err
	})
	log := filepath.Join(dir, "rollout.jsonl")
	fifo(log)
	within("a log", func() error {
		_, err := parseLog(context.Background(), logFile{log, logCodex}, nil, &fileEntry{}, 0)
		return err
	})
	if readFailure(errNotRegular) != "unreadable" {
		t.Error(readFailure(errNotRegular))
	}
}

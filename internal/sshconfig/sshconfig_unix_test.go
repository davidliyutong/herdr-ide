//go:build unix

package sshconfig

import (
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

// A FIFO named by an Include would block a reader that opened it: it is
// skipped, as every file that is not a regular one.
func TestReadSkipsSpecialFiles(t *testing.T) {
	home := t.TempDir()
	write(t, home, map[string]string{".ssh/config": "Include fifo /dev/zero\nHost after\n"})
	if err := syscall.Mkfifo(filepath.Join(home, ".ssh", "fifo"), 0o600); err != nil {
		t.Skip(err)
	}
	if got := Read(home); !reflect.DeepEqual(got, []Host{{Alias: "after"}}) {
		t.Errorf("Read = %+v", got)
	}
}

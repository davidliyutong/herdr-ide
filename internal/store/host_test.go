package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A database of a host is named after the host's first label, sanitized:
// two hosts sharing a data directory never share a database.
func TestHostFile(t *testing.T) {
	for _, c := range []struct{ host, want string }{
		{"node01.cluster.example.org", "node01"},
		{"MacBook-Pro.local", "macbook-pro"},
		{"  ", "localhost"},
		{"", "localhost"},
		{".local", "localhost"},
		{"a/b\\c:d e", "a_b_c_d_e"},
		{"..", "localhost"},
		{"büro", "b_ro"},
		{strings.Repeat("x", 100), strings.Repeat("x", 63)},
	} {
		if got := hostLabel(c.host); got != c.want {
			t.Errorf("hostLabel(%q) = %q, want %q", c.host, got, c.want)
		}
	}
	if got := hostFileName("machine.db", "h1"); got != "machine-h1.db" {
		t.Errorf("machine.db: %q", got)
	}
	if got := hostFileName("chat", "h1"); got != "chat-h1" {
		t.Errorf("chat: %q", got)
	}
	dir := t.TempDir()
	p := HostFile(dir, MachineDB)
	h, _ := os.Hostname()
	if filepath.Dir(p) != dir || filepath.Base(p) != "machine-"+hostLabel(h)+".db" {
		t.Errorf("HostFile = %q (host %q)", p, h)
	}
	if strings.Count(filepath.Base(p), ".") != 1 {
		t.Errorf("HostFile = %q", p)
	}
}

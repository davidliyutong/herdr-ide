package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"herdr-ide/internal/hostid"
)

// A database of a host is named after the host's whole name, sanitized,
// and a hash of its machine id: two hosts sharing a data directory never
// share a database, also when their names are alike or the same.
func TestHostFile(t *testing.T) {
	for _, c := range []struct{ host, want string }{
		{"node01.cluster.example.org", "node01.cluster.example.org"},
		{"MacBook-Pro.local", "macbook-pro.local"},
		{"  ", "localhost"},
		{"", "localhost"},
		{".local", "local"},
		{"a/b\\c:d e", "a_b_c_d_e"},
		{"..", "localhost"},
		{"büro", "b_ro"},
		{"x.", "x"},
		{strings.Repeat("x", 200), strings.Repeat("x", hostid.MaxName)},
	} {
		if got := hostid.Name(c.host); got != c.want {
			t.Errorf("hostid.Name(%q) = %q, want %q", c.host, got, c.want)
		}
	}
	// node01 of two clusters, and two machines of one name.
	a, b := hostKey("node01.a.example.org", "id-1"), hostKey("node01.b.example.org", "id-1")
	c, d := hostKey("node01", "id-1"), hostKey("node01", "id-2")
	if a == b || c == d || a == c {
		t.Errorf("keys %q %q %q %q", a, b, c, d)
	}
	if !strings.HasPrefix(c, "node01-") || len(c) != len("node01-")+8 || strings.Contains(c, "id-1") {
		t.Errorf("key %q", c)
	}
	if got := hostKey("Node01", " \n"); got != "node01" {
		t.Errorf("without an id: %q", got)
	}
	for _, k := range []string{a, b, c, d, "node01", "elsewhere", strings.Repeat("x", hostid.MaxName) + "-0123abcd"} {
		if !validHostKey(k) {
			t.Errorf("%q is no host's key", k)
		}
	}
	for _, k := range []string{"", "Upper", ".x", "x.", "a b", "a/b", strings.Repeat("x", hostid.MaxName+10)} {
		if validHostKey(k) {
			t.Errorf("%q is a host's key", k)
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
	if want := hostKey(h, machineID()); filepath.Dir(p) != dir || filepath.Base(p) != "machine-"+want+".db" || thisHost() != want {
		t.Errorf("HostFile = %q (host %q, key %q)", p, h, want)
	}
	if !validHostKey(thisHost()) {
		t.Errorf("this host's key %q", thisHost())
	}
}

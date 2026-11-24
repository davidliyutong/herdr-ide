package hostid

import (
	"strings"
	"testing"
)

// The id stays when the name changes, differs between machine ids, and
// without an id is the name, or a hash of a long one.
func TestID(t *testing.T) {
	a, b := IDOf("mac", "id-1"), IDOf("MacBook-Pro.local", "id-1")
	if a != b || len(a) != 8 || strings.Contains(a, "id") {
		t.Errorf("ids %q %q", a, b)
	}
	if IDOf("mac", "id-2") == a {
		t.Error("two machine ids, one id")
	}
	if got := IDOf("Node01", ""); got != "node01" {
		t.Errorf("without an id: %q", got)
	}
	long := strings.Repeat("x", 30)
	if got := IDOf(long, ""); len(got) != 8 || got == IDOf(long+"y", "") {
		t.Errorf("long name: %q", got)
	}
	if ID() == "" || !ValidKey(ID()) || !ValidKey(Key()) {
		t.Errorf("this host: id %q key %q", ID(), Key())
	}
}

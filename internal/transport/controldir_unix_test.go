//go:build unix

package transport

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"herdr-ide/internal/brand"
)

// Each instance has a control directory of its own, and its sockets' paths
// stay within macOS's limit for the longest instance name.
func TestControlDirPerInstance(t *testing.T) {
	long := strings.Repeat("a", 32)
	if !brand.ValidInstance(long) {
		t.Fatal("the longest instance name is not valid")
	}
	seen := map[string]string{}
	for _, inst := range []string{"", "dev", "desktop", "e2e-0123abcd", long, long[:31] + "b"} {
		name := controlName(inst)
		if other, ok := seen[name]; ok {
			t.Fatalf("instances %q and %q share %s", inst, other, name)
		}
		seen[name] = inst
		parent := fmt.Sprintf("/tmp/%s-%d", brand.Slug, os.Getuid())
		// <dir>/<%C> and the suffix ssh adds while it binds.
		if n := len(filepath.Join(parent, name, strings.Repeat("0", 40))) + 17; n >= 104 {
			t.Fatalf("instance %q: socket path of %d bytes", inst, n)
		}
	}
	if controlName("") != "s" {
		t.Fatalf("default instance: %s", controlName(""))
	}
}

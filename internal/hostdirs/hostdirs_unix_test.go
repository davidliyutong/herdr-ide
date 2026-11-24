//go:build unix

package hostdirs

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"veldr/internal/hostid"
)

func withRuntimeRoot(t *testing.T, root string) {
	t.Helper()
	old := userRuntimeRoot
	userRuntimeRoot = root
	t.Cleanup(func() { userRuntimeRoot = old })
}

// The runtime directory is in /run/user/<uid> when that is the user's and
// private, named after the data directory and a hash of its path, so two
// homes (tests) never share one; else in the data directory, named after
// the host's id.
func TestRunDir(t *testing.T) {
	root := t.TempDir()
	withRuntimeRoot(t, root)
	base := filepath.Join(t.TempDir(), ".app-dev")
	if got, want := RunDir(base), filepath.Join(base, "run-"+hostid.ID()); got != want {
		t.Errorf("without /run/user: %q, want %q", got, want)
	}
	user := filepath.Join(root, strconv.Itoa(os.Getuid()))
	if err := os.Mkdir(user, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := RunDir(base); !strings.HasPrefix(got, base) {
		t.Errorf("a runtime directory others can read was taken: %q", got)
	}
	os.Chmod(user, 0o700)
	a := RunDir(base)
	if filepath.Dir(a) != user || !strings.HasPrefix(filepath.Base(a), "app-dev-") || len(filepath.Base(a)) != len("app-dev-")+8 {
		t.Errorf("in /run/user: %q", a)
	}
	other := filepath.Join(t.TempDir(), ".app-dev")
	if RunDir(other) == a {
		t.Error("two homes share a runtime directory")
	}
	if RunDir(base) != a {
		t.Error("not stable")
	}
	// A link to the home gives the same directory.
	link := filepath.Join(t.TempDir(), "home")
	if err := os.Symlink(filepath.Dir(base), link); err != nil {
		t.Fatal(err)
	}
	if got := RunDir(filepath.Join(link, ".app-dev")); got != a {
		t.Errorf("through a link: %q, want %q", got, a)
	}
}

// Make creates the directories private, fixes looser modes and refuses a
// link in the runtime directory's place.
func TestMake(t *testing.T) {
	withRuntimeRoot(t, filepath.Join(t.TempDir(), "none"))
	d := Of(filepath.Join(t.TempDir(), ".app"))
	if err := os.MkdirAll(d.Run, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := d.Make(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{d.Base, d.Host, d.Run} {
		if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v %v", p, fi, err)
		}
	}
	if filepath.Dir(d.Host) != filepath.Join(d.Base, HostsDir) || filepath.Base(d.Host) != hostid.Key() {
		t.Errorf("host directory %q", d.Host)
	}
	target := t.TempDir()
	run := filepath.Join(t.TempDir(), "run")
	if err := os.Symlink(target, run); err != nil {
		t.Fatal(err)
	}
	if err := MakeRun(run); err == nil {
		t.Error("a link was taken as the runtime directory")
	}
}

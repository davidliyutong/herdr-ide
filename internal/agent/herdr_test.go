package agent

import (
	"path/filepath"
	"testing"
)

// The bundled herdr only stands in for a missing installation.
func TestResolveHerdrPrefersInstalledOverBundled(t *testing.T) {
	saved := systemHerdrPaths
	systemHerdrPaths = nil
	t.Cleanup(func() { systemHerdrPaths = saved })
	a := testAgent(t)
	t.Setenv("HERDR_BIN", "")
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SHELL", "/usr/bin/false") // the login-shell lookup finds nothing
	if bin, err := a.resolveHerdr(""); err == nil {
		t.Fatalf("resolved %q without an installation or a bundled herdr", bin)
	}

	a.bundledHerdr = filepath.Join(t.TempDir(), "herdr")
	writeExec(t, a.bundledHerdr)
	if bin, err := a.resolveHerdr(""); err != nil || bin != a.bundledHerdr {
		t.Fatalf("bundled: %q %v", bin, err)
	}

	installed := filepath.Join(a.home, ".local", "bin", "herdr")
	writeExec(t, installed)
	a.herdrCache = map[string]string{}
	if bin, err := a.resolveHerdr(""); err != nil || bin != installed {
		t.Fatalf("installed: %q %v", bin, err)
	}
}

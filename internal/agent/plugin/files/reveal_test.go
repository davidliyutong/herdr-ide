//go:build unix

package files

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/testexec"
)

// The command each system shows a path with: the program by its absolute
// path, never looked for in PATH; the path an argument of its own, never a
// shell's text; for xdg-open, which opens folders, a file's folder, and a
// trailing slash, so that a folder swapped for a file is not opened in the
// file's program.
func TestRevealCommand(t *testing.T) {
	bin := t.TempDir()
	xdg := filepath.Join(bin, "xdg-open")
	os.WriteFile(xdg, []byte("#!/bin/sh\n"), 0o755)
	was := revealDirs
	t.Cleanup(func() { revealDirs = was })
	revealDirs = []string{filepath.Join(bin, "none"), bin}
	cases := []struct {
		goos, path string
		dir        bool
		want       []string
	}{
		{"darwin", "/Users/me/a b;$(x).txt", false, []string{"/usr/bin/open", "-R", "/Users/me/a b;$(x).txt"}},
		{"darwin", "/Users/me/proj", true, []string{"/usr/bin/open", "-R", "/Users/me/proj"}},
		{"linux", "/home/me/a.txt", false, []string{xdg, "/home/me/"}},
		{"linux", "/home/me/proj", true, []string{xdg, "/home/me/proj/"}},
		{"linux", "/", true, []string{xdg, "/"}},
		{"linux", "/a.txt", false, []string{xdg, "/"}},
		{"windows", `C:\x`, false, nil},
	}
	for _, c := range cases {
		if got := revealCommand(c.goos, c.path, c.dir); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %s: %q, want %q", c.goos, c.path, got, c.want)
		}
	}

	// No xdg-open in the system's directories: none, whatever PATH holds;
	// a file there that is not executable is none either.
	t.Setenv("PATH", bin)
	revealDirs = []string{t.TempDir()}
	if got := revealCommand("linux", "/home/me", true); got != nil {
		t.Errorf("from PATH: %q", got)
	}
	plain := t.TempDir()
	os.WriteFile(filepath.Join(plain, "xdg-open"), []byte("#!/bin/sh\n"), 0o644)
	revealDirs = []string{plain}
	if got := revealCommand("linux", "/home/me", true); got != nil {
		t.Errorf("not executable: %q", got)
	}
}

// fakeReveal makes reveal run a script instead of the file manager, with
// body after a line that writes its arguments into a file, which it
// returns.
func fakeReveal(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "args")
	script := testexec.ScriptAt(t, filepath.Join(dir, "reveal"), "printf '%s\\n' \"$@\" > "+out+"\n"+body)
	was := revealCommand
	revealCommand = func(goos, p string, dir bool) []string {
		if dir {
			return []string{script, "dir", p}
		}
		return []string{script, "file", p}
	}
	t.Cleanup(func() { revealCommand = was })
	return out
}

// shortWait shortens the wait for a command's answer during the test, and
// waits at its end for the commands left running to free their places.
func shortWait(t *testing.T, d time.Duration) {
	t.Helper()
	was := revealWait
	revealWait = d
	t.Cleanup(func() {
		revealWait = was
		for deadline := time.Now().Add(10 * time.Second); len(revealGate) > 0 && time.Now().Before(deadline); {
			time.Sleep(20 * time.Millisecond)
		}
	})
}

func TestReveal(t *testing.T) {
	env := testEnv(t)
	out := fakeReveal(t, "exit 0\n")
	os.MkdirAll(filepath.Join(env.Home, "proj"), 0o755)
	os.WriteFile(filepath.Join(env.Home, "proj", "a.txt"), nil, 0o644)
	args := func() string {
		b, _ := os.ReadFile(out)
		os.Remove(out)
		return strings.TrimSpace(string(b))
	}

	// A file, a folder, a path against home, home itself (it changes
	// nothing, so what changes refuse can be shown).
	for p, want := range map[string]string{
		filepath.Join(env.Home, "proj", "a.txt"): "file\n" + filepath.Join(env.Home, "proj", "a.txt"),
		"~/proj":                                 "dir\n" + filepath.Join(env.Home, "proj"),
		"proj/a.txt":                             "file\n" + filepath.Join(env.Home, "proj", "a.txt"),
		"~":                                      "dir\n" + env.Home,
	} {
		r := result(t, call(t, env, "reveal", Params{Path: p}))
		if got := args(); got != want || len(r.Paths) != 1 {
			t.Errorf("reveal %s: ran with %q, answered %v", p, got, r.Paths)
		}
	}

	// Nothing runs for a path not there, or no path.
	for p, code := range map[string]string{filepath.Join(env.Home, "missing"): "not_found", "": "bad_params", "a\x00b": "bad_params"} {
		if rep := call(t, env, "reveal", Params{Path: p}); rep.OK || rep.Code != code {
			t.Errorf("reveal %q: %v %s", p, rep.OK, rep.Code)
		}
		if got := args(); got != "" {
			t.Errorf("reveal %q ran: %q", p, got)
		}
	}
}

func TestRevealFailures(t *testing.T) {
	env := testEnv(t)
	fakeReveal(t, "echo 'no file manager here' >&2\nexit 3\n")
	rep := call(t, env, "reveal", Params{Path: "~"})
	if rep.OK || rep.Code != "reveal_failed" || !strings.Contains(rep.Error, "exit status 3") {
		t.Fatalf("failing command: %v %s %s", rep.OK, rep.Code, rep.Error)
	}
	// No such program.
	missing := filepath.Join(t.TempDir(), "no-such-program")
	revealCommand = func(goos, p string, dir bool) []string { return []string{missing, p} }
	if rep := call(t, env, "reveal", Params{Path: "~"}); rep.OK || rep.Code != "reveal_unavailable" {
		t.Fatalf("missing program: %v %s %s", rep.OK, rep.Code, rep.Error)
	}
	if len(revealGate) != 0 {
		t.Fatalf("%d places held", len(revealGate))
	}
}

// An xdg-open that starts the file manager as its child, which inherits
// its standard streams and stays: the answer comes when xdg-open exits,
// not when the window closes, and its place is free then.
func TestRevealLeavesTheFileManager(t *testing.T) {
	env := testEnv(t)
	shortWait(t, 5*time.Second)
	fakeReveal(t, "sleep 30 &\necho 'file manager started' >&2\nexit 0\n")
	for i := 0; i < maxRevealing+2; i++ {
		start := time.Now()
		if rep := call(t, env, "reveal", Params{Path: "~"}); !rep.OK {
			t.Fatalf("reveal %d: %s %s", i, rep.Code, rep.Error)
		}
		// Well below the wait's limit, which an answer that waited for the
		// window would take, with room for a loaded machine.
		if d := time.Since(start); d > 4*time.Second {
			t.Fatalf("reveal %d answered after %v", i, d)
		}
		if len(revealGate) != 0 {
			t.Fatalf("reveal %d: %d places held by windows left open", i, len(revealGate))
		}
	}
}

// A command that does not exit (an xdg-open running the file manager
// itself) is answered for after revealWait and frees its place then (or when it exits);
// beyond maxRevealing waited for at once, reveal is busy.
func TestRevealWaitsBounded(t *testing.T) {
	env := testEnv(t)
	shortWait(t, 100*time.Millisecond)
	// The commands run until the test lets them go.
	release := filepath.Join(t.TempDir(), "release")
	t.Cleanup(func() { os.WriteFile(release, nil, 0o600) })
	fakeReveal(t, "while [ ! -e "+release+" ]; do sleep 0.02; done\n")
	start := time.Now()
	if rep := call(t, env, "reveal", Params{Path: "~"}); !rep.OK {
		t.Fatalf("reveal: %s", rep.Code)
	}
	if d := time.Since(start); d > time.Second || len(revealGate) != 0 {
		t.Fatalf("answered after %v, %d places held", d, len(revealGate))
	}

	revealWait = 30 * time.Second
	var wg sync.WaitGroup
	for i := 0; i < maxRevealing; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			call(t, env, "reveal", Params{Path: "~"})
		}()
	}
	for deadline := time.Now().Add(5 * time.Second); len(revealGate) < maxRevealing; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%d places taken", len(revealGate))
		}
	}
	if rep := call(t, env, "reveal", Params{Path: "~"}); rep.OK || rep.Code != "busy" {
		t.Fatalf("over the bound: %v %s", rep.OK, rep.Code)
	}
	// The commands exit: their places are free.
	os.WriteFile(release, nil, 0o600)
	wg.Wait()
	if len(revealGate) != 0 {
		t.Fatalf("%d places held after the waits", len(revealGate))
	}
}

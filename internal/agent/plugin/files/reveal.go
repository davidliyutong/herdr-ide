//go:build unix

package files

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"veldr/internal/agent/plugin"
)

// Reveal in Finder (Reveal in File Manager): the system's file manager
// shows a path, as VS Code's command of that name does. The core asks only
// for its own machine, whose agent runs in its process, and only for a
// client on its own host (backend/features/files): the window opens on the
// screen of the computer the user sits at.

// revealWait bounds the wait for the command's answer. open and xdg-open
// hand the path to the file manager and exit; one still running then (an
// xdg-open that runs a file manager itself) is that file manager's
// window, left to the user, and reaped when it ends. Tests shorten it.
var revealWait = 10 * time.Second

// maxRevealing bounds the commands waited for at once: a command frees
// its place when it exits or its wait ends, so a file manager's window
// left open holds none.
const maxRevealing = 4

var revealGate = make(chan struct{}, maxRevealing)

// revealDirs are where xdg-open is looked for: the system's own
// directories, never the PATH of the environment the core was started in.
var revealDirs = []string{"/usr/bin", "/bin", "/usr/local/bin"}

// systemProgram is the first regular, executable file named name in dirs,
// "" when there is none.
func systemProgram(name string, dirs []string) string {
	for _, d := range dirs {
		p := filepath.Join(d, name)
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// revealCommand is the program, by its absolute path, and the arguments
// that show p (absolute and there; dir: a folder) in the file manager of
// system goos: Finder, with p selected in its folder, on macOS
// (/usr/bin/open); elsewhere the default file manager with the folder, or
// the file's folder (xdg-open of the system's directories), named with a
// trailing slash, so that a folder swapped for a file meanwhile fails
// rather than opens in that file's program. Nil where there is none. p is
// an argument of its own, never a shell's text, and as an absolute path
// it starts with a slash, never taken for an option.
var revealCommand = func(goos, p string, dir bool) []string {
	switch goos {
	case "darwin":
		return []string{"/usr/bin/open", "-R", p}
	case "linux", "freebsd", "openbsd", "netbsd", "dragonfly":
		prog := systemProgram("xdg-open", revealDirs)
		if prog == "" {
			return nil
		}
		if !dir {
			p = filepath.Dir(p)
		}
		return []string{prog, strings.TrimSuffix(p, "/") + "/"}
	}
	return nil
}

// reveal shows p in the system's file manager. The path is expanded as
// every action's (guard.expand: not empty, no NUL, ~ and relative paths
// against home, cleaned) and must be there; it changes nothing, so the
// paths the changes refuse (the home directory, the data directory) can
// be shown, as the stat of them is answered.
//
// The command's standard streams are /dev/null: a pipe for its errors
// would be held open by the file manager it starts, and its wait would
// last as long as that window. It answers once the command exits (its
// exit status, xdg-open's 1 to 4, says why it failed) or revealWait
// passed, and frees its place then.
func (g *guard) reveal(ctx context.Context, p string) (*Result, error) {
	abs, err := g.expand(p)
	if err != nil {
		return nil, err
	}
	if _, err := os.Lstat(abs); err != nil {
		return nil, codeOf(err)
	}
	fi, err := os.Stat(abs)
	argv := revealCommand(runtime.GOOS, abs, err == nil && fi.IsDir())
	if argv == nil {
		return nil, plugin.Errorf("reveal_unavailable", "no file manager on %s", runtime.GOOS)
	}
	select {
	case revealGate <- struct{}{}:
	default:
		return nil, plugin.Errorf("busy", "%d file managers are being opened", maxRevealing)
	}
	// Its place is free once it answers: a window still open holds none.
	defer func() { <-revealGate }()
	cmd := exec.Command(argv[0], argv[1:]...)
	if g.env.Environ != nil {
		cmd.Env = g.env.Environ()
	}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return nil, plugin.Errorf("reveal_unavailable", "%s: %v", argv[0], err)
		}
		return nil, plugin.Errorf("reveal_failed", "%s: %v", argv[0], err)
	}
	done := make(chan error, 1)
	// Reaped whenever it ends, also after the answer.
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(revealWait)
	defer timer.Stop()
	select {
	case err := <-done:
		if err != nil {
			return nil, plugin.Errorf("reveal_failed", "%s: %v", argv[0], err)
		}
	case <-timer.C:
	case <-ctx.Done():
	}
	return &Result{Paths: []string{abs}}, nil
}

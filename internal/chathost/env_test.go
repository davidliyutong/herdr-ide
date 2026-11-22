//go:build unix

package chathost

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/brand"
)

// fakeShell writes a shell script that stands in for the user's shell and
// returns its path.
func fakeShell(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fakeshell")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// pidIn is the process a script wrote into a file ("echo $$ > file").
func pidIn(t *testing.T, file string) int {
	t.Helper()
	var pid int
	eventually(t, "the pid in "+file, func() bool {
		b, err := os.ReadFile(file)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil
	})
	return pid
}

// alive tells whether a process exists and is no zombie nobody waited for
// yet.
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	st := strings.TrimSpace(string(out))
	return err == nil && st != "" && !strings.HasPrefix(st, "Z")
}

func TestParseEnv(t *testing.T) {
	out := strings.Join([]string{
		"Welcome to this machine",       // what a startup file printed
		"it has = signs too",            // no variable: a space in the name
		"HOME=/home/u",                  //
		"EMPTY=",                        //
		"MULTI=first line",              //
		"  second line",                 // continues MULTI
		"",                              // an empty line of MULTI
		"9third=is no name",             // continues MULTI
		"BASH_FUNC_which%%=() {  alias", // an exported function: dropped
		"  x=1; eval ${which_declare}",  // its body
		"}",                             //
		"_under=1",                      //
		"PATH=/a:/b",                    //
		"TAIL=x=y",                      //
		"",                              // the output's last line, of TAIL
	}, "\n") + "\n"
	want := []string{
		"HOME=/home/u",
		"EMPTY=",
		"MULTI=first line\n  second line\n\n9third=is no name",
		"_under=1",
		"PATH=/a:/b",
		"TAIL=x=y\n",
	}
	if got := parseEnv([]byte(out)); !reflect.DeepEqual(got, want) {
		t.Errorf("parseEnv:\n got %q\nwant %q", got, want)
	}
	if got := parseEnv(nil); len(got) != 0 {
		t.Errorf("parseEnv of nothing = %q", got)
	}
}

func TestLoginEnv(t *testing.T) {
	dir := t.TempDir()
	args := filepath.Join(dir, "args")
	shell := fakeShell(t, `
echo "$@" > `+args+`
echo "a line of a startup file"
if read line; then echo STDIN=open; else echo STDIN=end; fi
echo "PATH=/from/the/shell:$PATH"
echo "HOME=$HOME"
echo "NOTE=two"
echo "lines"
`)
	env, err := loginEnv(context.Background(), shell, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(args); strings.TrimSpace(string(got)) != "-l -i -c env" {
		t.Errorf("the shell's arguments = %q", got)
	}
	for k, want := range map[string]string{"STDIN": "end", "HOME": os.Getenv("HOME"), "NOTE": "two\nlines"} {
		if got, _ := getenv(env, k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if path, _ := getenv(env, "PATH"); !strings.HasPrefix(path, "/from/the/shell:") {
		t.Errorf("PATH = %q", path)
	}
}

// Without a shell of the user's, /bin/sh tells, as a login shell that is
// not interactive.
func TestLoginEnvFallbackShell(t *testing.T) {
	for _, shell := range []string{"", "zsh"} {
		env, err := loginEnv(context.Background(), shell, 10*time.Second)
		if err != nil {
			t.Fatalf("shell %q: %v", shell, err)
		}
		if _, ok := getenv(env, "PATH"); !ok {
			t.Errorf("shell %q: no PATH", shell)
		}
	}
}

func TestLoginEnvFailures(t *testing.T) {
	dir := t.TempDir()
	pid, slow := filepath.Join(dir, "pid"), filepath.Join(dir, "slow")
	for _, tc := range []struct {
		name, body string
		timeout    time.Duration
		want       string
	}{
		{"exit status", "echo PATH=/bin\nexit 3\n", patience, "exit status 3"},
		{"no PATH", "echo HOME=/h\n", patience, "no PATH"},
		{"too much", "echo PATH=/bin\nyes 0123456789012345678901234567890123456789 | head -c 1100000\n", patience, "more than"},
		// Slow once the file is there: a system may take its time with the
		// first run of a new program, which is not what is measured.
		{"slow", "echo PATH=/bin\nif [ -e " + slow + " ]; then echo $$ > " + pid + "; sleep 30; fi\n", 300 * time.Millisecond, "did not answer"},
	} {
		shell := fakeShell(t, tc.body)
		// A system may take its time with the first run of a new program
		// (macOS scans it), which is not what is measured: each shell runs
		// once first.
		_, err := loginEnv(context.Background(), shell, patience)
		if tc.name == "slow" {
			if err != nil {
				t.Fatalf("the shell while it is fast: %v", err)
			}
			if err := os.WriteFile(slow, nil, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		start := time.Now()
		env, err := loginEnv(context.Background(), shell, tc.timeout)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: env %q, error %v; want an error with %q", tc.name, env, err, tc.want)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("%s: took %s", tc.name, d)
		}
	}
	// The shell that did not answer was killed.
	shell := pidIn(t, pid)
	eventually(t, "the slow shell to be gone", func() bool { return !alive(shell) })

	if _, err := loginEnv(context.Background(), filepath.Join(dir, "no-such-shell"), time.Second); err == nil {
		t.Error("a shell that does not exist told an environment")
	}
}

// A program the startup files leave running holds the shell's output open:
// the environment is taken when the shell exited, and the program ended.
func TestLoginEnvLeftoverProgram(t *testing.T) {
	pid := filepath.Join(t.TempDir(), "pid")
	shell := fakeShell(t, "sleep 30 &\necho $! > "+pid+"\necho PATH=/bin\necho AFTER=1\n")
	start := time.Now()
	env, err := loginEnv(context.Background(), shell, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := getenv(env, "AFTER"); v != "1" {
		t.Errorf("env = %q", env)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("waited %s for a pipe held open", d)
	}
	left := pidIn(t, pid)
	eventually(t, "the leftover program to be gone", func() bool { return !alive(left) })
}

func TestEnvironmentIsKeptAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	t.Setenv("SHELL", fakeShell(t, "echo run >> "+runs+"\necho PATH=/from/the/shell\n"))
	e := &environment{logger: log.New(io.Discard, "", 0)}
	for range 3 {
		if path, _ := getenv(e.get(context.Background()), "PATH"); path != "/from/the/shell" {
			t.Fatalf("PATH = %q", path)
		}
	}
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "run") != 1 {
		t.Errorf("the shell ran %d times for three lookups", strings.Count(string(b), "run"))
	}
	// After envKeep the shell is asked again.
	e.mu.Lock()
	e.at = time.Now().Add(-envKeep - time.Second)
	e.mu.Unlock()
	e.get(context.Background())
	if b, _ := os.ReadFile(runs); strings.Count(string(b), "run") != 2 {
		t.Errorf("the shell ran %d times, want 2", strings.Count(string(b), "run"))
	}

	// A shell that fails: the host's own environment.
	t.Setenv("SHELL", fakeShell(t, "exit 1\n"))
	t.Setenv("CHATHOST_TEST_OWN", "mine")
	var logged strings.Builder
	e = &environment{logger: log.New(&logged, "", 0)}
	if v, _ := getenv(e.get(context.Background()), "CHATHOST_TEST_OWN"); v != "mine" {
		t.Errorf("the fallback is not the host's environment")
	}
	if !strings.Contains(logged.String(), "login shell") {
		t.Errorf("the failure was not logged: %q", logged.String())
	}
}

// An agent gets the user's environment without the variables of the
// host's terminal, of terminals and multiplexers, of ssh and of the
// agents' sessions; the core's own variables stay, and the spec's are
// added.
func TestAgentEnv(t *testing.T) {
	user := []string{
		"HOME=/home/u", "PATH=/bin", "PWD=/somewhere", "OLDPWD=/before",
		"TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%1", "STY=1.pts", "ZELLIJ=0", "ZELLIJ_SESSION_NAME=x",
		"HC_TERMINAL_ID=7", "HC_TERMINAL_SOCKET=/run/t.sock", "HC_SCOPE=scope", "HC_SESSION=s", "HC_SOCKET=/run/hc.sock",
		"HERDR_PANE_ID=3", brand.EnvPrefix + "BRIDGE_SOCKET=/run/b.sock",
		"SSH_CONNECTION=1 2 3 4", "SSH_AUTH_SOCK=/a", "TERM_PROGRAM=ghostty", "TERM_PROGRAM_VERSION=1", "COLORTERM=truecolor",
		"CLAUDECODE=1", "CODEX_THREAD_ID=x", "CLAUDE_CONFIG_DIR=/c", "TERM=xterm-256color", "HCX=kept", "TMUXINATOR=kept",
	}
	got := agentEnv(user, map[string]string{"PATH": "/spec/bin", "KEY": "v=1", "": "x", "A=B": "x"}, "/work")
	want := []string{
		"HOME=/home/u", "PATH=/bin", "HC_SCOPE=scope", "HC_SESSION=s", "HC_SOCKET=/run/hc.sock",
		"CLAUDE_CONFIG_DIR=/c", "TERM=xterm-256color", "HCX=kept", "TMUXINATOR=kept",
		"PWD=/work", "KEY=v=1", "PATH=/spec/bin",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("agentEnv:\n got %q\nwant %q", got, want)
	}
	if path, _ := getenv(got, "PATH"); path != "/spec/bin" {
		t.Errorf("PATH = %q", path)
	}
}

// The agents' session markers are the machine agent's (a copy: the two
// packages do not import each other).
func TestAgentSessionVarsMatch(t *testing.T) {
	f, err := parser.ParseFile(token.NewFileSet(), filepath.Join("..", "agent", "procutil.go"), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var theirs []string
	ast.Inspect(f, func(n ast.Node) bool {
		vs, ok := n.(*ast.ValueSpec)
		if !ok || len(vs.Names) != 1 || vs.Names[0].Name != "agentSessionVars" || len(vs.Values) != 1 {
			return true
		}
		for _, el := range vs.Values[0].(*ast.CompositeLit).Elts {
			if lit, ok := el.(*ast.KeyValueExpr).Key.(*ast.BasicLit); ok {
				s, _ := strconv.Unquote(lit.Value)
				theirs = append(theirs, s)
			}
		}
		return false
	})
	var ours []string
	for k := range agentSessionVars {
		ours = append(ours, k)
	}
	slices.Sort(theirs)
	slices.Sort(ours)
	if len(theirs) == 0 || !slices.Equal(ours, theirs) {
		t.Errorf("agentSessionVars:\n ours   %q\n theirs %q", ours, theirs)
	}
}

func TestLookPath(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	for _, d := range []string{a, b, filepath.Join(a, "dir")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path string, mode os.FileMode) {
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(a, "data"), 0o644)   // not executable: skipped
	write(filepath.Join(b, "data"), 0o755)   //
	write(filepath.Join(a, "tool"), 0o755)   // the first in PATH wins
	write(filepath.Join(b, "tool"), 0o755)   //
	write(filepath.Join(root, "rel"), 0o755) // only through a relative PATH entry
	env := []string{"PATH=/overridden", "PATH=rel-dir::" + a + ":" + b}
	for _, tc := range []struct{ file, want string }{
		{"tool", filepath.Join(a, "tool")},
		{"data", filepath.Join(b, "data")},
		{"dir", ""}, // a directory is no program
		{"rel", ""}, // relative entries of PATH are not searched
		{"missing", ""},
		{"", ""},
		{filepath.Join(b, "tool"), filepath.Join(b, "tool")},
		{filepath.Join(a, "data"), ""},
		{"./rel", ""}, // relative to nothing
		{"a/tool", ""},
	} {
		got, ok := lookPath(tc.file, env)
		if (tc.want == "") == ok || (ok && got != tc.want) {
			t.Errorf("lookPath(%q) = %q, %v; want %q", tc.file, got, ok, tc.want)
		}
	}
	if _, ok := lookPath("tool", []string{"HOME=/h"}); ok {
		t.Error("found a program without a PATH")
	}
}

// The login shell is asked again when a startup file changes, after
// envKeep, and soon after it failed; not at every agent's start.
func TestEnvironmentAsksAgainWhenStartupChanges(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", "")
	rc := filepath.Join(home, ".zshrc")
	os.WriteFile(rc, []byte("export A=1\n"), 0o600)
	runs := 0
	e := &environment{logger: log.New(io.Discard, "", 0), lookup: func(context.Context) []string {
		runs++
		return []string{"PATH=/bin"}
	}}
	get := func(want int, why string) {
		t.Helper()
		e.get(context.Background())
		if runs != want {
			t.Fatalf("%s: the shell ran %d times, want %d", why, runs, want)
		}
	}
	get(1, "first")
	get(1, "unchanged")
	later := time.Now().Add(time.Minute)
	os.Chtimes(rc, later, later)
	get(2, "a startup file changed")
	get(2, "unchanged again")
	os.WriteFile(filepath.Join(home, ".profile"), nil, 0o600)
	get(3, "a startup file appeared")
	e.mu.Lock()
	e.at = time.Now().Add(-envKeep + time.Minute)
	e.mu.Unlock()
	get(3, "before envKeep")
	e.mu.Lock()
	e.at = time.Now().Add(-envKeep - time.Second)
	e.mu.Unlock()
	get(4, "after envKeep")
	// The shell told a ZDOTDIR: its files count too.
	zdot := t.TempDir()
	e.lookup = func(context.Context) []string {
		runs++
		return []string{"PATH=/bin", "ZDOTDIR=" + zdot}
	}
	os.Chtimes(rc, later.Add(time.Minute), later.Add(time.Minute))
	get(5, "changed")
	get(5, "with the shell's ZDOTDIR")
	os.WriteFile(filepath.Join(zdot, ".zshrc"), nil, 0o600)
	get(6, "a file of the shell's ZDOTDIR appeared")
}

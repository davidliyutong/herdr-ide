//go:build unix

package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// Paths from a request are literal: pathspec magic matches nothing, a
// name with wildcards names that file. Hooks do not inherit that: a
// pre-commit hook's own glob pathspecs match.
func TestLiteralPaths(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	write(t, filepath.Join(dir, "b.txt"), "b\n")
	fails(t, env, "stage", Params{Repo: dir, Paths: []string{":(glob)*.txt"}}, "git_failed")
	sh(t, dir, "diff", "--cached", "--exit-code")
	write(t, filepath.Join(dir, "*.txt"), "star\n")
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"*.txt"}}, nil)
	if got := sh(t, dir, "diff", "--cached", "--name-only"); got != "*.txt" {
		t.Errorf("staged %q", got)
	}
	ok(t, env, "commit", Params{Repo: dir, Message: "star"}, nil)

	marker := filepath.Join(env.Home, "hook.out")
	write(t, filepath.Join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\ngit diff --cached --name-only -- '*.txt' > '"+marker+"'\n")
	os.Chmod(filepath.Join(dir, ".git", "hooks", "pre-commit"), 0o755)
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"b.txt"}}, nil)
	ok(t, env, "commit", Params{Repo: dir, Message: "b"}, nil)
	if b, err := os.ReadFile(marker); err != nil || strings.TrimSpace(string(b)) != "b.txt" {
		t.Errorf("the hook's glob matched %q (%v)", b, err)
	}
}

// testEnv is an agent's environment with HOME (so the global git
// configuration) in a temporary directory; the setup's git reads no system
// configuration.
func testEnv(t *testing.T) *plugin.Env {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	return &plugin.Env{
		Home: home,
		Expand: func(p string) (string, error) {
			if !filepath.IsAbs(p) {
				return filepath.Join(home, p), nil
			}
			return filepath.Clean(p), nil
		},
	}
}

// sh runs git in dir for a test's setup.
func sh(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2024-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2024-01-01T00:00:00Z")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newRepo makes a repository with one commit (a.txt) on main.
func newRepo(t *testing.T, env *plugin.Env) string {
	t.Helper()
	dir := filepath.Join(env.Home, "repo")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	dir, _ = filepath.EvalSymlinks(dir)
	sh(t, dir, "init", "-q", "-b", "main")
	sh(t, dir, "config", "user.name", "Tester")
	sh(t, dir, "config", "user.email", "tester@example.com")
	sh(t, dir, "config", "commit.gpgsign", "false")
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\n")
	sh(t, dir, "add", "a.txt")
	sh(t, dir, "commit", "-q", "-m", "first")
	return dir
}

// call runs an action and returns its reply.
func call(t *testing.T, env *plugin.Env, action string, p Params) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	raw, _ := json.Marshal(p)
	go handle(context.Background(), a, action, raw, env)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatalf("%s: %v", action, err)
	}
	b.Close()
	return rep
}

// ok runs an action that must succeed and decodes its result into v.
func ok(t *testing.T, env *plugin.Env, action string, p Params, v any) {
	t.Helper()
	rep := call(t, env, action, p)
	if !rep.OK {
		t.Fatalf("%s: %s %s", action, rep.Code, rep.Error)
	}
	if v != nil {
		// A fresh value: decoding into an old one would keep its fields.
		rv := reflect.ValueOf(v).Elem()
		rv.Set(reflect.Zero(rv.Type()))
		if err := json.Unmarshal(rep.Plugin, v); err != nil {
			t.Fatal(err)
		}
	}
}

// fails runs an action that must fail with code.
func fails(t *testing.T, env *plugin.Env, action string, p Params, code string) {
	t.Helper()
	rep := call(t, env, action, p)
	if rep.OK || rep.Code != code {
		t.Fatalf("%s: ok %v, code %q (%s), want %s", action, rep.OK, rep.Code, rep.Error, code)
	}
}

func TestPlainName(t *testing.T) {
	for _, s := range []string{"main", "feature/x", "v1.0", "origin/main", "a-b", "HEAD", "0123abcd"} {
		if err := plainName(s); err != nil {
			t.Errorf("%q refused: %v", s, err)
		}
	}
	for _, s := range []string{"", "-x", "--upload-pack=evil", "--exec=sh", "a..b", "a b", "a~1", "a^2", "a:b", "@{u}", "x@{1}",
		"a\\b", "a*", "a?", "a[b", "/a", "a/", "a//b", "a.lock", "a.", "a\nb", "a\x00"} {
		if err := plainName(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

// Remotes' URLs reach the UI without what could be a credential.
func TestRedactURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/o/r.git":             "https://github.com/o/r.git",
		"https://user:ghp_secret@github.com/o/r": "https://github.com/o/r",
		"https://ghp_secret@github.com/o/r":      "https://github.com/o/r",
		"https://a@b:tok@host:8443/p@q":          "https://host:8443/p@q",
		"ssh://git@host:22/o/r.git":              "ssh://host:22/o/r.git",
		"git@github.com:o/r.git":                 "git@github.com:o/r.git",
		"user:pass@host:o/r.git":                 "host:o/r.git",
		"/srv/repos/a@b:c":                       "/srv/repos/a@b:c",
		"https://user:sp%zz@host/invalid-escape": "https://host/invalid-escape",
	} {
		if got := redactURL(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	got := remoteURLs("origin\thttps://t@h/r (fetch)\norigin\thttps://t@h/r (push)\nup\t/srv/r.git (fetch)\n")
	if len(got) != 2 || got["origin"] != "https://h/r" || got["up"] != "/srv/r.git" {
		t.Errorf("remoteURLs %v", got)
	}
}

func TestCleanPath(t *testing.T) {
	for s, want := range map[string]string{"a.txt": "a.txt", "dir/b c.txt": "dir/b c.txt", "-weird": "-weird", ":(glob)*": ":(glob)*",
		// A directory as the status lists an untracked repository.
		"nested/": "nested/", "a/b/": "a/b/"} {
		if got, err := cleanPath(s); err != nil || got != want {
			t.Errorf("%q: %q %v", s, got, err)
		}
	}
	for _, s := range []string{"", "/", "/etc/passwd", "../x", "a/../b", "./a", "a//b", "a//", "../", "a\x00b", ".", "..", "./"} {
		if _, err := cleanPath(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

// Many paths are split over runs that stay below the system's limit of a
// command line; each path is a literal pathspec after "--".
func TestPathRuns(t *testing.T) {
	var ps []string
	for i := 0; i < 5000; i++ {
		ps = append(ps, strings.Repeat("d", 40)+"/"+strconv.Itoa(i))
	}
	runs := pathRuns([]string{"add", "--all"}, ps)
	if len(runs) < 2 {
		t.Fatalf("%d runs", len(runs))
	}
	n := 0
	for _, rn := range runs {
		if rn.args[0] != "add" || rn.args[1] != "--all" || rn.args[2] != "--" {
			t.Fatalf("args %q", rn.args[:3])
		}
		size := 0
		for _, a := range rn.args[3:] {
			if !strings.HasPrefix(a, ":(literal)") {
				t.Fatalf("not literal: %q", a)
			}
			if a != literal(ps[n]) {
				t.Fatalf("path %d: %q", n, a)
			}
			size += len(a) + 1
			n++
		}
		if size > maxArgBytes {
			t.Errorf("a run of %d bytes", size)
		}
	}
	if n != len(ps) {
		t.Errorf("%d of %d paths", n, len(ps))
	}
	if runs := pathRuns([]string{"x"}, nil); len(runs) != 0 {
		t.Errorf("no paths: %v", runs)
	}
}

// Values from a request never become options of git.
func TestArgvRefusesOptions(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	r := &repo{env: env, root: dir}
	ctx := context.Background()
	bad := []struct {
		action string
		p      Params
	}{
		{"branchCreate", Params{Name: "--upload-pack=evil"}},
		{"branchCreate", Params{Name: "ok", At: "--all"}},
		{"branchCreate", Params{Name: "has space"}},
		{"branchCreate", Params{Name: "a..b"}},
		{"checkout", Params{Name: "-f"}},
		{"checkout", Params{Rev: "--orphan=x"}},
		{"checkout", Params{Name: "nonexistent"}},
		{"merge", Params{Ref: "--abort"}},
		{"rebase", Params{Onto: "-i"}},
		{"rebase", Params{Onto: "HEAD..main"}},
		{"cherryPick", Params{Rev: "--continue"}},
		{"reset", Params{Rev: "HEAD", Mode: "keep"}},
		{"reset", Params{Rev: "--hard", Mode: "hard"}},
		{"push", Params{Remote: "--exec=touch /tmp/x"}},
		{"push", Params{Remote: "origin"}},
		{"fetch", Params{Remote: "--upload-pack=x"}},
		{"pull", Params{Remote: "--upload-pack=x"}},
		{"pull", Params{Branch: "main"}},
		{"pull", Params{Remote: "origin", Branch: "main"}},
		{"stashApply", Params{Index: -1}},
		{"stashApply", Params{Index: 0}},
		{"stashDrop", Params{Index: 0, Hash: "--all"}},
		{"stashPop", Params{Index: 0, Hash: "stash@{0}"}},
		{"tagCreate", Params{Name: "-d"}},
		{"tagDelete", Params{Name: "missing"}},
		{"branchDelete", Params{Name: "--force"}},
		{"branchRename", Params{Name: "main", To: "-m"}},
		{"stage", Params{Paths: []string{"../outside"}}},
		{"stage", Params{}},
		{"discard", Params{Paths: []string{"/etc/passwd"}}},
		{"abort", Params{Op: "bisect"}},
		{"commit", Params{Message: "  "}},
		{"applyPatch", Params{}},
	}
	for _, c := range bad {
		if rns, err := r.runs(ctx, c.action, c.p); err == nil {
			t.Errorf("%s %+v: accepted as %v", c.action, c.p, rns)
		}
	}
	// What is accepted puts paths after "--" as literal pathspecs and
	// names where git takes no option.
	rns, err := r.runs(ctx, "stage", Params{Paths: []string{"-n", "a.txt", ":(glob)*"}})
	if err != nil || len(rns) != 1 || strings.Join(rns[0].args, " ") != "add --all -- :(literal)-n :(literal)a.txt :(literal):(glob)*" {
		t.Errorf("stage: %v %v", rns, err)
	}
	rns, err = r.runs(ctx, "discard", Params{Paths: []string{"a.txt"}, Untracked: []string{"-f"}})
	if err != nil || len(rns) != 2 || strings.Join(rns[0].args, " ") != "clean -f -q -- :(literal)-f" ||
		strings.Join(rns[1].args, " ") != "restore --worktree -- :(literal)a.txt" {
		t.Errorf("discard: %v %v", rns, err)
	}
	rns, err = r.runs(ctx, "stage", Params{All: true, Tracked: true})
	if err != nil || len(rns) != 1 || strings.Join(rns[0].args, " ") != "add --update" {
		t.Errorf("stage tracked: %v %v", rns, err)
	}
	rn, err := r.argv(ctx, "commit", Params{Message: "--amend\n\nbody"})
	if err != nil || strings.Join(rn.args, " ") != "commit --cleanup=whitespace --file=-" || string(rn.stdin) != "--amend\n\nbody" {
		t.Errorf("commit: %q %q %v", rn.args, rn.stdin, err)
	}
	// As many paths as a status lists.
	many := make([]string, maxStatus)
	for i := range many {
		many[i] = "f" + strconv.Itoa(i)
	}
	if _, err := r.runs(ctx, "stage", Params{Paths: many}); err != nil {
		t.Errorf("%d paths: %v", len(many), err)
	}
	if _, err := r.runs(ctx, "stage", Params{Paths: append(many, "one more")}); err == nil {
		t.Error("over the limit of paths accepted")
	}
}

func TestNotARepo(t *testing.T) {
	env := testEnv(t)
	plain := filepath.Join(env.Home, "plain")
	os.Mkdir(plain, 0o755)
	fails(t, env, "repo", Params{Path: plain}, "not_a_repo")
	fails(t, env, "status", Params{Repo: plain}, "not_a_repo")
	dir := newRepo(t, env)
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	// The actions run in the top level only; repo finds it.
	fails(t, env, "status", Params{Repo: filepath.Join(dir, "sub")}, "not_a_repo")
	var info Repo
	ok(t, env, "repo", Params{Path: filepath.Join(dir, "sub")}, &info)
	if info.Root != dir || info.Branch != "main" || info.Head == "" || info.Detached {
		t.Errorf("repo %+v", info)
	}
	fails(t, env, "nope", Params{Repo: dir}, "bad_params")
}

func TestGitMissing(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	old := lookGit
	lookGit = func() (string, error) { return "", exec.ErrNotFound }
	defer func() { lookGit = old }()
	fails(t, env, "status", Params{Repo: dir}, "git_missing")
}

// A run over its time is killed with its process group.
func TestTimeout(t *testing.T) {
	env := testEnv(t)
	dir := t.TempDir()
	fake := filepath.Join(dir, "git")
	// The fake git starts a child that would outlive it.
	write(t, fake, "#!/bin/sh\nsleep 30 &\nsleep 30\n")
	os.Chmod(fake, 0o755)
	old := lookGit
	lookGit = func() (string, error) { return fake, nil }
	defer func() { lookGit = old }()
	start := time.Now()
	_, err := execGit(context.Background(), env, dir, true, run{args: []string{"status"}, timeout: 300 * time.Millisecond})
	var pe *plugin.Error
	if !errors.As(err, &pe) || pe.Code != "timeout" {
		t.Fatalf("err %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("took %s", d)
	}
	// Output over the limit ends the run too.
	write(t, fake, "#!/bin/sh\nwhile :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n")
	_, err = execGit(context.Background(), env, dir, true, run{args: []string{"log"}, limit: 1000})
	if !errors.As(err, &pe) || pe.Code != "too_large" {
		t.Fatalf("err %v", err)
	}
}

// fakeGit makes lookGit find a script as git for the test.
func fakeGit(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	fake := filepath.Join(dir, "git")
	write(t, fake, "#!/bin/sh\n"+script)
	os.Chmod(fake, 0o755)
	old := lookGit
	lookGit = func() (string, error) { return fake, nil }
	t.Cleanup(func() { lookGit = old })
	return dir
}

// killPids kills the processes whose ids a fake git wrote to file.
func killPids(t *testing.T, file string) {
	t.Cleanup(func() {
		b, _ := os.ReadFile(file)
		for _, f := range strings.Fields(string(b)) {
			if pid, err := strconv.Atoi(f); err == nil && pid > 0 {
				syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
}

// A program git leaves in the background holding its output (a hook's
// "indexer &") does not hold the run: git's success is answered within
// the wait delay, and the program keeps running, also when it left the
// process group.
func TestBackgroundChild(t *testing.T) {
	env := testEnv(t)
	detach := ""
	if p, err := exec.LookPath("setsid"); err == nil {
		detach = p
	} else if p, err := exec.LookPath("perl"); err == nil {
		detach = p + " -MPOSIX -e 'POSIX::setsid(); exec @ARGV'"
	}
	cases := map[string]string{"same group": "sleep 30"}
	if detach != "" {
		cases["own session"] = detach + " sleep 30"
	}
	for name, child := range cases {
		t.Run(name, func(t *testing.T) {
			pids := filepath.Join(t.TempDir(), "pids")
			killPids(t, pids)
			dir := fakeGit(t, child+" &\necho $! > "+pids+"\necho ok\n")
			start := time.Now()
			res, err := execGit(context.Background(), env, dir, true, run{args: []string{"status"}})
			if err != nil || res.code != 0 || string(res.out) != "ok\n" {
				t.Fatalf("res %+v err %v", res, err)
			}
			// Well before the child's 30 s and the read's 15 s limit: the
			// run does not wait for the child (bounds are generous, the
			// whole suite may run at once on a loaded machine).
			if d := time.Since(start); d > 10*time.Second {
				t.Errorf("took %s", d)
			}
			// The child is the user's: still running after the success.
			b, _ := os.ReadFile(pids)
			pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
			if pid <= 0 || syscall.Kill(pid, 0) != nil {
				t.Errorf("background child %d gone", pid)
			}
		})
	}
	if detach != "" {
		// A run over its time ends although a child that left the group
		// keeps its output open.
		pids := filepath.Join(t.TempDir(), "pids")
		killPids(t, pids)
		dir := fakeGit(t, detach+" sleep 30 &\necho $! > "+pids+"\nsleep 30\n")
		start := time.Now()
		_, err := execGit(context.Background(), env, dir, true, run{args: []string{"status"}, timeout: 300 * time.Millisecond})
		var pe *plugin.Error
		if !errors.As(err, &pe) || pe.Code != "timeout" {
			t.Fatalf("err %v", err)
		}
		if d := time.Since(start); d > 10*time.Second {
			t.Errorf("took %s", d)
		}
	}
}

// At most MaxRuns runs at once; another waits briefly, then fails busy.
func TestBusy(t *testing.T) {
	env := testEnv(t)
	pids := filepath.Join(t.TempDir(), "pids")
	killPids(t, pids)
	dir := fakeGit(t, "echo $$ >> "+pids+"\nexec sleep 30\n")
	old := slotWait
	slotWait = 200 * time.Millisecond
	defer func() { slotWait = old }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, MaxRuns)
	for i := 0; i < MaxRuns; i++ {
		go func() {
			_, err := execGit(ctx, env, dir, true, run{args: []string{"status"}, timeout: time.Minute})
			done <- err
		}()
	}
	for deadline := time.Now().Add(5 * time.Second); len(slots) < MaxRuns; {
		if time.Now().After(deadline) {
			t.Fatalf("%d runs started", len(slots))
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, err := execGit(context.Background(), env, dir, true, run{args: []string{"status"}})
	var pe *plugin.Error
	if !errors.As(err, &pe) || pe.Code != "busy" {
		t.Errorf("err %v, want busy", err)
	}
	cancel()
	for i := 0; i < MaxRuns; i++ {
		if err := <-done; !errors.As(err, &pe) || pe.Code != "cancelled" {
			t.Errorf("err %v", err)
		}
	}
	// The slots are free again.
	if _, err := execGit(context.Background(), env, t.TempDir(), true, run{args: []string{"version"}, timeout: 50 * time.Millisecond}); err == nil || errors.As(err, &pe) && pe.Code == "busy" {
		t.Errorf("after the runs: %v", err)
	}
}

// Reads run no file system monitor of the repository's configuration
// and no textconv driver; a change may (as in a terminal).
func TestReadsRunNoMonitor(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	marker := filepath.Join(env.Home, "marker")
	hook := filepath.Join(env.Home, "fsmonitor.sh")
	write(t, hook, "#!/bin/sh\ntouch "+marker+"\nexit 1\n")
	os.Chmod(hook, 0o755)
	tc := filepath.Join(env.Home, "textconv.sh")
	write(t, tc, "#!/bin/sh\ntouch "+marker+".tc\ncat \"$1\"\n")
	os.Chmod(tc, 0o755)
	sh(t, dir, "config", "core.fsmonitor", hook)
	sh(t, dir, "config", "diff.evil.textconv", tc)
	write(t, filepath.Join(dir, ".gitattributes"), "*.txt diff=evil\n")
	sh(t, dir, "add", ".gitattributes")
	sh(t, dir, "commit", "-q", "-m", "attrs")
	os.Remove(marker)
	write(t, filepath.Join(dir, "a.txt"), "changed\n")
	var st Status
	ok(t, env, "status", Params{Repo: dir}, &st)
	var ds DiffStat
	ok(t, env, "diffStat", Params{Repo: dir}, &ds)
	var info Repo
	ok(t, env, "repo", Params{Path: dir}, &info)
	var shown Shown
	ok(t, env, "show", Params{Repo: dir, Rev: sh(t, dir, "rev-parse", "HEAD~1"), Rev2: "HEAD"}, &shown)
	for _, m := range []string{marker, marker + ".tc"} {
		if _, err := os.Stat(m); err == nil {
			t.Errorf("a read ran %s", filepath.Base(m))
		}
	}
	if len(st.Files) != 1 || ds.Worktree["a.txt"] != [2]int{1, 3} {
		t.Errorf("status %+v diffStat %+v", st, ds)
	}
	// The same repository makes git itself run the monitor: the test
	// tests something.
	sh(t, dir, "status")
	if _, err := os.Stat(marker); err != nil {
		t.Log("this git runs no fsmonitor hook of core.fsmonitor")
	}
}

func TestClassify(t *testing.T) {
	cases := map[string]string{
		"fatal: could not read Username for 'https://example.com': terminal prompts disabled": "auth_required",
		"git@example.com: Permission denied (publickey).":                                     "auth_required",
		"Host key verification failed.":                                                       "auth_required",
		"remote: HTTP Basic: Access denied":                                                   "auth_required",
		"fatal: not a git repository (or any of the parent directories): .git":                "not_a_repo",
		"error: could not apply 1234... x":                                                    "conflicts",
		"fatal: something else":                                                               "git_failed",
	}
	for msg, code := range cases {
		var pe *plugin.Error
		if err := classify("x", result{err: []byte(msg), code: 1}); !errors.As(err, &pe) || pe.Code != code {
			t.Errorf("%q: %v, want %s", msg, err, code)
		}
	}
}

func TestReads(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	// A branch merged with a merge commit, a rename, a tag, a stash.
	sh(t, dir, "checkout", "-q", "-b", "feature")
	write(t, filepath.Join(dir, "b.txt"), "bee\n")
	sh(t, dir, "add", "b.txt")
	sh(t, dir, "commit", "-q", "-m", "add b")
	sh(t, dir, "checkout", "-q", "main")
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\n")
	sh(t, dir, "commit", "-q", "-am", "four")
	sh(t, dir, "merge", "-q", "--no-ff", "--no-edit", "feature")
	sh(t, dir, "mv", "b.txt", "c.txt")
	sh(t, dir, "commit", "-q", "-m", "rename b\n\nlonger body")
	sh(t, dir, "tag", "-a", "-m", "release", "v1")
	write(t, filepath.Join(dir, "a.txt"), "stashed\n")
	sh(t, dir, "stash", "push", "-q", "-m", "wip")
	// Changes: staged, modified, untracked, binary.
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n")
	sh(t, dir, "add", "a.txt")
	write(t, filepath.Join(dir, "a.txt"), "zero\none\ntwo\nthree\nfour\nfive\n")
	write(t, filepath.Join(dir, "new dir/u.txt"), "u\n")
	write(t, filepath.Join(dir, "bin.dat"), "a\x00b")

	var info Repo
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.Branch != "main" || info.State != "" || info.GitDir != filepath.Join(dir, ".git") {
		t.Errorf("repo %+v", info)
	}

	var st Status
	ok(t, env, "status", Params{Repo: dir}, &st)
	kinds := map[string]File{}
	for _, f := range st.Files {
		kinds[f.Path] = f
	}
	if f := kinds["a.txt"]; f.X != "M" || f.Y != "M" || f.Kind != "changed" {
		t.Errorf("a.txt %+v", f)
	}
	if f := kinds["new dir/u.txt"]; f.Kind != "untracked" {
		t.Errorf("u.txt %+v", f)
	}
	if st.Branch != "main" || st.Head != info.Head {
		t.Errorf("status %+v", st)
	}

	var lg Log
	ok(t, env, "log", Params{Repo: dir}, &lg)
	if len(lg.Commits) != 5 || lg.More || lg.Branch != "main" {
		t.Fatalf("log %+v", lg)
	}
	if lg.Commits[0].Subject != "rename b" || len(lg.Commits[1].Parents) != 2 {
		t.Errorf("commits %+v", lg.Commits[:2])
	}
	refs := map[string]string{}
	for _, r := range lg.Refs {
		refs[r.Name] = r.Hash
	}
	if refs["refs/tags/v1"] != lg.Commits[0].Hash || refs["refs/heads/feature"] == "" {
		t.Errorf("refs %v", refs)
	}
	if len(lg.Stashes) != 1 || lg.Stashes[0].Base != lg.Commits[0].Hash || !strings.Contains(lg.Stashes[0].Message, "wip") {
		t.Errorf("stashes %+v", lg.Stashes)
	}
	var page Log
	ok(t, env, "log", Params{Repo: dir, Skip: 2, Limit: 2}, &page)
	if len(page.Commits) != 2 || !page.More || page.Commits[0].Hash != lg.Commits[2].Hash || page.Refs != nil {
		t.Errorf("page %+v", page)
	}
	ok(t, env, "log", Params{Repo: dir, Branches: []string{"feature"}}, &page)
	if len(page.Commits) != 2 {
		t.Errorf("feature log %+v", page.Commits)
	}
	fails(t, env, "log", Params{Repo: dir, Branches: []string{"--all"}}, "bad_ref")
	fails(t, env, "log", Params{Repo: dir, Branches: []string{"nope"}}, "bad_ref")

	var shown Shown
	ok(t, env, "show", Params{Repo: dir, Rev: lg.Commits[0].Hash}, &shown)
	if shown.Commit == nil || shown.Commit.Message != "rename b\n\nlonger body" || len(shown.Files) != 1 {
		t.Fatalf("show %+v", shown)
	}
	if f := shown.Files[0]; f.Status != "R" || f.Path != "c.txt" || f.Orig != "b.txt" {
		t.Errorf("rename %+v", f)
	}
	// The merge against its second parent: main's change.
	ok(t, env, "show", Params{Repo: dir, Rev: lg.Commits[1].Hash, Parent: 2}, &shown)
	if len(shown.Files) != 1 || shown.Files[0].Path != "a.txt" || shown.Files[0].Added != 1 {
		t.Errorf("merge vs 2 %+v", shown.Files)
	}
	// The root commit against the empty tree.
	ok(t, env, "show", Params{Repo: dir, Rev: lg.Commits[4].Hash}, &shown)
	if len(shown.Files) != 1 || shown.Files[0].Status != "A" || shown.Files[0].Added != 3 {
		t.Errorf("root %+v", shown.Files)
	}
	ok(t, env, "show", Params{Repo: dir, Rev: lg.Commits[4].Hash, Rev2: "main"}, &shown)
	if shown.Commit != nil || len(shown.Files) != 2 {
		t.Errorf("compare %+v", shown)
	}
	fails(t, env, "show", Params{Repo: dir, Rev: lg.Commits[0].Hash, Parent: 3}, "bad_params")

	blob := func(source, path string, parent int) Blob {
		var b Blob
		ok(t, env, "blob", Params{Repo: dir, Source: source, Path: path, Parent: parent}, &b)
		return b
	}
	if b := blob("worktree", "a.txt", 0); b.Text != "zero\none\ntwo\nthree\nfour\nfive\n" || b.MTime == 0 {
		t.Errorf("worktree %+v", b)
	}
	if b := blob("index", "a.txt", 0); b.Text != "one\ntwo\nthree\nfour\nfive\n" {
		t.Errorf("index %+v", b)
	}
	if b := blob("head", "a.txt", 0); b.Text != "one\ntwo\nthree\nfour\n" {
		t.Errorf("head %+v", b)
	}
	if b := blob(lg.Commits[0].Hash, "b.txt", 1); b.Text != "bee\n" {
		t.Errorf("parent %+v", b)
	}
	if b := blob("v1", "b.txt", 0); b.Exists {
		t.Errorf("gone %+v", b)
	}
	if b := blob("worktree", "bin.dat", 0); !b.Exists || !b.Binary || b.Text != "" {
		t.Errorf("binary %+v", b)
	}
	fails(t, env, "blob", Params{Repo: dir, Source: "worktree", Path: "../x"}, "bad_params")
	fails(t, env, "blob", Params{Repo: dir, Source: "--output=/tmp/x", Path: "a.txt"}, "bad_ref")

	var branches []Branch
	ok(t, env, "branches", Params{Repo: dir}, &branches)
	if len(branches) != 2 || !branches[1].Current || branches[1].Name != "main" || branches[0].Name != "feature" {
		t.Errorf("branches %+v", branches)
	}
	var tags []Tag
	ok(t, env, "tags", Params{Repo: dir}, &tags)
	if len(tags) != 1 || tags[0].Name != "v1" || !tags[0].Annotated || tags[0].Hash != lg.Commits[0].Hash {
		t.Errorf("tags %+v", tags)
	}
	var ds DiffStat
	ok(t, env, "diffStat", Params{Repo: dir}, &ds)
	if ds.Worktree["a.txt"] != [2]int{1, 0} || ds.Staged["a.txt"] != [2]int{1, 0} {
		t.Errorf("diffStat %+v", ds)
	}

	var w1, w2 Watch
	ok(t, env, "watch", Params{Repo: dir}, &w1)
	ok(t, env, "watch", Params{Repo: dir}, &w2)
	if w1.Token == "" || w1 != w2 {
		t.Errorf("watch %v %v", w1, w2)
	}
	time.Sleep(20 * time.Millisecond)
	sh(t, dir, "commit", "-q", "-m", "five")
	ok(t, env, "watch", Params{Repo: dir}, &w2)
	if w1 == w2 {
		t.Error("watch did not change after a commit")
	}
}

func TestConflictAndDetached(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	sh(t, dir, "checkout", "-q", "-b", "other")
	write(t, filepath.Join(dir, "a.txt"), "other\n")
	sh(t, dir, "commit", "-q", "-am", "other")
	sh(t, dir, "checkout", "-q", "main")
	write(t, filepath.Join(dir, "a.txt"), "mine\n")
	sh(t, dir, "commit", "-q", "-am", "mine")

	fails(t, env, "merge", Params{Repo: dir, Ref: "other"}, "conflicts")
	var info Repo
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.State != "merge" {
		t.Errorf("state %q", info.State)
	}
	var st Status
	ok(t, env, "status", Params{Repo: dir}, &st)
	if len(st.Files) != 1 || st.Files[0].Kind != "unmerged" || st.Files[0].X != "U" || st.State != "merge" {
		t.Errorf("status %+v", st)
	}
	ok(t, env, "abort", Params{Repo: dir, Op: "merge"}, nil)
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.State != "" {
		t.Errorf("after abort %q", info.State)
	}

	first := sh(t, dir, "rev-parse", "HEAD~1")
	ok(t, env, "checkout", Params{Repo: dir, Rev: first[:8]}, nil)
	ok(t, env, "repo", Params{Path: dir}, &info)
	if !info.Detached || info.Branch != "" || info.Head != first {
		t.Errorf("detached %+v", info)
	}
	ok(t, env, "status", Params{Repo: dir}, &st)
	if st.Branch != "" || st.Head != first {
		t.Errorf("detached status %+v", st)
	}
	ok(t, env, "checkout", Params{Repo: dir, Name: "main"}, nil)
}

// A linked worktree's .git is a file naming its git directory.
func TestWorktree(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	wt := filepath.Join(env.Home, "wt")
	sh(t, dir, "worktree", "add", "-q", "-b", "side", wt)
	wt, _ = filepath.EvalSymlinks(wt)
	gd, common := gitDirs(wt)
	if gd != filepath.Join(dir, ".git", "worktrees", "wt") || common != filepath.Join(dir, ".git") {
		t.Fatalf("gitDirs %q %q", gd, common)
	}
	var info Repo
	ok(t, env, "repo", Params{Path: wt}, &info)
	if info.Root != wt || info.Branch != "side" || info.GitDir != gd || filepath.Clean(info.CommonDir) != common {
		t.Errorf("repo %+v", info)
	}
	var w1, w2 Watch
	ok(t, env, "watch", Params{Repo: wt}, &w1)
	time.Sleep(20 * time.Millisecond)
	write(t, filepath.Join(wt, "w.txt"), "w\n")
	ok(t, env, "stage", Params{Repo: wt, Paths: []string{"w.txt"}}, nil)
	ok(t, env, "watch", Params{Repo: wt}, &w2)
	if w1 == w2 {
		t.Error("watch did not change after staging in a worktree")
	}
}

// A repository inside another one lists the outer one.
func TestNested(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	inner := filepath.Join(dir, "inner")
	os.Mkdir(inner, 0o755)
	sh(t, inner, "init", "-q", "-b", "main")
	var info Repo
	ok(t, env, "repo", Params{Path: inner}, &info)
	if info.Root != inner || len(info.Parents) != 1 || info.Parents[0] != dir || info.Head != "" {
		t.Errorf("nested %+v", info)
	}
	// Before the first commit: an empty log, staging and unstaging.
	var lg Log
	ok(t, env, "log", Params{Repo: inner}, &lg)
	if len(lg.Commits) != 0 {
		t.Errorf("log %+v", lg)
	}
	write(t, filepath.Join(inner, "x"), "x\n")
	ok(t, env, "stage", Params{Repo: inner, All: true}, nil)
	// Changed again after it was staged: unstaging still drops it from
	// the index and keeps the working tree's file.
	write(t, filepath.Join(inner, "x"), "x again\n")
	ok(t, env, "unstage", Params{Repo: inner, Paths: []string{"x"}}, nil)
	var st Status
	ok(t, env, "status", Params{Repo: inner}, &st)
	if len(st.Files) != 1 || st.Files[0].Kind != "untracked" {
		t.Errorf("status %+v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(inner, "x")); string(b) != "x again\n" {
		t.Errorf("working tree %q", b)
	}
	// From the outer repository the inner one is an untracked directory,
	// listed with a trailing "/"; it can be staged and unstaged, and a
	// discard does not delete a repository.
	sh(t, inner, "add", "x")
	sh(t, inner, "-c", "user.name=I", "-c", "user.email=i@example.com", "commit", "-q", "-m", "inner")
	ok(t, env, "status", Params{Repo: dir}, &st)
	if len(st.Files) != 1 || st.Files[0].Path != "inner/" || st.Files[0].Kind != "untracked" {
		t.Fatalf("outer status %+v", st)
	}
	var b Blob
	ok(t, env, "blob", Params{Repo: dir, Path: "inner/", Source: "worktree"}, &b)
	if b.Exists {
		t.Errorf("blob of a directory %+v", b)
	}
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"inner/"}}, nil)
	ok(t, env, "status", Params{Repo: dir}, &st)
	if len(st.Files) != 1 || st.Files[0].X != "A" || !st.Files[0].Submodule {
		t.Fatalf("staged %+v", st)
	}
	ok(t, env, "unstage", Params{Repo: dir, Paths: []string{st.Files[0].Path}}, nil)
	ok(t, env, "discard", Params{Repo: dir, Untracked: []string{"inner/"}}, nil)
	if _, err := os.Stat(filepath.Join(inner, ".git")); err != nil {
		t.Errorf("inner repository removed: %v", err)
	}
}

// On a branch without commits (an orphan), the log still has the other
// branches' commits.
func TestLogUnbornBranch(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	sh(t, dir, "checkout", "-q", "--orphan", "fresh")
	var lg Log
	ok(t, env, "log", Params{Repo: dir}, &lg)
	if len(lg.Commits) != 1 || lg.Head != "" || lg.Branch != "fresh" || len(lg.Refs) != 1 {
		t.Errorf("log %+v", lg)
	}
}

// A directory reached through a link to a directory: the top level is
// spelled through the link, as the explorer and editors show it.
func TestLogicalRoot(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	os.MkdirAll(filepath.Join(dir, "sub", "deeper"), 0o755)
	link := filepath.Join(env.Home, "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{link, filepath.Join(link, "sub"), filepath.Join(link, "sub", "deeper")} {
		var info Repo
		ok(t, env, "repo", Params{Path: p}, &info)
		if info.Root != link {
			t.Errorf("%s: root %q, want %q", p, info.Root, link)
		}
	}
	var st Status
	ok(t, env, "status", Params{Repo: link}, &st)
	// A link inside the repository: git's prefix is not the path's end,
	// the physical top level is answered.
	os.Symlink("sub", filepath.Join(dir, "alias"))
	var info Repo
	ok(t, env, "repo", Params{Path: filepath.Join(link, "alias")}, &info)
	if info.Root != dir {
		t.Errorf("through alias: %q, want %q", info.Root, dir)
	}
	for _, c := range []struct{ dir, top, prefix, want string }{
		{"/a/b/c", "/x/b", "c/", "/x/b"},
		{"/a/b/c", "/a/b", "c/", "/a/b"},
		{"/a/b/c", "/x", "b/c/", "/x"},
	} {
		if got := logical(c.dir, c.top, c.prefix); got != c.want {
			t.Errorf("logical(%q, %q, %q) = %q", c.dir, c.top, c.prefix, got)
		}
	}
}

// The watch: the whole token moves with the index, the refs token only
// with HEAD, refs and stashes, the config token with the configuration.
func TestWatch(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	watch := func(d string) Watch {
		var w Watch
		ok(t, env, "watch", Params{Repo: d}, &w)
		time.Sleep(20 * time.Millisecond)
		return w
	}
	w0 := watch(dir)
	write(t, filepath.Join(dir, "b.txt"), "b\n")
	if w := watch(dir); w != w0 {
		t.Errorf("an edit of the working tree moved %v", w)
	}
	sh(t, dir, "add", "b.txt")
	w1 := watch(dir)
	if w1.Token == w0.Token || w1.Refs != w0.Refs || w1.Config != w0.Config {
		t.Errorf("staging: %v → %v", w0, w1)
	}
	for _, step := range [][]string{{"commit", "-q", "-m", "b"}, {"branch", "x"}, {"stash", "push", "-q", "--include-untracked", "-m", "s"}} {
		if step[0] == "stash" {
			write(t, filepath.Join(dir, "u.txt"), "u\n")
		}
		sh(t, dir, step...)
		w2 := watch(dir)
		if w2.Refs == w1.Refs || w2.Token == w1.Token || w2.Config != w1.Config {
			t.Errorf("%s: %v → %v", step[0], w1, w2)
		}
		w1 = w2
	}
	sh(t, dir, "remote", "add", "o", "/nowhere")
	if w2 := watch(dir); w2.Config == w1.Config || w2.Token == w1.Token || w2.Refs != w1.Refs {
		t.Errorf("remote add: %v → %v", w1, w2)
	}

	// Refs in reftable (git 2.45 and later).
	rt := filepath.Join(env.Home, "rt")
	cmd := exec.Command("git", "init", "-q", "-b", "main", "--ref-format=reftable", rt)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("no reftable: %s", out)
	}
	rt, _ = filepath.EvalSymlinks(rt)
	sh(t, rt, "config", "user.name", "Tester")
	sh(t, rt, "config", "user.email", "tester@example.com")
	write(t, filepath.Join(rt, "a"), "a\n")
	sh(t, rt, "add", "a")
	sh(t, rt, "commit", "-q", "-m", "a")
	w0 = watch(rt)
	sh(t, rt, "branch", "other")
	if w := watch(rt); w.Refs == w0.Refs {
		t.Error("a branch in reftable did not move the refs token")
	}
}

// The status gives a changed file of the working tree its modification
// time and size: they move when it is edited again.
func TestStatusStamps(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	write(t, filepath.Join(dir, "a.txt"), "changed\n")
	write(t, filepath.Join(dir, "u.txt"), "u\n")
	write(t, filepath.Join(dir, "s.txt"), "s\n")
	sh(t, dir, "add", "s.txt")
	files := func() map[string]File {
		var st Status
		ok(t, env, "status", Params{Repo: dir}, &st)
		m := map[string]File{}
		for _, f := range st.Files {
			m[f.Path] = f
		}
		return m
	}
	f1 := files()
	if f := f1["a.txt"]; f.MTime == 0 || f.Size != 8 {
		t.Errorf("a.txt %+v", f)
	}
	if f := f1["u.txt"]; f.MTime == 0 || f.Size != 2 {
		t.Errorf("u.txt %+v", f)
	}
	if f := f1["s.txt"]; f.MTime != 0 {
		t.Errorf("staged only %+v", f)
	}
	write(t, filepath.Join(dir, "a.txt"), "changed again\n")
	if f := files()["a.txt"]; f.Y != f1["a.txt"].Y || f.Size == f1["a.txt"].Size {
		t.Errorf("edited again %+v", f)
	}
}

// Stage and discard many paths: they are split over runs of git.
func TestManyPaths(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	sub := strings.Repeat("long-directory-name-", 3)
	var ps []string
	for i := 0; i < 2500; i++ {
		p := sub + "/f" + strconv.Itoa(i)
		write(t, filepath.Join(dir, p), "x\n")
		ps = append(ps, p)
	}
	if runs := pathRuns(nil, ps); len(runs) < 2 {
		t.Fatalf("%d runs", len(runs))
	}
	ok(t, env, "stage", Params{Repo: dir, Paths: ps}, nil)
	if n := len(strings.Fields(sh(t, dir, "diff", "--cached", "--name-only"))); n != len(ps) {
		t.Errorf("%d staged", n)
	}
	ok(t, env, "unstage", Params{Repo: dir, All: true}, nil)
	ok(t, env, "discard", Params{Repo: dir, Untracked: ps}, nil)
	if l := sh(t, dir, "status", "--porcelain"); l != "" {
		t.Errorf("left %q", l)
	}
}

// A run that cannot start fails as what kept it: no git, no directory, or
// an argument list over the system's limit (not "git is missing").
func TestStartError(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	code := func(err error) string {
		var pe *plugin.Error
		if errors.As(err, &pe) {
			return pe.Code
		}
		return fmt.Sprint(err)
	}
	_, err := execGit(context.Background(), env, dir, true, run{args: []string{"log", strings.Repeat("x", 4<<20)}})
	if c := code(err); c != "failed" {
		t.Errorf("long arguments: %s (%v)", c, err)
	}
	_, err = execGit(context.Background(), env, filepath.Join(dir, "gone"), true, run{args: []string{"status"}})
	if c := code(err); c != "not_found" {
		t.Errorf("no directory: %s (%v)", c, err)
	}
	old := lookGit
	lookGit = func() (string, error) { return filepath.Join(dir, "no-git"), nil }
	defer func() { lookGit = old }()
	_, err = execGit(context.Background(), env, dir, true, run{args: []string{"status"}})
	if c := code(err); c != "git_missing" {
		t.Errorf("no git: %s (%v)", c, err)
	}
}

func TestWrites(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	status := func() map[string]File {
		var st Status
		ok(t, env, "status", Params{Repo: dir}, &st)
		m := map[string]File{}
		for _, f := range st.Files {
			m[f.Path] = f
		}
		return m
	}
	head := func(path string) string { return sh(t, dir, "show", "HEAD:"+path) }
	index := func(path string) string { return sh(t, dir, "show", ":"+path) }

	write(t, filepath.Join(dir, "a.txt"), "one\nTWO\nthree\n")
	write(t, filepath.Join(dir, "-n.txt"), "dash\n")
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"a.txt", "-n.txt"}}, nil)
	if s := status(); s["a.txt"].X != "M" || s["-n.txt"].X != "A" {
		t.Fatalf("staged %+v", s)
	}
	ok(t, env, "unstage", Params{Repo: dir, Paths: []string{"a.txt"}}, nil)
	if s := status(); s["a.txt"].X != "." || s["a.txt"].Y != "M" {
		t.Fatalf("unstaged %+v", s)
	}
	ok(t, env, "unstage", Params{Repo: dir, All: true}, nil)

	// A staged rename is unstaged with both its paths: nothing stays
	// staged.
	sh(t, dir, "mv", "a.txt", "moved.txt")
	if f := status()["moved.txt"]; f.Kind != "renamed" || f.Orig != "a.txt" {
		t.Fatalf("rename %+v", f)
	}
	ok(t, env, "unstage", Params{Repo: dir, Paths: []string{"moved.txt", "a.txt"}}, nil)
	for p, f := range status() {
		if f.X != "." && f.X != "?" {
			t.Errorf("%s still staged: %+v", p, f)
		}
	}
	os.Rename(filepath.Join(dir, "moved.txt"), filepath.Join(dir, "a.txt"))

	// A patch into the index, and the same patch taken back.
	patch := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n"
	ok(t, env, "applyPatch", Params{Repo: dir, Patch: patch, Cached: true}, nil)
	if got := index("a.txt"); got != "one\nTWO\nthree" {
		t.Fatalf("index %q", got)
	}
	ok(t, env, "applyPatch", Params{Repo: dir, Patch: patch, Cached: true, Reverse: true}, nil)
	if got := index("a.txt"); got != "one\ntwo\nthree" {
		t.Fatalf("index after reverse %q", got)
	}
	// Into the working tree: reverse discards the change.
	ok(t, env, "applyPatch", Params{Repo: dir, Patch: patch, Reverse: true}, nil)
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "one\ntwo\nthree\n" {
		t.Fatalf("worktree %q", b)
	}
	fails(t, env, "applyPatch", Params{Repo: dir, Patch: "not a patch"}, "git_failed")

	// Discard: a tracked change restored, an untracked file removed.
	write(t, filepath.Join(dir, "a.txt"), "changed\n")
	ok(t, env, "discard", Params{Repo: dir, Paths: []string{"a.txt"}, Untracked: []string{"-n.txt"}}, nil)
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(b) != "one\ntwo\nthree\n" {
		t.Errorf("discarded %q", b)
	}
	if _, err := os.Stat(filepath.Join(dir, "-n.txt")); !os.IsNotExist(err) {
		t.Errorf("untracked file kept: %v", err)
	}
	// clean leaves tracked files alone even when named as untracked.
	ok(t, env, "discard", Params{Repo: dir, Untracked: []string{"a.txt"}}, nil)
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err != nil {
		t.Errorf("tracked file removed: %v", err)
	}

	// Commit with the message on stdin, amend, signoff.
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\n")
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"a.txt"}}, nil)
	ok(t, env, "commit", Params{Repo: dir, Message: "--amend title  \n\n\n# kept as typed\nbody `x` $(y)\n\n"}, nil)
	if msg := sh(t, dir, "log", "-1", "--format=%B"); msg != "--amend title\n\n# kept as typed\nbody `x` $(y)" {
		t.Errorf("message %q", msg)
	}
	// A message that starts with "#" is a message.
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n")
	ok(t, env, "stage", Params{Repo: dir, Paths: []string{"a.txt"}}, nil)
	ok(t, env, "commit", Params{Repo: dir, Message: "#123 reported this"}, nil)
	if msg := sh(t, dir, "log", "-1", "--format=%B"); msg != "#123 reported this" {
		t.Errorf("message %q", msg)
	}
	sh(t, dir, "reset", "-q", "--soft", "HEAD~1")
	write(t, filepath.Join(dir, "a.txt"), "one\ntwo\nthree\nfour\n")
	sh(t, dir, "add", "a.txt")
	ok(t, env, "commit", Params{Repo: dir, Message: "four", Amend: true, Signoff: true}, nil)
	if msg := sh(t, dir, "log", "-1", "--format=%B"); !strings.HasPrefix(msg, "four\n\nSigned-off-by: Tester") {
		t.Errorf("amended %q", msg)
	}
	if n := sh(t, dir, "rev-list", "--count", "HEAD"); n != "2" {
		t.Errorf("%s commits", n)
	}
	fails(t, env, "commit", Params{Repo: dir, Message: "nothing"}, "git_failed")

	// Branches.
	ok(t, env, "branchCreate", Params{Repo: dir, Name: "topic", At: sh(t, dir, "rev-parse", "HEAD~1")}, nil)
	ok(t, env, "branchRename", Params{Repo: dir, Name: "topic", To: "topic2"}, nil)
	ok(t, env, "checkout", Params{Repo: dir, Name: "topic2"}, nil)
	write(t, filepath.Join(dir, "t.txt"), "t\n")
	sh(t, dir, "add", "t.txt")
	sh(t, dir, "commit", "-q", "-m", "topic")
	topic := sh(t, dir, "rev-parse", "HEAD")
	ok(t, env, "branchCreate", Params{Repo: dir, Name: "made", Checkout: true}, nil)
	if b := sh(t, dir, "branch", "--show-current"); b != "made" {
		t.Errorf("on %q", b)
	}
	ok(t, env, "checkout", Params{Repo: dir, Name: "main"}, nil)
	fails(t, env, "branchDelete", Params{Repo: dir, Name: "topic2"}, "git_failed")
	ok(t, env, "cherryPick", Params{Repo: dir, Rev: topic}, nil)
	if head("t.txt") != "t" {
		t.Error("cherry-pick")
	}
	ok(t, env, "revert", Params{Repo: dir, Rev: "HEAD"}, nil)
	if _, ok := status()["t.txt"]; ok {
		t.Error("revert left changes")
	}
	ok(t, env, "merge", Params{Repo: dir, Ref: "topic2", NoFF: true}, nil)
	if p := sh(t, dir, "log", "-1", "--format=%P"); len(strings.Fields(p)) != 2 {
		t.Errorf("merge parents %q", p)
	}
	ok(t, env, "branchDelete", Params{Repo: dir, Name: "topic2"}, nil)
	ok(t, env, "branchDelete", Params{Repo: dir, Name: "made", Force: true}, nil)

	// Reset.
	before := sh(t, dir, "rev-parse", "HEAD~1")
	ok(t, env, "reset", Params{Repo: dir, Rev: before, Mode: "hard"}, nil)
	if sh(t, dir, "rev-parse", "HEAD") != before {
		t.Error("reset")
	}

	// Tags.
	ok(t, env, "tagCreate", Params{Repo: dir, Name: "v1", Message: "release one"}, nil)
	ok(t, env, "tagCreate", Params{Repo: dir, Name: "light", At: before[:12]}, nil)
	if typ := sh(t, dir, "cat-file", "-t", "v1"); typ != "tag" {
		t.Errorf("v1 is a %s", typ)
	}
	ok(t, env, "tagDelete", Params{Repo: dir, Name: "light"}, nil)

	// Stashes.
	write(t, filepath.Join(dir, "a.txt"), "stash me\n")
	write(t, filepath.Join(dir, "un.txt"), "untracked\n")
	ok(t, env, "stashPush", Params{Repo: dir, Message: "--keep-index", IncludeUntracked: true}, nil)
	if len(status()) != 0 {
		t.Fatalf("stash left %+v", status())
	}
	if l := sh(t, dir, "stash", "list"); !strings.Contains(l, "--keep-index") {
		t.Errorf("stash list %q", l)
	}
	stash := func(n int) string { return sh(t, dir, "rev-parse", "stash@{"+strconv.Itoa(n)+"}") }
	ok(t, env, "stashApply", Params{Repo: dir, Index: 0, Hash: stash(0)}, nil)
	if len(status()) != 2 {
		t.Errorf("applied %+v", status())
	}
	sh(t, dir, "checkout", "--", "a.txt")
	os.Remove(filepath.Join(dir, "un.txt"))
	ok(t, env, "stashPop", Params{Repo: dir, Hash: stash(0)}, nil)
	sh(t, dir, "stash", "push", "-q", "-u")
	// The list changed since the UI read it (another stash pushed): the
	// entry at the index is not the one shown, nothing is dropped.
	shown := stash(0)
	write(t, filepath.Join(dir, "a.txt"), "another\n")
	sh(t, dir, "stash", "push", "-q")
	fails(t, env, "stashDrop", Params{Repo: dir, Index: 0, Hash: shown}, "stale")
	if n := len(strings.Fields(sh(t, dir, "stash", "list", "--format=%H"))); n != 2 {
		t.Fatalf("%d stashes", n)
	}
	ok(t, env, "stashDrop", Params{Repo: dir, Index: 1, Hash: shown}, nil)
	ok(t, env, "stashDrop", Params{Repo: dir, Index: 0, Hash: stash(0)}, nil)
	if l := sh(t, dir, "stash", "list"); l != "" {
		t.Errorf("stash list %q", l)
	}
	fails(t, env, "stashDrop", Params{Repo: dir, Index: 3, Hash: shown}, "stale")

	// Rebase.
	sh(t, dir, "checkout", "-q", "-b", "re")
	write(t, filepath.Join(dir, "r.txt"), "r\n")
	sh(t, dir, "add", "r.txt")
	sh(t, dir, "commit", "-q", "-m", "r")
	sh(t, dir, "checkout", "-q", "main")
	write(t, filepath.Join(dir, "m.txt"), "m\n")
	sh(t, dir, "add", "m.txt")
	sh(t, dir, "commit", "-q", "-m", "m")
	sh(t, dir, "checkout", "-q", "re")
	ok(t, env, "rebase", Params{Repo: dir, Onto: "main"}, nil)
	if sh(t, dir, "rev-parse", "HEAD~1") != sh(t, dir, "rev-parse", "main") {
		t.Error("rebase")
	}
}

// Push, fetch and pull with a bare repository as the remote.
func TestRemote(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	bare := filepath.Join(env.Home, "bare.git")
	sh(t, env.Home, "init", "-q", "--bare", "-b", "main", bare)
	sh(t, dir, "remote", "add", "origin", bare)
	ok(t, env, "push", Params{Repo: dir, Remote: "origin", Branch: "main", SetUpstream: true}, nil)
	var info Repo
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.Upstream != "origin/main" || info.Ahead != 0 || len(info.Remotes) != 1 {
		t.Errorf("repo %+v", info)
	}
	// Another clone pushes; fetch and pull bring it.
	other := filepath.Join(env.Home, "other")
	sh(t, env.Home, "clone", "-q", bare, other)
	sh(t, other, "config", "user.name", "O")
	sh(t, other, "config", "user.email", "o@example.com")
	write(t, filepath.Join(other, "o.txt"), "o\n")
	sh(t, other, "add", "o.txt")
	sh(t, other, "commit", "-q", "-m", "o")
	sh(t, other, "push", "-q")
	ok(t, env, "fetch", Params{Repo: dir, Remote: "origin", Prune: true}, nil)
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.Behind != 1 {
		t.Errorf("behind %d", info.Behind)
	}
	ok(t, env, "pull", Params{Repo: dir, Rebase: true}, nil)
	if _, err := os.Stat(filepath.Join(dir, "o.txt")); err != nil {
		t.Error("pull")
	}
	ok(t, env, "tagCreate", Params{Repo: dir, Name: "v2"}, nil)
	ok(t, env, "push", Params{Repo: dir, Remote: "origin", Tag: "v2"}, nil)
	sh(t, bare, "rev-parse", "refs/tags/v2")
	ok(t, env, "tagDelete", Params{Repo: dir, Name: "v2", Remote: "origin"}, nil)
	ok(t, env, "fetch", Params{Repo: dir, All: true}, nil)
	ok(t, env, "push", Params{Repo: dir}, nil)
	fails(t, env, "push", Params{Repo: dir, Remote: "upstream"}, "not_found")

	// A second remote: its URL (without a user or token), a fetch from
	// it, a push that makes it the upstream, a pull of one of its
	// branches named by its full ref.
	second := filepath.Join(env.Home, "second.git")
	sh(t, env.Home, "init", "-q", "--bare", "-b", "main", second)
	sh(t, dir, "remote", "add", "second", second)
	sh(t, dir, "remote", "add", "token", "https://user:secret@example.com/r.git")
	ok(t, env, "repo", Params{Path: dir}, &info)
	if len(info.Remotes) != 3 || info.RemoteURLs["second"] != second || info.RemoteURLs["token"] != "https://example.com/r.git" {
		t.Errorf("remotes %v %v", info.Remotes, info.RemoteURLs)
	}
	sh(t, dir, "remote", "remove", "token")
	sh(t, dir, "checkout", "-q", "-b", "topic")
	ok(t, env, "push", Params{Repo: dir, Remote: "second", Branch: "topic", SetUpstream: true}, nil)
	ok(t, env, "repo", Params{Path: dir}, &info)
	if info.Upstream != "second/topic" {
		t.Errorf("upstream %q", info.Upstream)
	}
	write(t, filepath.Join(other, "s.txt"), "s\n")
	sh(t, other, "add", "s.txt")
	sh(t, other, "commit", "-q", "-m", "s")
	sh(t, other, "push", "-q", second, "HEAD:refs/heads/topic")
	ok(t, env, "fetch", Params{Repo: dir, Remote: "second"}, nil)
	ok(t, env, "pull", Params{Repo: dir, Remote: "second", Branch: "topic", Rebase: true}, nil)
	if _, err := os.Stat(filepath.Join(dir, "s.txt")); err != nil {
		t.Error("pull from second/topic")
	}
	for _, b := range []string{"-x", "a:b", "a..b", "x y"} {
		fails(t, env, "pull", Params{Repo: dir, Remote: "second", Branch: b}, "bad_ref")
	}
	sh(t, dir, "checkout", "-q", "main")

	// Branches that diverged: a pull follows the user's configuration
	// (pull.rebase), and without one git's refusal is diverged.
	diverge := func(n string) {
		write(t, filepath.Join(other, "o"+n), n)
		sh(t, other, "add", "o"+n)
		sh(t, other, "commit", "-q", "-m", "other "+n)
		sh(t, other, "pull", "-q", "--rebase")
		sh(t, other, "push", "-q")
		write(t, filepath.Join(dir, "d"+n), n)
		sh(t, dir, "add", "d"+n)
		sh(t, dir, "commit", "-q", "-m", "mine "+n)
	}
	diverge("1")
	if gitAtLeast(t, 2, 34) {
		fails(t, env, "pull", Params{Repo: dir}, "diverged")
	}
	sh(t, dir, "config", "pull.rebase", "true")
	ok(t, env, "pull", Params{Repo: dir}, nil)
	if p := sh(t, dir, "log", "-1", "--format=%P"); len(strings.Fields(p)) != 1 || sh(t, dir, "rev-parse", "HEAD~1") != sh(t, dir, "rev-parse", "origin/main") {
		t.Errorf("not rebased: parents %q", p)
	}
}

// gitAtLeast reports whether the git of the tests is at least major.minor.
func gitAtLeast(t *testing.T, major, minor int) bool {
	t.Helper()
	var a, b int
	fmt.Sscanf(strings.TrimPrefix(sh(t, t.TempDir(), "--version"), "git version "), "%d.%d", &a, &b)
	return a > major || a == major && b >= minor
}

// A remote that asks for a password fails with auth_required instead of
// waiting for one.
func TestAuthRequired(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	sh(t, dir, "remote", "add", "origin", srv.URL+"/repo.git")
	t.Setenv("GIT_ASKPASS", "/bin/echo")
	t.Setenv("SSH_ASKPASS", "/bin/echo")
	fails(t, env, "fetch", Params{Repo: dir, Remote: "origin"}, "auth_required")
}

// The environment of a run: no variables that point git elsewhere or ask
// for credentials; no optional locks for reads.
func TestEnviron(t *testing.T) {
	env := &plugin.Env{Environ: func() []string {
		return []string{"PATH=/bin", "GIT_DIR=/x", "GIT_ASKPASS=/a", "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=core.pager", "LANG=de_DE",
			"GIT_CONFIG_GLOBAL=/tmp/evil", "GIT_ATTR_SOURCE=HEAD~1", "GIT_TRACE=/tmp/trace", "GIT_EXEC_PATH=/x", "GIT_PAGER=less",
			"SSH_ASKPASS=/a", "GIT_SSH_COMMAND=ssh -i k", "GIT_SSH=/usr/bin/ssh", "GIT_SSH_VARIANT=ssh", "GIT_AUTHOR_NAME=A", "GIT_COMMITTER_EMAIL=c@x",
			"GIT_LITERAL_PATHSPECS=1", "GIT_GLOB_PATHSPECS=1"}
	}}
	got := strings.Join(environ(env, true), "\n")
	// Hooks get the environment too: none sets how their pathspecs read.
	for _, bad := range []string{"GIT_DIR", "GIT_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "LANG=", "GIT_CONFIG_GLOBAL",
		"GIT_ATTR_SOURCE", "GIT_TRACE", "GIT_EXEC_PATH", "GIT_PAGER=less", "SSH_ASKPASS=", "PATHSPECS"} {
		if strings.Contains(got, bad) {
			t.Errorf("%s passed: %s", bad, got)
		}
	}
	for _, want := range []string{"PATH=/bin", "LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0",
		"GIT_SSH_COMMAND=ssh -i k", "GIT_SSH=/usr/bin/ssh", "GIT_SSH_VARIANT=ssh", "GIT_AUTHOR_NAME=A", "GIT_COMMITTER_EMAIL=c@x"} {
		if !strings.Contains(got, want) {
			t.Errorf("%s missing: %s", want, got)
		}
	}
	if strings.Contains(strings.Join(environ(env, false), "\n"), "GIT_OPTIONAL_LOCKS") {
		t.Error("optional locks off for a change")
	}
}

// The web UI's patches of selected ranges (web/src/plugins/git/patch.ts,
// design/testdata/git/range-patches.json) apply with git apply and give
// the vectors' results.
func TestRangePatchVectors(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	b, err := os.ReadFile("../../../../design/testdata/git/range-patches.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Path, Original, Modified, Direction string
		Patch, Result                             *string
	}
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		if v.Patch == nil {
			if v.Result != nil {
				t.Errorf("%s: no patch, a result", v.Name)
			}
			continue
		}
		base := v.Original
		if v.Direction == "backward" {
			base = v.Modified
		}
		write(t, filepath.Join(dir, v.Path), base)
		sh(t, dir, "add", "--", v.Path)
		if rep := call(t, env, "applyPatch", Params{Repo: dir, Patch: *v.Patch, Cached: true}); !rep.OK {
			t.Errorf("%s: %s\n%s", v.Name, rep.Error, *v.Patch)
			continue
		}
		cmd := exec.Command("git", "cat-file", "blob", ":0:"+v.Path)
		cmd.Dir = dir
		got, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != *v.Result {
			t.Errorf("%s: index %q, want %q", v.Name, got, *v.Result)
		}
	}
}

// A file of the working tree is read only inside the repository: a link
// to a directory outside does not lead there; a link is shown as its
// target.
func TestWorktreeBlobLinks(t *testing.T) {
	env := testEnv(t)
	dir := newRepo(t, env)
	if err := os.Symlink("/", filepath.Join(dir, "out")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "sub/x.txt"), "x\n")
	os.Symlink("sub", filepath.Join(dir, "in"))
	os.Symlink("/etc/hosts", filepath.Join(dir, "hosts"))
	blob := func(path string) Blob {
		var b Blob
		ok(t, env, "blob", Params{Repo: dir, Source: "worktree", Path: path}, &b)
		return b
	}
	if b := blob("out/etc/hosts"); b.Exists || b.Text != "" {
		t.Errorf("out/etc/hosts %+v", b)
	}
	if b := blob("in/x.txt"); b.Text != "x\n" {
		t.Errorf("in/x.txt %+v", b)
	}
	if b := blob("hosts"); b.Text != "/etc/hosts" {
		t.Errorf("hosts %+v", b)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo"), 0o600); err == nil {
		if b := blob("fifo"); b.Exists {
			t.Errorf("fifo %+v", b)
		}
	}
}

//go:build unix

package sessions

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// real is p resolved through symlinks (the temporary directory of macOS is
// under a symlink).
func real(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestLocateBadID(t *testing.T) {
	e := newEnv(t)
	e.claudeTranscript("", cwd, sid(1), e.now, e.now)
	for _, id := range []string{
		"", "../x", "*", sid(1)[:35], sid(1) + "\n", strings.ToUpper(sid(1)), "../" + sid(1),
		sid(1) + "/../" + sid(1), " " + sid(1), "00000001-0000-4000-8000-00000000000g", sid(1) + "0",
	} {
		for _, kind := range []string{"claude", "codex", "gemini"} {
			if _, err := e.r.Locate(kind, id); !errors.Is(err, ErrBadID) {
				t.Errorf("Locate(%q, %q) = %v", kind, id, err)
			}
			if _, err := e.r.Describe(kind, id); !errors.Is(err, ErrBadID) {
				t.Errorf("Describe(%q, %q) = %v", kind, id, err)
			}
		}
	}
	for _, kind := range []string{"gemini", "agy", "", "Claude"} {
		if _, err := e.r.Locate(kind, sid(1)); !errors.Is(err, ErrUnknownKind) {
			t.Errorf("Locate(%q) = %v", kind, err)
		}
	}
}

func TestLocateClaude(t *testing.T) {
	e := newEnv(t)
	at := e.now.Add(-time.Hour)
	f := e.claudeTranscript("", cwd, sid(1), at, at)
	sub := filepath.Join(strings.TrimSuffix(f, ".jsonl"), "subagents")
	e.write(filepath.Join(sub, "agent-b.jsonl"), "{}\n", time.Time{})
	e.write(filepath.Join(sub, "agent-a.jsonl"), "{}\n", time.Time{})
	e.write(filepath.Join(sub, "notes.txt"), "x", time.Time{})
	secret := e.write(filepath.Join(t.TempDir(), "secret.jsonl"), "{}\n", time.Time{})
	os.Symlink(secret, filepath.Join(sub, "agent-c.jsonl"))
	unix.Mkfifo(filepath.Join(sub, "agent-d.jsonl"), 0o600)

	var got File
	var err error
	within(t, 5*time.Second, func() { got, err = e.r.Locate("claude", sid(1)) })
	if err != nil || got.Path != real(t, f) {
		t.Fatalf("Locate = %+v, %v", got, err)
	}
	rs := real(t, sub)
	if len(got.Subagents) != 2 || got.Subagents[0] != filepath.Join(rs, "agent-a.jsonl") || got.Subagents[1] != filepath.Join(rs, "agent-b.jsonl") {
		t.Errorf("subagents = %v", got.Subagents)
	}
	info, err := e.r.Describe("claude", sid(1))
	if err != nil || info.Cwd != cwd || !info.Started.Equal(at.Truncate(time.Millisecond)) {
		t.Errorf("Describe = %+v, %v", info, err)
	}
	if _, err := e.r.Locate("claude", sid(2)); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}

	// The answer is kept, and checked again: gone, then a symlink out.
	os.Remove(f)
	if _, err := e.r.Locate("claude", sid(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("removed: %v", err)
	}
	os.Symlink(secret, f)
	if _, err := e.r.Locate("claude", sid(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("symlink out of the root: %v", err)
	}
}

func TestLocateClaudeFiles(t *testing.T) {
	id := sid(1)
	tests := []struct {
		name  string
		setup func(e *testEnv) string // returns the expected path ("" for none)
		want  error
	}{
		{"symlink escaping the root", func(e *testEnv) string {
			out := e.write(filepath.Join(e.t.TempDir(), "x.jsonl"), "{}\n", time.Time{})
			os.MkdirAll(filepath.Join(e.home, ".claude/projects/p"), 0o700)
			os.Symlink(out, filepath.Join(e.home, ".claude/projects/p", id+".jsonl"))
			return ""
		}, ErrNotFound},
		{"symlinked project directory out of the root", func(e *testEnv) string {
			dir := e.t.TempDir()
			e.write(filepath.Join(dir, id+".jsonl"), "{}\n", time.Time{})
			os.MkdirAll(filepath.Join(e.home, ".claude/projects"), 0o700)
			os.Symlink(dir, filepath.Join(e.home, ".claude/projects/p"))
			return ""
		}, ErrNotFound},
		{"symlink inside the root", func(e *testEnv) string {
			f := e.claudeTranscriptIn("", "a", cwd, sid(9), e.now, e.now)
			os.MkdirAll(filepath.Join(e.home, ".claude/projects/b"), 0o700)
			os.Symlink(f, filepath.Join(e.home, ".claude/projects/b", id+".jsonl"))
			return f
		}, nil},
		{"a FIFO", func(e *testEnv) string {
			os.MkdirAll(filepath.Join(e.home, ".claude/projects/p"), 0o700)
			unix.Mkfifo(filepath.Join(e.home, ".claude/projects/p", id+".jsonl"), 0o600)
			return ""
		}, ErrNotFound},
		{"a directory", func(e *testEnv) string {
			os.MkdirAll(filepath.Join(e.home, ".claude/projects/p", id+".jsonl"), 0o700)
			return ""
		}, ErrNotFound},
		{"compressed only", func(e *testEnv) string {
			e.write(filepath.Join(".claude/projects/p", id+".jsonl.zst"), "zst", time.Time{})
			return ""
		}, ErrCompressed},
		{"compressed and plain", func(e *testEnv) string {
			e.write(filepath.Join(".claude/projects/p", id+".jsonl.zst"), "zst", time.Time{})
			return e.write(filepath.Join(".claude/projects/q", id+".jsonl"), "{}\n", time.Time{})
		}, nil},
		{"two: the most recently modified", func(e *testEnv) string {
			e.write(filepath.Join(".claude/projects/a", id+".jsonl"), "{}\n", e.now.Add(-time.Hour))
			newer := e.write(filepath.Join(".config/claude/projects/b", id+".jsonl"), "{}\n", e.now)
			e.write(filepath.Join(".claude/projects/c", id+".jsonl"), "{}\n", e.now.Add(-2*time.Hour))
			return newer
		}, nil},
		{"CLAUDE_CONFIG_DIR", func(e *testEnv) string {
			dir := filepath.Join(e.t.TempDir(), "cfg")
			e.vars["CLAUDE_CONFIG_DIR"] = dir
			return e.write(filepath.Join(dir, "projects/p", id+".jsonl"), "{}\n", time.Time{})
		}, nil},
		{"configuration directory behind a symlink", func(e *testEnv) string {
			dir := e.t.TempDir()
			f := e.write(filepath.Join(dir, "projects/p", id+".jsonl"), "{}\n", time.Time{})
			os.Symlink(dir, filepath.Join(e.home, ".claude"))
			return f
		}, nil},
		{"the projects directory a FIFO", func(e *testEnv) string {
			os.MkdirAll(filepath.Join(e.home, ".claude"), 0o700)
			unix.Mkfifo(filepath.Join(e.home, ".claude/projects"), 0o600)
			return ""
		}, ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			want := tt.setup(e)
			var got File
			var err error
			within(t, 5*time.Second, func() { got, err = e.r.Locate("claude", id) })
			if !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
			if want != "" && got.Path != real(t, want) {
				t.Errorf("path = %q, want %q", got.Path, real(t, want))
			}
		})
	}
}

func TestLocateCodex(t *testing.T) {
	// A version 7 id as Codex 0.170.0 made it (its session_meta says
	// 19:43:47.797), and a random one.
	v7 := "01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3"
	made, ok := uuidTime(v7)
	if !ok || made.UTC().Format(time.RFC3339Nano) != "2026-11-21T19:43:47.771Z" {
		t.Fatalf("uuidTime = %v %v", made.UTC(), ok)
	}
	if _, ok := uuidTime(sid(1)); ok {
		t.Error("a version 4 id has no time")
	}

	t.Run("dated, version 7", func(t *testing.T) {
		e := newEnv(t)
		f := e.rollout("", v7, cwd, made, made, 0)
		e.rollout("", sid(1), cwd, made, made, 0)
		got, err := e.r.Locate("codex", v7)
		if err != nil || got.Path != real(t, f) || got.Subagents != nil {
			t.Fatalf("Locate = %+v, %v", got, err)
		}
		info, err := e.r.Describe("codex", v7)
		if err != nil || info.Cwd != cwd || !info.Started.Equal(made) {
			t.Errorf("Describe = %+v, %v", info, err)
		}
	})
	t.Run("dated elsewhere, walked", func(t *testing.T) {
		e := newEnv(t)
		// The version 7 id's day has no match: the other days are read.
		f := e.rollout("", v7, cwd, made.AddDate(0, 2, 0), made, 0)
		got, err := e.r.Locate("codex", v7)
		if err != nil || got.Path != real(t, f) {
			t.Fatalf("Locate = %+v, %v", got, err)
		}
		g := e.rollout("", sid(1), cwd, made.AddDate(-1, 0, 0), made, 0)
		if got, err := e.r.Locate("codex", sid(1)); err != nil || got.Path != real(t, g) {
			t.Fatalf("Locate = %+v, %v", got, err)
		}
	})
	t.Run("archived", func(t *testing.T) {
		e := newEnv(t)
		home := filepath.Join(t.TempDir(), "ch")
		e.vars["CODEX_HOME"] = home
		f := e.write(filepath.Join(home, "archived_sessions", "rollout-2026-01-02T03-04-05-"+sid(1)+".jsonl"), "{}\n", time.Time{})
		got, err := e.r.Locate("codex", sid(1))
		if err != nil || got.Path != real(t, f) {
			t.Fatalf("Locate = %+v, %v", got, err)
		}
		if info, err := e.r.Describe("codex", sid(1)); err != nil || info != (Info{}) {
			t.Errorf("Describe of a file without session_meta = %+v, %v", info, err)
		}
	})
	t.Run("two: the most recently modified", func(t *testing.T) {
		e := newEnv(t)
		e.rollout("", sid(1), cwd, made, made, 0)
		newer := e.write(filepath.Join(".codex/archived_sessions", "rollout-2026-01-02T03-04-05-"+sid(1)+".jsonl"), "{}\n", made.Add(time.Hour))
		if got, err := e.r.Locate("codex", sid(1)); err != nil || got.Path != real(t, newer) {
			t.Fatalf("Locate = %+v, %v", got, err)
		}
	})
	t.Run("compressed only", func(t *testing.T) {
		e := newEnv(t)
		f := e.rollout("", v7, cwd, made, made, 0)
		os.Rename(f, f+".zst")
		if _, err := e.r.Locate("codex", v7); !errors.Is(err, ErrCompressed) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("not regular or outside", func(t *testing.T) {
		e := newEnv(t)
		f := e.rollout("", v7, cwd, made, made, 0)
		os.Remove(f)
		unix.Mkfifo(f, 0o600)
		dir := filepath.Dir(f)
		os.Mkdir(filepath.Join(dir, "rollout-x-"+sid(1)+".jsonl"), 0o700)
		out := e.write(filepath.Join(t.TempDir(), "o.jsonl"), "{}\n", time.Time{})
		os.Symlink(out, filepath.Join(dir, "rollout-y-"+sid(2)+".jsonl"))
		for _, id := range []string{v7, sid(1), sid(2)} {
			var err error
			within(t, 5*time.Second, func() { _, err = e.r.Locate("codex", id) })
			if !errors.Is(err, ErrNotFound) {
				t.Errorf("Locate(%s) = %v", id, err)
			}
		}
	})
}

func TestOpen(t *testing.T) {
	dir := real(t, t.TempDir())
	f := filepath.Join(dir, "f")
	os.WriteFile(f, []byte("x"), 0o600)
	fh, err := Open(f)
	if err != nil {
		t.Fatal(err)
	}
	fh.Close()
	fifo := filepath.Join(dir, "fifo")
	unix.Mkfifo(fifo, 0o600)
	link := filepath.Join(dir, "link")
	os.Symlink(f, link)
	sub := filepath.Join(dir, "sub")
	os.Mkdir(sub, 0o700)
	os.WriteFile(filepath.Join(sub, "g"), []byte("x"), 0o600)
	os.Symlink(sub, filepath.Join(dir, "linked"))
	two := filepath.Join(dir, "two")
	os.WriteFile(two, []byte("x"), 0o600)
	os.Link(two, filepath.Join(dir, "two-again"))
	for _, p := range []string{
		fifo, dir, link, "/dev/null", filepath.Join(dir, "missing"),
		// A link on the way, not only at the end.
		filepath.Join(dir, "linked", "g"),
		// A hard link: the file has another name, maybe outside.
		two,
		// Not absolute and clean.
		"f", dir + "/./f", dir + "/sub/../f",
	} {
		within(t, 5*time.Second, func() {
			if fh, err := Open(p); err == nil {
				fh.Close()
				t.Errorf("Open(%s) succeeded", p)
			}
		})
	}
	// A file of another user.
	defer func(u uint32) { agentUID = u }(agentUID)
	agentUID++
	if fh, err := Open(f); err == nil {
		fh.Close()
		t.Error("opened a file of another user")
	}
}

func TestZeroResolver(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "~/ch")
	e := &testEnv{t: t, home: home}
	f := e.claudeTranscript("", cwd, sid(1), time.Now(), time.Now())
	g := e.rollout(filepath.Join(home, "ch"), sid(2), cwd, time.Now(), time.Now(), 0)
	var r Resolver
	if got, err := r.Locate("claude", sid(1)); err != nil || got.Path != real(t, f) {
		t.Errorf("claude: %+v %v", got, err)
	}
	if got, err := r.Locate("codex", sid(2)); err != nil || got.Path != real(t, g) {
		t.Errorf("codex: %+v %v", got, err)
	}
}

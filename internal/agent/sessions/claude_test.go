//go:build unix

package sessions

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"veldr/internal/agentproto"
)

const cwd = "/home/dev/project"

func TestClaudeArgv(t *testing.T) {
	a, b := sid(1), sid(2)
	tests := []struct {
		argv []string
		want string
	}{
		{[]string{"claude", "--session-id", a}, a},
		{[]string{"claude", "--session-id=" + a}, a},
		{[]string{"claude", "--resume", a}, a},
		{[]string{"claude", "--resume=" + a}, a},
		{[]string{"claude", "-r", a}, a},
		{[]string{"/bin/sh", "/usr/local/bin/claude-wrapper", "--model", "opus", "-r", a, "fix it"}, a},
		// --fork-session makes a new session: the resumed one is not it.
		{[]string{"claude", "--resume", a, "--fork-session"}, ""},
		{[]string{"claude", "--resume", a, "--fork-session", "--session-id", b}, b},
		{[]string{"claude", "--continue"}, ""},
		{[]string{"claude", "--resume"}, ""},
		{[]string{"claude", "--resume", "my title"}, ""},
		{[]string{"claude", "--session-id", strings.ToUpper(a)}, ""},
		{[]string{"claude", "--session-id", a + "\n"}, ""},
		{[]string{"claude", "--", "--session-id", a}, ""},
		{[]string{"claude", "--session-id " + a}, ""},
		{nil, ""},
	}
	for _, tt := range tests {
		got, ok := claudeArgv(tt.argv)
		if got != tt.want || ok != (tt.want != "") {
			t.Errorf("claudeArgv(%q) = %q, %v; want %q", tt.argv, got, ok, tt.want)
		}
	}
}

func TestClaudeRecord(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	start := e.now.Add(-5 * time.Minute)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	p := Proc{PID: 100, Argv: []string{"claude"}, Cwd: cwd}

	if f, ok := e.r.Resolve(ctx, "claude", p); ok {
		t.Fatalf("no record yet: %+v", f)
	}
	before := e.r.Stamp("claude", p, Found{})
	e.record("", 100, sid(1), cwd, start.Add(800*time.Millisecond))
	if e.r.Stamp("claude", p, Found{}) == before {
		t.Error("the stamp does not change when the record is made")
	}
	f, ok := e.r.Resolve(ctx, "claude", p)
	if !ok || f != (Found{ID: sid(1), Source: agentproto.SessionFromPID}) {
		t.Fatalf("record: %+v %v", f, ok)
	}
	stamp := e.r.Stamp("claude", p, f)
	if stamp != e.r.Stamp("claude", p, f) {
		t.Error("the stamp changes with nothing changed")
	}

	// /clear rewrites the record with a new session.
	rec := e.record("", 100, sid(2), cwd, start.Add(800*time.Millisecond))
	later := time.Now().Add(time.Minute)
	os.Chtimes(rec, later, later)
	if e.r.Stamp("claude", p, f) == stamp {
		t.Error("the stamp does not change on /clear")
	}
	if f, ok := e.r.Resolve(ctx, "claude", p); !ok || f.ID != sid(2) || f.Source != agentproto.SessionFromPID {
		t.Fatalf("after /clear: %+v %v", f, ok)
	}

	// The command line's session is the initial answer; the record wins
	// when it names another one.
	p.Argv = []string{"claude", "--session-id", sid(2)}
	if f, _ := e.r.Resolve(ctx, "claude", p); f != (Found{ID: sid(2), Source: agentproto.SessionFromArgv}) {
		t.Errorf("argv agreeing with the record: %+v", f)
	}
	p.Argv = []string{"claude", "--session-id", sid(1)}
	if f, _ := e.r.Resolve(ctx, "claude", p); f != (Found{ID: sid(2), Source: agentproto.SessionFromPID}) {
		t.Errorf("record after /clear of an argv session: %+v", f)
	}
	os.Remove(rec)
	if f, _ := e.r.Resolve(ctx, "claude", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromArgv}) {
		t.Errorf("argv without a record: %+v", f)
	}
}

func TestClaudeRecordRejected(t *testing.T) {
	ctx := context.Background()
	start := time.Date(2026, 11, 22, 14, 55, 0, 0, time.Local)
	tests := []struct {
		name  string
		write func(e *testEnv)
	}{
		{"pid reused", func(e *testEnv) { e.record("", 100, sid(1), cwd, start.Add(-3*time.Hour)) }},
		{"another pid", func(e *testEnv) {
			e.write(".claude/sessions/100.json", `{"pid":101,"sessionId":"`+sid(1)+`"}`, time.Time{})
		}},
		{"not a session id", func(e *testEnv) {
			e.write(".claude/sessions/100.json", `{"pid":100,"sessionId":"../../etc/passwd"}`, time.Time{})
		}},
		{"upper case", func(e *testEnv) {
			e.write(".claude/sessions/100.json", `{"pid":100,"sessionId":"`+strings.ToUpper(sid(1))+`"}`, time.Time{})
		}},
		{"too large", func(e *testEnv) {
			e.write(".claude/sessions/100.json", `{"pid":100,"sessionId":"`+sid(1)+`","pad":"`+strings.Repeat("x", maxRecord)+`"}`, time.Time{})
		}},
		{"not JSON", func(e *testEnv) { e.write(".claude/sessions/100.json", "{", time.Time{}) }},
		{"a directory", func(e *testEnv) { os.MkdirAll(filepath.Join(e.home, ".claude/sessions/100.json"), 0o700) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
			tt.write(e)
			if f, ok := e.r.Resolve(ctx, "claude", Proc{PID: 100, Cwd: cwd}); ok {
				t.Errorf("found %+v", f)
			}
		})
	}
	// Without a start time to compare (the process is gone), the record is
	// believed.
	e := newEnv(t)
	e.record("", 100, sid(1), cwd, start.Add(-3*time.Hour))
	if f, ok := e.r.Resolve(ctx, "claude", Proc{PID: 100, Cwd: cwd}); !ok || f.ID != sid(1) {
		t.Errorf("record of a process without a start time: %+v %v", f, ok)
	}
}

func TestClaudeWrapper(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	start := e.now.Add(-time.Minute)
	// The terminal's program is a shell script; its child is a launcher
	// whose child is Claude Code. A background job of the script is in
	// another process group, and a process deeper than the bound is not
	// looked at.
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	e.procs[101] = fakeProc{ppid: 100, pgid: 100, start: start}
	e.procs[102] = fakeProc{ppid: 101, pgid: 100, start: start}
	e.procs[103] = fakeProc{ppid: 100, pgid: 103, start: start}
	e.procs[104] = fakeProc{ppid: 102, pgid: 100, start: start}
	e.procs[105] = fakeProc{ppid: 104, pgid: 100, start: start}
	p := Proc{PID: 100, Argv: []string{"/bin/sh", "/usr/local/bin/claude"}, Cwd: cwd}

	e.record("", 103, sid(3), cwd, start)
	e.record("", 105, sid(5), cwd, start)
	if f, ok := e.r.Resolve(ctx, "claude", p); ok {
		t.Fatalf("a process of another group or too deep: %+v", f)
	}
	e.record("", 102, sid(2), cwd, start)
	f, ok := e.r.Resolve(ctx, "claude", p)
	if !ok || f != (Found{ID: sid(2), Source: agentproto.SessionFromPID}) {
		t.Fatalf("wrapper: %+v %v", f, ok)
	}
	// The stamp watches the descendant's record.
	stamp := e.r.Stamp("claude", p, f)
	rec := e.record("", 102, sid(6), cwd, start)
	later := time.Now().Add(time.Minute)
	os.Chtimes(rec, later, later)
	os.Chtimes(filepath.Dir(rec), e.now, e.now)
	if e.r.Stamp("claude", p, f) == stamp {
		t.Error("the stamp does not follow the descendant's record")
	}

	if got := e.r.candidates(100); len(got) != 4 || got[0] != 100 || got[1] != 101 || got[2] != 102 || got[3] != 104 {
		t.Errorf("candidates = %v", got)
	}
	// A cycle in the table and a wide group stay bounded.
	e.procs = map[int]fakeProc{1000: {ppid: 1001, pgid: 1000}, 1001: {ppid: 1000, pgid: 1000}}
	for i := 0; i < 100; i++ {
		e.procs[2000+i] = fakeProc{ppid: 1000, pgid: 1000}
	}
	if got := e.r.candidates(1000); len(got) != maxCandidates || got[0] != 1000 {
		t.Errorf("bounded candidates = %d %v", len(got), got[:3])
	}
}

// TestClaudeKeyNeverOpened resolves beside Claude Code's keys
// (<pid>.<hex>.key, readable here): the recorder every test env installs
// sees every path the package opens and fails the test on a key.
func TestClaudeKeyNeverOpened(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	start := e.now.Add(-time.Minute)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	e.procs[200] = fakeProc{ppid: 1, pgid: 200, start: start}
	e.procs[300] = fakeProc{ppid: 1, pgid: 300, start: start}
	dir := filepath.Join(e.home, ".claude", "sessions")
	os.MkdirAll(dir, 0o700)
	for _, k := range []string{"100.6b1d0e.key", "200.0f3a.key", "300.9c.key", "100.json.key"} {
		body := `{"pid":100,"sessionId":"` + sid(7) + `","startedAt":` + fmt.Sprint(start.UnixMilli()) + `}`
		if err := os.WriteFile(filepath.Join(dir, k), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Another process's record is a FIFO: opening it must not block.
	if err := unix.Mkfifo(filepath.Join(dir, "300.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.record("", 200, sid(2), "/other", start)
	e.claudeTranscript("", cwd, sid(1), start, e.now)
	var f Found
	var ok bool
	within(t, 5*time.Second, func() { f, ok = e.r.Resolve(ctx, "claude", Proc{PID: 100, Cwd: cwd}) })
	if !ok || f != (Found{ID: sid(1), Source: agentproto.SessionFromGuess}) {
		t.Errorf("guess beside keys: %+v %v", f, ok)
	}
	within(t, 5*time.Second, func() { f, ok = e.r.Resolve(ctx, "claude", Proc{PID: 300, Cwd: cwd}) })
	within(t, 5*time.Second, func() { e.r.Stamp("claude", Proc{PID: 300, Cwd: cwd}, Found{}) })
	within(t, 5*time.Second, func() { e.r.Locate("claude", sid(1)) })
	// The recorder works: it saw the records the guess read for their
	// claims, the transcript and the sessions directory.
	opened := e.open.take()
	for _, want := range []string{filepath.Join(dir, "200.json"), filepath.Join(dir, "300.json"), dir} {
		if !slices.Contains(opened, want) {
			t.Errorf("%s not recorded in %q", want, opened)
		}
	}
}

func TestClaudeGuess(t *testing.T) {
	ctx := context.Background()
	start := time.Date(2026, 11, 22, 14, 55, 0, 0, time.Local)
	setup := func(t *testing.T) *testEnv {
		e := newEnv(t)
		e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
		return e
	}
	p := Proc{PID: 100, Argv: []string{"claude"}, Cwd: cwd}
	guess := func(id string) Found { return Found{ID: id, Source: agentproto.SessionFromGuess} }

	t.Run("newest since start", func(t *testing.T) {
		e := setup(t)
		e.claudeTranscript("", cwd, sid(1), start, start.Add(time.Minute))
		e.claudeTranscript("", cwd, sid(2), start, start.Add(2*time.Minute))
		e.claudeTranscript("", cwd, sid(3), start, start.Add(-time.Hour))
		if f, _ := e.r.Resolve(ctx, "claude", p); f != guess(sid(2)) {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("peers", func(t *testing.T) {
		e := setup(t)
		e.peers = 1
		e.claudeTranscript("", cwd, sid(1), start, start.Add(time.Minute))
		if f, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("guess with another terminal there: %+v", f)
		}
	})
	t.Run("older than the process", func(t *testing.T) {
		e := setup(t)
		e.claudeTranscript("", cwd, sid(1), start, start.Add(-3*time.Second))
		if f, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("got %+v", f)
		}
		e.claudeTranscript("", cwd, sid(1), start, start.Add(-time.Second))
		if f, _ := e.r.Resolve(ctx, "claude", p); f != guess(sid(1)) {
			t.Errorf("within the slack: %+v", f)
		}
	})
	t.Run("claimed by another process", func(t *testing.T) {
		e := setup(t)
		// The terminal core was started from a Claude Code session in the
		// same directory: its transcript is the newest, but its record
		// claims it.
		e.procs[50] = fakeProc{ppid: 1, pgid: 50, start: start.Add(-time.Hour)}
		e.record("", 50, sid(9), cwd, start.Add(-time.Hour))
		e.claudeTranscript("", cwd, sid(9), start, start.Add(3*time.Minute))
		e.claudeTranscript("", cwd, sid(1), start, start.Add(time.Minute))
		if f, _ := e.r.Resolve(ctx, "claude", p); f != guess(sid(1)) {
			t.Errorf("got %+v", f)
		}
		// A record of a process that is gone claims nothing.
		delete(e.procs, 50)
		if f, _ := e.r.Resolve(ctx, "claude", p); f != guess(sid(9)) {
			t.Errorf("stale record: %+v", f)
		}
	})
	t.Run("same escaped name, other directory", func(t *testing.T) {
		e := setup(t)
		e.claudeTranscript("", "/home/dev-project", sid(1), start, start.Add(time.Minute))
		if ClaudeEscape("/home/dev-project") != ClaudeEscape(cwd) {
			t.Fatal("the names should collide")
		}
		if f, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("long directory", func(t *testing.T) {
		e := setup(t)
		long := "/home/dev/" + strings.Repeat("deep/", 50) + "project"
		lp := Proc{PID: 100, Cwd: long}
		esc := ClaudeEscape(long)
		// Another long directory with the same first 200 characters, more
		// recently written.
		e.claudeTranscriptIn("", esc[:ClaudeMaxName]+"-abc123", long+"x", sid(2), start, start.Add(2*time.Minute))
		e.claudeTranscriptIn("", esc[:ClaudeMaxName]+"-1x9z", long, sid(1), start, start.Add(time.Minute))
		e.claudeTranscriptIn("", esc[:ClaudeMaxName-1], long, sid(3), start, start.Add(3*time.Minute))
		if got, _ := e.r.Resolve(ctx, "claude", lp); got != guess(sid(1)) {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("not a transcript name", func(t *testing.T) {
		e := setup(t)
		f := e.claudeTranscript("", cwd, sid(1), start, start.Add(time.Minute))
		os.Rename(f, filepath.Join(filepath.Dir(f), "notes.jsonl"))
		if got, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("stamp", func(t *testing.T) {
		e := setup(t)
		s0 := e.r.Stamp("claude", p, Found{})
		e.claudeTranscript("", cwd, sid(1), start, start.Add(time.Minute))
		s1 := e.r.Stamp("claude", p, Found{})
		if s0 == s1 {
			t.Error("the stamp does not change when a transcript is made")
		}
		f, _ := e.r.Resolve(ctx, "claude", p)
		if e.r.Stamp("claude", p, f) != s1 {
			t.Error("the stamp changes with nothing changed")
		}
	})
}

func TestClaudeEscape(t *testing.T) {
	for in, want := range map[string]string{
		"/home/dev/project":        "-home-dev-project",
		"/Users/a.b/my project_1":  "-Users-a-b-my-project-1",
		"/tmp/café":                "-tmp-caf-",
		"/tmp/\U0001F600":          "-tmp---",
		"/srv/日本":                  "-srv---",
		"C:\\Users\\x":             "C--Users-x",
		"/a/b-c/../d~e@f+g=h,i;j'": "-a-b-c----d-e-f-g-h-i-j-",
	} {
		if got := ClaudeEscape(in); got != want {
			t.Errorf("ClaudeEscape(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClaudeProcfs(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	boot := time.Date(2026, 11, 20, 8, 0, 0, 0, time.Local)
	fs := newProcfs(t, boot)
	e.r.procRoot, e.r.table, e.r.started = fs.root, nil, nil
	start := e.now.Add(-2 * time.Minute)
	cfg := filepath.Join(t.TempDir(), "cfg")

	// A wrapper with Claude Code as its child, whose own environment names
	// its configuration directory.
	fs.add(100, 1, 100, "bash", start, []string{"PATH=/bin"}, nil)
	fs.add(101, 100, 100, "2.1.330", start.Add(300*time.Millisecond), []string{"PATH=/bin", "CLAUDE_CONFIG_DIR=" + cfg}, nil)
	e.record(cfg, 101, sid(1), cwd, start.Add(time.Second))
	f, ok := e.r.Resolve(ctx, "claude", Proc{PID: 100, Argv: []string{"bash", "./claude"}, Cwd: cwd})
	if !ok || f != (Found{ID: sid(1), Source: agentproto.SessionFromPID}) {
		t.Fatalf("own CLAUDE_CONFIG_DIR: %+v %v", f, ok)
	}
	// The start time read from /proc rejects a record of a reused pid.
	e.record(cfg, 101, sid(1), cwd, start.Add(-10*time.Minute))
	if f, ok := e.r.Resolve(ctx, "claude", Proc{PID: 100, Cwd: cwd}); ok {
		t.Errorf("reused pid: %+v", f)
	}

	// A child session of another Claude Code keeps no transcript: the
	// newest one of the directory is not it.
	fs.add(200, 1, 200, "2.1.330", start, []string{"CLAUDE_CODE_CHILD_SESSION=1"}, nil)
	e.claudeTranscript("", cwd, sid(2), start, start.Add(time.Minute))
	if f, ok := e.r.Resolve(ctx, "claude", Proc{PID: 200, Cwd: cwd}); ok {
		t.Errorf("child session: %+v", f)
	}
	fs.add(300, 1, 300, "2.1.330", start, []string{"HOME=" + e.home}, nil)
	if f, _ := e.r.Resolve(ctx, "claude", Proc{PID: 300, Cwd: cwd}); f != (Found{ID: sid(2), Source: agentproto.SessionFromGuess}) {
		t.Errorf("guess: %+v", f)
	}
}

func TestUnknownKind(t *testing.T) {
	e := newEnv(t)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: e.now}
	e.record("", 100, sid(1), cwd, e.now)
	for _, k := range []string{"gemini", "agy", "", "nope", "Claude"} {
		if f, ok := e.r.Resolve(context.Background(), k, Proc{PID: 100, Argv: []string{"claude", "--session-id", sid(1)}, Cwd: cwd}); ok {
			t.Errorf("Resolve(%q) = %+v", k, f)
		}
		if s := e.r.Stamp(k, Proc{PID: 100}, Found{}); s != "" {
			t.Errorf("Stamp(%q) = %q", k, s)
		}
	}
}

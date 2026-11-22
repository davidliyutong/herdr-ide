//go:build unix

package sessions

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

func TestCodexArgv(t *testing.T) {
	a := sid(1)
	tests := []struct {
		argv []string
		want string
	}{
		{[]string{"codex", "resume", a}, a},
		{[]string{"codex", "-m", "gpt-5", "resume", a, "go on"}, a},
		{[]string{"codex", "exec", "resume", a}, a},
		{[]string{"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "resume", a}, a},
		{[]string{"codex", "resume", "--last"}, ""},
		{[]string{"codex", "resume"}, ""},
		{[]string{"codex", "resume", strings.ToUpper(a)}, ""},
		{[]string{"codex", "resume " + a}, ""},
		{[]string{"codex", "--", "resume", a}, ""},
		{[]string{"codex", "fork", a}, ""},
		{[]string{"codex"}, ""},
	}
	for _, tt := range tests {
		got, ok := codexArgv(tt.argv)
		if got != tt.want || ok != (tt.want != "") {
			t.Errorf("codexArgv(%q) = %q, %v; want %q", tt.argv, got, ok, tt.want)
		}
	}
}

func TestCodexResolve(t *testing.T) {
	ctx := context.Background()
	start := time.Date(2026, 11, 22, 14, 55, 0, 0, time.Local)
	setup := func(t *testing.T) *testEnv {
		e := newEnv(t)
		e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
		return e
	}
	p := Proc{PID: 100, Argv: []string{"codex"}, Cwd: cwd}

	t.Run("argv", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(2), cwd, start.Add(10*time.Second), start.Add(time.Minute), 0)
		q := p
		q.Argv = []string{"codex", "resume", sid(1)}
		if f, _ := e.r.Resolve(ctx, "codex", q); f != (Found{ID: sid(1), Source: agentproto.SessionFromArgv}) {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("no file yet", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(9), cwd, start.Add(-time.Hour), start.Add(-time.Hour), 0)
		e.rollout("", sid(8), "/other", start.Add(time.Second), start.Add(time.Minute), 0)
		if f, ok := e.r.Resolve(ctx, "codex", p); ok {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("exactly one", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(9), cwd, start.Add(-time.Hour), start.Add(time.Minute), 0)
		e.rollout("", sid(1), cwd, start.Add(20*time.Second), start.Add(time.Minute), 0)
		if f, _ := e.r.Resolve(ctx, "codex", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromStart}) {
			t.Errorf("got %+v", f)
		}
		e.peers = 1
		if f, ok := e.r.Resolve(ctx, "codex", p); ok {
			t.Errorf("with another terminal there: %+v", f)
		}
	})
	t.Run("two: the newest is a guess", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(1), cwd, start.Add(20*time.Second), start.Add(3*time.Minute), 0)
		e.rollout("", sid(2), cwd, start.Add(40*time.Second), start.Add(2*time.Minute), 0)
		if f, _ := e.r.Resolve(ctx, "codex", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromGuess}) {
			t.Errorf("got %+v", f)
		}
		e.peers = 1
		if f, ok := e.r.Resolve(ctx, "codex", p); ok {
			t.Errorf("with another terminal there: %+v", f)
		}
	})
	t.Run("made just before the process", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(1), cwd, start.Add(-1500*time.Millisecond), start.Add(time.Minute), 0)
		e.rollout("", sid(2), cwd, start.Add(-3*time.Second), start.Add(time.Minute), 0)
		if f, _ := e.r.Resolve(ctx, "codex", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromStart}) {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("large session_meta", func(t *testing.T) {
		e := setup(t)
		e.rollout("", sid(1), cwd, start.Add(time.Second), start.Add(time.Minute), 200<<10)
		if f, _ := e.r.Resolve(ctx, "codex", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromStart}) {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("name and session_meta disagree", func(t *testing.T) {
		e := setup(t)
		f := e.rollout("", sid(1), cwd, start.Add(time.Second), start.Add(time.Minute), 0)
		os.Rename(f, strings.Replace(f, sid(1), sid(2), 1))
		if got, ok := e.r.Resolve(ctx, "codex", p); ok {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("a day after the start, in CODEX_HOME", func(t *testing.T) {
		e := setup(t)
		home := filepath.Join(t.TempDir(), "codex")
		e.vars["CODEX_HOME"] = home
		e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start.AddDate(0, 0, -3)}
		e.rollout(home, sid(1), cwd, start.AddDate(0, 0, -1), start.Add(time.Minute), 0)
		if f, _ := e.r.Resolve(ctx, "codex", p); f != (Found{ID: sid(1), Source: agentproto.SessionFromStart}) {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("not a regular file", func(t *testing.T) {
		e := setup(t)
		f := e.rollout("", sid(1), cwd, start.Add(time.Second), start.Add(time.Minute), 0)
		os.Remove(f)
		os.Symlink(filepath.Join(e.home, "elsewhere.jsonl"), f)
		if got, ok := e.r.Resolve(ctx, "codex", p); ok {
			t.Errorf("got %+v", got)
		}
	})
}

func TestCodexStamp(t *testing.T) {
	e := newEnv(t)
	start := time.Date(2026, 11, 22, 14, 55, 0, 0, time.Local)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	p := Proc{PID: 100, Argv: []string{"codex"}, Cwd: cwd}
	s0 := e.r.Stamp("codex", p, Found{})
	if s0 != e.r.Stamp("codex", p, Found{}) {
		t.Error("the stamp changes with nothing changed")
	}
	f := e.rollout("", sid(1), cwd, start.Add(time.Second), start.Add(time.Minute), 0)
	s1 := e.r.Stamp("codex", p, Found{})
	if s1 == s0 {
		t.Error("the stamp does not change when a rollout is made")
	}
	found, _ := e.r.Resolve(context.Background(), "codex", p)
	// A rollout written to again: the answer of start does not change, a
	// guess may.
	os.Chtimes(f, start.Add(2*time.Minute), start.Add(2*time.Minute))
	if e.r.Stamp("codex", p, found) != s1 {
		t.Error("the stamp of a start answer follows writes")
	}
	g := Found{ID: sid(1), Source: agentproto.SessionFromGuess}
	sg := e.r.Stamp("codex", p, g)
	os.Chtimes(f, start.Add(3*time.Minute), start.Add(3*time.Minute))
	if e.r.Stamp("codex", p, g) == sg {
		t.Error("the stamp of a guess does not follow writes")
	}
	e.rollout("", sid(2), cwd, start.Add(time.Minute), start.Add(time.Minute), 0)
	if e.r.Stamp("codex", p, found) == s1 {
		t.Error("the stamp does not change when another rollout is made")
	}
}

func TestCodexFD(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	boot := time.Date(2026, 11, 20, 8, 0, 0, 0, time.Local)
	fs := newProcfs(t, boot)
	e.r.procRoot, e.r.table, e.r.started = fs.root, nil, nil
	start := e.now.Add(-time.Minute)
	rollout := e.rollout("", sid(1), "/somewhere/else", start.Add(-time.Hour), start, 0)
	outside := e.write("notes/rollout-2026-11-22T14-00-00-"+sid(2)+".jsonl", "{}\n", time.Time{})

	// npm's launcher and the native binary as its child, which holds the
	// rollout open; the launcher holds a rollout-like file outside the
	// sessions directory.
	fs.add(100, 1, 100, "node", start, []string{"PATH=/bin"}, map[string]string{"0": "/dev/pts/3", "20": outside})
	fs.add(101, 100, 100, "codex", start, []string{"PATH=/bin"}, map[string]string{"0": "/dev/pts/3", "1": "/dev/pts/3", "31": rollout})
	f, ok := e.r.Resolve(ctx, "codex", Proc{PID: 100, Argv: []string{"node", "codex"}, Cwd: cwd})
	if !ok || f != (Found{ID: sid(1), Source: agentproto.SessionFromFD}) {
		t.Fatalf("got %+v %v", f, ok)
	}
	// A process's own CODEX_HOME.
	home := filepath.Join(t.TempDir(), "ch")
	r2 := e.rollout(home, sid(3), cwd, start.Add(-time.Hour), start, 0)
	fs.add(200, 1, 200, "codex", start, []string{"CODEX_HOME=" + home}, map[string]string{"7": r2})
	if f, _ := e.r.Resolve(ctx, "codex", Proc{PID: 200, Cwd: cwd}); f != (Found{ID: sid(3), Source: agentproto.SessionFromFD}) {
		t.Errorf("own CODEX_HOME: %+v", f)
	}
	fs.add(300, 1, 300, "codex", start, []string{}, map[string]string{"7": r2})
	if f, ok := e.r.Resolve(ctx, "codex", Proc{PID: 300, Cwd: "/nowhere"}); ok {
		t.Errorf("a home not of the process: %+v", f)
	}
}

func TestCodexDays(t *testing.T) {
	at := func(d int, h int) time.Time { return time.Date(2026, 11, d, h, 0, 0, 0, time.Local) }
	tests := []struct {
		start, now time.Time
		want       []string
	}{
		{at(22, 10), at(22, 15), []string{"2026/11/23", "2026/11/22", "2026/11/21"}},
		{at(20, 10), at(22, 15), []string{"2026/11/23", "2026/11/22", "2026/11/21", "2026/11/20", "2026/11/19"}},
		{at(1, 10), at(22, 15), []string{"2026/11/23", "2026/11/22", "2026/11/21", "2026/11/20", "2026/11/19", "2026/11/18", "2026/11/17", "2026/11/16", "2026/11/15", "2026/10/31", "2026/11/01", "2026/11/02"}},
	}
	for _, tt := range tests {
		got := codexDays(tt.start, tt.now)
		if strings.Join(got, " ") != strings.Join(tt.want, " ") {
			t.Errorf("codexDays(%v, %v) = %v, want %v", tt.start, tt.now, got, tt.want)
		}
	}
}

func TestDecodeSessionMeta(t *testing.T) {
	id := sid(1)
	ts := "2026-11-22T14:55:01.5Z"
	tests := []struct {
		name, line string
		ok         bool
		cwd        string
	}{
		{"fixture order", `{"timestamp":"2026-11-22T14:55:09Z","ordinal":0,"type":"session_meta","payload":{"id":"` + id + `","timestamp":"` + ts + `","cwd":"/p","base_instructions":{"text":"x"}}}`, true, "/p"},
		{"payload first", `{"payload":{"base_instructions":{"text":"x","n":[1,2,{"a":null}]},"cwd":"/p","timestamp":"` + ts + `","id":"` + id + `"},"type":"session_meta"}`, true, "/p"},
		{"line timestamp", `{"timestamp":"` + ts + `","type":"session_meta","payload":{"id":"` + id + `","cwd":"/p"}}`, true, "/p"},
		{"another type", `{"timestamp":"` + ts + `","type":"event_msg","payload":{"id":"` + id + `","timestamp":"` + ts + `","cwd":"/p"}}`, false, ""},
		{"no cwd", `{"type":"session_meta","payload":{"id":"` + id + `","timestamp":"` + ts + `"}}`, false, ""},
		{"cut off", `{"type":"session_meta","payload":{"id":"` + id + `","base_instructions":"xxxx`, false, ""},
		{"not an object", `["session_meta"]`, false, ""},
		{"bad time", `{"type":"session_meta","payload":{"id":"` + id + `","timestamp":"yesterday","cwd":"/p"}}`, false, ""},
		{"empty", ``, false, ""},
	}
	for _, tt := range tests {
		m, ok := decodeSessionMeta(strings.NewReader(tt.line + "\n{\"type\":\"next\"}\n"))
		if ok != tt.ok || m.cwd != tt.cwd || (ok && (m.id != id || m.started.IsZero())) {
			t.Errorf("%s: %+v %v", tt.name, m, ok)
		}
	}
	// The fields Resolve reads come first: a line much longer than what is
	// read is enough.
	long := `{"type":"session_meta","payload":{"id":"` + id + `","timestamp":"` + ts + `","cwd":"/p","base_instructions":"` + strings.Repeat("x", 3<<20) + `"}}`
	if m, ok := decodeSessionMeta(strings.NewReader(long[:maxMetaLine])); !ok || m.cwd != "/p" {
		t.Errorf("long line: %+v %v", m, ok)
	}
}

func TestRolloutID(t *testing.T) {
	id := sid(7)
	for name, want := range map[string]string{
		"rollout-2026-11-22T03-43-47-" + id + ".jsonl":     id,
		"rollout-2026-11-22T03-43-47-" + id + ".jsonl.zst": "",
		"rollout-" + id + ".jsonl":                         "",
		"rollout--" + id + ".jsonl":                        id,
		"rollout-x" + id + ".jsonl":                        "",
		"rollout-2026-" + strings.ToUpper(id) + ".jsonl":   "",
		id + ".jsonl": "",
		"rollout-2026-11-22T03-43-47-" + id + "x.jsonl": "",
	} {
		if got, ok := rolloutID(name); got != want || ok != (want != "") {
			t.Errorf("rolloutID(%q) = %q, %v", name, got, ok)
		}
	}
}

// TestCodexOwnHome: a process's own CODEX_HOME (Linux, read from its
// environment) is searched for its rollouts only when the user's own: one
// the agent searches too, or owned by the user and written by no one else,
// as a process's own CLAUDE_CONFIG_DIR is (TestClaudeOwnConfigDir).
func TestCodexOwnHome(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	fs := newProcfs(t, e.now.Add(-time.Hour))
	e.r.procRoot, e.r.table, e.r.started = fs.root, nil, nil
	start := e.now.Add(-time.Minute)
	planted := t.TempDir()
	held := e.rollout(planted, sid(9), cwd, start.Add(time.Second), start.Add(2*time.Second), 0)
	// One holds the rollout open; the other made it since it started.
	fs.add(100, 1, 100, "codex", start, []string{"CODEX_HOME=" + planted}, map[string]string{"7": held})
	fs.add(200, 1, 200, "codex", start, []string{"CODEX_HOME=" + planted}, nil)
	byFD, byStart := Proc{PID: 100, Cwd: cwd}, Proc{PID: 200, Cwd: cwd}
	if f, ok := e.r.Resolve(ctx, "codex", byFD); !ok || f != (Found{ID: sid(9), Source: agentproto.SessionFromFD}) {
		t.Fatalf("held open in a home of the user's own: %+v %v", f, ok)
	}
	if f, ok := e.r.Resolve(ctx, "codex", byStart); !ok || f != (Found{ID: sid(9), Source: agentproto.SessionFromStart}) {
		t.Fatalf("made in a home of the user's own: %+v %v", f, ok)
	}
	// Writable by others: nothing in it is believed.
	for _, mode := range []os.FileMode{0o777, 0o757, 0o1777} {
		os.Chmod(planted, mode)
		for _, p := range []Proc{byFD, byStart} {
			if f, ok := e.r.Resolve(ctx, "codex", p); ok {
				t.Errorf("home %v, pid %d: %+v", mode, p.PID, f)
			}
		}
	}
	os.Chmod(planted, 0o700)
	defer func(u uint32) { agentUID = u }(agentUID)
	agentUID++
	if f, ok := e.r.Resolve(ctx, "codex", byFD); ok {
		t.Errorf("home of another user: %+v", f)
	}
	agentUID--
	// One the agent searches too is the user's whatever its mode.
	e.vars["CODEX_HOME"] = planted
	os.Chmod(planted, 0o777)
	defer os.Chmod(planted, 0o700)
	if f, ok := e.r.Resolve(ctx, "codex", byFD); !ok || f.ID != sid(9) {
		t.Errorf("the agent's own CODEX_HOME: %+v %v", f, ok)
	}
}

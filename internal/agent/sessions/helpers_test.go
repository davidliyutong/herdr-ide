//go:build unix

package sessions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProc is a process of a test's process table.
type fakeProc struct {
	ppid, pgid int
	start      time.Time
}

// testEnv is a temporary home, the agent's environment, a fake process
// table and clock, and a Resolver over them that reads no real process,
// environment or home.
type testEnv struct {
	t     *testing.T
	home  string
	vars  map[string]string
	procs map[int]fakeProc
	now   time.Time
	peers int
	r     *Resolver
	open  *opens
}

// opens records every path the package opens (openHook).
type opens struct {
	mu    sync.Mutex
	all   []string
	taken int
}

// record installs a recorder of the paths the package opens until the
// test ends, and fails the test when one of them is a key of Claude Code
// (<pid>.<hex>.key, never to be read).
func record(t *testing.T) *opens {
	t.Helper()
	o := &opens{}
	fn := func(p string) {
		o.mu.Lock()
		o.all = append(o.all, p)
		o.mu.Unlock()
	}
	openHook.Store(&fn)
	t.Cleanup(func() {
		openHook.Store(nil)
		o.mu.Lock()
		defer o.mu.Unlock()
		for _, p := range o.all {
			if strings.HasSuffix(p, ".key") {
				t.Errorf("opened a key: %s", p)
			}
		}
	})
	return o
}

// take returns the paths opened since the last take.
func (o *opens) take() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := slices.Clone(o.all[o.taken:])
	o.taken = len(o.all)
	return out
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	e := &testEnv{
		t: t, home: home, vars: map[string]string{}, procs: map[int]fakeProc{},
		now:  time.Date(2026, 11, 22, 15, 0, 0, 0, time.Local),
		open: record(t),
	}
	e.r = &Resolver{
		Home:   home,
		Getenv: func(k string) string { return e.vars[k] },
		Peers:  func(kind, cwd string) int { return e.peers },
		// An empty /proc: no process's environment or open files.
		procRoot: t.TempDir(),
		table: func(int) ([]procEntry, error) {
			var out []procEntry
			for pid, p := range e.procs {
				out = append(out, procEntry{PID: pid, PPID: p.ppid, PGID: p.pgid})
			}
			return out, nil
		},
		started: func(pid int) (time.Time, bool) {
			p, ok := e.procs[pid]
			return p.start, ok
		},
		now: func() time.Time { return e.now },
	}
	return e
}

// sid is a session id made from n.
func sid(n int) string { return fmt.Sprintf("%08x-abcd-4ef0-8abc-%012x", n, n) }

// write writes a file under the home (rel) with mtime mod (zero: now).
func (e *testEnv) write(rel, content string, mod time.Time) string {
	e.t.Helper()
	p := rel
	if !filepath.IsAbs(p) {
		p = filepath.Join(e.home, rel)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		e.t.Fatal(err)
	}
	if !mod.IsZero() {
		if err := os.Chtimes(p, mod, mod); err != nil {
			e.t.Fatal(err)
		}
	}
	return p
}

// record writes Claude Code's record of process pid in the claude dir dir
// ("" is ~/.claude), as Claude Code 2.1.330 writes it.
func (e *testEnv) record(dir string, pid int, id, cwd string, startedAt time.Time) string {
	e.t.Helper()
	if dir == "" {
		dir = filepath.Join(e.home, ".claude")
	}
	b, _ := json.Marshal(map[string]any{
		"pid": pid, "sessionId": id, "cwd": cwd, "startedAt": startedAt.UnixMilli(),
		"procStart": startedAt.UTC().Format("Mon Jan 2 15:04:05 2006"), "version": "2.1.330",
		"kind": "interactive", "entrypoint": "cli", "status": "idle", "updatedAt": startedAt.UnixMilli(),
	})
	return e.write(filepath.Join(dir, "sessions", fmt.Sprintf("%d.json", pid)), string(b), time.Time{})
}

// claudeTranscript writes a Claude Code transcript of cwd in the claude dir
// dir ("" is ~/.claude): stub lines, an attachment line longer than the
// reader's buffer naming another directory, then the first prompt.
func (e *testEnv) claudeTranscript(dir, cwd, id string, at, mod time.Time) string {
	e.t.Helper()
	return e.claudeTranscriptIn(dir, ClaudeEscape(cwd), cwd, id, at, mod)
}

// claudeTranscriptIn is claudeTranscript in the project directory project.
func (e *testEnv) claudeTranscriptIn(dir, project, cwd, id string, at, mod time.Time) string {
	e.t.Helper()
	if dir == "" {
		dir = filepath.Join(e.home, ".claude")
	}
	user, _ := json.Marshal(map[string]any{
		"parentUuid": nil, "isSidechain": false, "type": "user",
		"message":   map[string]any{"role": "user", "content": "hello"},
		"uuid":      "78850659-556e-420f-a477-038716d01f20",
		"timestamp": at.UTC().Format("2006-01-02T15:04:05.000Z"), "cwd": cwd, "sessionId": id,
	})
	lines := []string{
		`{"type":"mode","sessionId":"` + id + `"}`,
		`{"type":"permission-mode","sessionId":"` + id + `"}`,
		`{"type":"attachment","cwd":"/elsewhere","content":"` + strings.Repeat("x", 300<<10) + `"}`,
		string(user),
		`{"type":"assistant","cwd":"` + cwd + `","message":{"content":[]}}`,
	}
	return e.write(filepath.Join(dir, "projects", project, id+".jsonl"), strings.Join(lines, "\n")+"\n", mod)
}

// rollout writes a Codex rollout made at created in the dated directory of
// created under the Codex home home ("" is ~/.codex), whose session_meta
// carries pad bytes of instructions after the fields Resolve reads.
func (e *testEnv) rollout(home, id, cwd string, created, mod time.Time, pad int) string {
	e.t.Helper()
	if home == "" {
		home = filepath.Join(e.home, ".codex")
	}
	meta := fmt.Sprintf(`{"timestamp":%q,"ordinal":0,"type":"session_meta","payload":{"id":%q,"session_id":%q,"timestamp":%q,"cwd":%q,"originator":"codex-tui","cli_version":"0.170.0","base_instructions":{"text":%q}}}`,
		created.Add(time.Second).UTC().Format(time.RFC3339Nano), id, id, created.UTC().Format(time.RFC3339Nano), cwd, strings.Repeat("i", pad))
	body := meta + "\n" + `{"timestamp":"2026-11-22T14:00:00Z","type":"event_msg","payload":{"type":"task_started"}}` + "\n"
	name := "rollout-" + created.Local().Format("2006-01-02T15-04-05") + "-" + id + ".jsonl"
	return e.write(filepath.Join(home, "sessions", created.Local().Format("2006/01/02"), name), body, mod)
}

// within fails the test when f does not return within d.
func within(t *testing.T, d time.Duration, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatal("blocked")
	}
}

// fakeProcfs is a fake /proc: its stat has btime boot.
type fakeProcfs struct {
	t    *testing.T
	root string
	boot time.Time
}

func newProcfs(t *testing.T, boot time.Time) *fakeProcfs {
	root := t.TempDir()
	stat := "cpu  1 2 3 4\ncpu0 1 2 3 4\nintr 12 0 0 1\nctxt 99\nbtime " + fmt.Sprint(boot.Unix()) + "\nprocesses 7\n"
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte(stat), 0o600); err != nil {
		t.Fatal(err)
	}
	return &fakeProcfs{t: t, root: root, boot: boot}
}

// add adds a process started at start with the command name comm, the
// environment env and open files fds (fd number → target).
func (f *fakeProcfs) add(pid, ppid, pgid int, comm string, start time.Time, env []string, fds map[string]string) {
	f.t.Helper()
	dir := filepath.Join(f.root, fmt.Sprint(pid))
	if err := os.MkdirAll(filepath.Join(dir, "fd"), 0o700); err != nil {
		f.t.Fatal(err)
	}
	ticks := start.Sub(f.boot) / (time.Second / clockTicks)
	stat := fmt.Sprintf("%d (%s) S %d %d %d 34816 %d 4194304 100 0 0 0 5 3 0 0 20 0 1 0 %d 10000 200 18446744073709551615\n",
		pid, comm, ppid, pgid, pgid, pgid, ticks)
	if err := os.WriteFile(filepath.Join(dir, "stat"), []byte(stat), 0o600); err != nil {
		f.t.Fatal(err)
	}
	if env != nil {
		if err := os.WriteFile(filepath.Join(dir, "environ"), []byte(strings.Join(env, "\x00")+"\x00"), 0o600); err != nil {
			f.t.Fatal(err)
		}
	}
	for n, target := range fds {
		if err := os.Symlink(target, filepath.Join(dir, "fd", n)); err != nil {
			f.t.Fatal(err)
		}
	}
}

//go:build unix

package sessions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"herdr-ide/internal/agentproto"
)

// readAll reads f and closes it.
func readAll(t *testing.T, f *os.File) string {
	t.Helper()
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestOpenAfterSwap swaps, after Locate, a directory above the transcript
// and then the transcript itself for links out of the root: nothing opens
// the file outside.
func TestOpenAfterSwap(t *testing.T) {
	e := newEnv(t)
	id := sid(1)
	e.write(filepath.Join(".claude/projects/p", id+".jsonl"), "inside\n", time.Time{})
	got, err := e.r.Locate("claude", id)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	e.write(filepath.Join(outside, id+".jsonl"), "OUTSIDE\n", time.Time{})
	proj := filepath.Join(e.home, ".claude/projects/p")
	if err := os.Rename(proj, proj+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, proj); err != nil {
		t.Fatal(err)
	}
	if f, err := Open(got.Path); err == nil {
		t.Errorf("Open through a swapped directory read %q", readAll(t, f))
	}
	if f, err := got.Open(); !errors.Is(err, ErrNotFound) {
		if err == nil {
			t.Errorf("File.Open through a swapped directory read %q", readAll(t, f))
		} else {
			t.Errorf("File.Open: %v", err)
		}
	}
	// Located again: the transcript where it now is, inside the root.
	f, again, err := e.r.OpenLocated("claude", id)
	if err != nil {
		t.Fatalf("OpenLocated: %v", err)
	}
	if s := readAll(t, f); s != "inside\n" || again.Path != filepath.Join(real(t, proj+".old"), id+".jsonl") {
		t.Errorf("OpenLocated read %q at %s", s, again.Path)
	}

	// The transcript itself swapped for a link out.
	if err := os.Remove(again.Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, id+".jsonl"), again.Path); err != nil {
		t.Fatal(err)
	}
	if f, err := Open(again.Path); err == nil {
		t.Errorf("Open of a link read %q", readAll(t, f))
	}
	if f, err := again.Open(); !errors.Is(err, ErrNotFound) {
		if err == nil {
			t.Errorf("File.Open of a link read %q", readAll(t, f))
		} else {
			t.Errorf("File.Open: %v", err)
		}
	}
	if f, _, err := e.r.OpenLocated("claude", id); !errors.Is(err, ErrNotFound) {
		if err == nil {
			t.Errorf("OpenLocated of a link read %q", readAll(t, f))
		} else {
			t.Errorf("OpenLocated: %v", err)
		}
	}
}

// TestOpenReplaced replaces a located transcript with another file at the
// same name: File.Open refuses it (not the file Locate saw), OpenLocated
// locates it again.
func TestOpenReplaced(t *testing.T) {
	e := newEnv(t)
	id := sid(1)
	p := e.write(filepath.Join(".claude/projects/p", id+".jsonl"), "first\n", time.Time{})
	got, err := e.r.Locate("claude", id)
	if err != nil {
		t.Fatal(err)
	}
	f, err := got.Open()
	if err != nil {
		t.Fatal(err)
	}
	if s := readAll(t, f); s != "first\n" {
		t.Fatalf("read %q", s)
	}
	n := e.write(p+".new", "second\n", time.Time{})
	if err := os.Rename(n, p); err != nil {
		t.Fatal(err)
	}
	if f, err := got.Open(); !errors.Is(err, ErrNotFound) {
		if err == nil {
			f.Close()
		}
		t.Errorf("File.Open of another file: %v", err)
	}
	f, again, err := e.r.OpenLocated("claude", id)
	if err != nil {
		t.Fatal(err)
	}
	if s := readAll(t, f); s != "second\n" || again.Path != got.Path {
		t.Errorf("OpenLocated read %q at %s", s, again.Path)
	}
	// A File not made by Locate opens nothing.
	if f, err := (File{Path: got.Path}).Open(); !errors.Is(err, ErrNotFound) {
		if err == nil {
			f.Close()
		}
		t.Errorf("File without what Locate saw: %v", err)
	}
}

// TestLocateHardLink: a hard link inside the root to a file outside it is a
// regular file inside the root, but not one with a single name.
func TestLocateHardLink(t *testing.T) {
	e := newEnv(t)
	id := sid(2)
	out := e.write("outside-secret", "SECRET\n", time.Time{})
	dir := filepath.Join(e.home, ".claude/projects/p")
	os.MkdirAll(dir, 0o700)
	if err := os.Link(out, filepath.Join(dir, id+".jsonl")); err != nil {
		t.Skip(err)
	}
	if got, err := e.r.Locate("claude", id); !errors.Is(err, ErrNotFound) {
		t.Errorf("hard link located: %+v %v", got, err)
	}
	if f, _, err := e.r.OpenLocated("claude", id); err == nil {
		t.Errorf("hard link opened: %q", readAll(t, f))
	}

	// A subagent's transcript linked the same way is left out.
	main := e.claudeTranscript("", cwd, sid(3), e.now, e.now)
	sub := filepath.Join(strings.TrimSuffix(main, ".jsonl"), "subagents")
	e.write(filepath.Join(sub, "agent-a.jsonl"), "{}\n", time.Time{})
	os.Link(out, filepath.Join(sub, "agent-b.jsonl"))
	got, err := e.r.Locate("claude", sid(3))
	if err != nil || len(got.Subagents) != 1 || filepath.Base(got.Subagents[0]) != "agent-a.jsonl" {
		t.Errorf("subagents %+v %v", got, err)
	}

	// Once the file has one name again, it is located.
	os.Remove(out)
	os.Remove(filepath.Join(sub, "agent-b.jsonl"))
	e.now = e.now.Add(missRecheck)
	if _, err := e.r.Locate("claude", id); err != nil {
		t.Errorf("one name: %v", err)
	}
}

// TestLocateNotOwn: a transcript of another user is not located.
func TestLocateNotOwn(t *testing.T) {
	e := newEnv(t)
	e.claudeTranscript("", cwd, sid(1), e.now, e.now)
	defer func(u uint32) { agentUID = u }(agentUID)
	agentUID++
	if got, err := e.r.Locate("claude", sid(1)); !errors.Is(err, ErrNotFound) {
		t.Errorf("located %+v %v", got, err)
	}
}

func TestOpenSubagent(t *testing.T) {
	e := newEnv(t)
	main := e.claudeTranscript("", cwd, sid(1), e.now, e.now)
	sub := filepath.Join(strings.TrimSuffix(main, ".jsonl"), "subagents")
	e.write(filepath.Join(sub, "agent-a.jsonl"), "a\n", time.Time{})
	e.write(filepath.Join(sub, "agent-b.jsonl"), "b\n", time.Time{})
	f, got, err := e.r.OpenLocated("claude", sid(1))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if len(got.Subagents) != 2 {
		t.Fatalf("subagents %v", got.Subagents)
	}
	for i, want := range []string{"a\n", "b\n"} {
		f, err := got.OpenSubagent(i)
		if err != nil {
			t.Fatal(err)
		}
		if s := readAll(t, f); s != want {
			t.Errorf("subagent %d read %q", i, s)
		}
	}
	for _, i := range []int{-1, 2} {
		if f, err := got.OpenSubagent(i); !errors.Is(err, ErrNotFound) {
			if err == nil {
				f.Close()
			}
			t.Errorf("OpenSubagent(%d): %v", i, err)
		}
	}
	// Swapped for a link out, or for another file: refused.
	out := e.write(filepath.Join(t.TempDir(), "x.jsonl"), "OUTSIDE\n", time.Time{})
	os.Remove(got.Subagents[0])
	os.Symlink(out, got.Subagents[0])
	// Made before the old one goes, the other file has another inode.
	os.Rename(e.write(got.Subagents[1]+".new", "other\n", time.Time{}), got.Subagents[1])
	for i := range 2 {
		if f, err := got.OpenSubagent(i); !errors.Is(err, ErrNotFound) {
			if err == nil {
				t.Errorf("subagent %d read %q", i, readAll(t, f))
			} else {
				t.Errorf("subagent %d: %v", i, err)
			}
		}
	}
}

// TestWalkOpen opens element by element, as where the system cannot refuse
// links on a whole path in one call.
func TestWalkOpen(t *testing.T) {
	dir := real(t, t.TempDir())
	sub := filepath.Join(dir, "a", "b")
	os.MkdirAll(sub, 0o700)
	f := filepath.Join(sub, "f")
	os.WriteFile(f, []byte("x"), 0o600)
	os.Symlink(filepath.Join(dir, "a"), filepath.Join(dir, "la"))
	os.Symlink(f, filepath.Join(sub, "lf"))
	os.WriteFile(filepath.Join(dir, "plain"), nil, 0o600)
	fd, err := walkOpen(f)
	if err != nil {
		t.Fatal(err)
	}
	if fh := os.NewFile(uintptr(fd), f); readAll(t, fh) != "x" {
		t.Error("walkOpen read another file")
	}
	for _, p := range []string{
		filepath.Join(dir, "la", "b", "f"), filepath.Join(sub, "lf"), filepath.Join(dir, "plain", "f"),
		filepath.Join(sub, "missing"), "a/b", "/", sub + "/../b/f", sub + "//f",
	} {
		if fd, err := walkOpen(p); err == nil {
			unix.Close(fd)
			t.Errorf("walkOpen(%s) succeeded", p)
		}
	}
	// The open of the whole path agrees.
	fd, err = openNoLinks(f)
	if err != nil {
		t.Fatal(err)
	}
	unix.Close(fd)
	if fd, err := openNoLinks(filepath.Join(dir, "la", "b", "f")); err == nil {
		unix.Close(fd)
		t.Error("openNoLinks followed a link")
	}
}

// TestClaudeRecordStartedAt: when the process's start time is known, a
// record believed has a numeric startedAt that agrees with it.
func TestClaudeRecordStartedAt(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	start := e.now.Add(-time.Minute)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	p := Proc{PID: 100, Cwd: "/w"}
	for _, at := range []string{
		``, `,"startedAt":"1"`, `,"startedAt":"` + fmt.Sprint(start.UnixMilli()) + `"`, `,"startedAt":0`, `,"startedAt":-5`,
		`,"startedAt":1e300`, `,"startedAt":null`, `,"startedAt":true`, `,"startedAt":{}`,
		`,"startedAt":` + fmt.Sprint(e.now.Add(-48*time.Hour).UnixMilli()),
	} {
		e.write(".claude/sessions/100.json", fmt.Sprintf(`{"pid":100,"sessionId":%q%s}`, sid(7), at), time.Time{})
		if f, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("startedAt %q: %+v", at, f)
		}
	}
	e.write(".claude/sessions/100.json", fmt.Sprintf(`{"pid":100,"sessionId":%q,"startedAt":%d}`, sid(7), start.Add(time.Second).UnixMilli()), time.Time{})
	if f, ok := e.r.Resolve(ctx, "claude", p); !ok || f != (Found{ID: sid(7), Source: agentproto.SessionFromPID}) {
		t.Errorf("agreeing startedAt: %+v %v", f, ok)
	}
	// Without a start time to compare (the process is gone), the record is
	// believed, also without startedAt.
	delete(e.procs, 100)
	e.write(".claude/sessions/100.json", fmt.Sprintf(`{"pid":100,"sessionId":%q}`, sid(7)), time.Time{})
	if f, ok := e.r.Resolve(ctx, "claude", p); !ok || f.ID != sid(7) {
		t.Errorf("no start time: %+v %v", f, ok)
	}
}

// TestClaudeRecordTrust: a record is believed only when it is a file of the
// user's own in a directory no one else may write.
func TestClaudeRecordTrust(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	start := e.now.Add(-time.Minute)
	e.procs[100] = fakeProc{ppid: 1, pgid: 100, start: start}
	p := Proc{PID: 100, Cwd: "/w"}
	rec := e.record("", 100, sid(1), "/w", start)
	dir := filepath.Dir(rec)
	found := func() bool {
		t.Helper()
		f, ok := e.r.Resolve(ctx, "claude", p)
		return ok && f.Source == agentproto.SessionFromPID
	}
	if !found() {
		t.Fatal("a record of the user's own")
	}
	defer func(u, g uint32) { agentUID, agentGID = u, g }(agentUID, agentGID)
	agentUID++
	if found() {
		t.Error("a record of another user")
	}
	agentUID--
	// A directory the user's primary group may write: the user's own on
	// Linux (a user private group), not on macOS, where it is staff, every
	// user's.
	for _, c := range []struct {
		mode      os.FileMode
		gid       bool // the directory's group is the user's primary group
		ok, linux bool // believed elsewhere, believed on Linux
	}{
		{0o700, true, true, true}, {0o755, true, true, true}, {0o770, true, false, true}, {0o775, true, false, true},
		{0o770, false, false, false}, {0o777, true, false, false}, {0o703, true, false, false}, {0o1777, true, false, false},
	} {
		if err := os.Chmod(dir, c.mode); err != nil {
			t.Fatal(err)
		}
		agentGID = statGID(t, dir)
		if !c.gid {
			agentGID++
		}
		want := c.ok
		if runtime.GOOS == "linux" {
			want = c.linux
		}
		if got := found(); got != want {
			t.Errorf("%s: sessions directory %v (own group %v): believed %v", runtime.GOOS, c.mode, c.gid, got)
		}
	}
	if runtime.GOOS == "darwin" && userPrivateGroups {
		t.Error("macOS: a directory staff may write counts as private")
	}
	os.Chmod(dir, 0o700)
}

// statGID is the group of p.
func statGID(t *testing.T, p string) uint32 {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	st, ok := statInfo(fi)
	if !ok {
		t.Skip("no stat_t")
	}
	return st.gid
}

// TestClaudeOwnConfigDir: a process's own CLAUDE_CONFIG_DIR (Linux, read
// from its environment) is searched for its record only when the user's
// own: one the agent searches too, or owned by the user and written by no
// one else.
func TestClaudeOwnConfigDir(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	fs := newProcfs(t, e.now.Add(-time.Hour))
	e.r.procRoot, e.r.table, e.r.started = fs.root, nil, nil
	start := e.now.Add(-time.Minute)
	planted := t.TempDir()
	fs.add(100, 1, 100, "node", start, []string{"CLAUDE_CONFIG_DIR=" + planted}, nil)
	e.record(planted, 100, sid(9), "/w", start)
	// The user's own older session sid(9), which Locate finds.
	e.write(filepath.Join(".claude/projects/other", sid(9)+".jsonl"), "{}\n", time.Time{})
	p := Proc{PID: 100, Cwd: "/w"}
	if f, ok := e.r.Resolve(ctx, "claude", p); !ok || f.ID != sid(9) {
		t.Fatalf("a directory of the user's own: %+v %v", f, ok)
	}
	// Writable by others: nothing in it is believed (and no guess is made
	// from its transcripts).
	e.claudeTranscript(planted, "/w", sid(8), start, e.now)
	for _, mode := range []os.FileMode{0o777, 0o757, 0o1777} {
		os.Chmod(planted, mode)
		if f, ok := e.r.Resolve(ctx, "claude", p); ok {
			t.Errorf("directory %v: %+v", mode, f)
		}
	}
	os.Chmod(planted, 0o700)
	defer func(u uint32) { agentUID = u }(agentUID)
	agentUID++
	if f, ok := e.r.Resolve(ctx, "claude", p); ok {
		t.Errorf("directory of another user: %+v", f)
	}
	agentUID--
	// One the agent searches too is the user's whatever its mode.
	e.vars["CLAUDE_CONFIG_DIR"] = planted
	if !e.r.trustedDir(planted, e.r.ClaudeDirs()) {
		t.Error("the agent's own CLAUDE_CONFIG_DIR")
	}
	if !e.r.trustedDir(filepath.Join(planted, "not-yet"), e.r.ClaudeDirs()) {
		t.Error("a directory not made yet")
	}
}

// TestLocateMiss: a miss is remembered; a transcript made meanwhile is
// found within missRecheck of asking again, one that existed elsewhere
// within missTTL.
func TestLocateMiss(t *testing.T) {
	t.Run("codex", func(t *testing.T) {
		e := newEnv(t)
		// Many dated directories, read only by the search that walks them.
		for i := range 40 {
			e.rollout("", sid(1000+i), cwd, time.Date(2025, 1, 1+i%28, 12, 0, 0, 0, time.Local).AddDate(0, i/28, 0), time.Time{}, 0)
		}
		e.open.take()
		walked := func(opened []string) bool {
			return slices.ContainsFunc(opened, func(p string) bool { return strings.Contains(p, "/2025/") })
		}
		id := sid(1)
		if _, err := e.r.Locate("codex", id); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		if !walked(e.open.take()) {
			t.Fatal("the first search does not walk")
		}
		// Asked again at once: nothing is read.
		for range 100 {
			if _, err := e.r.Locate("codex", id); !errors.Is(err, ErrNotFound) {
				t.Fatal(err)
			}
		}
		if o := e.open.take(); len(o) != 0 {
			t.Errorf("a remembered miss read %q", o)
		}
		// After missRecheck: only where rollouts are made.
		e.now = e.now.Add(missRecheck)
		e.r.Locate("codex", id)
		if o := e.open.take(); len(o) == 0 || walked(o) {
			t.Errorf("the recheck read %q", o)
		}
		// A rollout made now is found at the next recheck.
		f := e.rollout("", id, cwd, e.now, e.now, 0)
		if _, err := e.r.Locate("codex", id); !errors.Is(err, ErrNotFound) {
			t.Errorf("within missRecheck: %v", err)
		}
		e.now = e.now.Add(missRecheck)
		if got, err := e.r.Locate("codex", id); err != nil || got.Path != real(t, f) {
			t.Errorf("made meanwhile: %+v %v", got, err)
		}
		// One that existed in a directory only the walk reads is found once
		// the miss expires.
		old := e.rollout("", sid(2), cwd, time.Date(2025, 3, 3, 12, 0, 0, 0, time.Local), time.Time{}, 0)
		os.Rename(old, old+".hidden")
		e.r.Locate("codex", sid(2))
		os.Rename(old+".hidden", old)
		e.now = e.now.Add(missRecheck)
		if _, err := e.r.Locate("codex", sid(2)); !errors.Is(err, ErrNotFound) {
			t.Errorf("walked within missTTL: %v", err)
		}
		e.now = e.now.Add(missTTL)
		if got, err := e.r.Locate("codex", sid(2)); err != nil || got.Path != real(t, old) {
			t.Errorf("after missTTL: %+v %v", got, err)
		}
	})
	t.Run("claude", func(t *testing.T) {
		e := newEnv(t)
		for i := range 20 {
			e.claudeTranscriptIn("", fmt.Sprintf("p%d", i), cwd, sid(100+i), e.now, e.now)
		}
		e.open.take()
		if _, err := e.r.Locate("claude", sid(1)); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
		e.open.take()
		f := e.claudeTranscriptIn("", "p3", cwd, sid(1), e.now, e.now)
		if _, err := e.r.Locate("claude", sid(1)); !errors.Is(err, ErrNotFound) {
			t.Errorf("within missRecheck: %v", err)
		}
		if o := e.open.take(); len(o) != 0 {
			t.Errorf("a remembered miss read %q", o)
		}
		// A caller asking once a second finds it at the next ask.
		e.now = e.now.Add(missRecheck)
		if got, err := e.r.Locate("claude", sid(1)); err != nil || got.Path != real(t, f) {
			t.Errorf("made meanwhile: %+v %v", got, err)
		}
		// Compressed only: remembered as such.
		e.write(filepath.Join(".claude/projects/p1", sid(2)+".jsonl.zst"), "zst", time.Time{})
		for range 2 {
			if _, err := e.r.Locate("claude", sid(2)); !errors.Is(err, ErrCompressed) {
				t.Errorf("compressed: %v", err)
			}
		}
		// A clock that went back does not keep a miss.
		e.r.Locate("claude", sid(3))
		f3 := e.claudeTranscriptIn("", "p4", cwd, sid(3), e.now, e.now)
		e.now = e.now.Add(-time.Hour)
		if got, err := e.r.Locate("claude", sid(3)); err != nil || got.Path != real(t, f3) {
			t.Errorf("clock back: %+v %v", got, err)
		}
	})
	t.Run("bounded", func(t *testing.T) {
		e := newEnv(t)
		count := func() (n int, first, last bool) {
			e.r.mu.Lock()
			defer e.r.mu.Unlock()
			_, first = e.r.misses[formatClaude+"/"+sid(0)]
			_, last = e.r.misses[formatClaude+"/"+sid(maxMisses+49)]
			return len(e.r.misses), first, last
		}
		for i := range maxMisses + 50 {
			e.r.Locate("claude", sid(i))
			e.now = e.now.Add(time.Millisecond)
		}
		if n, first, last := count(); n != maxMisses || first || !last {
			t.Errorf("%d misses, the oldest kept %v, the last %v", n, first, last)
		}
		// Expired misses go first.
		e.now = e.now.Add(missTTL)
		e.r.Locate("claude", sid(maxMisses+50))
		if n, _, _ := count(); n != 1 {
			t.Errorf("%d misses after they expired", n)
		}
	})
}

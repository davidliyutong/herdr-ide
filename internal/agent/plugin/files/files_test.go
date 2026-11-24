//go:build unix

package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
)

// testEnv is an agent's environment with HOME in a temporary directory.
func testEnv(t *testing.T) *plugin.Env {
	t.Helper()
	return envAt(t, t.TempDir())
}

// envAt is an agent's environment with HOME at home (which exists) and its
// data directory in it.
func envAt(t *testing.T, home string) *plugin.Env {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	base := filepath.Join(home, ".agent-base")
	if err := os.Mkdir(base, 0o700); err != nil {
		t.Fatal(err)
	}
	return &plugin.Env{
		Home: home,
		Base: base,
		Expand: func(p string) (string, error) {
			if p == "~" {
				return home, nil
			}
			if strings.HasPrefix(p, "~/") {
				return filepath.Join(home, p[2:]), nil
			}
			if !filepath.IsAbs(p) {
				return filepath.Join(home, p), nil
			}
			return filepath.Clean(p), nil
		},
	}
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

func result(t *testing.T, rep agentproto.Reply) Result {
	t.Helper()
	if !rep.OK {
		t.Fatalf("failed: %s %s", rep.Code, rep.Error)
	}
	var r Result
	if len(rep.Plugin) > 0 {
		if err := json.Unmarshal(rep.Plugin, &r); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMkdirCreateRename(t *testing.T) {
	env := testEnv(t)
	d := filepath.Join(env.Home, "src")
	result(t, call(t, env, "mkdir", Params{Path: "~/src"}))
	if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
		t.Fatalf("mkdir: %v", err)
	}
	if rep := call(t, env, "mkdir", Params{Path: d}); rep.OK || rep.Code != "exists" {
		t.Fatalf("mkdir again: %+v", rep)
	}
	result(t, call(t, env, "create", Params{Path: d + "/a.txt"}))
	write(t, d+"/a.txt", "a")
	if rep := call(t, env, "create", Params{Path: d + "/a.txt"}); rep.Code != "exists" || read(t, d+"/a.txt") != "a" {
		t.Fatalf("create over a file: %+v", rep)
	}
	write(t, d+"/b.txt", "b")
	// A rename never replaces what is there.
	if rep := call(t, env, "rename", Params{Path: d + "/a.txt", To: d + "/b.txt"}); rep.OK || rep.Code != "exists" {
		t.Fatalf("rename over a file: %+v", rep)
	}
	if read(t, d+"/a.txt") != "a" || read(t, d+"/b.txt") != "b" {
		t.Fatal("rename changed files")
	}
	r := result(t, call(t, env, "rename", Params{Path: d + "/a.txt", To: d + "/c.txt"}))
	if r.Paths[0] != d+"/c.txt" || read(t, d+"/c.txt") != "a" {
		t.Fatalf("rename: %+v", r)
	}
	if rep := call(t, env, "rename", Params{Path: d, To: d + "/inner"}); rep.Code != "bad_params" {
		t.Fatalf("into itself: %+v", rep)
	}
	if rep := call(t, env, "rename", Params{Path: d + "/nope", To: d + "/x"}); rep.Code != "not_found" {
		t.Fatalf("missing: %+v", rep)
	}
}

func TestMoveAndCopy(t *testing.T) {
	env := testEnv(t)
	src, dst := filepath.Join(env.Home, "src"), filepath.Join(env.Home, "dst")
	os.MkdirAll(src+"/dir/sub", 0o755)
	os.Mkdir(dst, 0o755)
	write(t, src+"/a.txt", "a")
	write(t, src+"/dir/sub/f", "f")
	os.Symlink("f", src+"/dir/sub/link")
	write(t, dst+"/a.txt", "taken")

	// Copies into the same directory get new names.
	r := result(t, call(t, env, "copy", Params{Paths: []string{src + "/a.txt", src + "/a.txt"}, Dir: src}))
	if strings.Join(r.Paths, ",") != src+"/a copy.txt,"+src+"/a copy 2.txt" {
		t.Fatalf("copies: %v", r.Paths)
	}
	r = result(t, call(t, env, "copy", Params{Paths: []string{src + "/dir"}, Dir: dst}))
	if r.Paths[0] != dst+"/dir" || read(t, dst+"/dir/sub/f") != "f" {
		t.Fatalf("copy dir: %+v", r)
	}
	if l, err := os.Readlink(dst + "/dir/sub/link"); err != nil || l != "f" {
		t.Fatalf("link copied as %q %v", l, err)
	}
	if rep := call(t, env, "copy", Params{Paths: []string{src + "/dir"}, Dir: src + "/dir/sub"}); rep.Code != "bad_params" {
		t.Fatalf("copy into itself: %+v", rep)
	}

	// A move replaces nothing: the taken name fails, the others move.
	write(t, src+"/b.txt", "b")
	r = result(t, call(t, env, "move", Params{Paths: []string{src + "/a.txt", src + "/b.txt"}, Dir: dst}))
	if len(r.Paths) != 1 || r.Paths[0] != dst+"/b.txt" || r.Failed[src+"/a.txt"] != "exists" {
		t.Fatalf("move: %+v", r)
	}
	if read(t, dst+"/a.txt") != "taken" || read(t, src+"/a.txt") != "a" {
		t.Fatal("move replaced a file")
	}
}

// A folder copied or moved into a link that leads inside it would hold
// itself (and a copy would go on until the path is too long).
func TestCopyIntoLinkInsideItself(t *testing.T) {
	env := testEnv(t)
	proj := filepath.Join(env.Home, "proj")
	os.MkdirAll(proj+"/sub", 0o755)
	write(t, proj+"/f", "f")
	os.Symlink(proj+"/sub", env.Home+"/l")
	for _, action := range []string{"copy", "move"} {
		if rep := call(t, env, action, Params{Paths: []string{proj}, Dir: env.Home + "/l"}); rep.Code != "bad_params" {
			t.Errorf("%s into a link inside itself: %+v", action, rep)
		}
	}
	if ents, _ := os.ReadDir(proj + "/sub"); len(ents) != 0 {
		t.Fatalf("copied into itself: %v", ents)
	}
	// A link in the folder is copied as a link, which holds nothing; the
	// home directory takes copies and moves (it is not changed itself).
	os.Symlink(env.Home, proj+"/up")
	result(t, call(t, env, "copy", Params{Paths: []string{proj}, Dir: env.Home}))
	if l, err := os.Readlink(env.Home + "/proj copy/up"); err != nil || l != env.Home {
		t.Fatalf("link %q %v", l, err)
	}
	result(t, call(t, env, "move", Params{Paths: []string{proj + "/f"}, Dir: "~"}))
	if read(t, env.Home+"/f") != "f" {
		t.Fatal("move into the home directory")
	}
}

// Across file systems a move copies and removes; it still replaces nothing.
func TestMoveAcrossFileSystems(t *testing.T) {
	env := testEnv(t)
	renameFile = func(from, to string) error {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: syscall.EXDEV}
	}
	defer func() { renameFile = renameNoReplace }()
	src, dst := filepath.Join(env.Home, "src"), filepath.Join(env.Home, "dst")
	os.MkdirAll(src+"/d/sub", 0o755)
	os.Mkdir(dst, 0o755)
	write(t, src+"/d/sub/f", "f")
	write(t, src+"/a.txt", "a")
	write(t, dst+"/a.txt", "taken")
	r := result(t, call(t, env, "move", Params{Paths: []string{src + "/d", src + "/a.txt"}, Dir: dst}))
	if len(r.Paths) != 1 || r.Paths[0] != dst+"/d" || r.Failed[src+"/a.txt"] != "exists" {
		t.Fatalf("move: %+v", r)
	}
	if read(t, dst+"/d/sub/f") != "f" || read(t, dst+"/a.txt") != "taken" || read(t, src+"/a.txt") != "a" {
		t.Fatal("contents")
	}
	if _, err := os.Lstat(src + "/d"); !os.IsNotExist(err) {
		t.Fatalf("source left: %v", err)
	}
}

func TestRefusedPaths(t *testing.T) {
	env := testEnv(t)
	inBase := filepath.Join(env.Base, "state.json")
	write(t, inBase, "{}")
	for _, p := range []string{"/", "~", env.Home, filepath.Dir(env.Home), env.Base, inBase} {
		for _, action := range []string{"trash", "remove"} {
			if rep := call(t, env, action, Params{Paths: []string{p}}); rep.OK || rep.Code != "refused" {
				t.Errorf("%s %s: %+v", action, p, rep)
			}
		}
		if rep := call(t, env, "rename", Params{Path: p, To: env.Home + "/x"}); rep.Code != "refused" {
			t.Errorf("rename %s: %+v", p, rep)
		}
	}
	if rep := call(t, env, "create", Params{Path: env.Base + "/x"}); rep.Code != "refused" {
		t.Errorf("create in base: %+v", rep)
	}
	write(t, env.Home+"/f", "f")
	if rep := call(t, env, "rename", Params{Path: env.Home + "/f", To: env.Base + "/f"}); rep.Code != "refused" {
		t.Errorf("rename into base: %+v", rep)
	}
	// A link to a protected file is not written through.
	os.Symlink(inBase, env.Home+"/link")
	if rep := call(t, env, "write", Params{Path: env.Home + "/link", Force: true}); rep.Code != "refused" {
		t.Errorf("write through a link: %+v", rep)
	}
	// Nor copied into through a link to the data directory.
	os.Symlink(env.Base, env.Home+"/base-link")
	if rep := call(t, env, "copy", Params{Paths: []string{env.Home + "/f"}, Dir: env.Home + "/base-link"}); rep.Code != "refused" {
		t.Errorf("copy through a link: %+v", rep)
	}
	if _, err := os.Lstat(env.Base + "/f"); err == nil {
		t.Error("copied into the data directory")
	}
	if read(t, inBase) != "{}" {
		t.Fatal("protected file changed")
	}
}

// A home directory that is a link (/home/me -> /data/me): its real path,
// the directories above it and the data directory there are refused too.
func TestRefusedThroughLinkedHome(t *testing.T) {
	real := filepath.Join(t.TempDir(), "me")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(t.TempDir(), "me")
	if err := os.Symlink(real, home); err != nil {
		t.Fatal(err)
	}
	env := envAt(t, home)
	write(t, real+"/.agent-base/state.json", "{}")
	write(t, real+"/f", "f")
	for _, p := range []string{real, filepath.Dir(real), real + "/.agent-base", real + "/.agent-base/state.json", home, home + "/.agent-base"} {
		for _, action := range []string{"trash", "remove"} {
			if rep := call(t, env, action, Params{Paths: []string{p}}); rep.OK || rep.Code != "refused" {
				t.Errorf("%s %s: %+v", action, p, rep)
			}
		}
		if rep := call(t, env, "rename", Params{Path: p, To: real + "/x"}); rep.Code != "refused" {
			t.Errorf("rename %s: %+v", p, rep)
		}
	}
	if read(t, real+"/.agent-base/state.json") != "{}" {
		t.Fatal("data directory changed")
	}
	// What is in the home directory is the user's to change.
	result(t, call(t, env, "remove", Params{Paths: []string{real + "/f"}}))
}

// On a case-insensitive volume (macOS by default) another case names the
// same home and data directories.
func TestRefusedInAnotherCase(t *testing.T) {
	home := filepath.Join(t.TempDir(), "me")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	env := envAt(t, home)
	upper := filepath.Join(filepath.Dir(home), "ME")
	if _, err := os.Stat(upper); err != nil {
		t.Skip("case-sensitive file system")
	}
	write(t, env.Base+"/state.json", "{}")
	for _, p := range []string{upper, upper + "/.AGENT-BASE", upper + "/.Agent-Base/state.json"} {
		if rep := call(t, env, "remove", Params{Paths: []string{p}}); rep.Code != "refused" {
			t.Errorf("remove %s: %+v", p, rep)
		}
	}
	if rep := call(t, env, "create", Params{Path: upper + "/.AGENT-BASE/new"}); rep.Code != "refused" {
		t.Errorf("create in the data directory: %+v", rep)
	}
	if read(t, env.Base+"/state.json") != "{}" {
		t.Fatal("data directory changed")
	}
}

func TestRemove(t *testing.T) {
	env := testEnv(t)
	d := filepath.Join(env.Home, "d")
	os.MkdirAll(d+"/x/y", 0o755)
	write(t, d+"/x/y/f", "f")
	result(t, call(t, env, "remove", Params{Paths: []string{d + "/x"}}))
	if _, err := os.Stat(d + "/x"); !os.IsNotExist(err) {
		t.Fatalf("still there: %v", err)
	}
	if rep := call(t, env, "remove", Params{Paths: []string{d + "/x"}}); rep.Code != "not_found" {
		t.Fatalf("again: %+v", rep)
	}
}

func TestTrashFreedesktop(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".local/share/Trash")
	os.MkdirAll(filepath.Dir(dir), 0o755)
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.Local)
	var got []string
	for i := 0; i < 2; i++ {
		p := filepath.Join(home, "my notes.txt")
		write(t, p, "n")
		where, err := trashFreedesktop(dir, "", p, now)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, where)
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatal("not moved")
		}
	}
	if got[0] != dir+"/files/my notes.txt" || got[1] != dir+"/files/my notes.2.txt" {
		t.Fatalf("names: %v", got)
	}
	info := read(t, dir+"/info/my notes.2.txt.trashinfo")
	want := "[Trash Info]\nPath=" + home + "/my%20notes.txt\nDeletionDate=2026-03-04T05:06:07\n"
	if info != want {
		t.Fatalf("info %q, want %q", info, want)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("trash mode %v", fi.Mode())
	}
	// The trash of another mount keeps paths relative to its top.
	top := t.TempDir()
	os.Mkdir(top+"/d", 0o755)
	write(t, top+"/d/f", "f")
	if _, err := trashFreedesktop(top+"/.Trash-1000", top, top+"/d/f", now); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read(t, top+"/.Trash-1000/info/f.trashinfo"), "\nPath=d/f\n") {
		t.Fatal("relative path")
	}
}

func TestTrashMac(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".Trash")
	var got []string
	for i := 0; i < 3; i++ {
		p := filepath.Join(home, "a.tar.gz")
		write(t, p, "x")
		where, err := trashMac(dir, p)
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, filepath.Base(where))
	}
	if strings.Join(got, ",") != "a.tar.gz,a.tar 2.gz,a.tar 3.gz" {
		t.Fatalf("names: %v", got)
	}
}

// The trash takes a file also where the data directory is missing (a
// server account no desktop used: no ~/.local/share).
func TestTrashAction(t *testing.T) {
	env := testEnv(t)
	t.Setenv("XDG_DATA_HOME", "")
	p := filepath.Join(env.Home, "gone.txt")
	write(t, p, "x")
	r := result(t, call(t, env, "trash", Params{Paths: []string{p}}))
	if len(r.Paths) != 1 || !strings.HasPrefix(r.Paths[0], env.Home+"/") {
		t.Fatalf("trash: %+v", r)
	}
	if read(t, r.Paths[0]) != "x" {
		t.Fatal("trashed file lost")
	}
}

func TestStat(t *testing.T) {
	env := testEnv(t)
	write(t, env.Home+"/f", "abc")
	rep := call(t, env, "stat", Params{Paths: []string{"~/f", "~/nope"}})
	var es []Entry
	if err := json.Unmarshal(rep.Plugin, &es); err != nil || len(es) != 2 {
		t.Fatalf("stat: %s %v", rep.Plugin, err)
	}
	if !es[0].Exists || es[0].Size != 3 || es[0].Path != "~/f" || es[1].Exists || es[1].Error != "" {
		t.Fatalf("entries: %+v", es)
	}
	many := make([]string, MaxStat+1)
	if rep := call(t, env, "stat", Params{Paths: many}); rep.Code != "bad_params" {
		t.Fatalf("too many: %+v", rep)
	}
}

// statAsync runs a stat action and sends its entries.
func statAsync(env *plugin.Env, paths []string, out chan<- []Entry) {
	a, b := net.Pipe()
	raw, _ := json.Marshal(Params{Paths: paths})
	go handle(context.Background(), a, "stat", raw, env)
	var rep agentproto.Reply
	agentproto.ReadLine(b, &rep)
	b.Close()
	var es []Entry
	json.Unmarshal(rep.Plugin, &es)
	out <- es
}

// Stats of a mount that does not answer: a path is stat'ed once however
// often it is asked, at most maxStatting stats wait, and the answers come
// in time with the paths' state unknown (not gone).
func TestStatOfADeadMount(t *testing.T) {
	env := testEnv(t)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := map[string]int{}
	osStat = func(p string) (fs.FileInfo, error) {
		mu.Lock()
		calls[p]++
		mu.Unlock()
		<-release
		return os.Stat(p)
	}
	statWait = 50 * time.Millisecond
	defer func() { osStat, statWait = os.Stat, 10*time.Second }()

	// The same path asked by three polls at once: one stat.
	out := make(chan []Entry, 3*maxStatting)
	for i := 0; i < 3; i++ {
		go statAsync(env, []string{"~/dead"}, out)
	}
	for i := 0; i < 3; i++ {
		if es := <-out; len(es) != 1 || es[0].Exists || es[0].Error != "timeout" {
			t.Fatalf("entries: %+v", es)
		}
	}
	// Other paths: the stats beyond maxStatting are not started.
	n := maxStatting + 2
	for i := 0; i < n; i++ {
		go statAsync(env, []string{fmt.Sprintf("~/dead%d", i), "~/after"}, out)
	}
	codes := map[string]int{}
	for i := 0; i < n; i++ {
		es := <-out
		if len(es) != 2 || es[0].Exists || es[1].Error == "" {
			t.Fatalf("entries: %+v", es)
		}
		codes[es[0].Error]++
	}
	if codes["busy"] != 3 || codes["timeout"] != maxStatting-1 {
		t.Fatalf("codes: %v", codes)
	}
	mu.Lock()
	if calls[filepath.Join(env.Home, "dead")] != 1 || len(calls) != maxStatting {
		t.Fatalf("stats started: %v", calls)
	}
	mu.Unlock()

	// Once the mount answers, the places are free again.
	close(release)
	for deadline := time.Now().Add(5 * time.Second); len(statGate) > 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("stats still running")
		}
	}
	write(t, env.Home+"/f", "abc")
	go statAsync(env, []string{"~/f"}, out)
	if es := <-out; len(es) != 1 || !es[0].Exists || es[0].Size != 3 {
		t.Fatalf("entries: %+v", es)
	}
}

// saveText runs the write action: the text follows the first reply as chunks,
// and a second line answers.
func saveText(t *testing.T, env *plugin.Env, p Params, text string) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	defer b.Close()
	raw, _ := json.Marshal(p)
	go handle(context.Background(), a, "write", raw, env)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatal(err)
	}
	if !rep.OK {
		return rep
	}
	cw := agentproto.ChunkWriter{W: b}
	go func() {
		io.Copy(cw, strings.NewReader(text))
		cw.Finish()
	}()
	rep = agentproto.Reply{}
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatal(err)
	}
	return rep
}

func TestWritePrecondition(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "f.txt")
	write(t, p, "one")
	os.Chmod(p, 0o600)
	fi, _ := os.Stat(p)
	loaded := entryOf(p, fi)

	r := result(t, saveText(t, env, Params{Path: p, Expect: loaded}, "two"))
	if read(t, p) != "two" || r.Entry == nil || r.Entry.Size != 3 {
		t.Fatalf("save: %+v", r)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	// Changed since it was loaded: a conflict that says how it is now.
	write(t, p, "changed elsewhere")
	rep := saveText(t, env, Params{Path: p, Expect: r.Entry}, "three")
	if rep.OK || rep.Code != "conflict" || read(t, p) != "changed elsewhere" {
		t.Fatalf("conflict: %+v", rep)
	}
	var now Entry
	if err := json.Unmarshal([]byte(strings.TrimPrefix(rep.Error, "conflict: ")), &now); err != nil || now.Size != 17 {
		t.Fatalf("conflict's state %q %v", rep.Error, err)
	}
	// Removed since: a conflict too; a new file must not exist.
	os.Remove(p)
	if rep := saveText(t, env, Params{Path: p, Expect: r.Entry}, "x"); rep.Code != "conflict" {
		t.Fatalf("removed: %+v", rep)
	}
	result(t, saveText(t, env, Params{Path: p}, "new"))
	if rep := saveText(t, env, Params{Path: p}, "again"); rep.Code != "conflict" {
		t.Fatalf("new over a file: %+v", rep)
	}
	// Force overwrites.
	result(t, saveText(t, env, Params{Path: p, Force: true}, "forced"))
	if read(t, p) != "forced" {
		t.Fatal("force")
	}
	// Through a link, the target is written and the link stays.
	os.Symlink("f.txt", env.Home+"/link")
	result(t, saveText(t, env, Params{Path: env.Home + "/link", Force: true}, "via link"))
	if l, err := os.Readlink(env.Home + "/link"); err != nil || l != "f.txt" || read(t, p) != "via link" {
		t.Fatalf("link %q %v", l, err)
	}
	// Too large: the file stays.
	rep = saveText(t, env, Params{Path: p, Force: true}, strings.Repeat("x", MaxWrite+1))
	if rep.Code != "too_large" || read(t, p) != "via link" {
		t.Fatalf("too large: %s", rep.Code)
	}
	ents, _ := os.ReadDir(env.Home)
	for _, e := range ents {
		if strings.Contains(e.Name(), "-save-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
}

// A new file gets the mode the umask leaves, as a program's new file does.
func TestWriteNewFileUmask(t *testing.T) {
	env := testEnv(t)
	old := syscall.Umask(0o027)
	defer syscall.Umask(old)
	p := filepath.Join(env.Home, "new.txt")
	result(t, saveText(t, env, Params{Path: p}, "new"))
	if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v %v", fi.Mode(), err)
	}
}

type fullDisk struct{}

func (fullDisk) Write([]byte) (int, error) { return 0, syscall.ENOSPC }

// A save that cannot be written still reads the text to its end, so the
// core that sends it reaches its answer.
func TestReceiveDrains(t *testing.T) {
	r := strings.NewReader(strings.Repeat("x", 3<<20))
	if err := receive(fullDisk{}, r, MaxWrite); !errors.Is(err, syscall.ENOSPC) || r.Len() != 0 {
		t.Fatalf("full disk: %v, %d bytes left", err, r.Len())
	}
	r = strings.NewReader(strings.Repeat("x", MaxWrite+10))
	if err := receive(io.Discard, r, MaxWrite); err == nil || r.Len() != 0 {
		t.Fatalf("too large: %v, %d bytes left", err, r.Len())
	}
}

// The trash at the top of another mount (/tmp, where anyone writes): made
// private, and one planted by someone else is not used.
func TestMountTrash(t *testing.T) {
	uid := os.Getuid()
	name := fmt.Sprintf(".Trash-%d", uid)
	top := t.TempDir()
	dir, err := mountTrash(top, uid)
	if err != nil || dir != filepath.Join(top, name) {
		t.Fatalf("trash %q %v", dir, err)
	}
	for _, d := range []string{dir, dir + "/files", dir + "/info"} {
		if fi, err := os.Lstat(d); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
			t.Fatalf("%s: %v %v", d, fi.Mode(), err)
		}
	}
	refused := map[string]func(top string){
		"a link": func(top string) { os.Symlink(t.TempDir(), filepath.Join(top, name)) },
		"open to others": func(top string) {
			os.Mkdir(filepath.Join(top, name), 0o700)
			os.Chmod(filepath.Join(top, name), 0o777)
		},
		"files a link": func(top string) {
			os.Mkdir(filepath.Join(top, name), 0o700)
			os.Symlink(t.TempDir(), filepath.Join(top, name, "files"))
		},
		"info open to others": func(top string) {
			os.MkdirAll(filepath.Join(top, name, "info"), 0o700)
			os.Chmod(filepath.Join(top, name, "info"), 0o755)
		},
	}
	for what, plant := range refused {
		top := t.TempDir()
		plant(top)
		if dir, err := mountTrash(top, uid); err == nil {
			t.Errorf("%s: used %s", what, dir)
		}
	}
	// An administrator's .Trash (sticky): the user's directory in it.
	top = t.TempDir()
	os.Mkdir(top+"/.Trash", 0o700)
	os.Chmod(top+"/.Trash", 0o777|fs.ModeSticky)
	if dir, err := mountTrash(top, uid); err != nil || dir != filepath.Join(top, ".Trash", fmt.Sprint(uid)) {
		t.Fatalf("shared trash %q %v", dir, err)
	}
	// Without the sticky bit, or a link to one: the user's own.
	top = t.TempDir()
	os.Mkdir(top+"/.Trash", 0o777)
	if dir, err := mountTrash(top, uid); err != nil || dir != filepath.Join(top, name) {
		t.Fatalf("not sticky: %q %v", dir, err)
	}
	top, sticky := t.TempDir(), t.TempDir()
	os.Chmod(sticky, 0o777|fs.ModeSticky)
	os.Symlink(sticky, top+"/.Trash")
	if dir, err := mountTrash(top, uid); err != nil || dir != filepath.Join(top, name) {
		t.Fatalf("link: %q %v", dir, err)
	}
}

// The top of the mount is looked for along the real path: links in the
// directory would lead elsewhere, and the trash's paths are relative to it.
func TestMountTopFollowsLinks(t *testing.T) {
	real, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write(t, real+"/f", "f")
	link := filepath.Join(t.TempDir(), "l")
	os.Symlink(real, link)
	top, err := mountTop(link + "/f")
	if err != nil || !within(real, top) {
		t.Fatalf("top %q of %s: %v", top, real, err)
	}
}

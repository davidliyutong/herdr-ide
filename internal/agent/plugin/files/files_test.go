//go:build unix

package files

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// testEnv is an agent's environment with HOME in a temporary directory.
func testEnv(t *testing.T) *plugin.Env {
	t.Helper()
	home := t.TempDir()
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
	if read(t, inBase) != "{}" {
		t.Fatal("protected file changed")
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

func TestTrashAction(t *testing.T) {
	env := testEnv(t)
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
	if !es[0].Exists || es[0].Size != 3 || es[0].Path != "~/f" || es[1].Exists {
		t.Fatalf("entries: %+v", es)
	}
	many := make([]string, MaxStat+1)
	if rep := call(t, env, "stat", Params{Paths: many}); rep.Code != "bad_params" {
		t.Fatalf("too many: %+v", rep)
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

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

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
)

// uploadText runs the upload action as saveText runs write.
func uploadText(t *testing.T, env *plugin.Env, p Params, text string) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	defer b.Close()
	raw, _ := json.Marshal(p)
	go handle(context.Background(), a, "upload", raw, env)
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

// Uploads take a free name, or replace the file as a save writes it.
func TestUpload(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "a.txt")
	r := result(t, uploadText(t, env, Params{Path: p}, "first"))
	if len(r.Paths) != 1 || r.Paths[0] != p || read(t, p) != "first" || r.Entry == nil || r.Entry.Size != 5 {
		t.Fatalf("first: %+v", r)
	}
	// Taken: the next free name, the file stays.
	r = result(t, uploadText(t, env, Params{Path: p}, "second"))
	if r.Paths[0] != filepath.Join(env.Home, "a-1.txt") || read(t, p) != "first" || read(t, r.Paths[0]) != "second" {
		t.Fatalf("second: %+v", r)
	}
	write(t, filepath.Join(env.Home, ".env"), "x")
	if r := result(t, uploadText(t, env, Params{Path: filepath.Join(env.Home, ".env")}, "y")); r.Paths[0] != filepath.Join(env.Home, ".env-1") {
		t.Fatalf("dot file: %+v", r)
	}
	// Replace: written over the file in place.
	other := filepath.Join(env.Home, "other.txt")
	if err := os.Link(p, other); err != nil {
		t.Skip("no hard links here:", err)
	}
	ino := inode(t, p)
	r = result(t, uploadText(t, env, Params{Path: p, Replace: true}, "replaced"))
	if real, _ := filepath.EvalSymlinks(p); r.Paths[0] != real || read(t, p) != "replaced" || read(t, other) != "replaced" || inode(t, p) != ino {
		t.Fatalf("replace: %+v %q", r, read(t, other))
	}
	// A folder is not replaced by a file.
	os.Mkdir(filepath.Join(env.Home, "dir"), 0o755)
	if rep := uploadText(t, env, Params{Path: filepath.Join(env.Home, "dir"), Replace: true}, "x"); rep.OK || rep.Code != "bad_params" {
		t.Fatalf("over a folder: %+v", rep)
	}
	// The agent's data directory is refused, as for every change.
	if rep := uploadText(t, env, Params{Path: filepath.Join(env.Base, "x")}, "x"); rep.OK || rep.Code != "refused" {
		t.Fatalf("data directory: %+v", rep)
	}
	nothingLeft(t, env)
}

// An upload cut short (the browser cancelled it) leaves nothing.
func TestUploadCutShort(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "big.bin")
	write(t, p, "old")
	for _, replace := range []bool{false, true} {
		a, b := net.Pipe()
		raw, _ := json.Marshal(Params{Path: p, Replace: replace})
		done := make(chan struct{})
		go func() {
			handle(context.Background(), a, "upload", raw, env)
			close(done)
		}()
		var rep agentproto.Reply
		if err := agentproto.ReadLine(b, &rep); err != nil || !rep.OK {
			t.Fatal(err, rep)
		}
		cw := agentproto.ChunkWriter{W: b}
		cw.Write([]byte(strings.Repeat("x", 1000)))
		b.Close()
		<-done
		if read(t, p) != "old" {
			t.Fatalf("replace %v: changed", replace)
		}
		nothingLeft(t, env)
		if _, err := os.Stat(filepath.Join(env.Home, "big-1.bin")); err == nil {
			t.Fatal("a partial upload was kept")
		}
	}
}

// mkdir with unique takes a free name; mkdirs makes folders with their
// parents and keeps those there.
func TestMkdirUniqueAndMkdirs(t *testing.T) {
	env := testEnv(t)
	d := filepath.Join(env.Home, "photos")
	result(t, call(t, env, "mkdir", Params{Path: d}))
	if rep := call(t, env, "mkdir", Params{Path: d}); rep.Code != "exists" {
		t.Fatalf("taken: %+v", rep)
	}
	r := result(t, call(t, env, "mkdir", Params{Path: d, Unique: true}))
	if r.Paths[0] != d+"-1" {
		t.Fatalf("unique: %+v", r)
	}
	write(t, filepath.Join(env.Home, "file"), "x")
	r = result(t, call(t, env, "mkdirs", Params{Paths: []string{d + "/a/b", d + "/a", filepath.Join(env.Home, "file", "sub")}}))
	if len(r.Paths) != 2 || r.Failed[filepath.Join(env.Home, "file", "sub")] != "exists" {
		t.Fatalf("mkdirs: %+v", r)
	}
	if fi, err := os.Stat(d + "/a/b"); err != nil || !fi.IsDir() {
		t.Fatal("not made")
	}
	if rep := call(t, env, "mkdirs", Params{Paths: []string{filepath.Join(env.Base, "x")}}); rep.Code != "refused" {
		t.Fatalf("data directory: %+v", rep)
	}
}

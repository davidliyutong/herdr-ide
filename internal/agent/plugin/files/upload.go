//go:build unix

package files

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"path/filepath"
	"strings"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// MaxUpload bounds an upload into the explorer (as the core's /upload).
const MaxUpload = 4 << 30

// upload writes a file uploaded from the explorer into Path: the reply
// comes first, then the file as chunks, then a line with the result. It
// takes a free name (Path, else name-1.ext, name-2.ext…), or with Replace
// it writes the file there as a save does (Force: through a link its
// target, in place when a rename would lose something). The file is
// received in full before anything at Path changes; one cut short leaves
// nothing.
func (g *guard) upload(st net.Conn, p Params) error {
	abs, err := g.resolve(p.Path)
	if err == nil && p.Replace {
		if abs, err = target(abs); err == nil {
			_, err = g.resolve(abs)
		}
	}
	if err != nil {
		return plugin.Reply(st, nil, err)
	}
	defer st.Close()
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		return err
	}
	r := &agentproto.ChunkReader{R: st}
	var e *Entry
	if p.Replace {
		e, err = g.put(abs, r, Params{Force: true, Method: p.Method}, MaxUpload)
	} else {
		e, err = g.putNew(abs, r)
	}
	if err != nil {
		return plugin.Fail(st, codeOf(err))
	}
	b, _ := json.Marshal(Result{Paths: []string{e.Path}, Entry: e})
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Plugin: b})
}

// putNew writes what r holds (at most MaxUpload bytes) into a new file
// beside p and gives it p's name or, when that is taken, the first free
// name-1.ext, name-2.ext…, in a rename that replaces nothing (of the file
// it wrote only: one swapped for it by name is a conflict, put's
// stagedFile). The new file gets what the umask leaves of 0666.
func (g *guard) putNew(p string, r io.Reader) (*Entry, error) {
	stage, err := g.createTemp(filepath.Dir(p), 0o666)
	if err != nil {
		io.Copy(io.Discard, r)
		return nil, err
	}
	defer stage.discard()
	err = receive(stage, r, MaxUpload)
	if err == nil {
		err = stage.Sync()
	}
	if err != nil {
		return nil, err
	}
	made(stage.name)
	for i := 0; i < 1000; i++ {
		q := numbered(p, i)
		fi, err := stage.renameTo(q, renameNoReplace)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if errors.Is(err, errSwapped) {
			return nil, &plugin.Error{Code: "conflict", Err: err}
		}
		if err != nil {
			return nil, err
		}
		return entryOf(q, fi), nil
	}
	return nil, plugin.Errorf("exists", "no free name for %s", p)
}

// numbered is p for i 0, else p with -i before its extension (as uploads
// into the machine's directories are named; a name that is all extension,
// .env, gets it at the end).
func numbered(p string, i int) string {
	if i == 0 {
		return p
	}
	dir, base := filepath.Split(p)
	ext := filepath.Ext(base)
	if ext == base {
		ext = ""
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, ext), i, ext))
}

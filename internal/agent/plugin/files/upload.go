//go:build unix

package files

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
)

// MaxUpload bounds an upload into the explorer (as the core's /upload).
const MaxUpload = 4 << 30

// upload writes a file uploaded from the explorer into Path: the reply
// comes first, then the file as chunks, then a line with the result. It
// takes a free name (Path, else name-1.ext, name-2.ext…), or with Replace
// it writes the file there as a save does (Force: through a link its
// target, in place). The file is received in full into the agent's
// private directory before anything at Path changes, so one cut short
// leaves nothing there.
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
	e, err := g.received(&agentproto.ChunkReader{R: st}, abs, p.Replace)
	if err != nil {
		return plugin.Fail(st, saveErr(err))
	}
	b, _ := json.Marshal(Result{Paths: []string{e.Path}, Entry: e})
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Plugin: b})
}

// received receives an upload (r, at most MaxUpload bytes) into a file in
// the private directory, writes it to abs (createFree, or with replace
// writeFile) and removes that file before the upload answers.
func (g *guard) received(r io.Reader, abs string, replace bool) (*Entry, error) {
	stage, err := g.stagingFile()
	if err != nil {
		io.Copy(io.Discard, r)
		return nil, err
	}
	defer func() {
		stage.Close()
		os.Remove(stage.Name())
	}()
	if err := receive(stage, r, MaxUpload); err != nil {
		return nil, err
	}
	size, err := stage.Seek(0, io.SeekCurrent)
	if err != nil {
		return nil, err
	}
	text := io.NewSectionReader(stage, 0, size)
	if replace {
		return writeFile(abs, text, Params{Force: true})
	}
	return createFree(abs, text)
}

// createFree creates p or, when that is taken, the first free name-1.ext,
// name-2.ext… (createFile: a new file, never one that is there) and writes
// what text holds into it.
func createFree(p string, text io.Reader) (*Entry, error) {
	for i := 0; i < 1000; i++ {
		q := numbered(p, i)
		e, err := createFile(q, text, Params{}, false)
		var pe *plugin.Error
		if errors.As(err, &pe) && pe.Code == "conflict" {
			continue // taken
		}
		return e, err
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

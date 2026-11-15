//go:build unix

// Package files is the machine side of the file explorer plugin
// (internal/plugins/files, docs/features/28-file-explorer.md): changes to
// files and directories the explorer makes (new files and folders, rename
// and move without replacing anything, copies, the trash, permanent
// removal, saving an editor's text with a check that nobody changed the
// file since it was loaded) and the stat of the directories it shows,
// which it polls while it is visible.
//
// Every path goes through the agent's expansion. Nothing touches the root,
// a directory holding the home directory (the home directory itself
// included) or the agent's own data directory.
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
	"syscall"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

const (
	// MaxWrite bounds an editor's save.
	MaxWrite = 8 << 20
	// MaxStat bounds the paths of one stat (the directories the explorer
	// shows expanded).
	MaxStat = 200
	// maxPaths bounds the paths of one trash, remove, move or copy.
	maxPaths = 1000
)

func init() { plugin.Register("files", handle) }

// Entry is the stat of a path the explorer follows; Exists is false when
// it is gone.
type Entry struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	IsDir  bool   `json:"is_dir,omitempty"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"` // unix milliseconds
}

// Params are the parameters of every action; each reads its own fields.
type Params struct {
	Path  string   `json:"path,omitempty"`
	Paths []string `json:"paths,omitempty"`
	// To is the new path of a rename; Dir the directory a move or copy
	// puts paths into.
	To  string `json:"to,omitempty"`
	Dir string `json:"dir,omitempty"`
	// Expect is the state a save expects the file in (from when it was
	// loaded); nil with Force unset: the file must not exist.
	Expect *Entry `json:"expect,omitempty"`
	Force  bool   `json:"force,omitempty"`
}

// Result answers the actions that change paths: the paths they made.
type Result struct {
	Paths []string `json:"paths,omitempty"`
	Entry *Entry   `json:"entry,omitempty"`
	// Failed are the paths an action on several could not handle, with
	// their codes.
	Failed map[string]string `json:"failed,omitempty"`
}

func handle(ctx context.Context, st net.Conn, action string, raw json.RawMessage, env *plugin.Env) error {
	var p Params
	if err := plugin.Decode(raw, &p); err != nil {
		return plugin.Reply(st, nil, err)
	}
	g := guard{env: env}
	switch action {
	case "stat":
		v, err := g.stat(p.Paths)
		return plugin.Reply(st, v, err)
	case "mkdir":
		v, err := g.mkdir(p.Path)
		return plugin.Reply(st, v, err)
	case "create":
		v, err := g.create(p.Path)
		return plugin.Reply(st, v, err)
	case "rename":
		v, err := g.rename(p.Path, p.To)
		return plugin.Reply(st, v, err)
	case "move":
		v, err := g.move(p.Paths, p.Dir)
		return plugin.Reply(st, v, err)
	case "copy":
		v, err := g.copy(ctx, p.Paths, p.Dir)
		return plugin.Reply(st, v, err)
	case "trash":
		v, err := g.each(p.Paths, g.trash)
		return plugin.Reply(st, v, err)
	case "remove":
		v, err := g.each(p.Paths, g.remove)
		return plugin.Reply(st, v, err)
	case "write":
		return g.write(st, p)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "unknown action %q", action))
}

// guard resolves paths and refuses the ones the explorer must not change.
type guard struct{ env *plugin.Env }

// resolve expands p; a path is refused when it is the root or holds the
// home directory, or is in the agent's data directory.
func (g guard) resolve(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", plugin.Errorf("bad_params", "no path")
	}
	abs, err := g.env.Expand(p)
	if err != nil {
		return "", plugin.Errorf("bad_params", "%v", err)
	}
	abs = filepath.Clean(abs)
	home, base := realPath(g.env.Home), realPath(g.env.Base)
	if refused(abs, g.env.Home, g.env.Base) || refused(realPath(abs), home, base) {
		return "", plugin.Errorf("refused", "%s is protected", abs)
	}
	return abs, nil
}

// realPath is p with the links of its directory resolved (the object a
// rename or removal of p acts on), or p as it is when that fails.
func realPath(p string) string {
	if p == "" || p == "/" {
		return p
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return p
	}
	return filepath.Join(dir, filepath.Base(p))
}

// refused reports whether p is the root, holds home (or is it), or is
// base or below it.
func refused(p, home, base string) bool {
	if p == "/" {
		return true
	}
	if home != "" && within(filepath.Clean(home), p) {
		return true
	}
	return base != "" && within(p, filepath.Clean(base))
}

// within reports whether p is dir or below it.
func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/")
}

// codeOf gives an error of the file system its code.
func codeOf(err error) error {
	var pe *plugin.Error
	switch {
	case err == nil:
		return nil
	case errors.As(err, &pe):
		return err
	case errors.Is(err, fs.ErrNotExist):
		return &plugin.Error{Code: "not_found", Err: err}
	case errors.Is(err, fs.ErrExist), errors.Is(err, syscall.ENOTEMPTY):
		return &plugin.Error{Code: "exists", Err: err}
	case errors.Is(err, fs.ErrPermission):
		return &plugin.Error{Code: "denied", Err: err}
	}
	return err
}

func entryOf(p string, fi fs.FileInfo) *Entry {
	return &Entry{Path: p, Exists: true, IsDir: fi.IsDir(), Size: fi.Size(), MTime: fi.ModTime().UnixMilli()}
}

func (g guard) stat(paths []string) ([]Entry, error) {
	if len(paths) > MaxStat {
		return nil, plugin.Errorf("bad_params", "at most %d paths", MaxStat)
	}
	out := make([]Entry, 0, len(paths))
	for _, p := range paths {
		abs, err := g.env.Expand(p)
		if err != nil {
			out = append(out, Entry{Path: p})
			continue
		}
		fi, err := os.Stat(abs)
		if err != nil {
			out = append(out, Entry{Path: p})
			continue
		}
		e := entryOf(p, fi)
		out = append(out, *e)
	}
	return out, nil
}

func (g guard) mkdir(p string) (*Result, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return nil, err
	}
	if err := os.Mkdir(abs, 0o755); err != nil {
		return nil, codeOf(err)
	}
	return &Result{Paths: []string{abs}}, nil
}

func (g guard) create(p string) (*Result, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, codeOf(err)
	}
	return &Result{Paths: []string{abs}}, f.Close()
}

// rename gives a path a new name or place; it never replaces what is
// there.
func (g guard) rename(from, to string) (*Result, error) {
	src, err := g.resolve(from)
	if err != nil {
		return nil, err
	}
	dst, err := g.resolve(to)
	if err != nil {
		return nil, err
	}
	if src == dst {
		return &Result{Paths: []string{dst}}, nil
	}
	if within(dst, src) {
		return nil, plugin.Errorf("bad_params", "cannot move %s into itself", src)
	}
	if err := renameNoReplace(src, dst); err != nil {
		return nil, codeOf(err)
	}
	return &Result{Paths: []string{dst}}, nil
}

// move puts paths into dir under their own names, replacing nothing.
func (g guard) move(paths []string, dir string) (*Result, error) {
	d, err := g.resolve(dir)
	if err != nil {
		return nil, err
	}
	return g.each(paths, func(src string) (string, error) {
		r, err := g.rename(src, filepath.Join(d, filepath.Base(filepath.Clean(src))))
		if err != nil {
			return "", err
		}
		return r.Paths[0], nil
	})
}

// copy copies paths into dir: under their own names, or "name copy",
// "name copy 2"… when those are taken (a copy into the same directory).
func (g guard) copy(ctx context.Context, paths []string, dir string) (*Result, error) {
	d, err := g.resolve(dir)
	if err != nil {
		return nil, err
	}
	return g.each(paths, func(p string) (string, error) {
		src, err := g.resolve(p)
		if err != nil {
			return "", err
		}
		if within(d, src) {
			return "", plugin.Errorf("bad_params", "cannot copy %s into itself", src)
		}
		dst, err := copyName(d, filepath.Base(src))
		if err != nil {
			return "", err
		}
		if made, err := copyTree(ctx, src, dst); err != nil {
			if made {
				os.RemoveAll(dst) // the partial copy, never what was there
			}
			return "", codeOf(err)
		}
		return dst, nil
	})
}

// action is an action on one path that returns the path it made.
type action func(string) (string, error)

// each runs f on every path: the paths it made, and the codes of those it
// failed on. One path that fails alone fails the action.
func (g guard) each(paths []string, f action) (*Result, error) {
	if len(paths) == 0 || len(paths) > maxPaths {
		return nil, plugin.Errorf("bad_params", "between 1 and %d paths", maxPaths)
	}
	res := &Result{}
	for _, p := range paths {
		made, err := f(p)
		if err != nil {
			if len(paths) == 1 {
				return nil, codeOf(err)
			}
			code := "failed"
			var pe *plugin.Error
			if errors.As(codeOf(err), &pe) {
				code = pe.Code
			}
			if res.Failed == nil {
				res.Failed = map[string]string{}
			}
			res.Failed[p] = code
			continue
		}
		if made != "" {
			res.Paths = append(res.Paths, made)
		}
	}
	return res, nil
}

func (g guard) remove(p string) (string, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(abs); err != nil {
		return "", codeOf(err)
	}
	return "", codeOf(os.RemoveAll(abs))
}

func (g guard) trash(p string) (string, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(abs); err != nil {
		return "", codeOf(err)
	}
	where, err := trash(abs, g.env.Home)
	return where, codeOf(err)
}

// write saves an editor's text: the reply comes first, then the text as
// chunks (agentproto.ChunkWriter), then a line with the result. The file
// must be as the editor loaded it (Expect) unless Force; it is replaced
// in one rename, through a symbolic link to its target, keeping its mode.
func (g guard) write(st net.Conn, p Params) error {
	abs, err := g.resolve(p.Path)
	if err == nil {
		abs, err = target(abs)
	}
	if err == nil {
		_, err = g.resolve(abs)
	}
	if err == nil {
		err = precondition(abs, p)
	}
	if err != nil {
		return plugin.Reply(st, nil, err)
	}
	defer st.Close()
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		return err
	}
	e, err := save(abs, &agentproto.ChunkReader{R: st}, p)
	if err != nil {
		return plugin.Fail(st, codeOf(err))
	}
	b, _ := json.Marshal(Result{Paths: []string{abs}, Entry: e})
	return agentproto.WriteLine(st, agentproto.Reply{OK: true, Plugin: b})
}

// target follows a symbolic link at p to the file it names (which may not
// exist yet).
func target(p string) (string, error) {
	t, err := filepath.EvalSymlinks(p)
	if err == nil {
		return t, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		if _, lerr := os.Lstat(p); lerr != nil {
			return p, nil // a new file
		}
	}
	return "", codeOf(err)
}

// precondition checks that the file at p is what a save expects.
func precondition(p string, w Params) error {
	if w.Force {
		return nil
	}
	fi, err := os.Stat(p)
	switch {
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return codeOf(err)
	case err == nil && fi.IsDir():
		return plugin.Errorf("bad_params", "%s is a directory", p)
	case w.Expect == nil || !w.Expect.Exists:
		if err == nil {
			return conflict(p, fi)
		}
		return nil
	case err != nil:
		return conflict(p, nil)
	case fi.Size() != w.Expect.Size || fi.ModTime().UnixMilli() != w.Expect.MTime:
		return conflict(p, fi)
	}
	return nil
}

// conflict is the failure of a save whose file changed (fi nil: was
// removed) since the editor loaded it; the message is the file's state now
// as JSON, which the core passes on.
func conflict(p string, fi fs.FileInfo) error {
	e := &Entry{Path: p}
	if fi != nil {
		e = entryOf(p, fi)
	}
	b, _ := json.Marshal(e)
	return &plugin.Error{Code: "conflict", Err: errors.New(string(b))}
}

// save writes r (at most MaxWrite bytes) into a new file beside p and
// renames it over p once the precondition still holds.
func save(p string, r io.Reader, w Params) (*Entry, error) {
	dir := filepath.Dir(p)
	mode := os.FileMode(0o644)
	if fi, err := os.Stat(p); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(dir, "."+brand.Slug+"-save-*")
	if err != nil {
		io.Copy(io.Discard, r)
		return nil, err
	}
	n, err := io.Copy(tmp, io.LimitReader(r, MaxWrite+1))
	if err == nil && n > MaxWrite {
		io.Copy(io.Discard, r)
		err = plugin.Errorf("too_large", "more than %d bytes", MaxWrite)
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), mode)
	}
	if err == nil {
		err = precondition(p, w)
	}
	if err == nil {
		err = os.Rename(tmp.Name(), p)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return nil, err
	}
	fi, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	return entryOf(p, fi), nil
}

// copyName is the first free name in dir for a copy of base: base, then
// "stem copy.ext", "stem copy 2.ext"…
func copyName(dir, base string) (string, error) {
	ext := filepath.Ext(base)
	if ext == base {
		ext = ""
	}
	stem := strings.TrimSuffix(base, ext)
	for i := 0; i < 1000; i++ {
		name := base
		switch {
		case i == 1:
			name = stem + " copy" + ext
		case i > 1:
			name = fmt.Sprintf("%s copy %d%s", stem, i, ext)
		}
		p := filepath.Join(dir, name)
		if _, err := os.Lstat(p); errors.Is(err, fs.ErrNotExist) {
			return p, nil
		}
	}
	return "", plugin.Errorf("exists", "no free name for %s", base)
}

// copyTree copies src to dst (which must not exist): files with their
// mode, directories with their contents, links as links. made tells
// whether it created dst.
func copyTree(ctx context.Context, src, dst string) (made bool, err error) {
	err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		to := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			var link string
			if link, err = os.Readlink(p); err == nil {
				err = os.Symlink(link, to)
			}
		case d.IsDir():
			err = os.Mkdir(to, info.Mode().Perm()|0o700)
		case d.Type().IsRegular():
			err = copyFile(p, to, info.Mode().Perm())
		}
		if err == nil && p == src {
			made = true
		}
		return err // sockets, devices and pipes are left out
	})
	return made, err
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

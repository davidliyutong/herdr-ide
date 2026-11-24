//go:build unix

// Package files is the machine side of the file explorer plugin
// (internal/plugins/files, docs/features/28-file-explorer.md): changes to
// files and directories the explorer makes (new files and folders, rename
// and move without replacing anything, copies, the trash, permanent
// removal, saving an editor's text with a check that nobody changed the
// file since it was loaded), the stat of the directories it shows, which
// it polls while it is visible, and showing a path in the system's file
// manager (reveal.go).
//
// Every path goes through the agent's expansion. Nothing touches the root,
// a directory holding the home directory (the home directory itself
// included) or the agent's own data directory, compared by file identity
// (os.SameFile), so a link or a name in another case does not reach them.
package files

import (
	"bytes"
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
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
)

const (
	// MaxWrite bounds an editor's save.
	MaxWrite = 8 << 20
	// MaxStat bounds the paths of one stat (the directories the explorer
	// shows expanded).
	MaxStat = 200
	// maxPaths bounds the paths of one trash, remove, move or copy.
	maxPaths = 1000
	// maxStatting bounds the stats running at once. A stat of a dead mount
	// holds a thread in the kernel until the mount answers, and the
	// explorer polls again every few seconds: at most this many threads
	// wait so, and a path is not asked again while a stat of it runs.
	maxStatting = 8
)

func init() { plugin.Register("files", handle) }

// Entry is the stat of a path the explorer follows; Exists is false when
// it is gone. Error is set (with Exists false) when its state is not known:
// the stat failed otherwise (denied, failed) or did not answer in time
// (busy, timeout); the explorer then keeps what it shows.
type Entry struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
	IsDir  bool   `json:"is_dir,omitempty"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"` // unix milliseconds
	Error  string `json:"error,omitempty"`
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
	// Replace: an upload replaces the file at Path, as a save does;
	// otherwise it takes a free name. Unique: a new folder takes a free
	// name.
	Replace bool `json:"replace,omitempty"`
	Unique  bool `json:"unique,omitempty"`
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
	g := &guard{env: env}
	switch action {
	case "stat":
		v, err := g.stat(ctx, p.Paths)
		return plugin.Reply(st, v, err)
	case "mkdir":
		v, err := g.mkdir(p.Path, p.Unique)
		return plugin.Reply(st, v, err)
	case "mkdirs":
		v, err := g.each(p.Paths, g.mkdirs)
		return plugin.Reply(st, v, err)
	case "create":
		v, err := g.create(p.Path)
		return plugin.Reply(st, v, err)
	case "rename":
		v, err := g.rename(ctx, p.Path, p.To)
		return plugin.Reply(st, v, err)
	case "move":
		v, err := g.move(ctx, p.Paths, p.Dir)
		return plugin.Reply(st, v, err)
	case "copy":
		// Copies and removals of large trees stop when the core gives up.
		ctx, cancel := plugin.UntilClosed(ctx, st)
		defer cancel()
		v, err := g.copy(ctx, p.Paths, p.Dir)
		return plugin.Reply(st, v, err)
	case "trash":
		v, err := g.each(p.Paths, g.trash)
		return plugin.Reply(st, v, err)
	case "remove":
		ctx, cancel := plugin.UntilClosed(ctx, st)
		defer cancel()
		v, err := g.each(p.Paths, func(p string) (string, error) { return g.remove(ctx, p) })
		return plugin.Reply(st, v, err)
	case "write":
		return g.write(st, p)
	case "upload":
		return g.upload(st, p)
	case "reveal":
		v, err := g.reveal(ctx, p.Path)
		return plugin.Reply(st, v, err)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "unknown action %q", action))
}

// guard resolves paths and refuses the ones the explorer must not change.
type guard struct {
	env  *plugin.Env
	prot *protection
}

// resolve expands p; a path is refused when it is the root or holds the
// home directory, or is in the agent's data directory: by its name, and by
// the identity of what it names once the links of its directories are
// followed.
func (g *guard) resolve(p string) (string, error) {
	abs, err := g.expand(p)
	if err != nil {
		return "", err
	}
	if g.prot == nil {
		g.prot = protect(g.env.Home, g.env.Base)
	}
	if refused(abs, g.env.Home, g.env.Base) || g.prot.refuses(abs) {
		return "", plugin.Errorf("refused", "%s is protected", abs)
	}
	return abs, nil
}

// expand makes p absolute and clean. Alone, it is for the directory a move
// or copy puts paths into, which is not changed itself (the home directory
// is a fine place to put files): each path that lands in it is resolved.
func (g *guard) expand(p string) (string, error) {
	if p == "" || strings.ContainsRune(p, 0) {
		return "", plugin.Errorf("bad_params", "no path")
	}
	abs, err := g.env.Expand(p)
	if err != nil {
		return "", plugin.Errorf("bad_params", "%v", err)
	}
	return filepath.Clean(abs), nil
}

// protection is what the explorer must not change, by file identity: the
// home directory and every directory holding it, and the data directory.
// Identities, not names: a home directory reached through a link
// (/home/me -> /data/me) or named in another case on a case-insensitive
// volume (/Users/ME) is the same directory.
type protection struct {
	// above are the home directory and the directories above it, along its
	// path as configured and along its real path.
	above []fs.FileInfo
	// base is the data directory; nil when it is not there.
	base fs.FileInfo
}

func protect(home, base string) *protection {
	pr := &protection{}
	add := func(p string) {
		for q := filepath.Clean(p); ; q = filepath.Dir(q) {
			if fi, err := os.Stat(q); err == nil {
				pr.above = append(pr.above, fi)
			}
			if q == "/" || q == "." {
				return
			}
		}
	}
	if home != "" {
		add(home)
		if r, err := filepath.EvalSymlinks(home); err == nil {
			add(r)
		}
	}
	if base != "" {
		if fi, err := os.Stat(base); err == nil {
			pr.base = fi
		}
	}
	return pr
}

// refuses reports whether p (absolute and clean) names the home directory
// or a directory above it, or the data directory or something in it. The
// last name of p is not followed (a rename or removal acts on a link, not
// on what it names); the links of its directories are.
func (pr *protection) refuses(p string) bool {
	rp := realPath(p)
	if fi, err := os.Lstat(rp); err == nil {
		for _, a := range pr.above {
			if os.SameFile(fi, a) {
				return true
			}
		}
	}
	if pr.base == nil {
		return false
	}
	for q := rp; ; q = filepath.Dir(q) {
		stat := os.Stat
		if q == rp {
			stat = os.Lstat
		}
		if fi, err := stat(q); err == nil && os.SameFile(fi, pr.base) {
			return true
		}
		if q == "/" || q == "." {
			return false
		}
	}
}

// realPath is p with the links of its directories resolved (the object a
// rename or removal of p acts on); the part of its directory not there
// yet stays as it is.
func realPath(p string) string {
	if p == "/" || p == "." {
		return p
	}
	return filepath.Join(realDir(filepath.Dir(p)), filepath.Base(p))
}

func realDir(d string) string {
	if r, err := filepath.EvalSymlinks(d); err == nil {
		return r
	}
	if d == "/" || d == "." {
		return d
	}
	return filepath.Join(realDir(filepath.Dir(d)), filepath.Base(d))
}

// refused reports whether p is the root, holds home (or is it), or is
// base or below it, by name.
func refused(p, home, base string) bool {
	if p == "/" {
		return true
	}
	if home != "" && within(filepath.Clean(home), p) {
		return true
	}
	return base != "" && within(p, filepath.Clean(base))
}

// within reports whether p is dir or below it, by name.
func within(p, dir string) bool {
	return p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, "/")+"/")
}

// holds reports whether dir is src or below it, following links: a copy
// or move of src into dir would put src inside itself. A link src is
// copied as a link, which holds nothing.
func holds(src, dir string) bool {
	if within(dir, src) {
		return true
	}
	sfi, err := os.Lstat(src)
	if err != nil || !sfi.IsDir() {
		return false
	}
	rd, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return false
	}
	for q := rd; ; q = filepath.Dir(q) {
		if fi, err := os.Stat(q); err == nil && os.SameFile(fi, sfi) {
			return true
		}
		if q == "/" || q == "." {
			return false
		}
	}
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
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return &plugin.Error{Code: "no_space", Err: err}
	case errors.Is(err, syscall.EROFS):
		return &plugin.Error{Code: "read_only", Err: err}
	}
	return err
}

func entryOf(p string, fi fs.FileInfo) *Entry {
	return &Entry{Path: p, Exists: true, IsDir: fi.IsDir(), Size: fi.Size(), MTime: fi.ModTime().UnixMilli()}
}

// statWait bounds how long one stat waits for its paths (the core waits
// 20 s); osStat is os.Stat, which tests replace.
var (
	statWait = 10 * time.Second
	osStat   = os.Stat
)

func (g *guard) stat(ctx context.Context, paths []string) ([]Entry, error) {
	if len(paths) > MaxStat {
		return nil, plugin.Errorf("bad_params", "at most %d paths", MaxStat)
	}
	ctx, cancel := context.WithTimeout(ctx, statWait)
	defer cancel()
	out := make([]Entry, 0, len(paths))
	for _, p := range paths {
		abs, err := g.env.Expand(p)
		if err != nil {
			out = append(out, Entry{Path: p})
			continue
		}
		fi, err := statShared(ctx, abs)
		switch {
		case err == nil:
			out = append(out, *entryOf(p, fi))
		case errors.Is(err, fs.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
			out = append(out, Entry{Path: p})
		default:
			out = append(out, Entry{Path: p, Error: statCode(err)})
		}
	}
	return out, nil
}

// errBusy: maxStatting stats are running (a mount that does not answer).
var errBusy = errors.New("too many stats running")

func statCode(err error) string {
	switch {
	case errors.Is(err, errBusy):
		return "busy"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "timeout"
	case errors.Is(err, fs.ErrPermission):
		return "denied"
	}
	return "failed"
}

// A flight is a stat running; who asks for its path meanwhile waits for
// it rather than starting another.
type flight struct {
	done chan struct{}
	fi   fs.FileInfo
	err  error
}

var (
	statGate  = make(chan struct{}, maxStatting)
	flightsMu sync.Mutex
	flights   = map[string]*flight{}
)

// statShared stats p, or waits for the stat of p already running, until
// ctx ends; with maxStatting stats running it fails at once (errBusy). A
// stat outlives a caller that stops waiting, as a system call cannot be
// interrupted, and keeps its place among the maxStatting until it ends.
func statShared(ctx context.Context, p string) (fs.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err // the paths after a stat that did not answer
	}
	flightsMu.Lock()
	f := flights[p]
	if f == nil {
		select {
		case statGate <- struct{}{}:
		default:
			flightsMu.Unlock()
			return nil, errBusy
		}
		f = &flight{done: make(chan struct{})}
		flights[p] = f
		go func() {
			f.fi, f.err = osStat(p)
			flightsMu.Lock()
			delete(flights, p)
			flightsMu.Unlock()
			<-statGate
			close(f.done)
		}()
	}
	flightsMu.Unlock()
	select {
	case <-f.done:
		return f.fi, f.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// mkdir makes a folder; a taken name fails, or with unique the folder
// gets the first free name-1, name-2… (a folder uploaded beside one of
// its name).
func (g *guard) mkdir(p string, unique bool) (*Result, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return nil, err
	}
	for i := 0; i < 1000; i++ {
		q := abs
		if i > 0 {
			q = fmt.Sprintf("%s-%d", abs, i)
		}
		err := os.Mkdir(q, 0o755)
		if err == nil {
			return &Result{Paths: []string{q}}, nil
		}
		if !unique || !errors.Is(err, fs.ErrExist) {
			return nil, codeOf(err)
		}
	}
	return nil, plugin.Errorf("exists", "no free name for %s", abs)
}

// mkdirs makes a folder with the folders that lead to it; one there
// already is fine (the folders of an upload), a file in the way is
// exists.
func (g *guard) mkdirs(p string) (string, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		if errors.Is(err, syscall.ENOTDIR) {
			return "", &plugin.Error{Code: "exists", Err: err}
		}
		return "", codeOf(err)
	}
	return abs, nil
}

func (g *guard) create(p string) (*Result, error) {
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
// there. Across file systems it is a copy and a removal.
func (g *guard) rename(ctx context.Context, from, to string) (*Result, error) {
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
	if within(dst, src) || holds(src, filepath.Dir(dst)) {
		return nil, plugin.Errorf("bad_params", "cannot move %s into itself", src)
	}
	if err := moveNoReplace(ctx, src, dst); err != nil {
		return nil, codeOf(err)
	}
	return &Result{Paths: []string{dst}}, nil
}

// renameFile is renameNoReplace; tests replace it.
var renameFile = renameNoReplace

// moveNoReplace renames src to dst, failing when dst exists. A rename
// across file systems (EXDEV) copies src (as copy does, never over
// something at dst) and removes it once copied; a copy that fails leaves
// src as it was and removes what it made.
func moveNoReplace(ctx context.Context, src, dst string) error {
	err := renameFile(src, dst)
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	made, err := copyTree(ctx, src, dst)
	if err != nil {
		if made {
			os.RemoveAll(dst)
		}
		return err
	}
	return os.RemoveAll(src)
}

// move puts paths into dir under their own names, replacing nothing.
func (g *guard) move(ctx context.Context, paths []string, dir string) (*Result, error) {
	d, err := g.expand(dir)
	if err != nil {
		return nil, err
	}
	return g.each(paths, func(src string) (string, error) {
		r, err := g.rename(ctx, src, filepath.Join(d, filepath.Base(filepath.Clean(src))))
		if err != nil {
			return "", err
		}
		return r.Paths[0], nil
	})
}

// copy copies paths into dir: under their own names, or "name copy",
// "name copy 2"… when those are taken (a copy into the same directory).
func (g *guard) copy(ctx context.Context, paths []string, dir string) (*Result, error) {
	d, err := g.expand(dir)
	if err != nil {
		return nil, err
	}
	return g.each(paths, func(p string) (string, error) {
		src, err := g.resolve(p)
		if err != nil {
			return "", err
		}
		if holds(src, d) {
			return "", plugin.Errorf("bad_params", "cannot copy %s into itself", src)
		}
		dst, err := copyName(d, filepath.Base(src))
		if err != nil {
			return "", err
		}
		// dir may be a link: where the copy lands is checked too.
		if _, err := g.resolve(dst); err != nil {
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
func (g *guard) each(paths []string, f action) (*Result, error) {
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

func (g *guard) remove(ctx context.Context, p string) (string, error) {
	abs, err := g.resolve(p)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(abs); err != nil {
		return "", codeOf(err)
	}
	return "", codeOf(removeTree(ctx, abs))
}

func (g *guard) trash(p string) (string, error) {
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
// must be as the editor loaded it (Expect) unless Force; through a
// symbolic link its target is written (the link stays). The text is
// received in full, then written into the file in place (save.go).
func (g *guard) write(st net.Conn, p Params) error {
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
	var text bytes.Buffer
	if err := receive(&text, &agentproto.ChunkReader{R: st}, MaxWrite); err != nil {
		return plugin.Fail(st, codeOf(err))
	}
	e, err := writeFile(abs, &text, p)
	if err != nil {
		return plugin.Fail(st, saveErr(err))
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

// precondition checks that the file at p is what a save expects, before
// the text is received; writeFile checks it again on the file it opens.
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
	case err != nil:
		if w.Expect != nil && w.Expect.Exists {
			return conflict(p, nil)
		}
		return nil
	}
	return expected(p, fi, w)
}

// expected checks that the file p, which is there as fi, is what a save
// expects: the file as the editor loaded it (its size and modification
// time), unless Force.
func expected(p string, fi fs.FileInfo, w Params) error {
	switch {
	case w.Force:
		return nil
	case w.Expect == nil || !w.Expect.Exists:
		return conflict(p, fi) // a new file was expected
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
			err = copyFile(ctx, p, to, info.Mode().Perm())
		}
		if err == nil && p == src {
			made = true
		}
		return err // sockets, devices and pipes are left out
	})
	return made, err
}

// copyFile copies a file, checking ctx between chunks.
func copyFile(ctx context.Context, src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	// Only the buffer's chunks: the file's ReadFrom would copy in its own.
	if _, err := io.CopyBuffer(struct{ io.Writer }{out}, ctxReader{ctx, in}, make([]byte, 1<<20)); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

//go:build unix

package chathost

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"veldr/internal/chatproto"
)

// fileID is a file's device and inode: what tells that a path still is the
// directory that was trusted.
type fileID struct{ dev, ino uint64 }

// trustable checks that a directory may be trusted (chatproto.OpTrust),
// and returns the device and inode of the directory it is. It may not be
// "/", the user's home directory or a directory above it (they hold every
// project of the user's), a directory that is not the user's, or that its
// group or others may write, nor one below a directory others may write
// that has no sticky bit (anyone could put another directory in its
// place). Symbolic links are followed: what is checked is the directory
// they lead to, and the directories above that one. home is the user's
// home directory, "" for none.
func trustable(dir, home string) (fileID, *chatproto.Error) {
	unsafe := func(why string) (fileID, *chatproto.Error) {
		return fileID{}, perr(chatproto.CodeUnsafeFolder, dir+" may not be trusted: "+why)
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil || !filepath.IsAbs(real) {
		return fileID{}, perr(chatproto.CodeBadRequest, "cwd is not a directory")
	}
	if dir == "/" || real == "/" {
		return unsafe("the root directory")
	}
	if home != "" && filepath.IsAbs(home) {
		homes := []string{filepath.Clean(home)}
		if r, err := filepath.EvalSymlinks(home); err == nil {
			homes = append(homes, r)
		}
		for _, h := range homes {
			for _, d := range []string{dir, real} {
				if d == h || within(d, h) {
					return unsafe("the home directory or a directory above it")
				}
			}
		}
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		return fileID{}, perr(chatproto.CodeBadRequest, "cwd is not a directory")
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return unsafe("its owner is not known")
	}
	if int(sys.Uid) != os.Getuid() {
		return unsafe("another user's directory")
	}
	if st.Mode().Perm()&0o022 != 0 {
		return unsafe("its group or others may write it")
	}
	for p := parentDir(real); ; p = parentDir(p) {
		pst, err := os.Stat(p)
		if err != nil {
			return unsafe("a directory above it cannot be read")
		}
		if pst.Mode().Perm()&0o002 != 0 && pst.Mode()&os.ModeSticky == 0 {
			return unsafe("it is below " + p + ", which others may write")
		}
		if p == "/" {
			break
		}
	}
	return fileID{dev: uint64(sys.Dev), ino: uint64(sys.Ino)}, nil
}

// within tells whether dir is a directory above p: p is below it.
func within(dir, p string) bool {
	if dir == "/" {
		return p != "/"
	}
	return strings.HasPrefix(p, dir+"/")
}

// userHome is the home directory of the host's user; "" when unknown.
func userHome() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// trusted tells whether the user trusted dir, or a directory above it,
// and that directory still may be trusted and is the one that was: a
// trusted directory that is another one now (its device and inode), or
// that is no longer safe to trust, is taken off the list.
func (h *host) trusted(dir string) bool {
	rows, err := h.j.trustedAbove(dir)
	if err != nil {
		h.logf("trusted %s: %v", dir, err)
		return false
	}
	home := userHome()
	var gone []string
	ok := false
	for _, t := range rows {
		id, e := trustable(t.path, home)
		if e == nil && id == t.id {
			ok = true
			break
		}
		why := "it is another directory now"
		if e != nil {
			why = e.Message
		}
		h.logf("%s is trusted no more: %s", t.path, why)
		gone = append(gone, t.path)
	}
	if err := h.j.untrust(gone...); err != nil {
		h.logf("untrust %v: %v", gone, err)
	}
	return ok
}

// listTrusted returns all persisted trusted folders that remain valid and
// safe, pruning any that have moved or become unsafe.
func (h *host) listTrusted() chatproto.Response {
	rows, err := h.j.listTrusted()
	if err != nil {
		h.logf("list trusted: %v", err)
		return refuse(chatproto.CodeFailed, "the journal did not answer")
	}
	home := userHome()
	var gone []string
	out := make([]chatproto.TrustedFolder, 0, len(rows))
	for _, t := range rows {
		id, e := trustable(t.path, home)
		if e == nil && id == t.id {
			out = append(out, chatproto.TrustedFolder{Cwd: t.path, At: t.at})
			continue
		}
		why := "it is another directory now"
		if e != nil {
			why = e.Message
		}
		h.logf("%s is trusted no more: %s", t.path, why)
		gone = append(gone, t.path)
	}
	if err := h.j.untrust(gone...); err != nil {
		h.logf("untrust %v: %v", gone, err)
	}
	return chatproto.Response{OK: true, Trusted: out}
}

// trust adds a directory to the ones the user trusts (chatproto.OpTrust).
func (h *host) trust(req chatproto.Request) chatproto.Response {
	if len(req.Cwd) > 4096 {
		return refuse(chatproto.CodeBadRequest, "cwd too long")
	}
	if e := checkCwd(req.Cwd); e != nil {
		return refusal(e)
	}
	id, e := trustable(req.Cwd, userHome())
	if e != nil {
		return refusal(e)
	}
	if err := h.j.trust(req.Cwd, now(), id); err != nil {
		h.logf("trust %s: %v", req.Cwd, err)
		return refuse(chatproto.CodeFailed, "the journal did not take the directory")
	}
	h.logf("trusted %s", req.Cwd)
	return chatproto.Response{OK: true}
}

// untrust takes back the trust that covers a directory
// (chatproto.OpUntrust): its own and that of the directories above it.
func (h *host) untrust(req chatproto.Request) chatproto.Response {
	if len(req.Cwd) > 4096 {
		return refuse(chatproto.CodeBadRequest, "cwd too long")
	}
	if req.Cwd == "" || !filepath.IsAbs(req.Cwd) || filepath.Clean(req.Cwd) != req.Cwd {
		return refuse(chatproto.CodeBadRequest, "cwd is not a clean absolute path")
	}
	rows, err := h.j.trustedAbove(req.Cwd)
	if err != nil {
		h.logf("untrust %s: %v", req.Cwd, err)
		return refuse(chatproto.CodeFailed, "the journal did not answer")
	}
	paths := make([]string, len(rows))
	for i, t := range rows {
		paths[i] = t.path
	}
	if err := h.j.untrust(paths...); err != nil {
		h.logf("untrust %s: %v", req.Cwd, err)
		return refuse(chatproto.CodeFailed, "the journal did not take it")
	}
	if len(paths) > 0 {
		h.logf("trusted no more: %v", paths)
	}
	return chatproto.Response{OK: true}
}

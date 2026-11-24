//go:build unix

package files

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"veldr/internal/agent/plugin"
)

// trash moves p into the user's trash and returns where it went: on macOS
// ~/.Trash, elsewhere the freedesktop.org trash (the home trash, or the
// trash at the top of p's mount when p is on another file system). A path
// no trash can take fails with trash_unavailable, and the explorer offers
// to delete it for good instead.
func trash(p, home string) (string, error) {
	if runtime.GOOS == "darwin" {
		return trashMac(filepath.Join(home, ".Trash"), p)
	}
	data := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(data) {
		data = filepath.Join(home, ".local", "share")
	}
	// The data directory may be missing on an account no desktop used
	// (a server's): made as gio makes it, 0700 as the specification asks.
	if err := os.MkdirAll(data, 0o700); err != nil {
		return "", err
	}
	where, err := trashFreedesktop(filepath.Join(data, "Trash"), "", p, time.Now())
	if !errors.Is(err, syscall.EXDEV) {
		return where, err
	}
	// Another file system: the trash at the top of its mount, which holds
	// paths relative to that top (of p's real path).
	rp := realPath(p)
	top, terr := mountTop(rp)
	if terr != nil {
		err = terr
	} else if dir, derr := mountTrash(top, os.Getuid()); derr != nil {
		err = derr
	} else {
		where, err = trashFreedesktop(dir, top, rp, time.Now())
	}
	if err != nil {
		return "", plugin.Errorf("trash_unavailable", "no trash for %s: %v", p, err)
	}
	return where, nil
}

// mountTrash is uid's trash at the top of a mount, as the freedesktop.org
// trash specification and gio choose it: $top/.Trash/$uid when $top/.Trash
// is a directory with the sticky bit that is not a link (an
// administrator's), else $top/.Trash-$uid. Other users may write at the
// top of a mount (/tmp): a trash directory and its files and info are
// used only when each is a directory of uid, not a link, without access
// for anyone else (made so when missing); another user's could read what
// is trashed into it.
func mountTrash(top string, uid int) (string, error) {
	shared := filepath.Join(top, ".Trash")
	if fi, err := os.Lstat(shared); err == nil && fi.IsDir() && fi.Mode()&fs.ModeSticky != 0 {
		dir := filepath.Join(shared, strconv.Itoa(uid))
		if privateDirs(dir, uid) == nil {
			return dir, nil
		}
	}
	dir := filepath.Join(top, fmt.Sprintf(".Trash-%d", uid))
	if err := privateDirs(dir, uid); err != nil {
		return "", err
	}
	return dir, nil
}

// privateDirs makes dir and its files and info directories (0700) where
// they are missing, and checks that each is a directory of uid (not a
// link) that nobody else can enter.
func privateDirs(dir string, uid int) error {
	for _, d := range []string{dir, filepath.Join(dir, "files"), filepath.Join(dir, "info")} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		fi, err := os.Lstat(d)
		if err != nil {
			return err
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		switch {
		case !fi.IsDir():
			return fmt.Errorf("%s is not a directory", d)
		case !ok || int(st.Uid) != uid:
			return fmt.Errorf("%s belongs to another user", d)
		case fi.Mode().Perm()&0o077 != 0:
			return fmt.Errorf("%s is open to others (%v)", d, fi.Mode().Perm())
		}
	}
	return nil
}

// trashFreedesktop moves p into the trash dir as the freedesktop.org trash
// specification describes: a unique name claimed by its info file
// (info/<name>.trashinfo, with the original path and the time), then the
// file itself in files/<name>. top is the mount the trash belongs to,
// whose info files hold paths relative to it; "" for the home trash.
func trashFreedesktop(dir, top, p string, now time.Time) (string, error) {
	files, info := filepath.Join(dir, "files"), filepath.Join(dir, "info")
	for _, d := range []string{dir, files, info} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	orig := p
	if top != "" {
		rel, err := filepath.Rel(top, p)
		if err != nil {
			return "", err
		}
		orig = rel
	}
	body := "[Trash Info]\nPath=" + escapePath(orig) + "\nDeletionDate=" + now.Format("2006-01-02T15:04:05") + "\n"
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	if ext == base {
		ext = ""
	}
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 10000; i++ {
		name := base
		if i > 1 {
			name = fmt.Sprintf("%s.%d%s", stem, i, ext)
		}
		ip := filepath.Join(info, name+".trashinfo")
		f, err := os.OpenFile(ip, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, werr := f.WriteString(body)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		dst := filepath.Join(files, name)
		if werr == nil {
			werr = renameNoReplace(p, dst)
		}
		if werr != nil {
			os.Remove(ip)
			if errors.Is(werr, fs.ErrExist) {
				continue // a file without its info file
			}
			return "", werr
		}
		return dst, nil
	}
	return "", plugin.Errorf("trash_unavailable", "no free name in %s", dir)
}

// escapePath escapes a path for a trash info file: as a URL path, keeping
// the slashes.
func escapePath(p string) string {
	parts := strings.Split(p, "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// trashMac moves p into the trash dir (~/.Trash) under its own name, or
// "stem 2.ext", "stem 3.ext"… when that is taken.
func trashMac(dir, p string) (string, error) {
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return "", err
	}
	base := filepath.Base(p)
	ext := filepath.Ext(base)
	if ext == base {
		ext = ""
	}
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 10000; i++ {
		name := base
		if i > 1 {
			name = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		dst := filepath.Join(dir, name)
		err := renameNoReplace(p, dst)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if errors.Is(err, syscall.EXDEV) {
			return "", plugin.Errorf("trash_unavailable", "%s is on another volume than the trash", p)
		}
		if err != nil {
			return "", err
		}
		return dst, nil
	}
	return "", plugin.Errorf("trash_unavailable", "no free name in %s", dir)
}

// mountTop is the top directory of the mount p is on: the highest
// directory above p on the same device, along p's directory with its links
// resolved.
func mountTop(p string) (string, error) {
	dev := func(q string) (uint64, error) {
		var st syscall.Stat_t
		if err := syscall.Lstat(q, &st); err != nil {
			return 0, err
		}
		return uint64(st.Dev), nil
	}
	d, err := dev(p)
	if err != nil {
		return "", err
	}
	top, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	for top != "/" {
		up := filepath.Dir(top)
		ud, err := dev(up)
		if err != nil || ud != d {
			break
		}
		top = up
	}
	return top, nil
}

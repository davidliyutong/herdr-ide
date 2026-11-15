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
	"strings"
	"syscall"
	"time"

	"herdr-ide/internal/agent/plugin"
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
	where, err := trashFreedesktop(filepath.Join(data, "Trash"), "", p, time.Now())
	if !errors.Is(err, syscall.EXDEV) {
		return where, err
	}
	// Another file system: the trash at the top of its mount.
	top, terr := mountTop(p)
	if terr == nil {
		dir := filepath.Join(top, fmt.Sprintf(".Trash-%d", os.Getuid()))
		where, err = trashFreedesktop(dir, top, p, time.Now())
	}
	if err != nil {
		return "", plugin.Errorf("trash_unavailable", "no trash for %s: %v", p, err)
	}
	return where, nil
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
// directory above p on the same device.
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
	top := filepath.Dir(p)
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

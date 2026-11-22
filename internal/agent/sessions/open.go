//go:build unix

package sessions

import (
	"errors"
	"os"
	"path"
	"strings"
	"sync/atomic"
	"syscall"

	"golang.org/x/sys/unix"
)

// How files are opened: read-only, without blocking (a FIFO or a device
// put at the name cannot hold up the caller; a regular file's reads ignore
// the flag), never as the controlling terminal, closed on exec.
const fileFlags = unix.O_RDONLY | unix.O_NONBLOCK | unix.O_NOCTTY | unix.O_CLOEXEC

var (
	// errNotOwn: a file is not one of the agent's user's own (another
	// owner, or more than one name, so that a hard link to a file
	// elsewhere is no transcript).
	errNotOwn = errors.New("sessions: not a file of the user's own")
	// errNoLinks: a path to open without following links is not absolute
	// and clean.
	errNoLinks = errors.New("sessions: not an absolute clean path")
)

// agentUID and agentGID are the user and primary group the agent runs as,
// whose files and directories are trusted (tests change them).
var (
	agentUID = uint32(os.Getuid())
	agentGID = uint32(os.Getgid())
)

// openHook, when set, is called with every path the package opens, before
// it is opened (tests).
var openHook atomic.Pointer[func(string)]

func traceOpen(p string) {
	if h := openHook.Load(); h != nil {
		(*h)(p)
	}
}

// fileID is a file as the system knows it: its device and inode.
type fileID struct{ dev, ino uint64 }

// fileStat is what this package checks of a file.
type fileStat struct {
	id    fileID
	mode  uint32
	uid   uint32
	gid   uint32
	nlink uint64
}

func statOf(st *unix.Stat_t) fileStat {
	return fileStat{
		id:   fileID{dev: uint64(st.Dev), ino: uint64(st.Ino)},
		mode: uint32(st.Mode), uid: st.Uid, gid: st.Gid, nlink: uint64(st.Nlink),
	}
}

// statInfo is fileStat of what os.Lstat or os.Stat returned; false when
// the system gives no stat_t.
func statInfo(fi os.FileInfo) (fileStat, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fileStat{}, false
	}
	return fileStat{
		id:   fileID{dev: uint64(st.Dev), ino: uint64(st.Ino)},
		mode: uint32(st.Mode), uid: st.Uid, gid: st.Gid, nlink: uint64(st.Nlink),
	}, true
}

func (s fileStat) regular() bool { return s.mode&unix.S_IFMT == unix.S_IFREG }
func (s fileStat) dir() bool     { return s.mode&unix.S_IFMT == unix.S_IFDIR }

// own reports whether a regular file is a transcript of the agent's user:
// owned by the user and with one name only (a hard link inside a session
// root to a file elsewhere has two).
func (s fileStat) own() bool { return s.regular() && s.uid == agentUID && s.nlink == 1 }

// private reports whether a directory is the agent's user's alone to
// write: no other user may, and no group may either, but on Linux the
// user's own primary group (userPrivateGroups: the user private group a
// umask of 002 leaves writable). On macOS every user's primary group is
// staff, so a directory that group may write is not private. What protects
// a record or a transcript is above all its own check, a regular file the
// user owns with one name (own, readRecordFile), which no one else can
// make; the directory's check keeps others from choosing which of the
// user's files a name holds.
func (s fileStat) private() bool {
	if !s.dir() || s.mode&0o002 != 0 {
		return false
	}
	return s.mode&0o020 == 0 || userPrivateGroups && s.gid == agentGID
}

// retry runs an open again while the system call is interrupted.
func retry(open func() (int, error)) (int, error) {
	for {
		fd, err := open()
		if !errors.Is(err, unix.EINTR) {
			return fd, err
		}
	}
}

// openNoFollow opens p as fileFlags say, refusing a symbolic link at its
// last element only: for paths this package made from directories it does
// not hold to be free of links (a symlinked ~/.claude is common), whose
// files are checked once open.
func openNoFollow(p string) (*os.File, error) {
	traceOpen(p)
	return os.OpenFile(p, fileFlags|unix.O_NOFOLLOW, 0)
}

// openStrict opens p, an absolute clean path, so that no symbolic link
// anywhere on it is followed (openNoLinks), and returns the open file and
// what fstat says of it. The file must be one of the user's own (own);
// it is open for blocking reads.
func openStrict(p string) (*os.File, fileStat, error) {
	if !path.IsAbs(p) || path.Clean(p) != p {
		return nil, fileStat{}, errNoLinks
	}
	traceOpen(p)
	fd, err := openNoLinks(p)
	if err != nil {
		return nil, fileStat{}, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, fileStat{}, err
	}
	s := statOf(&st)
	switch {
	case !s.regular():
		unix.Close(fd)
		return nil, fileStat{}, errNotRegular
	case !s.own():
		unix.Close(fd)
		return nil, fileStat{}, errNotOwn
	}
	// A regular file never blocks: reading it blocking keeps it off the
	// runtime's poller.
	if err := unix.SetNonblock(fd, false); err != nil {
		unix.Close(fd)
		return nil, fileStat{}, err
	}
	return os.NewFile(uintptr(fd), p), s, nil
}

// openAs opens a located file, p, so that no symbolic link on it is
// followed and checks that it is the file Locate saw there (want). Any
// way in which it is not (gone, a link on the way, another file, not the
// user's own) is ErrNotFound; other failures (permissions, no descriptors
// left) are the system's error, which names no path.
func openAs(p string, want fileID) (*os.File, error) {
	if want == (fileID{}) {
		return nil, ErrNotFound
	}
	f, st, err := openStrict(p)
	if err != nil {
		if gone(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if st.id != want {
		f.Close()
		return nil, ErrNotFound
	}
	return f, nil
}

// gone reports whether an open failed because the path does not name the
// file that was there: missing, a link on the way (ELOOP; ENOTDIR or
// EMLINK where a system says so), or not a regular file of the user's own.
func gone(err error) bool {
	for _, e := range []error{unix.ENOENT, unix.ELOOP, unix.ENOTDIR, unix.EMLINK, errNotRegular, errNotOwn, errNoLinks} {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

// walkOpen opens p, an absolute clean path, one element at a time from
// the root, each directory relative to the one before and none followed
// as a symbolic link (O_NOFOLLOW, and checked to be a directory), the last
// as fileFlags say: where the system cannot refuse links on the whole
// path in one call.
func walkOpen(p string) (int, error) {
	if !path.IsAbs(p) || path.Clean(p) != p || p == "/" {
		return -1, unix.EINVAL
	}
	dir, err := retry(func() (int, error) { return unix.Open("/", dirFlags, 0) })
	if err != nil {
		return -1, err
	}
	names := strings.Split(p[1:], "/")
	for i, name := range names {
		if name == "" || name == "." || name == ".." {
			unix.Close(dir)
			return -1, unix.EINVAL
		}
		last := i == len(names)-1
		flags := dirFlags | unix.O_NOFOLLOW
		if last {
			flags = fileFlags | unix.O_NOFOLLOW
		}
		fd, err := retry(func() (int, error) { return unix.Openat(dir, name, flags, 0) })
		unix.Close(dir)
		if err != nil {
			return -1, err
		}
		if !last {
			var st unix.Stat_t
			if err := unix.Fstat(fd, &st); err != nil || !statOf(&st).dir() {
				unix.Close(fd)
				return -1, unix.ENOTDIR
			}
		}
		dir = fd
	}
	return dir, nil
}

// readRecordFile reads a Claude Code record (dir/name) of at most max
// bytes: the directory must be the user's alone to write (private) and the
// record a regular file of the user's own, opened in that directory
// without following a link at its name.
func readRecordFile(dir, name string, max int64) ([]byte, error) {
	traceOpen(dir)
	dfd, err := retry(func() (int, error) {
		return unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	})
	if err != nil {
		return nil, err
	}
	defer unix.Close(dfd)
	var st unix.Stat_t
	if err := unix.Fstat(dfd, &st); err != nil {
		return nil, err
	}
	if !statOf(&st).private() {
		return nil, errNotOwn
	}
	traceOpen(path.Join(dir, name))
	fd, err := retry(func() (int, error) { return unix.Openat(dfd, name, fileFlags|unix.O_NOFOLLOW, 0) })
	if err != nil {
		return nil, err
	}
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if s := statOf(&st); !s.regular() || s.uid != agentUID {
		unix.Close(fd)
		return nil, errNotOwn
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		unix.Close(fd)
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path.Join(dir, name))
	defer f.Close()
	return readMax(f, max)
}

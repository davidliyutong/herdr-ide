//go:build unix

package store

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// machineIDFiles are where systems other than macOS keep the machine's id:
// systemd's (and dbus's, which systemd links to it) and FreeBSD's.
var machineIDFiles = []string{"/etc/machine-id", "/var/lib/dbus/machine-id", "/etc/hostid"}

// machineID is the machine's own id, which the system keeps on the machine
// (not on a home that hosts share): on macOS the platform's UUID
// (IOPlatformUUID), elsewhere the first of machineIDFiles that has one; ""
// for none.
func machineID() string {
	if runtime.GOOS == "darwin" {
		return platformUUID()
	}
	for _, p := range machineIDFiles {
		if b, err := os.ReadFile(p); err == nil {
			if id := strings.TrimSpace(string(b)); id != "" && len(id) <= 256 {
				return id
			}
		}
	}
	return ""
}

// platformUUID is macOS's hardware UUID, as ioreg shows it, "" when it
// cannot be read in 5 s.
func platformUUID() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return ""
	}
	return ioregUUID(out)
}

// ioregUUID is the IOPlatformUUID of ioreg's output.
func ioregUUID(out []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if ok && strings.TrimSpace(k) == `"IOPlatformUUID"` {
			return strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return ""
}

// SQLite's locks of a database file (its unix VFS): the pending byte, the
// reserved byte and the range of the shared locks, 512 bytes from 1 GiB.
const (
	sqlitePendingByte = 0x40000000
	sqliteLockBytes   = 512
)

// removeUnheld removes the database at p with its journal files when it
// takes the lock SQLite's writers take on it, without waiting, and still
// reports it should go once it holds it; false when the lock is held (or
// cannot be taken) or still says no.
func removeUnheld(p string, still func() bool) (bool, error) {
	f, err := os.OpenFile(p, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false, nil
	}
	// Closing it releases the lock (and every lock of this process on the
	// file: openHere made sure SQLite holds none here).
	defer f.Close()
	st, err := f.Stat()
	lst, lerr := os.Lstat(p)
	if err != nil || lerr != nil || !st.Mode().IsRegular() || !os.SameFile(st, lst) {
		return false, nil
	}
	lk := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: io.SeekStart, Start: sqlitePendingByte, Len: sqliteLockBytes}
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &lk); err != nil {
		return false, nil
	}
	if !still() {
		return false, nil
	}
	if err := removeFiles(p); err != nil {
		return false, err
	}
	return true, nil
}

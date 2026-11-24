//go:build unix

package hostdirs

import (
	"os"
	"strconv"
	"syscall"
)

// userRuntimeRoot holds the users' runtime directories (systemd-logind's,
// elogind's): tmpfs, one per host, removed when the user's last session
// ends unless lingering, as the user's services are.
var userRuntimeRoot = "/run/user"

// userRuntime is /run/user/<uid> when it is a directory of the user's
// with mode 0700. The directory is looked at rather than
// XDG_RUNTIME_DIR, which processes started otherwise than by a login may
// lack.
func userRuntime() (string, bool) {
	dir := userRuntimeRoot + "/" + strconv.Itoa(os.Getuid())
	fi, err := os.Lstat(dir)
	if err != nil || !fi.IsDir() || fi.Mode().Perm()&0o077 != 0 || !ownDir(fi) {
		return "", false
	}
	return dir, true
}

// ownDir reports whether fi is the user's.
func ownDir(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}

package agent

import (
	"errors"
	"net"
	"syscall"
)

// peerPid returns the process at the other end of a unix socket connection.
func peerPid(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var serr error
	err = raw.Control(func(fd uintptr) {
		// SOL_LOCAL, LOCAL_PEERPID from <sys/un.h>.
		pid, serr = syscall.GetsockoptInt(int(fd), 0, 0x002)
	})
	if err != nil {
		return 0, err
	}
	return pid, serr
}

// peerCred is peerPid with the peer's user; macOS has no virtual displays,
// so the user is not needed there and not reported.
func peerCred(c *net.UnixConn) (pid, uid int, err error) {
	pid, err = peerPid(c)
	if err != nil {
		return 0, 0, err
	}
	return pid, -1, errors.New("peer user not available on darwin")
}

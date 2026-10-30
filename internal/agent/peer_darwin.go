package agent

import (
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

package agent

import (
	"bytes"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
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

// peerCred returns the process and user at the other end of a unix socket
// connection (for a connected client: the process that listens).
func peerCred(c *net.UnixConn) (pid, uid int, err error) {
	pid, err = peerPid(c)
	if err != nil {
		return 0, 0, err
	}
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *unix.Xucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	}); err != nil {
		return 0, 0, err
	}
	if serr != nil {
		return 0, 0, serr
	}
	return pid, int(cred.Uid), nil
}

// parentOf returns pid's parent and pid's name (its p_comm, at most 16
// bytes) from the kernel (sysctl kern.proc.pid); ok is false when the
// process is gone.
func parentOf(pid int) (ppid int, name string, ok bool) {
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || kp.Proc.P_pid != int32(pid) {
		return 0, "", false
	}
	comm := kp.Proc.P_comm[:]
	if i := bytes.IndexByte(comm, 0); i >= 0 {
		comm = comm[:i]
	}
	return int(kp.Eproc.Ppid), string(comm), true
}

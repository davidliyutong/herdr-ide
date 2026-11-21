package agent

import (
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// peerPid returns the process at the other end of a unix socket connection.
func peerPid(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var serr error
	err = raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return 0, err
	}
	if serr != nil {
		return 0, serr
	}
	return int(cred.Pid), nil
}

// peerCred returns the process and user at the other end of a unix socket
// connection (for a connected client: the process that listens).
func peerCred(c *net.UnixConn) (pid, uid int, err error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *syscall.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, 0, err
	}
	if serr != nil {
		return 0, 0, serr
	}
	return int(cred.Pid), int(cred.Uid), nil
}

// parentOf returns pid's parent and pid's name (its comm) from
// /proc/<pid>/stat; ok is false when the process is gone.
func parentOf(pid int) (ppid int, name string, ok bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, "", false
	}
	// "pid (comm) state ppid …": the name may hold spaces and parentheses.
	s := string(b)
	open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 0 || end < open {
		return 0, "", false
	}
	f := strings.Fields(s[end+1:])
	if len(f) < 2 {
		return 0, "", false
	}
	ppid, _ = strconv.Atoi(f[1])
	return ppid, s[open+1 : end], true
}

//go:build unix

package usage

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

// ownGroup runs cmd in a process group of its own and makes the end of
// its context kill the whole group.
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		killGroup(cmd)
		return nil
	}
}

// killGroup kills what is left of cmd's process group.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil && cmd.Process.Pid > 0 {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// osRelease is the kernel's release (uname -r), as Node's os.release().
func osRelease() string {
	var u unix.Utsname
	if unix.Uname(&u) != nil {
		return ""
	}
	return unix.ByteSliceToString(u.Release[:])
}

//go:build unix

package usage

import (
	"os/exec"
	"syscall"
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

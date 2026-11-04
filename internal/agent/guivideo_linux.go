package agent

import "syscall"

// encoderProcAttr puts an encoder in its own process group, killed when
// the agent dies.
func encoderProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

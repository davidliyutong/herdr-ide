package transport

import (
	"os/exec"
	"syscall"
)

// ControlDir is empty on Windows: its OpenSSH cannot share connections
// (ControlMaster), so each ssh command connects and authenticates itself.
func ControlDir() (string, error) { return "", nil }

// noConsole starts ssh without a console window of its own: the desktop
// app's core has none, and Windows would give each ssh one.
func noConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

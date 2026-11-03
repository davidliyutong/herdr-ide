//go:build !linux

package agent

import "syscall"

// encoderProcAttr: program windows are encoded on Linux only.
func encoderProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

//go:build unix

package vaultmcp

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// newGroup starts the command in a process group of its own, which a
// timeout ends as a whole.
func newGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// ParentName is the name of the program that started this one (the CLI
// of a coding agent: claude, codex, node…), "" when unknown.
func ParentName() string {
	ppid := os.Getppid()
	var name string
	switch runtime.GOOS {
	case "linux":
		b, err := os.ReadFile("/proc/" + strconv.Itoa(ppid) + "/comm")
		if err != nil {
			return ""
		}
		name = string(b)
	default:
		out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(ppid)).Output()
		if err != nil {
			return ""
		}
		name = string(out)
	}
	return filepath.Base(strings.TrimSpace(name))
}

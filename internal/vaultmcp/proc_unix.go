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

// newGroup starts the command in a process group of its own, which is
// killed as a whole when the command returns, times out or is cancelled.
// A program that leaves the group (setsid, a daemon) escapes it. On Linux
// the shell also gets SIGKILL when the server dies.
func newGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	parentDeathSignal(cmd.SysProcAttr)
}

// watcherScript runs first in the command's shell: a watcher in the
// command's group waits on fd 3, the read end of a pipe whose write end
// only the server holds, and kills the group (kill 0) when it reads the
// end, which comes when the server is gone, however it ended (SIGKILL
// included); then the shell closes fd 3 and becomes the command's shell
// ($0, an absolute path: the command's environment may name another PATH),
// the command's $0 being $2. The watcher's output goes nowhere, so it does
// not hold the command's.
const watcherScript = `(read x <&3; kill -9 0) >/dev/null 2>&1 &
exec 3<&-
exec "$0" -c "$1" "$2"`

// watchServer makes cmd, a shell's -c command, end with this process: the
// shell runs watcherScript before the command. started is called once the
// command started (the server drops its read end), done once it is over
// (the write end goes, and with it the watcher if the group still runs).
func watchServer(cmd *exec.Cmd) (started, done func(), err error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	shell, command := cmd.Args[0], cmd.Args[2]
	cmd.Args = []string{shell, "-c", watcherScript, cmd.Path, command, shell}
	cmd.ExtraFiles = append(cmd.ExtraFiles, r) // fd 3
	return func() { r.Close() }, func() { r.Close(); w.Close() }, nil
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
		ps := "/bin/ps"
		if _, err := os.Stat(ps); err != nil {
			ps = "ps"
		}
		out, err := exec.Command(ps, "-o", "comm=", "-p", strconv.Itoa(ppid)).Output()
		if err != nil {
			return ""
		}
		name = string(out)
	}
	return filepath.Base(strings.TrimSpace(name))
}

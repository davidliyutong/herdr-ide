package vaultmcp

import "os/exec"

func newGroup(*exec.Cmd) {}

// watchServer leaves the command as it is on Windows, where no agent runs.
func watchServer(*exec.Cmd) (started, done func(), err error) {
	return func() {}, func() {}, nil
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// ParentName is unknown on Windows, where no agent runs.
func ParentName() string { return "" }

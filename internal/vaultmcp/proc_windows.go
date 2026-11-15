package vaultmcp

import "os/exec"

func newGroup(*exec.Cmd) {}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// ParentName is unknown on Windows, where no agent runs.
func ParentName() string { return "" }

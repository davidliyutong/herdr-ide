//go:build !unix

package usage

import "os/exec"

// ownGroup does nothing where there are no process groups (the agent runs
// on Unix only).
func ownGroup(*exec.Cmd) {}

// killGroup does nothing where there are no process groups.
func killGroup(*exec.Cmd) {}

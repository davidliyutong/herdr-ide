//go:build unix

package agent_test

import (
	"testing"

	agentgit "herdr-ide/internal/agent/plugin/git"
	coregit "herdr-ide/internal/plugins/git"
)

// The core's routes of the Git plugin are its machine side's actions,
// reads as reads.
func TestGitPluginActions(t *testing.T) {
	core := map[string]bool{}
	for _, a := range coregit.Reads {
		core[a] = true
		if !agentgit.Reads[a] {
			t.Errorf("core read %s is not an agent read", a)
		}
	}
	for _, a := range coregit.Writes {
		core[a] = true
		if !agentgit.Writes[a] {
			t.Errorf("core change %s is not an agent change", a)
		}
	}
	if len(core) != len(agentgit.Reads)+len(agentgit.Writes) {
		t.Errorf("core has %d actions, the agent %d", len(core), len(agentgit.Reads)+len(agentgit.Writes))
	}
}

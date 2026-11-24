//go:build unix

package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"veldr/internal/brand"
)

// cleanEnv is the agent's environment for the programs it starts (the
// terminal core, whose terminals inherit it, code-server, the display),
// without the variables of a terminal or multiplexer the agent itself was
// started in, nor the session markers of a coding agent it was started
// from: those programs belong to no terminal, no multiplexer and no
// agent's session. A shell in their terminals that saw TMUX or
// HERDR_PANE_ID would take itself for a nested session, or hand an agent's
// status to the herdr pane the core was started from; Claude Code that saw
// CLAUDE_CODE_CHILD_SESSION would take itself for a child session and save
// no transcript and no session file. A core started on the command line
// (or by the desktop app) runs the local machine's agent in its own process
// and so with its own environment; ssh machines start theirs from a login.
func cleanEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if !inheritedVar(k) {
			continue
		}
		env = append(env, kv)
	}
	return env
}

// agentSessionVars are the variables by which Claude Code and Codex mark
// the programs of one of their sessions. They are named one by one, not by
// prefix: users configure these agents through other variables of the same
// prefixes (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK,
// CLAUDE_CODE_MAX_OUTPUT_TOKENS, ANTHROPIC_*, CODEX_HOME, OPENAI_*), which
// the programs in the terminals need.
var agentSessionVars = map[string]bool{
	"CLAUDECODE":                      true,
	"CLAUDE_CODE_CHILD_SESSION":       true,
	"CLAUDE_CODE_CHILD_NOTES_DIR":     true,
	"CLAUDE_CODE_ENTRYPOINT":          true,
	"CLAUDE_CODE_EXECPATH":            true,
	"CLAUDE_CODE_SESSION_ID":          true,
	"CLAUDE_CODE_SESSION_ATTENDED":    true,
	"CLAUDE_CODE_MESSAGING_SOCKET":    true,
	"CLAUDE_CODE_MESSAGING_TOKEN":     true,
	"CLAUDE_CODE_BRIDGE_SESSION_ID":   true,
	"CLAUDE_PID":                      true,
	"CLAUDE_EFFORT":                   true,
	"CLAUDE_PLUGIN_DATA":              true,
	"CODEX_THREAD_ID":                 true,
	"CODEX_SESSION_ID":                true,
	"CODEX_TOOL_CALL_ID":              true,
	"CODEX_COMPANION_SESSION_ID":      true,
	"CODEX_COMPANION_TRANSCRIPT_PATH": true,
}

// inheritedVar says whether a variable of the agent's environment is
// passed on (cleanEnv): not the terminal core's (HC_*, among them
// HC_SESSION, HC_SOCKET, HC_TERMINAL_ID and HC_TERMINAL_SOCKET), herdr's
// (HERDR_*; the product's own variables, brand.EnvPrefix, are kept),
// tmux's (TMUX, TMUX_PANE), GNU screen's (STY), zellij's (ZELLIJ,
// ZELLIJ_*) or a coding agent's session markers (agentSessionVars).
func inheritedVar(k string) bool {
	switch k {
	case "TMUX", "TMUX_PANE", "STY", "ZELLIJ":
		return false
	}
	if agentSessionVars[k] {
		return false
	}
	if strings.HasPrefix(k, "HC_") || strings.HasPrefix(k, "ZELLIJ_") {
		return false
	}
	return !strings.HasPrefix(k, "HERDR_") || strings.HasPrefix(k, brand.EnvPrefix)
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

// runOutput runs a command and returns its standard output; its error
// carries the standard error.
func runOutput(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

//go:build unix

package agent

import (
	"strings"
	"testing"

	"veldr/internal/brand"
)

// The programs the agent starts (the terminal core and so its terminals)
// do not inherit the terminal or multiplexer the agent was started in.
func TestCleanEnv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	drop := []string{
		"HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_LOG", "HC_CONFIG_DIR", "HC_",
		"HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_WORKSPACE_ID",
		"TMUX", "TMUX_PANE", "STY", "ZELLIJ", "ZELLIJ_SESSION_NAME",
	}
	keep := []string{"PATH", "LANG", "TERM_PROGRAM", "TMUX_TMPDIR", "WINDOW", "HCX", "MY_HC_VAR", brand.EnvPrefix + "CORE"}
	for _, k := range append(append([]string{}, drop...), keep...) {
		t.Setenv(k, "x")
	}
	got := map[string]bool{}
	for _, kv := range cleanEnv() {
		k, _, _ := strings.Cut(kv, "=")
		got[k] = true
	}
	for _, k := range drop {
		if got[k] {
			t.Errorf("%s passed on", k)
		}
	}
	for _, k := range keep {
		if !got[k] {
			t.Errorf("%s dropped", k)
		}
	}
}

// A core started from inside a coding agent's session (a developer running
// it from Claude Code's terminal) does not hand that session's markers to
// its terminals, where an agent would take itself for a child session; the
// variables that configure the agents stay.
func TestCleanEnvAgentSessionMarkers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	drop := []string{
		"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_CHILD_NOTES_DIR", "CLAUDE_CODE_ENTRYPOINT",
		"CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
		"CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_BRIDGE_SESSION_ID",
		"CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA",
		"CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID",
		"CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH",
	}
	keep := []string{
		"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
		"CLAUDE_CODE_SESSION", "CLAUDECODE_X", "CLAUDE_PID_FILE",
		"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
		"CODEX_HOME", "CODEX_THREAD", "OPENAI_API_KEY", "OPENAI_BASE_URL",
	}
	for _, k := range append(append([]string{}, drop...), keep...) {
		t.Setenv(k, "x")
	}
	got := map[string]bool{}
	for _, kv := range cleanEnv() {
		k, _, _ := strings.Cut(kv, "=")
		got[k] = true
	}
	for _, k := range drop {
		if got[k] {
			t.Errorf("%s passed on", k)
		}
	}
	for _, k := range keep {
		if !got[k] {
			t.Errorf("%s dropped", k)
		}
	}
	if len(agentSessionVars) != len(drop) {
		t.Errorf("%d markers dropped, %d tested", len(agentSessionVars), len(drop))
	}
}

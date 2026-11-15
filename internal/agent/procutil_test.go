//go:build unix

package agent

import (
	"strings"
	"testing"

	"herdr-ide/internal/brand"
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

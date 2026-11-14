package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"herdr-ide/internal/brand"
)

// cleanEnv is the agent's environment for the programs it starts (the
// terminal core, whose terminals inherit it, code-server, the display),
// without the variables of a terminal or multiplexer the agent itself was
// started in: those programs belong to no terminal and to no multiplexer,
// and a shell in their terminals that saw TMUX or HERDR_PANE_ID would take
// itself for a nested session, or hand an agent's status to the herdr pane
// the core was started from. A core started on the command line runs the
// local machine's agent with its own environment; ssh machines start
// theirs from a login.
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

// inheritedVar says whether a variable of the agent's environment is
// passed on (cleanEnv): not the terminal core's (HC_SESSION, HC_SOCKET,
// HC_TERMINAL_ID, HC_TERMINAL_SOCKET), herdr's (HERDR_*; the product's own
// variables, brand.EnvPrefix, are kept), tmux's (TMUX, TMUX_PANE), GNU
// screen's (STY) or zellij's (ZELLIJ, ZELLIJ_*).
func inheritedVar(k string) bool {
	switch k {
	case "HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "TMUX", "TMUX_PANE", "STY", "ZELLIJ":
		return false
	}
	if strings.HasPrefix(k, "HERDR_") && !strings.HasPrefix(k, brand.EnvPrefix) {
		return false
	}
	return !strings.HasPrefix(k, "ZELLIJ_")
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

// tailBuffer keeps the last 8 KiB written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if t.buf.Len() > 8192 {
		b := t.buf.Bytes()
		keep := append([]byte(nil), b[len(b)-8192:]...)
		t.buf.Reset()
		t.buf.Write(keep)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

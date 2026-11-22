//go:build unix

package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// Helpers of the product's own that outlive the agent (the chat host) run
// as terminals of the instance's terminal core: the terminal core, not the
// agent, is their parent, so they have the lifetime, the owner (a user
// service or launchd job) and, on macOS, the privacy attribution of the
// user's terminals. They end with their program, or with the terminal core
// (its stop sends SIGHUP, SIGTERM half a second later, then SIGKILL). No
// client shows them: the core keeps a terminal that carries
// agentproto.HiddenLabel from its clients.

const (
	// hiddenCols and hiddenRows are the size of a helper's terminal, which
	// nobody looks at.
	hiddenCols = 80
	hiddenRows = 24
	// hiddenTimeout is how long the terminal core has to answer a run.
	hiddenTimeout = 30 * time.Second
	// hiddenDial is how long the terminal core's socket has to take the
	// connection.
	hiddenDial = 5 * time.Second
)

// runHidden runs argv as a terminal of the instance's terminal core named
// name, with the label that hides it from clients: without a parent, not
// notifying, in the user's home, with the agent's environment for the
// programs it starts (hiddenEnv) on top of the terminal core's, and removed
// from the terminal core's records as soon as its program exits. The
// terminal core gives a name to one live terminal at a time, so a name
// that is taken means the helper runs already (or one that ends still
// holds it), which is success: the caller finds it serving, or asks again.
// The error wraps plugin.ErrNoTerminalCore when no terminal core answers on
// the instance's socket: the agent starts none here.
func (a *Agent) runHidden(ctx context.Context, name string, argv []string) error {
	c, err := net.DialTimeout("unix", a.hcSocket(), hiddenDial)
	if err != nil {
		return fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	dctx, dcancel := context.WithTimeout(ctx, hiddenDial)
	conn, _, err := hc.Dial(dctx, c)
	dcancel()
	if err != nil {
		return fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(ctx, hiddenTimeout)
	defer cancel()
	err = conn.Call(ctx, "terminal.run", map[string]any{
		"argv": argv, "cwd": a.home, "env": hiddenEnv(cleanEnv()),
		"name":      name,
		"labels":    map[string]string{agentproto.HiddenLabel: agentproto.HiddenValue(name)},
		"size":      map[string]int{"cols": hiddenCols, "rows": hiddenRows},
		"no_parent": true, "no_notify": true, "rm": true,
	}, nil)
	var e *hc.Error
	if errors.As(err, &e) && e.Kind == "name_taken" {
		return nil
	}
	if err != nil {
		return fmt.Errorf("terminal core: run %s: %w", name, err)
	}
	a.logger.Printf("started %s as a hidden terminal of the terminal core", name)
	return nil
}

// hiddenEnv is what a helper gets on top of the terminal core's
// environment: the agent's (environ, cleanEnv's) without the variables of
// the ssh session the agent may have been started from, which the terminal
// core leaves out of its own (a helper outlives that session), and without
// the terminal identity the terminal core sets for its terminals (TERM,
// TERM_PROGRAM*, COLORTERM), which a client's environment would override.
func hiddenEnv(environ []string) map[string]string {
	env := map[string]string{}
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			continue
		}
		if strings.HasPrefix(k, "SSH_") || k == "TERM" || k == "COLORTERM" || strings.HasPrefix(k, "TERM_PROGRAM") {
			continue
		}
		env[k] = v
	}
	return env
}

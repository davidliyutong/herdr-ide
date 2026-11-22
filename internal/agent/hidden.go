//go:build unix

package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
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
// notifying, in the user's home, with the user's variables of the agent's
// environment (hiddenEnv) on top of the terminal core's, and removed
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

// errNotHelper is killHidden's error for a terminal of the name that is not
// the helper argv runs.
var errNotHelper = errors.New("the terminal of the name is not the helper")

// killHidden is plugin.Env.KillHidden: killHidden on the instance's
// terminal core.
func (a *Agent) killHidden(ctx context.Context, name string, argv []string, kill bool) (bool, error) {
	return killHidden(ctx, a.hcSocket(), name, argv, kill)
}

// killHidden ends a helper terminal that holds its name and does not do
// its work (its socket does not answer): the terminal named name, when it
// carries the helper's hidden label (HiddenValue(name)) and runs argv's
// program with argv's arguments (the program's path may be an older
// build's), is killed by the terminal core, and killHidden returns once
// the name is free, true; without kill, it reports whether such a live
// terminal holds the name. False, nil when no live terminal has the name;
// errNotHelper when the one that has it is not such a helper, which is
// left alone. sock is the terminal core's socket.
func killHidden(ctx context.Context, sock, name string, argv []string, kill bool) (bool, error) {
	c, err := net.DialTimeout("unix", sock, hiddenDial)
	if err != nil {
		return false, fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	dctx, dcancel := context.WithTimeout(ctx, hiddenDial)
	conn, _, err := hc.Dial(dctx, c)
	dcancel()
	if err != nil {
		return false, fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(ctx, hiddenTimeout)
	defer cancel()
	live := func() (*hc.Terminal, error) {
		var rec hc.Terminal
		err := conn.Call(ctx, "terminal.get", map[string]string{"terminal": name}, &rec)
		var e *hc.Error
		if errors.As(err, &e) && e.Kind == "not_found" {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("terminal core: get %s: %w", name, err)
		}
		if rec.State != "live" {
			return nil, nil
		}
		return &rec, nil
	}
	rec, err := live()
	if rec == nil || err != nil {
		return false, err
	}
	if rec.Labels[agentproto.HiddenLabel] != agentproto.HiddenValue(name) || len(rec.Argv) != len(argv) || len(argv) == 0 ||
		!slices.Equal(rec.Argv[1:], argv[1:]) {
		return false, errNotHelper
	}
	if !kill {
		return true, nil
	}
	if err := conn.Call(ctx, "terminal.kill", map[string]string{"terminal": rec.Address}, nil); err != nil {
		return false, fmt.Errorf("terminal core: kill %s: %w", rec.Address, err)
	}
	for {
		rec, err := live()
		if err != nil {
			return false, err
		}
		if rec == nil {
			return true, nil
		}
		select {
		case <-ctx.Done():
			return false, fmt.Errorf("terminal core: %s did not end: %w", name, ctx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// hiddenEnv is what a helper gets on top of the terminal core's
// environment: of the agent's (environ, cleanEnv's), only what names the
// user, the user's home, shell, PATH, locale, temporary directory and XDG
// directories (hiddenVars). A helper outlives the ssh session and the
// terminal the agent may have been started from, and takes what the
// programs it starts need from the user's login shell (the chat host:
// internal/chathost); nothing else of the agent's environment (its
// credentials, its session's variables) reaches it.
func hiddenEnv(environ []string) map[string]string {
	env := map[string]string{}
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if ok && hiddenVar(k) {
			env[k] = v
		}
	}
	return env
}

// hiddenVar tells whether a variable of the agent's environment is one a
// helper gets.
func hiddenVar(k string) bool {
	switch k {
	case "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "TMPDIR":
		return true
	}
	return strings.HasPrefix(k, "LC_") || strings.HasPrefix(k, "XDG_")
}

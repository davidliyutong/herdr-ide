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

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
	"veldr/internal/hc"
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
	// maxChatHostFallbacks bounds fallback terminal names tried when a user
	// terminal occupies ChatHostName without the helper's hidden identity.
	maxChatHostFallbacks = 16
)

func dialHC(ctx context.Context, sock string) (*hc.Conn, error) {
	c, err := net.DialTimeout("unix", sock, hiddenDial)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	dctx, dcancel := context.WithTimeout(ctx, hiddenDial)
	conn, _, err := hc.Dial(dctx, c)
	dcancel()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", plugin.ErrNoTerminalCore, err)
	}
	return conn, nil
}

func getLiveTerminal(ctx context.Context, conn *hc.Conn, target string) (*hc.Terminal, error) {
	var rec hc.Terminal
	err := conn.Call(ctx, "terminal.get", map[string]string{"terminal": target}, &rec)
	var e *hc.Error
	if errors.As(err, &e) && e.Kind == "not_found" {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("terminal core: get %s: %w", target, err)
	}
	if rec.State != "live" {
		return nil, nil
	}
	return &rec, nil
}

func isHelperRecord(rec *hc.Terminal, name string, argv []string) bool {
	if rec == nil || rec.State != "live" {
		return false
	}
	if rec.Name != nil && *rec.Name != name {
		return false
	}
	return rec.Labels[agentproto.HiddenLabel] == agentproto.HiddenValue(name) &&
		len(rec.Argv) == len(argv) && len(argv) > 0 && slices.Equal(rec.Argv[1:], argv[1:])
}

// runHidden runs argv as a terminal of the instance's terminal core named
// name, with the label that hides it from clients: without a parent, not
// notifying, in the user's home, with the user's variables of the agent's
// environment (hiddenEnv) on top of the terminal core's, and removed
// from the terminal core's records as soon as its program exits. When name
// is already taken by our own helper, runHidden succeeds so the caller finds
// it serving; when ChatHostName is occupied by a user terminal (missing the
// hidden identity), runHidden leaves that terminal untouched and falls back to
// a disambiguated hidden name (ChatHostFallbackName).
// The error wraps plugin.ErrNoTerminalCore when no terminal core answers on
// the instance's socket: the agent starts none here.
func (a *Agent) runHidden(ctx context.Context, name string, argv []string) error {
	conn, err := dialHC(ctx, a.hcSocket())
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(ctx, hiddenTimeout)
	defer cancel()

	candidates := []string{name}
	if name == agentproto.ChatHostName {
		for i := 1; i <= maxChatHostFallbacks; i++ {
			candidates = append(candidates, agentproto.ChatHostFallbackName(i))
		}
	}
	env := hiddenEnv(cleanEnv())
	for _, candidate := range candidates {
		started, takenByHelper, err := tryRunHidden(ctx, conn, a.home, env, candidate, argv)
		if err != nil {
			return err
		}
		if started {
			a.logger.Printf("started %s as a hidden terminal of the terminal core", candidate)
			return nil
		}
		if takenByHelper {
			return nil
		}
		// Name is occupied by a non-helper terminal: never kill/hijack it;
		// continue to the next fallback candidate if available.
	}
	if name == agentproto.ChatHostName {
		return fmt.Errorf("terminal core: run %s: all fallback names are taken", name)
	}
	return fmt.Errorf("terminal core: run %s: %w", name, errNotHelper)
}

func tryRunHidden(ctx context.Context, conn *hc.Conn, home string, env map[string]string, candidate string, argv []string) (started, takenByHelper bool, err error) {
	params := map[string]any{
		"argv": argv, "cwd": home, "env": env,
		"name":      candidate,
		"labels":    map[string]string{agentproto.HiddenLabel: agentproto.HiddenValue(candidate)},
		"size":      map[string]int{"cols": hiddenCols, "rows": hiddenRows},
		"no_parent": true, "no_notify": true, "rm": true,
	}
	for attempt := 0; attempt < 2; attempt++ {
		err = conn.Call(ctx, "terminal.run", params, nil)
		if err == nil {
			return true, false, nil
		}
		var e *hc.Error
		if !errors.As(err, &e) || e.Kind != "name_taken" {
			return false, false, fmt.Errorf("terminal core: run %s: %w", candidate, err)
		}
		rec, gerr := getLiveTerminal(ctx, conn, candidate)
		if gerr != nil {
			return false, false, gerr
		}
		if rec == nil {
			// Terminal exited between terminal.run and terminal.get; retry once.
			continue
		}
		if isHelperRecord(rec, candidate, argv) {
			return false, true, nil
		}
		return false, false, nil
	}
	return false, false, nil
}

// errNotHelper is killHidden's error for a terminal of the name that is not
// the helper argv runs.
var errNotHelper = errors.New("the terminal of the name is not the helper")

// killHidden is plugin.Env.KillHidden: killHidden on the instance's
// terminal core, falling back to disambiguated helper names when ChatHostName
// is occupied by a user's terminal.
func (a *Agent) killHidden(ctx context.Context, name string, argv []string, kill bool) (bool, error) {
	ok, err := killHidden(ctx, a.hcSocket(), name, argv, kill)
	if errors.Is(err, errNotHelper) && name == agentproto.ChatHostName {
		return killFallbackHidden(ctx, a.hcSocket(), argv, kill)
	}
	return ok, err
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
	conn, err := dialHC(ctx, sock)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(ctx, hiddenTimeout)
	defer cancel()
	return killNamedHelper(ctx, conn, name, argv, kill)
}

func killFallbackHidden(ctx context.Context, sock string, argv []string, kill bool) (bool, error) {
	conn, err := dialHC(ctx, sock)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(ctx, hiddenTimeout)
	defer cancel()
	for i := 1; i <= maxChatHostFallbacks; i++ {
		ok, err := killNamedHelper(ctx, conn, agentproto.ChatHostFallbackName(i), argv, kill)
		if errors.Is(err, errNotHelper) {
			continue
		}
		if err != nil || ok {
			return ok, err
		}
	}
	return false, nil
}

func killNamedHelper(ctx context.Context, conn *hc.Conn, name string, argv []string, kill bool) (bool, error) {
	rec, err := getLiveTerminal(ctx, conn, name)
	if rec == nil || err != nil {
		return false, err
	}
	if !isHelperRecord(rec, name, argv) {
		return false, errNotHelper
	}
	if !kill {
		return true, nil
	}
	if err := conn.Call(ctx, "terminal.kill", map[string]string{"terminal": rec.Address}, nil); err != nil {
		return false, fmt.Errorf("terminal core: kill %s: %w", rec.Address, err)
	}
	for {
		rec, err := getLiveTerminal(ctx, conn, name)
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

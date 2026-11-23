//go:build unix

// Package plugin is the machine side of the core's plugins
// (internal/plugin): handlers of the agent's plugin op, one per plugin,
// registered by the plugins' packages. A handler answers one action per
// stream: a reply with its result (Reply), or a reply followed by what the
// action streams until either side closes the stream.
package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"

	"herdr-ide/internal/agentproto"
)

// Env is what the agent gives its plugins.
type Env struct {
	// Home is the user's home directory, Base the agent's data directory
	// (~/.<slug>[-<instance>]), RunDir its private run directory.
	Home, Base, RunDir string
	Logger             *log.Logger
	// Expand resolves "~" and makes a path absolute relative to Home.
	Expand func(string) (string, error)
	// Environ is the environment of processes the agent starts: its own
	// without the terminal core's and multiplexers' variables.
	Environ func() []string
	// RunHidden runs argv as a terminal of the instance's terminal core
	// that no client shows (agentproto.HiddenLabel), named name: a helper
	// of the product's own that outlives the agent, as the user's
	// terminals do. A live terminal that has the name already is success:
	// the helper runs (or one that ends still holds the name). The error
	// wraps ErrNoTerminalCore when no terminal core answers.
	RunHidden func(ctx context.Context, name string, argv []string) error
	// KillHidden ends a helper's terminal that holds its name and does
	// not do its work: when the live terminal named name carries the
	// helper's hidden label and runs argv's program with argv's arguments
	// (the program's path may be an older build's), the terminal core
	// kills it and KillHidden returns once the name is free, true; without
	// kill, it reports whether such a terminal holds the name. False, nil
	// when no live terminal has the name; an error, and the terminal left
	// alone, when the one that has it is not such a helper. Nil leaves a
	// stuck helper as it is.
	KillHidden func(ctx context.Context, name string, argv []string, kill bool) (bool, error)
}

// ErrNoTerminalCore is RunHidden's error when the instance's terminal core
// does not run: the agent starts none for a helper.
var ErrNoTerminalCore = errors.New("the terminal core is not running")

// Handler runs the actions of one plugin. It owns st and closes it. params
// are read in full, from the header or the body after it; ctx is the
// agent's: an action that reads nothing more from st ends with the core's
// interest through UntilClosed.
type Handler func(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *Env) error

var (
	mu       sync.Mutex
	handlers = map[string]Handler{}
)

// Register adds a plugin's handler; packages call it from init.
func Register(id string, h Handler) {
	mu.Lock()
	defer mu.Unlock()
	if _, dup := handlers[id]; dup {
		panic("plugin registered twice: " + id)
	}
	handlers[id] = h
}

// Lookup returns the handler of id, nil when none is registered.
func Lookup(id string) Handler {
	mu.Lock()
	defer mu.Unlock()
	return handlers[id]
}

// Error is a failure with a code the UIs translate.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}

func (e *Error) Unwrap() error { return e.Err }

// Errorf returns an Error with code.
func Errorf(code, format string, args ...any) error {
	return &Error{Code: code, Err: fmt.Errorf(format, args...)}
}

// Decode reads an action's params into v; empty params leave v as it is.
func Decode(params json.RawMessage, v any) error {
	if len(params) == 0 {
		return nil
	}
	if err := json.Unmarshal(params, v); err != nil {
		return &Error{Code: "bad_params", Err: err}
	}
	return nil
}

// Reply answers the stream with v as the result, or with err, and closes it.
func Reply(st net.Conn, v any, err error) error {
	defer st.Close()
	if err != nil {
		return Fail(st, err)
	}
	return writeResult(st, v)
}

// Fail answers with err and its code (Error's, else "failed").
func Fail(st net.Conn, err error) error {
	code := "failed"
	var pe *Error
	if errors.As(err, &pe) {
		code = pe.Code
	}
	return agentproto.WriteLine(st, agentproto.Reply{OK: false, Error: err.Error(), Code: code})
}

func writeResult(st net.Conn, v any) error {
	rep := agentproto.Reply{OK: true}
	var body []byte
	if v != nil {
		b, err := json.Marshal(v)
		if err != nil {
			return Fail(st, err)
		}
		switch {
		case len(b) > agentproto.MaxBody:
			return Fail(st, Errorf("too_large", "result of %d bytes", len(b)))
		case len(b) > agentproto.MaxInline:
			// A large result follows the reply line, which the core reads
			// byte by byte and bounds.
			rep.PluginLength, body = int64(len(b)), b
		default:
			rep.Plugin = b
		}
	}
	if err := agentproto.WriteLine(st, rep); err != nil {
		return err
	}
	if len(body) > 0 {
		_, err := st.Write(body)
		return err
	}
	return nil
}

// UntilClosed returns ctx ended also when the core closes st: it gave up
// on the action (its request ended or timed out, the machine was left).
// It reads one byte of st in the background, so only actions that read
// nothing more from st after the header use it (not one that reads an
// upload's chunks); the reply closing st ends it too. cancel releases it.
func UntilClosed(ctx context.Context, st net.Conn) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		var b [1]byte
		st.Read(b[:])
		cancel()
	}()
	return ctx, cancel
}

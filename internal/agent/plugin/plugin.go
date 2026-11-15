//go:build unix

// Package plugin is the machine side of the core's plugins
// (internal/plugin): handlers of the agent's plugin op, one per plugin,
// registered by the plugins' packages. A handler answers one action per
// stream: a reply with its result (Reply), or a reply followed by JSON
// lines (Stream) until either side closes the stream.
package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sort"
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
}

// Handler runs the actions of one plugin. It owns st and closes it.
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

// IDs lists the registered plugins, sorted.
func IDs() []string {
	mu.Lock()
	defer mu.Unlock()
	ids := make([]string, 0, len(handlers))
	for id := range handlers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
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
	if v != nil {
		b, err := json.Marshal(v)
		if err != nil {
			return Fail(st, err)
		}
		rep.Plugin = b
	}
	return agentproto.WriteLine(st, rep)
}

// Stream answers with first as the result, then writes the values next
// sends as JSON lines until it returns nil, ctx ends or the core closes
// the stream; it closes st.
func Stream(ctx context.Context, st net.Conn, first any, next func(ctx context.Context) (any, error)) error {
	defer st.Close()
	if err := writeResult(st, first); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// The core sends nothing after the header: a read ends when it closes
	// the stream.
	go func() {
		var b [1]byte
		st.Read(b[:])
		cancel()
	}()
	for {
		v, err := next(ctx)
		if err != nil || v == nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := agentproto.WriteLine(st, v); err != nil {
			return err
		}
	}
}

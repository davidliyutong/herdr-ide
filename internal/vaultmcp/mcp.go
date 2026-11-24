// Package vaultmcp is the variable vault's MCP server: the mcp command of
// the agent and of the core (whose process is the local machine's agent),
// which a coding agent's CLI (Claude Code, Codex…) starts on a machine and
// speaks to over stdio (JSON-RPC 2.0, one message per line). It asks the
// core for variables through the agent's <run>/vault.sock, which relays
// each connection to the core (agentproto.OpVault); the core decides what
// the machine may read. docs/features/30-variable-vault.md has the design.
package vaultmcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/hostdirs"
)

// LinkName is the stable command's name in <data dir>/bin, which MCP
// configurations name: a script (LinkScript) running the executable that
// serves this command, kept by the agent.
const LinkName = brand.Slug + "-mcp"

// ServerName is the server's name in MCP (serverInfo) and the name the
// setup guide gives it in the CLIs' configurations.
const ServerName = brand.Slug + "-vault"

// protocolVersions are the MCP revisions spoken, newest first.
var protocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// Limits.
const (
	maxLine = 4 << 20
	// maxResponse bounds the core's answer (values of up to 64 variables).
	maxResponse = 32 << 20
)

// Server serves MCP on a pair of streams.
type Server struct {
	// Dial connects to the agent's vault socket.
	Dial func(ctx context.Context) (net.Conn, error)
	// Client and Terminal tell the user who asks (VaultRequest).
	Client, Terminal string
	// Runner runs run_with_env's commands; zero values take the defaults.
	Runner Runner

	wmu sync.Mutex
	out io.Writer

	// calls are the tool calls in flight by request id, which the client
	// may cancel (notifications/cancelled).
	cmu   sync.Mutex
	calls map[string]*inflight
}

// inflight is a tool call that runs: cancel ends it (its request to the
// core, its command); cancelled says the client asked, so it gets no
// response.
type inflight struct {
	cancel    context.CancelFunc
	cancelled bool
}

// idKey is a request id as a map key: its JSON without spaces.
func idKey(id json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, id) != nil {
		return string(id)
	}
	return b.String()
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func (s *Server) send(v rpcResponse) {
	v.JSONRPC = "2.0"
	if v.ID == nil {
		v.ID = json.RawMessage("null")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	s.out.Write(append(b, '\n'))
}

// Serve answers the messages of in on out until in ends (the CLI closed
// it) or ctx does (Main: a signal); commands still running are then
// killed, and Serve returns once they are.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	s.out = out
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	defer wg.Wait()
	defer cancel()
	// Reading blocks until a line or the end of in: it runs apart, so that
	// ctx ends Serve too.
	lines := make(chan []byte)
	ended := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(in)
		sc.Buffer(make([]byte, 64<<10), maxLine)
		for sc.Scan() {
			select {
			case lines <- slices.Clone(sc.Bytes()):
			case <-ctx.Done():
				return
			}
		}
		ended <- sc.Err()
	}()
	for {
		var line []byte
		select {
		case <-ctx.Done():
			return nil
		case err := <-ended:
			return err
		case line = <-lines:
		}
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			s.send(rpcResponse{Error: &rpcError{Code: -32700, Message: "parse error"}})
			continue
		}
		if req.Method == "" {
			continue // a response to a request this server never makes
		}
		notification := req.ID == nil
		switch req.Method {
		case "initialize":
			s.send(rpcResponse{ID: req.ID, Result: initialize(req.Params)})
		case "ping":
			if !notification {
				s.send(rpcResponse{ID: req.ID, Result: map[string]any{}})
			}
		case "tools/list":
			s.send(rpcResponse{ID: req.ID, Result: map[string]any{"tools": tools()}})
		case "tools/call":
			if notification {
				continue
			}
			cctx, ccancel := context.WithCancel(ctx)
			call := &inflight{cancel: ccancel}
			key := idKey(req.ID)
			s.cmu.Lock()
			if s.calls == nil {
				s.calls = map[string]*inflight{}
			}
			s.calls[key] = call
			s.cmu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer ccancel()
				res, rerr := s.call(cctx, req.Params)
				s.cmu.Lock()
				if s.calls[key] == call {
					delete(s.calls, key)
				}
				cancelled := call.cancelled
				s.cmu.Unlock()
				if !cancelled {
					s.send(rpcResponse{ID: req.ID, Result: res, Error: rerr})
				}
			}()
		case "notifications/cancelled":
			// The client gave up on a request: its call ends (a request
			// waiting for the user's approval goes away, which the core
			// takes as a denial; a command is killed) and gets no response.
			var p struct {
				RequestID json.RawMessage `json:"requestId"`
			}
			if json.Unmarshal(req.Params, &p) == nil && len(p.RequestID) > 0 {
				s.cmu.Lock()
				if call := s.calls[idKey(p.RequestID)]; call != nil {
					call.cancelled = true
					call.cancel()
				}
				s.cmu.Unlock()
			}
		default:
			if !notification {
				s.send(rpcResponse{ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + req.Method}})
			}
		}
	}
}

func initialize(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	json.Unmarshal(params, &p)
	version := protocolVersions[0]
	for _, v := range protocolVersions {
		if v == p.ProtocolVersion {
			version = v
		}
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": ServerName, "version": agentproto.Version},
		"instructions": "Environment variables (API keys, tokens) kept in " + brand.Name + "'s vault. " +
			"Prefer run_with_env, which runs a command with the variables set and keeps their values out of the conversation; " +
			"use get_variable only when a value itself is needed. A request may wait for the user's approval.",
	}
}

func tools() []map[string]any {
	str := map[string]any{"type": "string"}
	return []map[string]any{
		{
			"name":        "list_variables",
			"description": "List the vault's variables: name, description, whether the value can only be injected into a command (inject_only), and whether reading it from this machine asks the user first (approval). Values are not listed.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "get_variable",
			"description": "Return a variable's value. The value enters the conversation; prefer run_with_env. Refused for inject-only variables.",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"name": str},
				"required":   []string{"name"},
			},
		},
		{
			"name": "run_with_env",
			"description": "Run a shell command (sh -c) with the named variables in its environment, and return its exit status and output (stdout and stderr, at most 64 KiB unless the vault's settings say otherwise). " +
				"Occurrences of the values in the output are replaced with ***. The default and longest timeouts are the vault's settings (120 s and 600 s unless changed).",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{"type": "string", "description": "The command, run by sh -c."},
					"names":   map[string]any{"type": "array", "items": str, "description": "The variables to set."},
					"cwd":     map[string]any{"type": "string", "description": "Working directory (default: the server's)."},
					"timeout": map[string]any{"type": "integer", "description": "Seconds (by default the vault's setting, 120 unless changed; at most its longest, 600 unless changed)."},
				},
				"required": []string{"command", "names"},
			},
		},
	}
}

// text is a tool result.
func text(s string, isError bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": s}}, "isError": isError}
}

func (s *Server) call(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "invalid params"}
	}
	if len(p.Arguments) == 0 || string(p.Arguments) == "null" {
		p.Arguments = json.RawMessage("{}")
	}
	switch p.Name {
	case "list_variables":
		resp, err := s.ask(ctx, agentproto.VaultRequest{Tool: agentproto.VaultList})
		if err != nil {
			return text(err.Error(), true), nil
		}
		b, _ := json.MarshalIndent(resp.Variables, "", "  ")
		if len(resp.Variables) == 0 {
			b = []byte("[]")
		}
		return text(string(b), false), nil
	case "get_variable":
		var a struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(p.Arguments, &a) != nil || a.Name == "" {
			return nil, &rpcError{Code: -32602, Message: "get_variable needs a name"}
		}
		resp, err := s.ask(ctx, agentproto.VaultRequest{Tool: agentproto.VaultGet, Names: []string{a.Name}})
		if err != nil {
			return text(err.Error(), true), nil
		}
		return text(resp.Values[a.Name], false), nil
	case "run_with_env":
		var a struct {
			Command string   `json:"command"`
			Names   []string `json:"names"`
			Cwd     string   `json:"cwd"`
			Timeout float64  `json:"timeout"`
		}
		if json.Unmarshal(p.Arguments, &a) != nil || a.Command == "" || len(a.Names) == 0 {
			return nil, &rpcError{Code: -32602, Message: "run_with_env needs a command and names"}
		}
		resp, err := s.ask(ctx, agentproto.VaultRequest{Tool: agentproto.VaultEnv, Names: a.Names, Cwd: a.Cwd})
		if err != nil {
			return text(err.Error(), true), nil
		}
		out, failed := s.Runner.with(resp.Run).Run(ctx, a.Command, resp.Values, a.Cwd, time.Duration(a.Timeout*float64(time.Second)))
		return text(out, failed), nil
	}
	return nil, &rpcError{Code: -32602, Message: "unknown tool: " + p.Name}
}

// ask sends one request to the core through the agent's socket.
func (s *Server) ask(ctx context.Context, req agentproto.VaultRequest) (*agentproto.VaultResponse, error) {
	req.Client, req.Terminal = s.Client, s.Terminal
	if req.Cwd == "" {
		req.Cwd, _ = os.Getwd()
	}
	c, err := s.Dial(ctx)
	if err != nil {
		return nil, fmt.Errorf("unavailable: the %s agent is not running on this machine (%v)", brand.Name, err)
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	if err := agentproto.WriteLine(c, req); err != nil {
		return nil, err
	}
	r := bufio.NewReader(io.LimitReader(c, maxResponse))
	line, err := r.ReadBytes('\n')
	if err != nil && !(errors.Is(err, io.EOF) && len(line) > 0) {
		return nil, fmt.Errorf("unavailable: no answer from %s (%v)", brand.Name, err)
	}
	var resp agentproto.VaultResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	if !resp.OK {
		return nil, fmt.Errorf("%s: %s", resp.Code, resp.Error)
	}
	return &resp, nil
}

// SocketPath is the vault socket of the agent whose data directory holds
// the command at argv0 (started as <data dir>/bin/<slug>-mcp or a
// platform's link beside it), else of the instance's data directory in
// home: in that data directory's runtime directory on this host
// (hostdirs.RunDir).
func SocketPath(argv0, home, instance string) string {
	if IsLink(argv0) && filepath.Dir(argv0) != "." && filepath.IsAbs(argv0) {
		return filepath.Join(hostdirs.RunDir(filepath.Dir(filepath.Dir(argv0))), "vault.sock")
	}
	return filepath.Join(hostdirs.RunDir(filepath.Join(home, brand.DataDir(instance))), "vault.sock")
}

// PlatformLink is the name of the link to the agent of a system and
// architecture (uname -s, uname -m) beside the stable command, which
// runs the one of the host it runs on: a home that hosts of several
// architectures share has a link for each.
func PlatformLink(system, machine string) string { return LinkName + "-" + system + "-" + machine }

// LinkScript is the stable command, a POSIX shell script that runs this
// host's PlatformLink.
const LinkScript = `#!/bin/sh
# The variable vault's MCP server: the agent of this host's system and
# architecture, linked beside this script.
exec "$(dirname "$0")/` + LinkName + `-$(uname -s)-$(uname -m)" "$@"
`

// IsLink tells whether the executable was started by the stable command's
// name or a platform's link, which run the mcp command without arguments.
func IsLink(argv0 string) bool {
	b := filepath.Base(argv0)
	return b == LinkName || strings.HasPrefix(b, LinkName+"-")
}

// Main runs the mcp command with its arguments; argv0 is the name the
// executable was started by.
func Main(argv0 string, args []string) int {
	fl := flag.NewFlagSet("mcp", flag.ContinueOnError)
	instance := fl.String("instance", "", "state instance whose agent to ask (see --instance of serve)")
	socket := fl.String("socket", "", "the agent's vault socket (default vault.sock in the data directory's runtime directory)")
	fl.Usage = func() {
		fmt.Fprintf(fl.Output(), "usage: %s mcp [--instance NAME] [--socket PATH]\n\nThe variable vault's MCP server (stdio), for coding agents' CLIs.\n\n", brand.CoreBin)
		fl.PrintDefaults()
	}
	if err := fl.Parse(args); err != nil {
		return 2
	}
	if !brand.ValidInstance(*instance) {
		fmt.Fprintln(os.Stderr, "--instance must be lowercase letters, digits and dashes")
		return 2
	}
	path := *socket
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		path = SocketPath(argv0, home, *instance)
	}
	s := &Server{
		Dial: func(ctx context.Context) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
		Client:   ParentName(),
		Terminal: os.Getenv("HC_TERMINAL_ID"),
	}
	return serveStdio(s)
}

// serveStdio serves MCP on stdin and stdout until stdin closes or a signal
// asks the server to end (SIGTERM, SIGINT, SIGHUP): the commands it runs
// are killed first, so none outlives it with the values in its
// environment. A server killed outright (SIGKILL) cannot: its commands'
// groups watch it (watchServer).
func serveStdio(s *Server) int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer stop()
	if err := s.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

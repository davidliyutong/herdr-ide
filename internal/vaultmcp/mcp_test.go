package vaultmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

// fakeCore answers each connection as the core would, recording requests.
func fakeCore(t *testing.T, answer func(agentproto.VaultRequest) agentproto.VaultResponse, seen chan<- agentproto.VaultRequest) func(context.Context) (net.Conn, error) {
	return func(context.Context) (net.Conn, error) {
		a, b := net.Pipe()
		go func() {
			defer b.Close()
			var req agentproto.VaultRequest
			if err := agentproto.ReadLine(b, &req); err != nil {
				return
			}
			if seen != nil {
				seen <- req
			}
			agentproto.WriteLine(b, answer(req))
		}()
		return a, nil
	}
}

type client struct {
	t   *testing.T
	in  *io.PipeWriter
	out *bufio.Reader
	id  int
}

func (c *client) send(v any) {
	b, _ := json.Marshal(v)
	c.in.Write(append(b, '\n'))
}

func (c *client) call(method string, params any) map[string]any {
	c.t.Helper()
	c.id++
	c.send(map[string]any{"jsonrpc": "2.0", "id": c.id, "method": method, "params": params})
	line, err := c.out.ReadBytes('\n')
	if err != nil {
		c.t.Fatal(err)
	}
	var resp map[string]any
	if err := json.Unmarshal(line, &resp); err != nil {
		c.t.Fatal(err)
	}
	if resp["id"] != float64(c.id) || resp["jsonrpc"] != "2.0" {
		c.t.Fatalf("response %s", line)
	}
	return resp
}

func startServer(t *testing.T, s *Server) (*client, chan error) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- s.Serve(context.Background(), inR, outW)
		outW.Close()
	}()
	return &client{t: t, in: inW, out: bufio.NewReader(outR)}, done
}

func toolText(t *testing.T, resp map[string]any) (string, bool) {
	t.Helper()
	res, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", resp)
	}
	content := res["content"].([]any)[0].(map[string]any)
	return content["text"].(string), res["isError"] == true
}

func TestProtocol(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	seen := make(chan agentproto.VaultRequest, 8)
	core := fakeCore(t, func(req agentproto.VaultRequest) agentproto.VaultResponse {
		switch req.Tool {
		case "list":
			return agentproto.VaultResponse{OK: true, Variables: []agentproto.VaultVariable{{Name: "TOKEN", Description: "d"}}}
		case "get":
			if req.Names[0] == "SECRET" {
				return agentproto.VaultResponse{Code: "inject_only", Error: "no"}
			}
			return agentproto.VaultResponse{OK: true, Values: map[string]string{"TOKEN": "tok-123"}}
		}
		return agentproto.VaultResponse{OK: true, Values: map[string]string{"TOKEN": "tok-123", "SECRET": "hunter2hunter2"}}
	}, seen)
	c, done := startServer(t, &Server{Dial: core, Client: "claude", Terminal: "t7"})

	r := c.call("initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test"}})
	res := r["result"].(map[string]any)
	if res["protocolVersion"] != "2025-03-26" || res["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("initialize %v", r)
	}
	if r := c.call("initialize", map[string]any{"protocolVersion": "1999-01-01"}); r["result"].(map[string]any)["protocolVersion"] != protocolVersions[0] {
		t.Errorf("unknown version %v", r)
	}
	// A notification gets no response: the next line answers the ping.
	c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	if r := c.call("ping", nil); r["result"] == nil {
		t.Errorf("ping %v", r)
	}
	r = c.call("tools/list", map[string]any{})
	var names []string
	for _, tool := range r["result"].(map[string]any)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "list_variables,get_variable,run_with_env" {
		t.Errorf("tools %v", names)
	}
	if r := c.call("nope", nil); r["error"].(map[string]any)["code"] != float64(-32601) {
		t.Errorf("unknown method %v", r)
	}

	txt, isErr := toolText(t, c.call("tools/call", map[string]any{"name": "list_variables"}))
	if isErr || !strings.Contains(txt, `"TOKEN"`) {
		t.Errorf("list %q", txt)
	}
	if req := <-seen; req.Client != "claude" || req.Terminal != "t7" || req.Cwd == "" {
		t.Errorf("identity %+v", req)
	}
	txt, isErr = toolText(t, c.call("tools/call", map[string]any{"name": "get_variable", "arguments": map[string]any{"name": "TOKEN"}}))
	if isErr || txt != "tok-123" {
		t.Errorf("get %q", txt)
	}
	<-seen
	txt, isErr = toolText(t, c.call("tools/call", map[string]any{"name": "get_variable", "arguments": map[string]any{"name": "SECRET"}}))
	if !isErr || !strings.HasPrefix(txt, "inject_only") {
		t.Errorf("inject-only %q", txt)
	}
	<-seen
	txt, isErr = toolText(t, c.call("tools/call", map[string]any{"name": "run_with_env", "arguments": map[string]any{
		"command": `echo "token=$TOKEN"; echo "secret=$SECRET" >&2; printf %s "$SECRET" | cut -c1-6`, "names": []string{"TOKEN", "SECRET"},
	}}))
	if isErr || !strings.Contains(txt, "exit status: 0") || !strings.Contains(txt, "token=***") || !strings.Contains(txt, "secret=***") ||
		strings.Contains(txt, "tok-123") || strings.Contains(txt, "hunter2hunter2") {
		t.Errorf("run %q", txt)
	}
	// Masking is not a guarantee: a part of a value is shown.
	if !strings.Contains(txt, "hunter") {
		t.Errorf("partial value %q", txt)
	}
	if req := <-seen; req.Tool != "env" || len(req.Names) != 2 {
		t.Errorf("env request %+v", req)
	}
	if r := c.call("tools/call", map[string]any{"name": "run_with_env", "arguments": map[string]any{"command": "true"}}); r["error"] == nil {
		t.Errorf("no names %v", r)
	}
	c.in.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Error(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the server did not exit when stdin closed")
	}
}

func TestErrorsReachTheModel(t *testing.T) {
	core := fakeCore(t, func(agentproto.VaultRequest) agentproto.VaultResponse {
		return agentproto.VaultResponse{Code: "denied", Error: "the user denied the request"}
	}, nil)
	c, _ := startServer(t, &Server{Dial: core})
	txt, isErr := toolText(t, c.call("tools/call", map[string]any{"name": "get_variable", "arguments": map[string]any{"name": "X"}}))
	if !isErr || !strings.Contains(txt, "denied") {
		t.Errorf("denied %q", txt)
	}
	down := &Server{Dial: func(context.Context) (net.Conn, error) { return nil, io.ErrClosedPipe }}
	c, _ = startServer(t, down)
	txt, isErr = toolText(t, c.call("tools/call", map[string]any{"name": "list_variables"}))
	if !isErr || !strings.HasPrefix(txt, "unavailable") {
		t.Errorf("no agent %q", txt)
	}
	c.in.Write([]byte("{not json\n"))
	line, _ := c.out.ReadBytes('\n')
	if !strings.Contains(string(line), "-32700") {
		t.Errorf("parse error %s", line)
	}
}

func TestRunLimits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	r := Runner{MaxOutput: 100}
	out, failed := r.Run(context.Background(), "yes abcdefghij | head -c 5000", nil, "", 0)
	if failed || !strings.Contains(out, "[output truncated: 100 of 5000 bytes]") {
		t.Errorf("truncated %q", out)
	}
	// A value cut by the limit is still masked.
	v := strings.Repeat("s", 60)
	out, _ = r.Run(context.Background(), `printf '%080d' 0; printf %s "$V"`, map[string]string{"V": v}, "", 0)
	if strings.Contains(out, "ssssssssss") {
		t.Errorf("cut value shown %q", out)
	}
	start := time.Now()
	out, failed = Runner{MaxTimeout: 300 * time.Millisecond}.Run(context.Background(), "sleep 30 & sleep 30", nil, "", time.Hour)
	if !failed || !strings.Contains(out, "timed out after 300ms") || time.Since(start) > 10*time.Second {
		t.Errorf("timeout %q after %v", out, time.Since(start))
	}
	out, failed = r.Run(context.Background(), "exit 3", nil, t.TempDir(), 0)
	if !failed || !strings.HasPrefix(out, "exit status: 3") {
		t.Errorf("exit %q", out)
	}
	if out, failed := r.Run(context.Background(), "pwd", nil, "/nonexistent-dir", 0); !failed || !strings.Contains(out, "cannot start") {
		t.Errorf("bad dir %q", out)
	}
}

func TestSocketPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX paths")
	}
	if p := SocketPath("/home/u/.x-dev/bin/"+LinkName, "/home/u", ""); p != "/home/u/.x-dev/run/vault.sock" {
		t.Errorf("link %s", p)
	}
	want := filepath.Join("/home/u", ".herdr-ide-dev", "run", "vault.sock")
	if p := SocketPath(LinkName, "/home/u", "dev"); p != want {
		t.Errorf("by name %s", p)
	}
	if p := SocketPath("/usr/bin/agent", "/home/u", "dev"); p != want {
		t.Errorf("subcommand %s", p)
	}
}

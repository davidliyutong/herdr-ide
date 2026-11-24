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

	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/hostdirs"
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
	out, failed = Runner{DefaultTimeout: 200 * time.Millisecond}.Run(context.Background(), "sleep 30", nil, "", 0)
	if !failed || !strings.Contains(out, "timed out after 200ms") {
		t.Errorf("default timeout %q", out)
	}
	out, failed = r.Run(context.Background(), "exit 3", nil, t.TempDir(), 0)
	if !failed || !strings.HasPrefix(out, "exit status: 3") {
		t.Errorf("exit %q", out)
	}
	if out, failed := r.Run(context.Background(), "pwd", nil, "/nonexistent-dir", 0); !failed || !strings.Contains(out, "cannot start") {
		t.Errorf("bad dir %q", out)
	}
}

// The core's limits (the vault's settings) bound run_with_env's command:
// its output, its default and longest timeout; without them the server's
// own hold.
func TestRunLimitsFromTheCore(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	run := &agentproto.VaultRun{Timeout: 1, MaxTimeout: 2, MaxOutput: 50}
	core := fakeCore(t, func(req agentproto.VaultRequest) agentproto.VaultResponse {
		return agentproto.VaultResponse{OK: true, Values: map[string]string{"K": "v"}, Run: run}
	}, nil)
	c, _ := startServer(t, &Server{Dial: core})
	call := func(command string, timeout float64) (string, bool) {
		args := map[string]any{"command": command, "names": []string{"K"}}
		if timeout > 0 {
			args["timeout"] = timeout
		}
		return toolText(t, c.call("tools/call", map[string]any{"name": "run_with_env", "arguments": args}))
	}
	if txt, _ := call("yes abcdefghij | head -c 5000", 0); !strings.Contains(txt, "[output truncated: 50 of 5000 bytes]") {
		t.Errorf("output %q", txt)
	}
	// The call's own timeout, under the core's longest.
	if txt, failed := call("sleep 30", 0.2); !failed || !strings.Contains(txt, "timed out after 200ms") {
		t.Errorf("the call's timeout %q", txt)
	}
	// The core's timeouts, in seconds, become the runner's; that a
	// runner's default and longest timeouts end a command is TestRunLimits'.
	if r := (Runner{}).with(run); r != (Runner{MaxOutput: 50, DefaultTimeout: time.Second, MaxTimeout: 2 * time.Second}) {
		t.Errorf("with the core's limits %+v", r)
	}
	r := Runner{}.with(nil)
	if r != (Runner{}) {
		t.Errorf("without the core's limits %+v", r)
	}
}

// Output cut by the capture: masking shrinks the text, so the beginning of
// a value at the cut, which no occurrence matches, would come within the
// returned part; it is dropped, and an occurrence that began before it is
// masked whole.
func TestMaskAtTheCut(t *testing.T) {
	v := map[string]string{"V": "SECRET"}
	for _, c := range []struct {
		in   string
		cut  bool
		want string
	}{
		{"a SECRET b SEC", true, "a *** "},
		{"a SECRET b SEC", false, "a *** b SEC"}, // a part the command printed
		{"xxxxSECRET", true, "xxxx***"},
		{"SECRETSECRETSECR", true, "******"},
		{"", true, ""},
	} {
		if got := maskOutput(c.in, v, c.cut); got != c.want {
			t.Errorf("%q (cut %v): %q, want %q", c.in, c.cut, got, c.want)
		}
	}
	// A shorter value inside the cut beginning of a longer one leaves none
	// of the longer one's bytes.
	two := map[string]string{"A": "XAB", "B": "ABCDE"}
	if got := maskOutput("..XABCD", two, true); got != "..***" {
		t.Errorf("overlapping values at the cut: %q", got)
	}
	if got := Mask("x ABCDE XAB y", two); got != "x *** *** y" {
		t.Errorf("two values %q", got)
	}
	if runtime.GOOS == "windows" {
		return
	}
	// A 39-byte value printed 4000 times: the capture (64 KiB beyond the
	// limit) ends inside one, which is not shown.
	secret := "sk-live-0123456789abcdefghijklmnopqrstuv"[:39]
	out, failed := Runner{}.Run(context.Background(), `yes "$V" | head -n 4000`, map[string]string{"V": secret}, "", 0)
	if failed || !strings.Contains(out, "[output truncated: 65536 of 160000 bytes]") {
		t.Fatalf("run %q", out[:min(len(out), 200)])
	}
	if strings.Contains(out, secret[:4]) {
		i := strings.Index(out, secret[:4])
		t.Errorf("a cut value shown: %q", out[max(0, i-20):min(len(out), i+40)])
	}
}

// A call the client cancels while it waits for the user's approval ends:
// its request to the core goes away (the core takes it as a denial) and it
// gets no response.
func TestCancelledRequestLeavesTheCore(t *testing.T) {
	asked, gone := make(chan struct{}), make(chan struct{})
	dial := func(context.Context) (net.Conn, error) {
		a, b := net.Pipe()
		go func() {
			defer b.Close()
			var req agentproto.VaultRequest
			if agentproto.ReadLine(b, &req) != nil {
				return
			}
			close(asked)
			io.Copy(io.Discard, b) // waits for the user, until the requester leaves
			close(gone)
		}()
		return a, nil
	}
	c, done := startServer(t, &Server{Dial: dial})
	defer func() {
		c.in.Close()
		<-done
	}()
	c.send(map[string]any{"jsonrpc": "2.0", "id": "call-7", "method": "tools/call", "params": map[string]any{"name": "get_variable", "arguments": map[string]any{"name": "KEY"}}})
	<-asked
	c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": "call-7"}})
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the request to the core outlived its cancellation")
	}
	if r := c.call("ping", nil); r["result"] == nil {
		t.Errorf("ping %v", r)
	}
}

func TestSocketPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX paths")
	}
	// The data directory holding the command, or the instance's: its
	// runtime directory on this host.
	if p, want := SocketPath("/home/u/.x-dev/bin/"+LinkName, "/home/u", ""), filepath.Join(hostdirs.RunDir("/home/u/.x-dev"), "vault.sock"); p != want {
		t.Errorf("link %s, want %s", p, want)
	}
	if p, want := SocketPath("/home/u/.x-dev/bin/"+PlatformLink("Linux", "x86_64"), "/home/u", ""), filepath.Join(hostdirs.RunDir("/home/u/.x-dev"), "vault.sock"); p != want {
		t.Errorf("platform link %s, want %s", p, want)
	}
	want := filepath.Join(hostdirs.RunDir(filepath.Join("/home/u", brand.DataDir("dev"))), "vault.sock")
	if p := SocketPath(LinkName, "/home/u", "dev"); p != want {
		t.Errorf("by name %s", p)
	}
	if p := SocketPath("/usr/bin/agent", "/home/u", "dev"); p != want {
		t.Errorf("subcommand %s", p)
	}
	if !IsLink("/x/bin/"+PlatformLink("Darwin", "arm64")) || IsLink("/x/bin/agent") {
		t.Error("IsLink")
	}
}

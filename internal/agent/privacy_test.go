//go:build unix

package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"herdr-ide/internal/agentproto"
)

func TestAccessOfTellsFullDiskAccessFromOtherErrors(t *testing.T) {
	for err, want := range map[error]string{
		nil: agentproto.AccessGranted,
		&fs.PathError{Op: "open", Path: "/x", Err: syscall.EPERM}:  agentproto.AccessDenied,
		&fs.PathError{Op: "open", Path: "/x", Err: syscall.EACCES}: agentproto.AccessUnknown,
		&fs.PathError{Op: "open", Path: "/x", Err: syscall.EIO}:    agentproto.AccessUnknown,
	} {
		if got := accessOf(err); got != want {
			t.Errorf("accessOf(%v) = %s, want %s", err, got, want)
		}
	}
}

func TestFilesAccessOpensTheFirstFolderThatExists(t *testing.T) {
	home := t.TempDir()
	folders := fdaFolders(home)
	if !strings.HasSuffix(folders[0], "/Library/Application Support/com.apple.TCC") || !strings.HasSuffix(folders[1], "/Library/Safari") {
		t.Fatalf("folders = %v", folders)
	}
	if got := filesAccess(folders); got != agentproto.AccessUnknown {
		t.Fatalf("no folder: %s", got)
	}
	if err := os.MkdirAll(folders[1], 0o700); err != nil {
		t.Fatal(err)
	}
	if got := filesAccess(folders); got != agentproto.AccessGranted {
		t.Fatalf("an openable folder: %s", got)
	}
	if os.Geteuid() != 0 {
		// A folder its mode closes says nothing about Full Disk Access.
		os.Chmod(folders[1], 0)
		defer os.Chmod(folders[1], 0o700)
		if got := filesAccess(folders); got != agentproto.AccessUnknown {
			t.Fatalf("a folder of mode 0: %s", got)
		}
	}
}

// The script as the system's shell runs it: the exit codes the terminal
// probe reads, and no output.
func TestFDAScriptExitCodes(t *testing.T) {
	dir := t.TempDir()
	open := filepath.Join(dir, "open")
	os.Mkdir(open, 0o700)
	missing := filepath.Join(dir, "missing")
	run := func(args ...string) (int, string) {
		out, err := exec.Command("/bin/sh", append([]string{"-c", fdaScript, "sh"}, args...)...).CombinedOutput()
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), string(out)
		} else if err != nil {
			t.Fatal(err)
		}
		return 0, string(out)
	}
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{missing, open}, 0},
		{[]string{missing}, 3},
		{nil, 3},
	} {
		if code, out := run(c.args...); code != c.code || out != "" {
			t.Errorf("%v: exit %d %q, want %d and no output", c.args, code, out, c.code)
		}
	}
	if os.Geteuid() != 0 {
		closed := filepath.Join(dir, "closed")
		os.Mkdir(closed, 0)
		defer os.Chmod(closed, 0o700)
		// A failed open ends the loop with 1, without a message and without
		// ending the shell early.
		if code, out := run(closed, open); code != 1 || out != "" {
			t.Errorf("closed folder: exit %d %q", code, out)
		}
	}
}

// fakeExecCore answers herdr-core's hello and machine.exec on a unix
// socket: the exit code answer gives (nil: an error), recording the params.
func fakeExecCore(t *testing.T, socket string, answer func() *int) <-chan map[string]any {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	calls := make(chan map[string]any, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				br := bufio.NewReader(c)
				if _, err := br.ReadString('\n'); err != nil {
					return
				}
				fmt.Fprintln(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"9.9.9","framed":true}}`)
				for {
					var h [9]byte
					if _, err := io.ReadFull(br, h[:]); err != nil {
						return
					}
					payload := make([]byte, binary.LittleEndian.Uint32(h[5:]))
					if _, err := io.ReadFull(br, payload); err != nil {
						return
					}
					var req struct {
						ID     uint64         `json:"id"`
						Method string         `json:"method"`
						Params map[string]any `json:"params"`
					}
					json.Unmarshal(payload, &req)
					if req.Method != "machine.exec" {
						continue
					}
					calls <- req.Params
					var reply []byte
					if code := answer(); code != nil {
						reply, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{
							"code": *code, "stdout": "", "stderr": "", "truncated": false, "timed_out": false, "ms": 3}})
					} else {
						reply, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{
							"code": -32000, "message": "spawn_failed", "data": map[string]any{"kind": "spawn_failed"}}})
					}
					frame := binary.LittleEndian.AppendUint32(nil, 0)
					frame = append(frame, 0)
					frame = binary.LittleEndian.AppendUint32(frame, uint32(len(reply)))
					c.Write(append(frame, reply...))
				}
			}()
		}
	}()
	return calls
}

func TestTerminalsAccessRunsTheScriptInTheTerminalCore(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "fda")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "hc.sock")
	folders := []string{"/f/one", "/f/two"}
	ctx := context.Background()
	if got := terminalsAccess(ctx, socket, folders); got != agentproto.AccessUnknown {
		t.Fatalf("no core: %s", got)
	}
	var code *int
	calls := fakeExecCore(t, socket, func() *int { return code })
	for _, c := range []struct {
		code *int
		want string
	}{
		{ptr(0), agentproto.AccessGranted},
		{ptr(1), agentproto.AccessDenied},
		{ptr(3), agentproto.AccessUnknown},
		{ptr(126), agentproto.AccessUnknown},
		{nil, agentproto.AccessUnknown},
	} {
		code = c.code
		if got := terminalsAccess(ctx, socket, folders); got != c.want {
			t.Errorf("exit %v: %s, want %s", c.code, got, c.want)
		}
		p := <-calls
		argv, _ := json.Marshal(p["argv"])
		want, _ := json.Marshal(append([]string{"/bin/sh", "-c", fdaScript, "sh"}, folders...))
		if string(argv) != string(want) || p["timeout"] != float64(10) || len(p) != 2 {
			t.Fatalf("params = %v", p)
		}
	}
}

func ptr(n int) *int { return &n }

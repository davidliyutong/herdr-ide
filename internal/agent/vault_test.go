//go:build unix

package agent_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/transport"
)

// An MCP server's connection to vault.sock reaches the core as a stream
// with op vault; the socket is the user's alone, and the stable mcp link
// points at the running executable.
func TestVaultSocketRelaysToTheCore(t *testing.T) {
	// A short home: macOS limits socket paths to 104 bytes.
	home, err := os.MkdirTemp("/tmp", "vlt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	s, err := transport.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	sock := filepath.Join(home, ".herdr-ide", "run", "vault.sock")
	var st os.FileInfo
	for i := 0; i < 100; i++ {
		var err error
		if st, err = os.Stat(sock); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if st == nil || st.Mode().Perm() != 0o600 || st.Mode().Type() != os.ModeSocket {
		t.Fatalf("vault.sock %v", st)
	}
	// The core's side: answer the stream the agent opens.
	go func() {
		c, err := s.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var h agentproto.Header
		if agentproto.ReadLine(c, &h) != nil || h.Op != agentproto.OpVault {
			agentproto.WriteLine(c, agentproto.Reply{Error: "unexpected"})
			return
		}
		agentproto.WriteLine(c, agentproto.Reply{OK: true})
		var req agentproto.VaultRequest
		agentproto.ReadLine(c, &req)
		agentproto.WriteLine(c, agentproto.VaultResponse{OK: true, Values: map[string]string{req.Names[0]: "v"}})
	}()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	agentproto.WriteLine(c, agentproto.VaultRequest{Tool: "get", Names: []string{"K"}})
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var resp agentproto.VaultResponse
	if json.Unmarshal(line, &resp) != nil || !resp.OK || resp.Values["K"] != "v" {
		t.Fatalf("response %s", line)
	}

	link := filepath.Join(home, ".herdr-ide", "bin", agent.MCPLinkName)
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	for i := 0; i < 100; i++ {
		if target, err := os.Readlink(link); err == nil {
			if target != exe {
				t.Errorf("link %s -> %s, want %s", link, target, exe)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("no link %s", link)
}

func TestLinkMCPReplacesTheLink(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bin")
	if err := agent.LinkMCP(dir, "/old/agent"); err != nil {
		t.Fatal(err)
	}
	if err := agent.LinkMCP(dir, "/new/agent"); err != nil {
		t.Fatal(err)
	}
	if target, _ := os.Readlink(filepath.Join(dir, agent.MCPLinkName)); target != "/new/agent" {
		t.Errorf("link -> %s", target)
	}
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o700 {
		t.Errorf("bin dir %v", st.Mode())
	}
}

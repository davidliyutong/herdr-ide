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
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"veldr/internal/agent"
	"veldr/internal/agent/agenttest"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/hostdirs"
	"veldr/internal/vaultmcp"
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
	s, err := agenttest.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	sock := filepath.Join(hostdirs.RunDir(filepath.Join(home, brand.DataDir(""))), "vault.sock")
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
	header := make(chan agentproto.Header, 1)
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
		header <- h
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
	// The core learns who connected, as the agent saw it: this process
	// (by peer credentials) and its parents.
	h := <-header
	if len(h.Process) < 2 || h.Process[0].Pid != os.Getpid() || h.Process[1].Pid != os.Getppid() || h.Process[0].Name == "" {
		t.Errorf("process chain %+v", h.Process)
	}

	link := platformLink(filepath.Join(home, brand.DataDir(""), "bin"))
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

// coreTagged answers the streams s's agent opens as a core would, with tag
// as every variable's value and as the bridge's answer to a message.
func coreTagged(s *agenttest.Session, tag string) {
	for {
		c, err := s.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			var h agentproto.Header
			if agentproto.ReadLine(c, &h) != nil {
				return
			}
			agentproto.WriteLine(c, agentproto.Reply{OK: true})
			switch h.Op {
			case agentproto.OpVault:
				var req agentproto.VaultRequest
				agentproto.ReadLine(c, &req)
				agentproto.WriteLine(c, agentproto.VaultResponse{OK: true, Values: map[string]string{"K": tag}})
			case agentproto.OpBridge:
				var msg map[string]any
				agentproto.ReadLine(c, &msg)
				agentproto.WriteLine(c, map[string]string{"core": tag})
			}
		}()
	}
}

// Two agents of one instance on a machine: the old session's agent that
// lingers after a reconnect, or a second core's. The newest serves
// vault.sock and bridge.sock; the old one exiting leaves them to it; when
// the newest exits first, the other serves them again; the last one
// removes them.
func TestSocketsFollowTheNewestAgent(t *testing.T) {
	defer agent.SetSocketWatch(20 * time.Millisecond)()
	home, err := os.MkdirTemp("/tmp", "vlt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	run := hostdirs.RunDir(filepath.Join(home, brand.DataDir("")))
	start := func(tag string) *agenttest.Session {
		s, err := agenttest.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
		if err != nil {
			t.Fatal(err)
		}
		go coreTagged(s, tag)
		return s
	}
	// The core that answers on each socket ("" when none does).
	ask := func(sock string, req any) string {
		c, err := net.Dial("unix", filepath.Join(run, sock))
		if err != nil {
			return ""
		}
		defer c.Close()
		agentproto.WriteLine(c, req)
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		line, err := bufio.NewReader(c).ReadBytes('\n')
		if err != nil {
			return ""
		}
		var resp struct {
			Values map[string]string `json:"values"`
			Core   string            `json:"core"`
		}
		json.Unmarshal(line, &resp)
		return resp.Values["K"] + resp.Core
	}
	served := func(want string) {
		t.Helper()
		for _, sock := range []string{"vault.sock", "bridge.sock"} {
			req := any(agentproto.VaultRequest{Tool: "get", Names: []string{"K"}})
			if sock == "bridge.sock" {
				req = map[string]string{"type": "hello"}
			}
			got := ""
			for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
				if got = ask(sock, req); got == want {
					break
				}
			}
			if got != want {
				t.Fatalf("%s reaches %q, want %q", sock, got, want)
			}
		}
	}

	old := start("old")
	served("old")
	young := start("new")
	served("new")
	old.Close()
	time.Sleep(100 * time.Millisecond)
	served("new")

	third := start("third")
	served("third")
	third.Close()
	served("new")

	young.Close()
	for _, sock := range []string{"vault.sock", "bridge.sock"} {
		for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			if _, err := os.Lstat(filepath.Join(run, sock)); os.IsNotExist(err) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s left after the last agent", sock)
			}
		}
	}
}

// The stable command is a script running the link of the host's system
// and architecture, which LinkMCP points at the agent.
func TestLinkMCPReplacesTheLink(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bin")
	agentAt := func(name string) string {
		p := filepath.Join(t.TempDir(), name)
		os.WriteFile(p, []byte("#!/bin/sh\necho "+name+" \"$@\"\n"), 0o700)
		return p
	}
	if err := agent.LinkMCP(dir, agentAt("old")); err != nil {
		t.Fatal(err)
	}
	newer := agentAt("new")
	if err := agent.LinkMCP(dir, newer); err != nil {
		t.Fatal(err)
	}
	if target, _ := os.Readlink(platformLink(dir)); target != newer {
		t.Errorf("link -> %s", target)
	}
	out, err := exec.Command(filepath.Join(dir, vaultmcp.LinkName), "a b").Output()
	if err != nil || string(out) != "new a b\n" {
		t.Errorf("the command ran %q %v", out, err)
	}
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o700 {
		t.Errorf("bin dir %v", st.Mode())
	}
}

// platformLink is the agent's link of this host in dir.
func platformLink(dir string) string {
	s, _ := exec.Command("uname", "-s").Output()
	m, _ := exec.Command("uname", "-m").Output()
	return filepath.Join(dir, vaultmcp.PlatformLink(strings.TrimSpace(string(s)), strings.TrimSpace(string(m))))
}

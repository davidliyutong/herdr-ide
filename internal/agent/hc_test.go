package agent_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
	"herdr-ide/internal/transport"
)

// hcAgent is an agent whose home is short enough for a unix socket in its
// run directory.
func hcAgent(t *testing.T, instance string) (*transport.Session, string) {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "hca")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	s, err := transport.DialLocal(context.Background(), agent.Options{Instance: instance, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, home
}

// installHC uploads script as the executable, claiming digest ("" for its own).
func installHC(t *testing.T, s *transport.Session, script, digest string) (*agentproto.Reply, string) {
	t.Helper()
	if digest == "" {
		digest = fmt.Sprintf("%x", sha256.Sum256([]byte(script)))
	}
	conn, _, err := s.Open(context.Background(), agentproto.Header{Op: agentproto.OpHC, Action: "install", Digest: digest})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write([]byte(script))
	zw.Close()
	cw := agentproto.ChunkWriter{W: conn}
	cw.Write(gz.Bytes())
	cw.Finish()
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil {
		t.Fatal(err)
	}
	return &rep, digest
}

// fakeHC records how it was run instead of starting a core.
const fakeHC = `#!/bin/sh
echo "$* session=$HC_SESSION socket=$HC_SOCKET terminal=$HC_TERMINAL_ID" >> "$HOME/ran"
[ "$2" = stop ] && { echo "no core running"; exit 3; }
exit 0
`

func TestHCInstallStartAndPipe(t *testing.T) {
	t.Setenv("HC_SESSION", "the-users-own")
	t.Setenv("HC_TERMINAL_ID", "t7")
	s, home := hcAgent(t, "dev")
	ctx := context.Background()
	socket := filepath.Join(home, ".herdr-ide-dev", "run", "hc.sock")

	rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || rep.HC.Digest != "" || rep.HC.Running || rep.HC.Session != "herdr-ide-dev" || rep.HC.Socket != socket {
		t.Fatalf("status = %+v %v", rep.HC, err)
	}
	rep, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"})
	if err == nil || rep.Code != agentproto.HCNotInstalled {
		t.Fatalf("start without an executable: %+v %v", rep, err)
	}

	// A wrong digest installs nothing and leaves no partial file.
	rep, _ = installHC(t, s, fakeHC, strings.Repeat("0", 64))
	if rep.OK || rep.Code != agentproto.HCBadDigest || rep.HC.Digest != "" {
		t.Fatalf("install with a wrong digest: %+v", rep)
	}
	if ents, _ := os.ReadDir(filepath.Join(home, ".herdr-ide-dev", "hc")); len(ents) != 0 {
		t.Fatalf("left behind: %v", ents)
	}
	if rep, _ = installHC(t, s, fakeHC, "nonsense"); rep.OK {
		t.Fatal("malformed digest accepted")
	}

	rep, digest := installHC(t, s, fakeHC, "")
	if !rep.OK || rep.HC.Digest != digest {
		t.Fatalf("install: %+v", rep)
	}
	bin := filepath.Join(home, ".herdr-ide-dev", "hc", "herdr-core")
	if st, err := os.Stat(bin); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("executable: %v %v", st, err)
	}
	// A newer build replaces it.
	newer := fakeHC + "# 2\n"
	if rep, digest = installHC(t, s, newer, ""); !rep.OK || rep.HC.Digest != digest {
		t.Fatalf("second install: %+v", rep)
	}
	if b, _ := os.ReadFile(bin); string(b) != newer {
		t.Fatal("executable not replaced")
	}

	// Start runs it for the agent's own session and socket, whatever
	// session or terminal the agent's environment names.
	rep, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"})
	if err != nil || rep.HC.Running {
		t.Fatalf("start: %+v %v", rep, err)
	}
	ran, _ := os.ReadFile(filepath.Join(home, "ran"))
	if want := "server start --json session=herdr-ide-dev socket=" + socket + " terminal=\n"; string(ran) != want {
		t.Fatalf("ran %q, want %q", ran, want)
	}
	rep, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "stop"})
	if err == nil || rep.Code != agentproto.HCStopFailed || !strings.Contains(rep.Error, "no core running") {
		t.Fatalf("failed stop: %+v %v", rep, err)
	}
	if rep, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "explode"}); err == nil {
		t.Fatalf("unknown action: %+v", rep)
	}

	// Nothing listens: the API pipe fails. With a core on the socket the
	// status reports it and the pipe reaches it.
	if _, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHCAPI}); err == nil {
		t.Fatal("pipe to a missing socket opened")
	}
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadString('\n')
				framed := strings.Contains(line, `"framed":true`)
				fmt.Fprintf(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"9.9.9","framed":%v}}`+"\n", framed)
				if framed {
					io.Copy(io.Discard, c)
				}
			}()
		}
	}()
	rep, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || !rep.HC.Running || rep.HC.Version != "9.9.9" {
		t.Fatalf("status with a core: %+v %v", rep.HC, err)
	}
	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHCAPI})
	if err != nil {
		t.Fatal(err)
	}
	c, hello, err := hc.Dial(ctx, conn)
	if err != nil || hello.Version != "9.9.9" {
		t.Fatalf("dial through the agent: %+v %v", hello, err)
	}
	c.Close()
}

func TestHCSessionOfDefaultInstance(t *testing.T) {
	s, home := hcAgent(t, "")
	rep, err := s.Request(context.Background(), agentproto.Header{Op: agentproto.OpHC, Action: "status"})
	if err != nil || rep.HC.Session != "herdr-ide" || rep.HC.Socket != filepath.Join(home, ".herdr-ide", "run", "hc.sock") {
		t.Fatalf("status = %+v %v", rep.HC, err)
	}
}

// Before a start or restart the agent hashes the executable again: one that
// changed since it was installed (even keeping its size and time) does not
// run. After a start or restart the API socket is private (0600) whatever
// mode the terminal core created it with.
func TestHCVerifiedBeforeStartAndSocketPrivate(t *testing.T) {
	s, home := hcAgent(t, "dev")
	ctx := context.Background()
	rep, digest := installHC(t, s, fakeHC, "")
	if !rep.OK {
		t.Fatalf("install: %+v", rep)
	}
	socket := filepath.Join(home, ".herdr-ide-dev", "run", "hc.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { // no core answers: the status after an action says so at once
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	for _, action := range []string{"start", "restart"} {
		os.Chmod(socket, 0o755) // as herdr-core creates it
		rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: action, Digest: digest})
		if err != nil || !rep.OK {
			t.Fatalf("%s: %+v %v", action, rep, err)
		}
		if st, err := os.Stat(socket); err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("%s: socket %v %v", action, st.Mode(), err)
		}
	}
	// Another build's digest: refused, nothing runs.
	os.Remove(filepath.Join(home, "ran"))
	if rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start", Digest: strings.Repeat("ab", 32)}); err == nil || rep.Code != agentproto.HCBadDigest {
		t.Fatalf("start of another digest: %+v %v", rep, err)
	}
	// The file changes in place, keeping its size and modification time.
	bin := filepath.Join(home, ".herdr-ide-dev", "hc", "herdr-core")
	st, _ := os.Stat(bin)
	tampered := []byte(strings.Replace(fakeHC, "exit 0", "exit 1", 1))
	if len(tampered) != int(st.Size()) {
		t.Fatal("the stand-in changed its size")
	}
	if err := os.WriteFile(bin, tampered, 0o700); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(bin, st.ModTime(), st.ModTime())
	for _, action := range []string{"start", "restart"} {
		if rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: action, Digest: digest}); err == nil || rep.Code != agentproto.HCBadDigest {
			t.Fatalf("%s of a changed executable: %+v %v", action, rep, err)
		}
	}
	if _, err := os.Stat(filepath.Join(home, "ran")); err == nil {
		t.Fatal("a refused executable ran")
	}
}

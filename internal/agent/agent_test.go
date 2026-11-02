package agent_test

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/transport"
)

func dialAgent(t *testing.T) (*transport.Session, string) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s, err := transport.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, home
}

func TestHelloAndPrivateRunDir(t *testing.T) {
	s, home := dialAgent(t)
	rep, err := s.Request(context.Background(), agentproto.Header{Op: agentproto.OpHello})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Info.OS != runtime.GOOS || rep.Info.Home != home {
		t.Fatalf("info = %+v", rep.Info)
	}
	st, err := os.Stat(filepath.Join(home, ".herdr-ide", "run"))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("run dir perms: %v %v", st.Mode(), err)
	}
}

func TestFileOps(t *testing.T) {
	s, home := dialAgent(t)
	ctx := context.Background()
	payload := bytes.Repeat([]byte("0123456789"), 50000)

	// Upload (chunked), then stat, ranged read and list.
	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpFsWrite, Path: "~/up/data.bin", Mkdirs: true})
	if err != nil {
		t.Fatal(err)
	}
	cw := agentproto.ChunkWriter{W: conn}
	cw.Write(payload)
	cw.Finish()
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil || !rep.OK || rep.Stat.Size != int64(len(payload)) {
		t.Fatalf("write reply = %+v %v", rep, err)
	}
	conn.Close()

	conn, rep2, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpFsRead, Path: filepath.Join(home, "up", "data.bin"), Offset: 7, Length: 12})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(conn)
	if string(got) != "789012345678" || rep2.Stat.Size != int64(len(payload)) {
		t.Fatalf("range read = %q", got)
	}

	lst, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpFsList, Path: "~/up"})
	if err != nil || len(lst.Entries) != 1 || lst.Entries[0].Name != "data.bin" {
		t.Fatalf("list = %+v %v", lst, err)
	}
	if _, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpFsStat, Path: "~/missing"}); err == nil {
		t.Fatal("stat of missing file succeeded")
	}
}

func TestWriteKeepsExistingFiles(t *testing.T) {
	s, home := dialAgent(t)
	ctx := context.Background()
	write := func(path, body string) (*agentproto.Reply, error) {
		conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpFsWrite, Path: path, Unique: true})
		if err != nil {
			return nil, err
		}
		defer conn.Close()
		cw := agentproto.ChunkWriter{W: conn}
		cw.Write([]byte(body))
		cw.Finish()
		var rep agentproto.Reply
		return &rep, agentproto.ReadLine(conn, &rep)
	}
	proj := filepath.Join(home, "proj")
	os.MkdirAll(proj, 0o755)
	os.WriteFile(filepath.Join(proj, "shot.png"), []byte("mine"), 0o644)
	os.Symlink("/nonexistent", filepath.Join(proj, "shot-1.png"))
	rep, err := write("~/proj/shot.png", "new")
	if err != nil || !rep.OK || rep.Stat.Path != filepath.Join(proj, "shot-2.png") {
		t.Fatalf("write = %+v %v", rep, err)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "shot.png")); string(b) != "mine" {
		t.Fatalf("existing file replaced: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, "shot-2.png")); string(b) != "new" {
		t.Fatalf("upload = %q", b)
	}
	rep, err = write("~/proj/.env", "x")
	if err != nil || rep.Stat.Path != filepath.Join(proj, ".env") {
		t.Fatalf("dotfile = %+v %v", rep, err)
	}
	if rep, err = write("~/proj/.env", "y"); err != nil || rep.Stat.Path != filepath.Join(proj, ".env-1") {
		t.Fatalf("second dotfile = %+v %v", rep, err)
	}
	// Without Mkdirs the directory must exist; no temporary file is left.
	if _, err := write("~/missing/a.txt", "z"); err == nil {
		t.Fatal("wrote into a missing directory")
	}
	ents, _ := os.ReadDir(proj)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".herdr-ide-upload-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
}

func TestExecAndDialRestriction(t *testing.T) {
	s, _ := dialAgent(t)
	ctx := context.Background()
	rep, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpExec, Argv: []string{"/bin/sh", "-c", "echo out; echo err >&2; exit 3"}})
	if err != nil || rep.Exec.ExitCode != 3 || rep.Exec.Stdout != "out\n" || rep.Exec.Stderr != "err\n" {
		t.Fatalf("exec = %+v %v", rep, err)
	}
	// Only sockets inside ~/.herdr-ide/run may be dialed.
	ln, err := net.Listen("unix", filepath.Join(t.TempDir(), "x.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if _, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpDialUnix, Path: ln.Addr().String()}); err == nil {
		t.Fatal("dial outside run dir allowed")
	}
}

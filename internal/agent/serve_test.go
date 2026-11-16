//go:build unix

package agent

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

// When the session ends during an upload, Serve returns only once the
// upload's handler removed the file it was being received into, so an
// agent that exits with its session leaves nothing in its data directory.
func TestServeWaitsForRequestsToClean(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	c1, c2 := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- Serve(context.Background(), c1, Options{Instance: "test", Logger: log.New(io.Discard, "", 0)})
	}()
	client, err := yamux.Client(c2, agentproto.YamuxConfig(log.New(io.Discard, "", 0)))
	if err != nil {
		t.Fatal(err)
	}
	st, err := client.OpenStream()
	if err != nil {
		t.Fatal(err)
	}
	params, _ := json.Marshal(map[string]any{"path": filepath.Join(home, "big.bin")})
	if err := agentproto.WriteLine(st, agentproto.Header{Op: agentproto.OpPlugin, Plugin: "files", Action: "upload", Params: params}); err != nil {
		t.Fatal(err)
	}
	var rep agentproto.Reply
	if err := agentproto.ReadLine(st, &rep); err != nil || !rep.OK {
		t.Fatal(err, rep)
	}
	if _, err := (agentproto.ChunkWriter{W: st}).Write([]byte(strings.Repeat("x", 1000))); err != nil {
		t.Fatal(err)
	}
	staged := func() []string {
		var names []string
		ents, _ := os.ReadDir(filepath.Join(home, brand.DataDir("test"), "staging"))
		for _, e := range ents {
			names = append(names, "staging/"+e.Name())
		}
		return names
	}
	for deadline := time.Now().Add(5 * time.Second); len(staged()) < 1; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the upload staged nothing: %q", staged())
		}
	}
	client.Close()
	c2.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(handlerDrain + 5*time.Second):
		t.Fatal("Serve did not return")
	}
	if left := staged(); len(left) != 0 {
		t.Fatalf("left after the session ended: %q", left)
	}
}

func TestWaitAtMost(t *testing.T) {
	var wg sync.WaitGroup
	if !waitAtMost(&wg, time.Second) {
		t.Fatal("nothing running")
	}
	wg.Add(1)
	if waitAtMost(&wg, 20*time.Millisecond) {
		t.Fatal("one running")
	}
	go func() {
		time.Sleep(20 * time.Millisecond)
		wg.Done()
	}()
	if !waitAtMost(&wg, 5*time.Second) {
		t.Fatal("ended")
	}
}

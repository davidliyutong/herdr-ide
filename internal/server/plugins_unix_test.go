//go:build unix

package server

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	agentplugin "herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/plugin"
)

// held is closed when the agent's side of a "testhold" stream ends.
var held = make(chan struct{}, 1)

func init() {
	agentplugin.Register("testbig", func(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *agentplugin.Env) error {
		var p struct{ Text string }
		if err := agentplugin.Decode(params, &p); err != nil {
			return agentplugin.Reply(st, nil, err)
		}
		return agentplugin.Reply(st, map[string]string{"text": strings.ToUpper(p.Text)}, nil)
	})
	agentplugin.Register("testhold", func(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *agentplugin.Env) error {
		defer st.Close()
		agentplugin.Reply(nopClose{st}, "held", nil)
		var b [1]byte
		st.Read(b[:])
		held <- struct{}{}
		return nil
	})
}

// nopClose keeps a stream open after Reply.
type nopClose struct{ net.Conn }

func (nopClose) Close() error { return nil }

// Params and results of 2 MiB, more than a header or reply line holds,
// travel as bodies through the core's plugin.Request and the agent's
// dispatch.
func TestPluginLargeParamsAndResults(t *testing.T) {
	_, mc, _ := agentMachine(t)
	text := strings.Repeat("ab", 1<<20)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var out struct{ Text string }
	if err := plugin.Request(ctx, mc, "testbig", "echo", map[string]string{"text": text}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Text != strings.ToUpper(text) {
		t.Fatalf("result of %d bytes", len(out.Text))
	}
	// Small ones as before.
	if err := plugin.Request(ctx, mc, "testbig", "echo", map[string]string{"text": "x"}, &out); err != nil || out.Text != "X" {
		t.Fatalf("small: %q %v", out.Text, err)
	}
}

// The stream plugin.Open returns is closed when the caller's context ends,
// also after the reply: a caller waiting on a stalled agent returns.
func TestPluginOpenFollowsTheContext(t *testing.T) {
	_, mc, _ := agentMachine(t)
	ctx, cancel := context.WithCancel(context.Background())
	conn, res, err := plugin.Open(ctx, mc, "testhold", "hold", nil)
	if err != nil || string(res) != `"held"` {
		t.Fatalf("open: %s %v", res, err)
	}
	read := make(chan error, 1)
	go func() {
		var b [1]byte
		_, err := conn.Read(b[:])
		read <- err
	}()
	select {
	case <-read:
		t.Fatal("the stream ended before the context")
	case <-time.After(100 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-read:
		if err == nil {
			t.Fatal("read data")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream outlived the context")
	}
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent's side did not end")
	}
	conn.Close()
}

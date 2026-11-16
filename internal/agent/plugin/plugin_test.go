//go:build unix

package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

// A result larger than a line follows the reply as a body; a small one
// stays in the line.
func TestLargeResultFollowsTheReply(t *testing.T) {
	big := strings.Repeat("x", 2<<20)
	a, b := net.Pipe()
	go Reply(a, map[string]string{"text": big}, nil)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil || !rep.OK || len(rep.Plugin) != 0 || rep.PluginLength <= 2<<20 {
		t.Fatalf("reply %+v %v", rep.PluginLength, err)
	}
	body, err := agentproto.ReadBody(b, rep.PluginLength)
	var v map[string]string
	if err != nil || json.Unmarshal(body, &v) != nil || v["text"] != big {
		t.Fatalf("body of %d bytes: %v", len(body), err)
	}
	a, b = net.Pipe()
	go Reply(a, map[string]string{"text": "small"}, nil)
	rep = agentproto.Reply{}
	if err := agentproto.ReadLine(b, &rep); err != nil || rep.PluginLength != 0 || string(rep.Plugin) != `{"text":"small"}` {
		t.Fatalf("small reply %+v %v", rep, err)
	}
}

// UntilClosed ends the action's context when the core closes the stream.
func TestUntilClosed(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	ctx, cancel := UntilClosed(context.Background(), a)
	defer cancel()
	select {
	case <-ctx.Done():
		t.Fatal("ended while the stream is open")
	case <-time.After(50 * time.Millisecond):
	}
	b.Close()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("not ended when the core closed the stream")
	}
}

func TestReplyAndFail(t *testing.T) {
	a, b := net.Pipe()
	go Reply(a, map[string]int{"n": 1}, nil)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil || !rep.OK || string(rep.Plugin) != `{"n":1}` {
		t.Fatalf("reply %+v %v", rep, err)
	}
	a, b = net.Pipe()
	go Reply(a, nil, Errorf("git_missing", "no git"))
	rep = agentproto.Reply{}
	if err := agentproto.ReadLine(b, &rep); err != nil || rep.OK || rep.Code != "git_missing" {
		t.Fatalf("failure %+v %v", rep, err)
	}
	a, b = net.Pipe()
	go Reply(a, nil, errors.New("plain"))
	rep = agentproto.Reply{}
	if err := agentproto.ReadLine(b, &rep); err != nil || rep.Code != "failed" {
		t.Fatalf("plain failure %+v %v", rep, err)
	}
}

func TestStreamEndsWhenCoreCloses(t *testing.T) {
	a, b := net.Pipe()
	n := 0
	done := make(chan error)
	go func() {
		done <- Stream(context.Background(), a, "first", func(ctx context.Context) (any, error) {
			n++
			if n > 2 {
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return n, nil
		})
	}()
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil || string(rep.Plugin) != `"first"` {
		t.Fatalf("reply %+v %v", rep, err)
	}
	for want := 1; want <= 2; want++ {
		var v json.RawMessage
		if err := agentproto.ReadLine(b, &v); err != nil || string(v) != string(rune('0'+want)) {
			t.Fatalf("line %d: %s %v", want, v, err)
		}
	}
	b.Close()
	if err := <-done; err != nil {
		t.Fatalf("stream: %v", err)
	}
}

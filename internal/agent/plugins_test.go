//go:build unix

package agent

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

func init() {
	plugin.Register("testecho", func(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
		var p map[string]string
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		return plugin.Reply(st, map[string]int{"len": len(p["text"])}, nil)
	})
	plugin.Register("testpanic", func(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
		if action == "after" {
			agentproto.WriteLine(st, agentproto.Reply{OK: true})
		}
		panic("boom")
	})
}

// openPlugin runs handlePlugin on one end of a pipe with h and body after
// the header, and returns the other end with the reply read.
func openPlugin(t *testing.T, a *Agent, h agentproto.Header, body []byte) (net.Conn, agentproto.Reply) {
	t.Helper()
	core, st := net.Pipe()
	t.Cleanup(func() { core.Close() })
	go a.handlePlugin(context.Background(), st, h)
	if len(body) > 0 {
		go core.Write(body)
	}
	core.SetReadDeadline(time.Now().Add(5 * time.Second))
	var rep agentproto.Reply
	if err := agentproto.ReadLine(core, &rep); err != nil {
		t.Fatal(err)
	}
	return core, rep
}

// Params larger than a line follow the header as a body.
func TestPluginParamsBody(t *testing.T) {
	a := testAgent(t)
	big, _ := json.Marshal(map[string]string{"text": strings.Repeat("y", 2<<20)})
	h := agentproto.Header{Op: agentproto.OpPlugin, Plugin: "testecho", Action: "echo", ParamsLength: int64(len(big))}
	_, rep := openPlugin(t, a, h, big)
	if !rep.OK || string(rep.Plugin) != `{"len":2097152}` {
		t.Fatalf("reply %+v", rep)
	}
	h.ParamsLength = agentproto.MaxBody + 1
	if _, rep := openPlugin(t, a, h, nil); rep.OK || rep.Code != "bad_params" {
		t.Fatalf("params over the bound: %+v", rep)
	}
}

// A handler's panic fails its action and leaves the agent running; one
// that answered before panicking gets no second reply.
func TestPluginPanicFails(t *testing.T) {
	a := testAgent(t)
	_, rep := openPlugin(t, a, agentproto.Header{Op: agentproto.OpPlugin, Plugin: "testpanic", Action: "now"}, nil)
	if rep.OK || rep.Code != "failed" {
		t.Fatalf("reply %+v", rep)
	}
	core, rep := openPlugin(t, a, agentproto.Header{Op: agentproto.OpPlugin, Plugin: "testpanic", Action: "after"}, nil)
	if !rep.OK {
		t.Fatalf("first reply %+v", rep)
	}
	var more agentproto.Reply
	if err := agentproto.ReadLine(core, &more); err == nil {
		t.Fatalf("a second reply %+v", more)
	}
}

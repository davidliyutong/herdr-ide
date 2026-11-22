//go:build unix

package chat

import (
	"context"
	"net"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// reply runs an action and reads its reply.
func reply(t *testing.T, action string) agentproto.Reply {
	t.Helper()
	core, st := net.Pipe()
	defer core.Close()
	t.Setenv("HOME", t.TempDir())
	go plugin.Lookup(ID)(context.Background(), st, action, nil, &plugin.Env{})
	core.SetReadDeadline(time.Now().Add(5 * time.Second))
	var rep agentproto.Reply
	if err := agentproto.ReadLine(core, &rep); err != nil {
		t.Fatal(err)
	}
	return rep
}

// The plugin is registered; without a chat host its action answers
// unsupported, and another action is refused.
func TestNoChatHost(t *testing.T) {
	if plugin.Lookup(ID) == nil {
		t.Fatal("not registered")
	}
	if rep := reply(t, ActionOpen); rep.OK || rep.Code != "unsupported" {
		t.Errorf("open: %+v", rep)
	}
	if rep := reply(t, "run"); rep.OK || rep.Code != "bad_params" {
		t.Errorf("another action: %+v", rep)
	}
}

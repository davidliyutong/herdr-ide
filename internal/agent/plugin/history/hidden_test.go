//go:build unix

package history

import (
	"testing"

	"herdr-ide/internal/agentproto"
)

// A terminal of the product's own helpers (the chat host), which no client
// shows, is never read, attached to or stored, whatever its label's value;
// the other terminals are captured as before.
func TestHiddenTerminalsNotCaptured(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	shown := live("t1", 100)
	host := live("t2", 200)
	host.Labels[agentproto.HiddenLabel] = agentproto.HiddenChatHost
	other := live("t3", 300)
	other.Labels[agentproto.HiddenLabel] = ""
	f.set(shown, host, other)
	for _, addr := range []string{"t1", "t2", "t3"} {
		f.setText(addr, "$ "+addr)
		f.setPaint(addr, painter(50, 40, "$ "+addr))
	}
	res := mustCapture(t, env, params)
	if res.Captured != 1 || res.Failed != 0 || res.Skipped != 0 {
		t.Fatalf("result %+v", res)
	}
	if at := f.attached(); len(at) != 1 || at[0].Terminal != "t1" {
		t.Fatalf("attaches %+v", at)
	}
	f.mu.Lock()
	for _, r := range f.reads {
		if r["terminal"] != "t1" {
			t.Errorf("read %v", r)
		}
	}
	f.mu.Unlock()
	for _, addr := range []string{"t2", "t3"} {
		if metaOf(t, env, addr, false) != nil {
			t.Errorf("a snapshot of %s", addr)
		}
	}
	if metaOf(t, env, "t1", false) == nil {
		t.Error("no snapshot of t1")
	}
}

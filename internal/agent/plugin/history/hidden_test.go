//go:build unix

package history

import (
	"testing"

	"herdr-ide/internal/agentproto"
)

// The terminal of the product's own helper (the chat host: its reserved
// name and its hidden label's value, both, as the core's terminal
// protocol hides it), which no client shows, is never read, attached to or
// stored; a terminal that only carries the label, or only has the name,
// is one the clients show and is captured as before.
func TestHiddenTerminalsNotCaptured(t *testing.T) {
	env, f := testEnv(t)
	fast(t)
	name := agentproto.ChatHostName
	shown := live("t1", 100)
	host := live("t2", 200)
	host.Name = &name
	host.Labels[agentproto.HiddenLabel] = agentproto.HiddenChatHost
	labeled := live("t3", 300)
	labeled.Labels[agentproto.HiddenLabel] = agentproto.HiddenChatHost
	named := live("t4", 400)
	named.Name = &name
	named.Labels[agentproto.HiddenLabel] = "other"
	f.set(shown, host, labeled, named)
	for _, addr := range []string{"t1", "t2", "t3", "t4"} {
		f.setText(addr, "$ "+addr)
		f.setPaint(addr, painter(50, 40, "$ "+addr))
	}
	res := mustCapture(t, env, params)
	if res.Captured != 3 || res.Failed != 0 || res.Skipped != 0 {
		t.Fatalf("result %+v", res)
	}
	for _, at := range f.attached() {
		if at.Terminal == "t2" {
			t.Errorf("attached to the chat host's terminal: %+v", at)
		}
	}
	f.mu.Lock()
	for _, r := range f.reads {
		if r["terminal"] == "t2" {
			t.Errorf("read %v", r)
		}
	}
	f.mu.Unlock()
	if metaOf(t, env, "t2", false) != nil {
		t.Error("a snapshot of the chat host's terminal")
	}
	for _, addr := range []string{"t1", "t3", "t4"} {
		if metaOf(t, env, addr, false) == nil {
			t.Errorf("no snapshot of %s", addr)
		}
	}
}

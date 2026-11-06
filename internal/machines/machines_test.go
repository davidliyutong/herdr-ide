package machines

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/transport"
)

func TestLoadSpecsFromHerdrCatalog(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	client := filepath.Join(state, "herdr", "client")
	os.MkdirAll(filepath.Join(client, "ssh-metadata"), 0o755)
	os.WriteFile(filepath.Join(client, "endpoints.json"), []byte(`{"version":1,"selected_profile":"a1","ssh":[
		{"id":"a1","label":"gpu","target":"gpu-host","session":"default","enabled":true},
		{"id":"b2","label":"","target":"robot","session":"","enabled":false}]}`), 0o644)
	os.WriteFile(filepath.Join(client, "ssh-metadata", "a1.json"), []byte(`{"version":1,"target":"gpu-host","session":"default","metadata":{"os":"linux","executable":"/home/u/.local/bin/herdr"}}`), 0o644)

	specs := LoadSpecs("dev", []Spec{{Target: "extra"}, {ID: "a1", Target: "dup"}})
	if len(specs) != 4 {
		t.Fatalf("specs = %+v", specs)
	}
	if specs[0].ID != LocalID || specs[0].Session != "dev" {
		t.Fatalf("local = %+v", specs[0])
	}
	if s := specs[1]; s.Target != "gpu-host" || s.HerdrBin != "/home/u/.local/bin/herdr" || !s.Enabled {
		t.Fatalf("gpu = %+v", s)
	}
	if s := specs[2]; s.Label != "robot" || s.Session != "default" || s.Enabled {
		t.Fatalf("robot = %+v", s)
	}
	if s := specs[3]; s.ID != "extra" || s.Kind != KindSSH {
		t.Fatalf("extra = %+v", s)
	}
}

func TestIsReadOnly(t *testing.T) {
	for m, want := range map[string]bool{"session.snapshot": true, "pane.list": true, "layout.export": true, "pane.split": false, "agent.prompt": false} {
		if IsReadOnlyMethod(m) != want {
			t.Errorf("isReadOnly(%s) != %v", m, want)
		}
	}
}

// A machine whose herdr does not answer is degraded while its agent stays
// connected; Retry replaces the session at once instead of waiting for it
// to end, but not one that has just started.
func TestRetryReconnectsADegradedMachine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	old := pollInterval
	pollInterval = 50 * time.Millisecond
	t.Cleanup(func() { pollInterval = old })

	logger := log.New(io.Discard, "", 0)
	var dials atomic.Int32
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		dials.Add(1)
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	m := newMachine(Spec{ID: "x", Label: "x", Kind: KindSSH, Session: "herdr-ide-none", Enabled: true}, dial, logger, func(State) {}, func(AgentEvent) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		m.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (status %s, %d dials)", what, m.State().Status, dials.Load())
			}
		}
	}
	waitFor("degraded", func() bool { return m.State().Status == StatusDegraded })
	first := m.Session()
	// A session younger than minRetryAge stays.
	oldAge := minRetryAge
	t.Cleanup(func() { minRetryAge = oldAge })
	minRetryAge = time.Hour
	if m.Retry() || m.Session() != first {
		t.Fatal("Retry replaced a session that had just started")
	}
	minRetryAge = 0
	if !m.Retry() {
		t.Fatal("Retry did not replace the degraded session")
	}
	waitFor("a new session", func() bool { s := m.Session(); return dials.Load() == 2 && s != nil && s != first })
	select {
	case <-first.Done():
	default:
		t.Fatal("the first session is still open")
	}
	waitFor("degraded again", func() bool { return m.State().Status == StatusDegraded })
}

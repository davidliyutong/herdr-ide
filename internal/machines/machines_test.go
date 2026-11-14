package machines

import (
	"context"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
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
	if s := specs[1]; s.Target != "gpu-host" || s.HerdrBin != "/home/u/.local/bin/herdr" || !s.Enabled || !s.Saved {
		t.Fatalf("gpu = %+v", s)
	}
	if s := specs[2]; s.Label != "robot" || s.Session != "default" || s.Enabled {
		t.Fatalf("robot = %+v", s)
	}
	if s := specs[3]; s.ID != "extra" || s.Kind != KindSSH || s.Saved {
		t.Fatalf("extra = %+v", s)
	}
}

func TestIsReadOnly(t *testing.T) {
	for m, want := range map[string]bool{"session.snapshot": true, "pane.list": true, "layout.export": true, "pane.copy_search": true, "pane.copy_motion": true, "pane.split": false, "agent.prompt": false, "pane.scroll": false} {
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

func TestOverridesSaveAndApply(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conf", "machines.json")
	o := LoadOverrides(path)
	if err := o.SetEnabled("gpu", false); err != nil {
		t.Fatal(err)
	}
	if err := o.SetEnabled("robot", true); err != nil {
		t.Fatal(err)
	}
	specs := []Spec{{ID: "gpu", Enabled: true}, {ID: "robot"}, {ID: "other", Enabled: true}}
	LoadOverrides(path).Apply(specs)
	if specs[0].Enabled || !specs[1].Enabled || !specs[2].Enabled {
		t.Fatalf("applied: %+v", specs)
	}
	if st, err := os.Stat(path); err != nil || st.Mode().Perm()&0o077 != 0 {
		t.Fatalf("file: %v %v", st, err)
	}
	// A missing or broken file gives none.
	os.WriteFile(path, []byte("{"), 0o600)
	specs = []Spec{{ID: "gpu", Enabled: true}}
	LoadOverrides(path).Apply(specs)
	if !specs[0].Enabled {
		t.Fatal("a broken file disabled a machine")
	}
}

// Disabling a connected machine ends its session at once and forgets its
// herdr state; enabling it connects again.
func TestDisableAndEnableAtRuntime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	logger := log.New(io.Discard, "", 0)
	var dials atomic.Int32
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		dials.Add(1)
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	mg := NewManager([]Spec{{ID: "x", Label: "x", Kind: KindSSH, Session: "herdr-ide-none", Enabled: true}}, dial, logger)
	path := filepath.Join(t.TempDir(), "machines.json")
	mg.UseOverrides(LoadOverrides(path))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	m := mg.Get("x")
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (status %s, %d dials)", what, m.State().Status, dials.Load())
			}
		}
	}
	waitFor("a session", func() bool { return m.Session() != nil })
	first := m.Session()

	if err := mg.SetEnabled("x", false); err != nil {
		t.Fatal(err)
	}
	waitFor("the session to end", func() bool {
		select {
		case <-first.Done():
			return m.Session() == nil
		default:
			return false
		}
	})
	time.Sleep(100 * time.Millisecond)
	if st := m.State(); st.Status != StatusDisabled || st.Enabled || st.Snapshot != nil || dials.Load() != 1 {
		t.Fatalf("disabled: status %s enabled %v, %d dials", st.Status, st.Enabled, dials.Load())
	}
	if specs := []Spec{{ID: "x", Enabled: true}}; func() bool { LoadOverrides(path).Apply(specs); return specs[0].Enabled }() {
		t.Fatal("the choice was not saved")
	}

	if err := mg.SetEnabled("x", true); err != nil {
		t.Fatal(err)
	}
	waitFor("a new session", func() bool { s := m.Session(); return s != nil && s != first && dials.Load() == 2 })
	if !m.State().Enabled {
		t.Fatal("not enabled")
	}
	if err := mg.SetEnabled("nope", true); err != ErrUnknownMachine {
		t.Fatalf("unknown machine: %v", err)
	}
}

// The herdr a status found replaces the one of the session's first reply:
// herdr can be removed, reinstalled or moved while the agent runs.
func TestNoteHerdrFollowsTheMachine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	var published atomic.Bool // the reinstalled herdr reached the UI
	m := newMachine(Spec{ID: "x", Label: "x", Kind: KindSSH, Session: "herdr-ide-none", Enabled: true}, dial, logger, func(st State) {
		if st.Info != nil && st.Info.HerdrBin == "/opt/herdr" {
			published.Store(true)
		}
	}, func(AgentEvent) {})

	m.NoteHerdr("/opt/herdr", "0.9.5") // not connected: nothing to note
	if m.State().Info != nil {
		t.Fatal("noted herdr without a session")
	}

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
	for deadline := time.Now().Add(10 * time.Second); m.Session() == nil || m.State().Info == nil; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the session")
		}
	}

	first := m.State().Info
	m.NoteHerdr("", "")
	if info := m.State().Info; info.HerdrBin != "" || info.HerdrVersion != "" || info.HerdrError != agentproto.ErrHerdrNotFound.Error() || info.Hostname != first.Hostname {
		t.Fatalf("removed: %+v", info)
	}
	m.NoteHerdr("/opt/herdr", "0.10.0")
	if info := m.State().Info; info.HerdrBin != "/opt/herdr" || info.HerdrVersion != "0.10.0" || info.HerdrError != "" {
		t.Fatalf("reinstalled: %+v", info)
	}
	if first.HerdrBin == "/opt/herdr" {
		t.Fatal("changed an Info already published")
	}
	if !published.Load() {
		t.Fatal("the new herdr was not published")
	}
}

// Machines saved in herdr's catalog from the UI join a running manager and
// connect; removing one ends its session, forgets its enabled choice and
// publishes nothing more for it. The local machine cannot be removed.
func TestAddAndRemoveAtRuntime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	mg := NewManager([]Spec{{ID: LocalID, Label: "local", Kind: KindLocal, Session: "herdr-ide-none", Enabled: true}}, dial, logger)
	path := filepath.Join(t.TempDir(), "machines.json")
	o := LoadOverrides(path)
	mg.UseOverrides(o)
	var afterRemove atomic.Int32
	var removed atomic.Bool
	mg.Subscribe(func(st State) {
		if st.ID == "x" && removed.Load() {
			afterRemove.Add(1)
		}
	}, func(AgentEvent) {})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
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
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}

	spec := Spec{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Session: "herdr-ide-none", Enabled: true, Saved: true}
	if err := mg.Add(spec); err != nil {
		t.Fatal(err)
	}
	if err := mg.Add(spec); err != ErrMachineExists {
		t.Fatalf("added twice: %v", err)
	}
	m := mg.Get("x")
	waitFor("the added machine's session", func() bool { return m.Session() != nil })
	if st := mg.States(); len(st) != 2 || st[1].ID != "x" || !st[1].Saved {
		t.Fatalf("states = %+v", st)
	}
	sess := m.Session()
	if err := mg.SetEnabled("x", true); err != nil {
		t.Fatal(err)
	}

	removed.Store(true)
	if err := mg.Remove("x"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sess.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the session did not end")
	}
	if mg.Get("x") != nil || len(mg.States()) != 1 {
		t.Fatalf("still there: %+v", mg.States())
	}
	if n := afterRemove.Load(); n != 0 {
		t.Fatalf("%d states published after the removal", n)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), `"x"`) {
		t.Fatalf("the enabled choice was kept: %s", b)
	}
	if err := mg.Remove("x"); err != ErrUnknownMachine {
		t.Fatalf("removed twice: %v", err)
	}
	if err := mg.Remove(LocalID); err != ErrLocalMachine {
		t.Fatalf("removed the local machine: %v", err)
	}

	// A disabled choice made before for the id applies when it comes back.
	if err := o.SetEnabled("y", false); err != nil {
		t.Fatal(err)
	}
	if err := mg.Add(Spec{ID: "y", Label: "y", Kind: KindSSH, Session: "herdr-ide-none", Enabled: true, Saved: true}); err != nil {
		t.Fatal(err)
	}
	if st := mg.Get("y").State(); st.Status != StatusDisabled || st.Enabled {
		t.Fatalf("y = %s enabled %v", st.Status, st.Enabled)
	}
}

// A reload applies herdr's new label and enabled flag, but not the flag of
// a machine the user enabled or disabled here.
func TestUpdateFromCatalog(t *testing.T) {
	var labels []string
	mg := NewManager([]Spec{
		{ID: "a", Label: "a", Kind: KindSSH, Enabled: true, Saved: true},
		{ID: "b", Label: "b", Kind: KindSSH, Enabled: true, Saved: true},
	}, nil, log.New(io.Discard, "", 0))
	o := LoadOverrides("")
	o.SetEnabled("b", true)
	mg.UseOverrides(o)
	mg.Subscribe(func(st State) { labels = append(labels, st.Label) }, func(AgentEvent) {})

	if changed, err := mg.Update(Spec{ID: "a", Label: "a", Enabled: true}); err != nil || changed {
		t.Fatalf("unchanged: %v %v", changed, err)
	}
	if changed, _ := mg.Update(Spec{ID: "a", Label: "GPU", Enabled: false}); !changed {
		t.Fatal("not changed")
	}
	if st := mg.Get("a").State(); st.Label != "GPU" || st.Status != StatusDisabled || mg.Get("a").Label() != "GPU" {
		t.Fatalf("a = %s %s", st.Label, st.Status)
	}
	if len(labels) == 0 || labels[0] != "GPU" {
		t.Fatalf("published %v", labels)
	}
	if changed, _ := mg.Update(Spec{ID: "b", Label: "b", Enabled: false}); changed || mg.Get("b").State().Status == StatusDisabled {
		t.Fatal("herdr's flag replaced the user's choice")
	}
	if _, err := mg.Update(Spec{ID: "nope"}); err != ErrUnknownMachine {
		t.Fatalf("unknown: %v", err)
	}
}

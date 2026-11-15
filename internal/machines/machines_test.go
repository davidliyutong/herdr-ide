package machines

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/transport"
)

// herdrCatalog writes herdr's catalog under a private XDG_STATE_HOME.
func herdrCatalog(t *testing.T, json string) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	client := filepath.Join(state, "herdr", "client")
	os.MkdirAll(client, 0o755)
	os.WriteFile(filepath.Join(client, "endpoints.json"), []byte(json), 0o644)
}

const twoSaved = `{"version":1,"selected_profile":"a1","ssh":[
	{"id":"a1","label":"gpu","target":"gpu-host","session":"work","enabled":true},
	{"id":"b2","label":"","target":"robot","session":"","enabled":false}]}`

// Without a machines file, herdr's saved machines are imported once and
// written; afterwards herdr's catalog is not read again.
func TestRegistryImportsHerdrOnce(t *testing.T) {
	herdrCatalog(t, twoSaved)
	path := filepath.Join(t.TempDir(), "conf", "machines-dev.json")
	r, err := OpenRegistry(path, SavedSpecs)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Specs()
	if len(got) != 2 || got[0] != (Spec{ID: "a1", Label: "gpu", Kind: KindSSH, Target: "gpu-host", Enabled: true}) ||
		got[1] != (Spec{ID: "b2", Label: "robot", Kind: KindSSH, Target: "robot"}) {
		t.Fatalf("imported %+v", got)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("file: %v %v", st, err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "session") || !strings.Contains(string(b), `"version": 1`) {
		t.Fatalf("stored: %s", b)
	}
	// herdr's catalog changes: the core keeps its own machines.
	herdrCatalog(t, `{"version":1,"ssh":[{"id":"c3","label":"new","target":"new","enabled":true}]}`)
	r, err = OpenRegistry(path, SavedSpecs)
	if err != nil || len(r.Specs()) != 2 || r.Specs()[0].ID != "a1" {
		t.Fatalf("reopened: %+v %v", r.Specs(), err)
	}
	// An empty import is written too, and not repeated either.
	herdrCatalog(t, `{"version":1,"ssh":[]}`)
	empty := filepath.Join(t.TempDir(), "machines.json")
	if r, err := OpenRegistry(empty, SavedSpecs); err != nil || len(r.Specs()) != 0 {
		t.Fatalf("empty: %+v %v", r.Specs(), err)
	}
	herdrCatalog(t, twoSaved)
	if r, _ := OpenRegistry(empty, SavedSpecs); len(r.Specs()) != 0 {
		t.Fatalf("imported again: %+v", r.Specs())
	}
}

// The file an earlier version kept (the machines enabled or disabled over
// herdr's catalog) is migrated: herdr's machines are imported with those
// choices, the local machine's included.
func TestRegistryMigratesEnabledChoices(t *testing.T) {
	herdrCatalog(t, twoSaved)
	path := filepath.Join(t.TempDir(), "machines.json")
	os.WriteFile(path, []byte(`{"enabled":{"a1":false,"b2":true,"local":false,"gone":true}}`), 0o600)
	r, err := OpenRegistry(path, SavedSpecs)
	if err != nil {
		t.Fatal(err)
	}
	got := r.Specs()
	if len(got) != 3 || got[0].Enabled || !got[1].Enabled || got[2] != (Spec{ID: LocalID, Kind: KindLocal}) {
		t.Fatalf("migrated %+v", got)
	}
	specs := LoadSpecs(got, nil)
	if specs[0].ID != LocalID || specs[0].Enabled || len(specs) != 3 {
		t.Fatalf("specs %+v", specs)
	}
}

// Records are written at once and read back; a broken file is reported and
// left alone (the registry then keeps changes in memory); a catalog that
// cannot be read imports nothing and writes nothing.
func TestRegistryRoundTripAndErrors(t *testing.T) {
	herdrCatalog(t, `{"version":1,"ssh":[]}`)
	path := filepath.Join(t.TempDir(), "machines.json")
	r, err := OpenRegistry(path, SavedSpecs)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "x1", Label: "box", Target: "u@box", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "y2", Target: "y"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "x1", Label: "box 2", Target: "u@box", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Spec{ID: "", Target: "z"}); err == nil {
		t.Fatal("stored a record without an id")
	}
	if err := r.Delete("y2"); err != nil {
		t.Fatal(err)
	}
	r, err = OpenRegistry(path, nil)
	if err != nil || len(r.Specs()) != 1 || r.Specs()[0] != (Spec{ID: "x1", Label: "box 2", Kind: KindSSH, Target: "u@box"}) {
		t.Fatalf("read back %+v %v", r.Specs(), err)
	}

	os.WriteFile(path, []byte("{"), 0o600)
	r, err = OpenRegistry(path, SavedSpecs)
	if err == nil {
		t.Fatal("a broken file was accepted")
	}
	r.Put(Spec{ID: "z", Target: "z"})
	if b, _ := os.ReadFile(path); string(b) != "{" {
		t.Fatalf("the broken file was replaced: %s", b)
	}

	herdrCatalog(t, "{")
	none := filepath.Join(t.TempDir(), "machines.json")
	if _, err := OpenRegistry(none, SavedSpecs); err == nil {
		t.Fatal("an unreadable catalog was imported")
	}
	if _, err := os.Stat(none); err == nil {
		t.Fatal("wrote a file without herdr's machines")
	}
}

// The local machine comes first, then the stored SSH machines and the --ssh
// targets, each once; targets that could read as options are left out.
func TestLoadSpecs(t *testing.T) {
	stored := []Spec{{ID: "a1", Label: "gpu", Kind: KindSSH, Target: "gpu-host", Enabled: true}, {ID: LocalID, Kind: KindLocal, Enabled: true},
		{ID: "evil", Kind: KindSSH, Target: "-oProxyCommand=touch /tmp/x", Enabled: true}}
	specs := LoadSpecs(stored, []Spec{{Target: "extra"}, {ID: "a1", Target: "dup"}, {Target: "-oProxyCommand=sh"}, {Target: "host;id"}})
	if len(specs) != 3 || specs[0].ID != LocalID || !specs[0].Enabled || specs[1].ID != "a1" {
		t.Fatalf("specs = %+v", specs)
	}
	if s := specs[2]; s.ID != "extra" || s.Kind != KindSSH || s.Label != "extra" {
		t.Fatalf("extra = %+v", s)
	}
}

// Targets are ssh destinations that can never read as an option or carry a
// shell metacharacter.
func TestValidTarget(t *testing.T) {
	for _, ok := range []string{"gpu", "gpu-host", "u@gpu", "user@gpu.example.com", "ssh://u@h:2222", "host:22", "[fe80::1%en0]", "u_1@10.0.0.2", "a.b-c_d"} {
		if !ValidTarget(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "-oProxyCommand=x", "-p", "a b", "gpü", "h\tx", "h\nx", "h\x00", "h;id", "h|x", "h&x", "$(id)", "`id`", "h'x", `h"x`, "h*", "h?", "h>x", "h<x", "h\\x", "h~", "h=x", "h,x", "h!x", "h#x", "h{x}", "h(x)", "h\x7f", strings.Repeat("x", 256)} {
		if ValidTarget(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A stored record or a machine of herdr's catalog whose target could read
// as an option of ssh is dropped when the file is read or imported, and
// never stored.
func TestRegistryDropsInvalidTargets(t *testing.T) {
	herdrCatalog(t, `{"version":1,"ssh":[{"id":"a1","label":"gpu","target":"gpu-host","enabled":true},
		{"id":"p1","label":"proxy","target":"-oProxyCommand=touch /tmp/pwned","enabled":true},
		{"id":"s1","label":"semi","target":"host;id","enabled":true}]}`)
	path := filepath.Join(t.TempDir(), "machines.json")
	r, err := OpenRegistry(path, SavedSpecs)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.Specs(); len(got) != 1 || got[0].ID != "a1" {
		t.Fatalf("imported %+v", got)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "ProxyCommand") || strings.Contains(string(b), ";") {
		t.Fatalf("stored %s", b)
	}
	if err := r.Put(Spec{ID: "p2", Target: "-oProxyCommand=x"}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("put: %v", err)
	}
	os.WriteFile(path, []byte(`{"version":1,"machines":[{"id":"a1","kind":"ssh","target":"gpu-host","enabled":true},
		{"id":"p1","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true}]}`), 0o600)
	r, err = OpenRegistry(path, nil)
	if err != nil || len(r.Specs()) != 1 || r.Specs()[0].ID != "a1" {
		t.Fatalf("read %+v %v", r.Specs(), err)
	}
	mg := NewManager(nil, nil, log.New(io.Discard, "", 0))
	if err := mg.Add(Spec{ID: "p3", Target: "-oProxyCommand=x"}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("add: %v", err)
	}
}

// A machine is ready once its agent answers, quietly.
func TestReadyWhenTheAgentAnswers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))

	var logs strings.Builder
	var logMu sync.Mutex
	logger := log.New(writerFunc(func(p []byte) (int, error) {
		logMu.Lock()
		defer logMu.Unlock()
		return logs.Write(p)
	}), "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: log.New(io.Discard, "", 0)})
		return s, "test/test", err
	}
	m := newMachine(Spec{ID: "x", Label: "x", Kind: KindSSH, Enabled: true}, dial, logger, func(State) {})
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
	for deadline := time.Now().Add(10 * time.Second); m.State().Status != StatusReady; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out (status %s)", m.State().Status)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if st := m.State(); st.Status != StatusReady || st.Info == nil || st.Platform != "test/test" || m.Session() == nil {
		t.Fatalf("state %s %+v", st.Status, st)
	}
	logMu.Lock()
	defer logMu.Unlock()
	if logs.Len() > 0 {
		t.Fatalf("logged: %s", logs.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// Disabling a connected machine ends its session at once; enabling it
// connects again.
func TestDisableAndEnableAtRuntime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	var dials atomic.Int32
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		dials.Add(1)
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path, nil)
	reg.Put(Spec{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Enabled: true})
	mg := NewManager([]Spec{{ID: "x", Label: "x", Kind: KindSSH, Target: "x", Enabled: true}}, dial, logger)
	mg.UseRegistry(reg)
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
	if st := m.State(); st.Status != StatusDisabled || st.Enabled || dials.Load() != 1 {
		t.Fatalf("disabled: status %s enabled %v, %d dials", st.Status, st.Enabled, dials.Load())
	}
	if r, _ := OpenRegistry(path, nil); r.Specs()[0].Enabled {
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

// Machines added at runtime are stored, join a running manager and connect;
// removing one ends its session, deletes its record and publishes nothing
// more for it. A target or id the core has is refused, and the local machine
// cannot be removed.
func TestAddAndRemoveAtRuntime(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path, nil)
	// Stored, but left out of this run (--local-only).
	reg.Put(Spec{ID: "off", Label: "elsewhere", Target: "u@elsewhere", Enabled: true})
	mg := NewManager([]Spec{{ID: LocalID, Label: "local", Kind: KindLocal, Enabled: true}}, dial, logger)
	mg.UseRegistry(reg)
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

	spec := Spec{ID: "x", Label: "x", Target: "u@x", Enabled: true}
	if err := mg.Add(spec); err != nil {
		t.Fatal(err)
	}
	for _, dup := range []Spec{spec, {ID: "y", Target: "u@x"}, {ID: "z", Target: "u@elsewhere"}, {ID: "off", Target: "new"}} {
		if err := mg.Add(dup); err != ErrMachineExists {
			t.Fatalf("added %+v: %v", dup, err)
		}
	}
	m := mg.Get("x")
	waitFor("the added machine's session", func() bool { return m.Session() != nil })
	if st := mg.States(); len(st) != 2 || st[1].ID != "x" || st[1].Kind != KindSSH {
		t.Fatalf("states = %+v", st)
	}
	if r, _ := OpenRegistry(path, nil); len(r.Specs()) != 2 || r.Specs()[1].Target != "u@x" {
		t.Fatalf("stored %+v", r.Specs())
	}
	sess := m.Session()

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
		t.Fatalf("the record was kept: %s", b)
	}
	if err := mg.Remove("x"); err != ErrUnknownMachine {
		t.Fatalf("removed twice: %v", err)
	}
	if err := mg.Remove(LocalID); err != ErrLocalMachine {
		t.Fatalf("removed the local machine: %v", err)
	}

	// A machine added disabled stays so.
	if err := mg.Add(Spec{ID: "y", Label: "y", Target: "u@y"}); err != nil {
		t.Fatal(err)
	}
	if st := mg.Get("y").State(); st.Status != StatusDisabled || st.Enabled {
		t.Fatalf("y = %s enabled %v", st.Status, st.Enabled)
	}
}

// Renaming is stored for stored machines and kept in memory for --ssh ones;
// a label another machine has (also one stored but not running) is refused,
// and the local machine keeps its host's name. Enabling or disabling the
// local machine stores a record of it.
func TestSetLabelAndLocalRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machines.json")
	reg, _ := OpenRegistry(path, nil)
	reg.Put(Spec{ID: "a", Label: "a", Target: "a", Enabled: true})
	reg.Put(Spec{ID: "off", Label: "elsewhere", Target: "e", Enabled: true})
	mg := NewManager([]Spec{
		{ID: LocalID, Label: "mac (local)", Kind: KindLocal, Enabled: true},
		{ID: "a", Label: "a", Kind: KindSSH, Target: "a", Enabled: true},
		{ID: "extra", Label: "extra", Kind: KindSSH, Target: "extra", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	mg.UseRegistry(reg)
	var labels []string
	mg.Subscribe(func(st State) { labels = append(labels, st.Label) }, func(AgentEvent) {})

	if err := mg.SetLabel("a", "GPU"); err != nil {
		t.Fatal(err)
	}
	if mg.Get("a").Label() != "GPU" || len(labels) == 0 || labels[0] != "GPU" {
		t.Fatalf("label %q, published %v", mg.Get("a").Label(), labels)
	}
	for _, c := range []struct {
		id, label string
		want      error
	}{{"extra", "GPU", ErrLabelTaken}, {"extra", "elsewhere", ErrLabelTaken}, {LocalID, "x", ErrLocalMachine}, {"nope", "x", ErrUnknownMachine}} {
		if err := mg.SetLabel(c.id, c.label); err != c.want {
			t.Fatalf("%s → %s: %v", c.id, c.label, err)
		}
	}
	if err := mg.SetLabel("extra", "Extra"); err != nil || mg.Get("extra").Label() != "Extra" {
		t.Fatalf("--ssh machine: %v", err)
	}
	if err := mg.SetEnabled(LocalID, false); err != nil {
		t.Fatal(err)
	}
	r, _ := OpenRegistry(path, nil)
	got := r.Specs()
	if len(got) != 3 || got[0].Label != "GPU" || got[2] != (Spec{ID: LocalID, Kind: KindLocal}) {
		t.Fatalf("stored %+v", got)
	}
	if mg.Get(LocalID).State().Status != StatusDisabled {
		t.Fatal("the local machine is not disabled")
	}
}
